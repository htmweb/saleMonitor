// dbFunctions.js — port of db_functions.py (PySide6/SQLite) to Node.js + MySQL (RDS)
// Function names, parameters, return shapes, validations and transaction boundaries are unchanged.
// Only the SQL dialect was translated (see notes at the bottom of this file).
const { pool, rows, objs, run, withTransaction } = require('./db');

// GROUP_CONCAT can come back as a Buffer from mysql2 on long values, so normalise to string.
const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v);

const hasEntry = (map, key) =>
  map != null && Object.prototype.hasOwnProperty.call(map, key) && map[key] != null;

// ---- SQL shared by redepositCheque / payChequeReturn / settleWithCheque / settleWithStock ----
const SQL_RETURN_AMOUNT_DETAIL = `
  SELECT
      COALESCE(cd.amount, crcd.amount)       AS amount,
      COALESCE(cr.cheque_detail_id, crcd.id) AS detail_id
  FROM cheque_returns cr
  LEFT JOIN chequeDetails cd
      ON cr.cheque_detail_id = cd.id
  LEFT JOIN cheque_return_payments crp
      ON cr.parent_return_payment_id = crp.id
  LEFT JOIN cheque_return_cheque_details crcd
      ON crp.id = crcd.return_payment_id
  WHERE cr.id = ?`;

const SQL_RETURN_SETTLED_CHECK = `
  SELECT
      COALESCE(cd.amount, crcd.amount)  AS original_amount,
      COALESCE(SUM(crp_paid.amount), 0) AS paid_amount
  FROM cheque_returns cr
  LEFT JOIN chequeDetails cd
      ON cr.cheque_detail_id = cd.id
  LEFT JOIN cheque_return_payments crp_parent
      ON cr.parent_return_payment_id = crp_parent.id
  LEFT JOIN cheque_return_cheque_details crcd
      ON crp_parent.id = crcd.return_payment_id
  LEFT JOIN cheque_return_payments crp_paid
      ON crp_paid.cheque_return_id = cr.id
  WHERE cr.id = ?
  GROUP BY cr.id`;

class DBFunctions {
  // ------------------------------------------------------------------ helpers (shared steps)

  // "Check if this return is now fully settled" block used in several functions
  async _settleIfPaid(conn, return_id) {
    const r = await rows(conn, SQL_RETURN_SETTLED_CHECK, [return_id]);
    if (!r.length) {
      throw new Error(`Failed to check settled status for return ${return_id}`);
    }
    const original_amount = r[0][0];
    const paid_amount = r[0][1];
    if (paid_amount >= original_amount) {
      await run(conn, 'UPDATE cheque_returns SET is_settled = 1 WHERE id = ?', [return_id]);
    }
  }

  // Step 1 of the redeposit / settle functions: this return's own amount + detail_id
  async _getReturnAmountDetail(conn, return_id) {
    const r = await rows(conn, SQL_RETURN_AMOUNT_DETAIL, [return_id]);
    if (!r.length) {
      throw new Error(`Could not fetch amount/detail_id for return_id ${return_id}`);
    }
    return { amount: r[0][0], detail_id: r[0][1] };
  }

  // ------------------------------------------------------------------ customers / reps

  async add_customer(name, address, mobile, shop_address) {
    const filter = await rows(
      pool,
      `SELECT COUNT(*) FROM customers WHERE name = ? AND address_id = ?`,
      [name, address]
    );
    if (filter.length) {
      if (filter[0][0] > 0) return 'exists';
    }

    await run(
      pool,
      `INSERT INTO customers (name, address_id,mobile,shop_address)
       VALUES (?, ?, ?,?)`,
      [name, address, mobile, shop_address]
    );
    return true;
  }

  async updateCustomerNumber(customerId, newNumber) {
    await run(pool, `UPDATE customers SET mobile = ? WHERE id = ?`, [newNumber, customerId]);
    return true;
  }

  async add_rep(name) {
    await run(pool, `INSERT INTO reps (name) VALUES (?)`, [name]);
    return true;
  }

  async get_customers_count(filter_text) {
    const r = await rows(
      pool,
      `SELECT COUNT(*) FROM customers JOIN addresses ON customers.address_id = addresses.id
       WHERE name LIKE ? OR addresses.address LIKE ? OR mobile LIKE ?`,
      [`%${filter_text}%`, `%${filter_text}%`, `%${filter_text}%`]
    );
    if (r.length) return r[0][0];
    return 0;
  }

  async get_customers(filter_text, limit, offset) {
    const r = await rows(
      pool,
      `SELECT
           customers.id,
           customers.name,
           addresses.address,
           customers.mobile,
           COALESCE(SUM(invoices.balance), 0) AS total_balance
       FROM customers
       JOIN addresses ON customers.address_id = addresses.id
       LEFT JOIN invoices ON invoices.customer_id = customers.id
       WHERE customers.name LIKE ?
          OR addresses.address LIKE ?
          OR customers.mobile LIKE ?
       GROUP BY customers.id, customers.name, addresses.address, customers.mobile
       LIMIT ? OFFSET ?`,
      [`%${filter_text}%`, `%${filter_text}%`, `%${filter_text}%`, Number(limit), Number(offset)]
    );
    return r.map((row) => ({
      id: row[0],
      name: row[1],
      address: row[2],
      mobile: row[3],
      total_balance: row[4],
    }));
  }

  // ------------------------------------------------------------------ invoices

  // add invoices to the database
  async add_invoice(invoice) {
    await run(
      pool,
      `INSERT INTO invoices (rep_id,customer_id, invoice_code, amount, balance)
       VALUES (?,?, ?, ?, ?)`,
      [parseInt(invoice.repId, 10), parseInt(invoice.id, 10), invoice.code, invoice.amount, invoice.amount]
    );
    return true;
  }

  async get_invoices(filter_text, limit, offset) {
    const r = await rows(
      pool,
      `SELECT invoice_id,customer_id, name, address, invoice_code, amount, balance FROM invoices
       JOIN customers ON invoices.customer_id = customers.id JOIN addresses ON customers.address_id = addresses.id WHERE invoice_code LIKE ?
       ORDER BY invoices.created_at DESC LIMIT ? OFFSET ? `,
      [`%${filter_text}%`, Number(limit), Number(offset)]
    );
    return r.map((row) => ({
      invoice_id: row[0],
      customer_id: row[1],
      customer_name: row[2],
      customer_address: row[3],
      invoice_code: row[4],
      amount: row[5],
      balance: row[6],
    }));
  }

  async get_Invoices_Count(search) {
    const r = await rows(pool, `SELECT COUNT(*) FROM invoices WHERE invoice_code LIKE ?`, [`%${search}%`]);
    if (r.length) return r[0][0];
    return 0;
  }

  // ------------------------------------------------------------------ payments

  async add_payment(payment, isCheque) {
    return withTransaction(async (conn) => {
      const resPay = await run(
        conn,
        `INSERT INTO payments (invoice_id,amount,payment_method,payDate) VALUES (?,?,?,?)`,
        [payment.invoice_id, payment.amount, payment.method, payment.payDate]
      );

      const payId = resPay.insertId;
      if (payId === null || payId === undefined) {
        throw new Error('Payment ID error.');
      }
      if (isCheque) {
        await run(
          conn,
          `INSERT INTO chequeDetails (cheque_id,cheque_number,account_id,amount,date) VALUES (?,?,?,?,?)`,
          [payId, payment.cheque_number, payment.account_id, payment.amount, payment.date]
        );
      }

      await run(conn, `UPDATE invoices SET balance=? WHERE invoice_id=?`, [payment.balance, payment.invoice_id]);

      return true;
    });
  }

  async getTodayReport() {
    return withTransaction(async (conn) => {
      let invoice_amount, payment_amount, invoice_count;

      let r = await rows(conn, `SELECT IFNULL(SUM(amount),0) FROM invoices WHERE DATE(created_at) = CURDATE()`);
      if (r.length) invoice_amount = r[0][0];

      r = await rows(
        conn,
        `SELECT IFNULL(SUM(p.amount), 0) FROM payments p LEFT JOIN chequeDetails cd ON p.pay_id = cd.cheque_id WHERE DATE(p.created_at) = CURDATE() AND (cd.is_returned = 0 OR p.payment_method='CASH') `
      );
      if (r.length) payment_amount = r[0][0];

      r = await rows(conn, `SELECT COUNT(*) FROM invoices WHERE DATE(created_at) = CURDATE()`);
      if (r.length) invoice_count = r[0][0];

      return {
        payments: payment_amount,
        invoices: invoice_count,
        credit: invoice_amount,
      };
    });
  }

  async getTodayPaymentsGroupBy() {
    const r = await rows(
      pool,
      `SELECT
    IFNULL(SUM(CASE WHEN payment_method = 'CASH'   THEN amount ELSE 0 END), 0) AS cash,
    IFNULL(SUM(CASE WHEN payment_method = 'CHEQUE' THEN amount ELSE 0 END), 0) AS cheque
FROM payments
WHERE DATE(payDate) = CURDATE()`
    );
    let payments = {};
    if (r.length) {
      payments = { cash: r[0][0], cheque: r[0][1] };
    }
    return payments;
  }

  async getTodayInvoices(limit, offset) {
    const r = await rows(
      pool,
      `SELECT invoice_code,amount,name,invoices.created_at FROM invoices JOIN customers ON invoices.customer_id=customers.id WHERE DATE(invoices.created_at) = CURDATE() ORDER BY DATE(invoices.created_at) DESC LIMIT ? OFFSET ? `,
      [Number(limit), Number(offset)]
    );
    return r.map((row) => ({
      invoice_code: row[0],
      amount: row[1],
      name: row[2],
      date: row[3],
    }));
  }

  async getTodayInvoicesCount() {
    const r = await rows(pool, `SELECT COUNT(invoice_id) FROM invoices  WHERE DATE(created_at) = CURDATE()`);
    if (r.length) return r[0][0];
    return 0;
  }

  async getCustomerInvoice(customerId, limit, offset) {
    const r = await rows(
      pool,
      `SELECT invoice_id, invoice_code, amount, balance,created_at FROM invoices
       WHERE customer_id = ? ORDER BY DATE(invoices.created_at) DESC
       LIMIT ? OFFSET ? `,
      [customerId, Number(limit), Number(offset)]
    );
    return r.map((row) => ({
      invoice_id: row[0],
      invoice_code: row[1],
      amount: row[2],
      balance: row[3],
      date: row[4],
    }));
  }

  async getCustomerTotalCredit(customerId) {
    const r = await rows(pool, `SELECT IFNULL(SUM(balance),0) FROM invoices WHERE customer_id = ?`, [customerId]);
    if (r.length) return r[0][0];
    return 0;
  }

  async getCustomerInvoiceCount(customerId) {
    const r = await rows(pool, `SELECT COUNT(*) FROM invoices WHERE customer_id = ? `, [customerId]);
    if (r.length) return r[0][0];
    return 0;
  }

  async getInvoicePayments(invoiceId, limit, offset) {
    const r = await rows(
      pool,
      `SELECT amount, payment_method, payDate,pay_id FROM payments
       WHERE invoice_id = ? ORDER BY DATE(payDate) DESC LIMIT ? OFFSET ?`,
      [invoiceId, Number(limit), Number(offset)]
    );
    const payments = [];
    for (const row of r) {
      if (row[1] === 'CHEQUE') {
        payments.push({
          amount: row[0],
          method: row[1],
          date: row[2],
          cheque_details: await this.getChequeDetails(row[3]),
          pay_id: row[3],
        });
      } else {
        payments.push({
          amount: row[0],
          method: row[1],
          date: row[2],
          pay_id: row[3],
        });
      }
    }
    return payments;
  }

  async getChequeDetails(payId) {
    const r = await rows(
      pool,
      `SELECT cheque_number, bank_code, is_returned, date, account_number, chequeDetails.account_id, cheque_returns.id
       FROM chequeDetails
       INNER JOIN bankAccounts ON chequeDetails.account_id = bankAccounts.id
       LEFT JOIN cheque_returns ON cheque_returns.cheque_detail_id = chequeDetails.id
       WHERE chequeDetails.cheque_id = ? LIMIT 1`,
      [payId]
    );
    if (r.length) {
      const row = r[0];
      return {
        cheque_number: row[0],
        bank_code: row[1],
        is_returned: row[2],
        date: row[3],
        account_number: row[4],
        account_id: row[5],
        cheque_return_id: row[6],
      };
    }
    return null;
  }

  async getInvoicePaymentsCount(invoiceId) {
    const r = await rows(pool, `SELECT COUNT(*) FROM payments WHERE invoice_id = ? `, [invoiceId]);
    if (r.length) return r[0][0];
    return 0;
  }

  async getInvoice(invoiceId) {
    const r = await rows(
      pool,
      `SELECT invoice_id,invoice_code, amount, balance, created_at FROM invoices
       WHERE invoice_id = ? LIMIT 1`,
      [invoiceId]
    );
    if (r.length) {
      const row = r[0];
      return {
        invoice_id: row[0],
        invoice_code: row[1],
        amount: row[2],
        balance: row[3],
        date: row[4],
      };
    }
    return null;
  }

  async getReps(filter_text, limit, offset) {
    const r = await rows(
      pool,
      `SELECT id, name FROM reps WHERE name LIKE ? LIMIT ? OFFSET ?`,
      [`%${filter_text}%`, Number(limit), Number(offset)]
    );
    return r.map((row) => ({ id: row[0], name: row[1] }));
  }

  async getRepsCount(filter_text) {
    const r = await rows(pool, `SELECT COUNT(*) FROM reps WHERE name LIKE ?`, [`%${filter_text}%`]);
    if (r.length) return r[0][0];
    return 0;
  }

  async deletePayment(amount, invoiceId, payId) {
    try {
      return await withTransaction(async (conn) => {
        await run(conn, `UPDATE invoices SET balance = balance + ? WHERE invoice_id = ?`, [amount, invoiceId]);
        await run(conn, `DELETE FROM payments WHERE pay_id = ?`, [payId]);
        return true;
      });
    } catch (e) {
      throw new Error("Couldn't delete the payment");
    }
  }

  async toggleChequeReturned(payId, isReturned, amount, invoiceId) {
    if (isReturned == 0) {
      // RETURNING A CHEQUE
      try {
        return await withTransaction(async (conn) => {
          // 1. update invoice balance (add back)
          await run(conn, 'UPDATE invoices SET balance = balance + ? WHERE invoice_id = ?', [amount, invoiceId]);

          // 2. mark cheque as returned
          await run(conn, 'UPDATE chequeDetails SET is_returned = 1 WHERE cheque_id = ?', [payId]);

          // 3. get chequeDetails.id for this payId
          const q3 = await rows(conn, 'SELECT id FROM chequeDetails WHERE cheque_id = ?', [payId]);
          const chequeDetailId = q3.length ? q3[0][0] : undefined;

          // 4. insert into cheque_returns
          await run(
            conn,
            `INSERT INTO cheque_returns (cheque_detail_id, parent_return_payment_id)
             VALUES (?, NULL)`,
            [chequeDetailId]
          );

          return true;
        });
      } catch (e) {
        throw new Error(`Couldn't return the cheque: ${e.message}`);
      }
    } else {
      // UNDO CHEQUE RETURN
      try {
        return await withTransaction(async (conn) => {
          // 1. update invoice balance (subtract back)
          await run(conn, 'UPDATE invoices SET balance = balance - ? WHERE invoice_id = ?', [amount, invoiceId]);

          // 2. mark cheque as not returned
          await run(conn, 'UPDATE chequeDetails SET is_returned = 0 WHERE cheque_id = ?', [payId]);

          // 3. get chequeDetails.id
          const q3 = await rows(conn, 'SELECT id FROM chequeDetails WHERE cheque_id = ?', [payId]);
          const chequeDetailId = q3.length ? q3[0][0] : undefined;

          // 4. delete from cheque_returns (only if not settled — safety check)
          const q4 = await rows(
            conn,
            `SELECT is_settled FROM cheque_returns
             WHERE cheque_detail_id = ? AND parent_return_payment_id IS NULL`,
            [chequeDetailId]
          );
          if (q4.length && q4[0][0] == 1) {
            throw new Error('Cannot undo — cheque return is already settled');
          }

          await run(
            conn,
            `DELETE FROM cheque_returns
             WHERE cheque_detail_id = ? AND parent_return_payment_id IS NULL`,
            [chequeDetailId]
          );

          return true;
        });
      } catch (e) {
        throw new Error(`Couldn't undo cheque return: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ cheque search

  async filterChequesByDate(date, limit, offset) {
    const r = await rows(
      pool,
      `
WITH RECURSIVE return_chain(start_return_id, cheque_detail_id, parent_return_payment_id) AS (
    SELECT id, cheque_detail_id, parent_return_payment_id
    FROM cheque_returns
    UNION ALL
    SELECT rc.start_return_id, cr_parent.cheque_detail_id, cr_parent.parent_return_payment_id
    FROM return_chain rc
    JOIN cheque_return_payments crp ON rc.parent_return_payment_id = crp.id
    JOIN cheque_returns cr_parent ON crp.cheque_return_id = cr_parent.id
    WHERE rc.cheque_detail_id IS NULL
),
-- cheque_detail_ids that have been redeposited (have a replacement cheque)
redeposited_originals AS (
    SELECT DISTINCT cd.id AS cheque_detail_id
    FROM chequeDetails cd
    JOIN cheque_returns cr ON cr.cheque_detail_id = cd.id
    JOIN cheque_return_payments crp ON crp.cheque_return_id = cr.id
    WHERE crp.payment_type = 'CHEQUE'
),
-- replacement cheques that have themselves been redeposited again
redeposited_replacements AS (
    SELECT DISTINCT rcd.id AS rcd_id
    FROM cheque_return_cheque_details rcd
    JOIN cheque_returns cr ON cr.parent_return_payment_id = rcd.return_payment_id
    JOIN cheque_return_payments crp ON crp.cheque_return_id = cr.id
    WHERE crp.payment_type = 'CHEQUE'
)
SELECT * FROM (
    -- ORIGINAL cheques (exclude ones that have been redeposited)
    SELECT
        MIN(c.id) AS id,
        c.cheque_number,
        c.account_id,
        SUM(c.amount) AS amount,
        c.date,
        MAX(c.is_returned) AS is_returned,
        'ORIGINAL' AS cheque_source,
        (
            SELECT COALESCE(MIN(cr2.is_settled), 0)
            FROM cheque_returns cr2
            WHERE cr2.id IN (
                SELECT start_return_id FROM return_chain
                WHERE cheque_detail_id IN (
                    SELECT id FROM chequeDetails
                    WHERE cheque_number = c.cheque_number
                    AND account_id = c.account_id
                    AND DATE(\`date\`) = DATE(c.date)
                )
            )
        ) AS is_settled,
        cu.name AS customer_name,
        'NONE' AS tag
    FROM chequeDetails c
    LEFT JOIN bankAccounts ba ON ba.id = c.account_id
    LEFT JOIN customers cu ON cu.id = ba.customer_id
    WHERE DATE(c.date) = DATE(?)
    AND NOT EXISTS (
        SELECT 1 FROM redeposited_originals ro
        WHERE ro.cheque_detail_id = c.id
    )
    GROUP BY c.account_id, c.cheque_number, DATE(c.date)

    UNION ALL

    -- REPLACEMENT cheques (exclude ones that have been redeposited again)
    SELECT
        MIN(rcd.id) AS id,
        rcd.cheque_number,
        rcd.account_id,
        SUM(rcd.amount) AS amount,
        rcd.date,
        MAX(rcd.is_returned) AS is_returned,
        'REPLACEMENT' AS cheque_source,
        (
            SELECT COALESCE(MIN(cr2.is_settled), 0)
            FROM cheque_returns cr2
            WHERE cr2.id IN (
                SELECT start_return_id FROM return_chain
                WHERE cheque_detail_id IN (
                    SELECT rc2.cheque_detail_id
                    FROM return_chain rc2
                    JOIN cheque_return_payments crp2 ON crp2.cheque_return_id = rc2.start_return_id
                    WHERE crp2.id IN (
                        SELECT return_payment_id FROM cheque_return_cheque_details
                        WHERE cheque_number = rcd.cheque_number
                        AND account_id = rcd.account_id
                        AND DATE(\`date\`) = DATE(rcd.date)
                    )
                )
            )
        ) AS is_settled,
        cu.name AS customer_name,
        'REDEPOSITED' AS tag
    FROM cheque_return_cheque_details rcd
    JOIN cheque_return_payments crp ON crp.id = rcd.return_payment_id
    LEFT JOIN bankAccounts ba ON ba.id = rcd.account_id
    LEFT JOIN customers cu ON cu.id = ba.customer_id
    WHERE DATE(rcd.date) = DATE(?)
    AND NOT EXISTS (
        SELECT 1 FROM redeposited_replacements rr
        WHERE rr.rcd_id = rcd.id
    )
    GROUP BY rcd.account_id, rcd.cheque_number, DATE(rcd.date)
) AS t
ORDER BY DATE(t.\`date\`) DESC
LIMIT ? OFFSET ?
`,
      [date, date, Number(limit), Number(offset)]
    );

    return r.map((row) => ({
      id: row[0],
      cheque_number: row[1],
      account_id: row[2],
      amount: row[3],
      date: row[4],
      is_returned: row[5],
      cheque_source: row[6],
      is_settled: row[7],
      customer_name: row[8],
      tag: row[9],
    }));
  }

  async filterChequesByDateCount(date) {
    const r = await rows(
      pool,
      `
WITH
redeposited_originals AS (
    SELECT DISTINCT cd.id AS cheque_detail_id
    FROM chequeDetails cd
    JOIN cheque_returns cr ON cr.cheque_detail_id = cd.id
    JOIN cheque_return_payments crp ON crp.cheque_return_id = cr.id
    WHERE crp.payment_type = 'CHEQUE'
),
redeposited_replacements AS (
    SELECT DISTINCT rcd.id AS rcd_id
    FROM cheque_return_cheque_details rcd
    JOIN cheque_returns cr ON cr.parent_return_payment_id = rcd.return_payment_id
    JOIN cheque_return_payments crp ON crp.cheque_return_id = cr.id
    WHERE crp.payment_type = 'CHEQUE'
)
SELECT COUNT(*) FROM (
    -- ORIGINAL cheques (exclude redeposited)
    SELECT c.account_id, c.cheque_number
    FROM chequeDetails c
    WHERE DATE(c.date) = DATE(?)
    AND NOT EXISTS (
        SELECT 1 FROM redeposited_originals ro
        WHERE ro.cheque_detail_id = c.id
    )
    GROUP BY c.account_id, c.cheque_number

    UNION ALL

    -- REPLACEMENT cheques (exclude ones redeposited again)
    SELECT rcd.account_id, rcd.cheque_number
    FROM cheque_return_cheque_details rcd
    WHERE DATE(rcd.date) = DATE(?)
    AND NOT EXISTS (
        SELECT 1 FROM redeposited_replacements rr
        WHERE rr.rcd_id = rcd.id
    )
    GROUP BY rcd.account_id, rcd.cheque_number
) AS t
`,
      [date, date]
    );
    if (r.length) return r[0][0];
    return 0;
  }

  // ------------------------------------------------------------------ totals / reports

  async getTotalDue() {
    const r = await rows(pool, `SELECT IFNULL(SUM(balance),0) FROM invoices WHERE balance > 0`);
    if (r.length) return r[0][0];
    return 0;
  }

  async getTotalByRep(repId) {
    const r = await rows(pool, `SELECT IFNULL(SUM(balance),0) FROM invoices WHERE rep_id = ?`, [repId]);
    if (r.length) return r[0][0];
    return 0;
  }

  async getTodayTotalByRep(repId) {
    const r = await rows(
      pool,
      `SELECT IFNULL(SUM(amount),0) FROM invoices WHERE rep_id = ? AND DATE(created_at) = CURDATE()`,
      [repId]
    );
    if (r.length) return r[0][0];
    return 0;
  }

  async getTodayDetailByRepId(repId) {
    const r = await rows(
      pool,
      `SELECT IFNULL(SUM(CASE WHEN payment_method = 'CASH' THEN payments.amount ELSE 0 END), 0) AS cash,
    IFNULL(SUM(CASE WHEN payment_method = 'CHEQUE' THEN payments.amount ELSE 0 END), 0) AS cheque FROM payments LEFT JOIN invoices ON payments.invoice_id = invoices.invoice_id WHERE rep_id = ? AND DATE(payDate) = CURDATE()`,
      [repId]
    );
    if (r.length) {
      return { cash: r[0][0], cheque: r[0][1] };
    }
    return { cash: 0, cheque: 0 };
  }

  // NOTE: db_functions.py defined deleteCustomer twice. In Python the LAST definition wins,
  // so this is the later one (refuses to delete when the customer has invoices). See bottom.
  async deleteCustomer(customer_id) {
    try {
      const check = await rows(pool, `SELECT COUNT(*) FROM invoices WHERE customer_id = ?`, [customer_id]);
      if (!check.length) return false;
      if (check[0][0] > 0) return false;

      await run(pool, 'DELETE FROM customers WHERE id = ?', [customer_id]);
      return true;
    } catch (e) {
      return false;
    }
  }

  async deleteInvoice(invoiceId) {
    await run(pool, `DELETE FROM invoices WHERE invoice_id = ?`, [invoiceId]);
    return true;
  }

  async get_invoices_for_export() {
    // Query 1: rows
    const r = await rows(
      pool,
      `SELECT invoice_code, amount, balance, created_at
       FROM invoices
       WHERE balance > 0
       ORDER BY created_at DESC`
    );
    const invoices = r.map((row) => ({
      invoice_code: row[0],
      amount: row[1],
      balance: row[2],
      created_at: row[3],
    }));

    // Query 2: totals
    const t = await rows(
      pool,
      `SELECT IFNULL(SUM(amount), 0), IFNULL(SUM(balance), 0)
       FROM invoices
       WHERE balance > 0`
    );
    let total_amount = 0.0;
    let total_balance = 0.0;
    if (t.length) {
      total_amount = Number(t[0][0]);
      total_balance = Number(t[0][1]);
    }

    return { invoices, total_amount, total_balance };
  }

  async getThisMonthTotal() {
    const r = await rows(
      pool,
      `SELECT
           IFNULL(SUM(amount), 0),
           IFNULL(SUM(balance), 0)
       FROM invoices
       WHERE DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')`
    );
    if (r.length) {
      return { total_amount: r[0][0], total_balance: r[0][1] };
    }
    return { total_amount: 0.0, total_balance: 0.0 };
  }

  // ------------------------------------------------------------------ addresses

  async checkAndAddAddress(address) {
    await run(pool, `INSERT IGNORE INTO addresses (address) VALUES (?)`, [address]);
    return true;
  }

  async getAddressesCount(filter_text) {
    const r = await rows(pool, `SELECT COUNT(*) FROM addresses WHERE address LIKE ? `, [`%${filter_text}%`]);
    if (r.length) return r[0][0];
    return 0;
  }

  async getAddresses(filter_text, limit, offset) {
    const r = await rows(
      pool,
      `SELECT id, address FROM addresses WHERE address LIKE ? LIMIT ? OFFSET ?`,
      [`%${filter_text}%`, Number(limit), Number(offset)]
    );
    return r.map((row) => ({ id: row[0], address: row[1] }));
  }

  async getInvoiceByFilter(filter) {
    const anytime = filter.allTime;
    const anylocation = filter.allLocations;
    const repId = filter.repId;
    const locationId = filter.locationId;
    const fromDate = filter.fromDate;
    const toDate = filter.toDate;

    let query = `
    SELECT invoice_code, amount, balance, reps.name, customers.name, address, invoices.created_at,SUM(amount) OVER() AS total_amount,
    SUM(balance) OVER() AS total_balance FROM invoices JOIN customers ON invoices.customer_id = customers.id JOIN addresses ON customers.address_id = addresses.id JOIN reps ON invoices.rep_id = reps.id WHERE invoices.rep_id =? AND balance != 0
    `;
    const conditions = [];
    const binds = [repId];
    if (!anytime) {
      conditions.push('invoices.created_at BETWEEN ? AND ?');
      binds.push(`${fromDate} 00:00:00`);
      binds.push(`${toDate} 23:59:59`);
    }

    if (!anylocation) {
      conditions.push('addresses.id = ?');
      binds.push(locationId);
    }

    if (conditions.length !== 0) {
      query = query + ' AND ' + conditions.join(' AND ');
    }
    query += ' ORDER BY invoices.created_at DESC';

    const r = await rows(pool, query, binds);

    const invoices = [];
    // In Python these were unassigned when there were no rows (it would crash); default to 0 here.
    let total_amount = 0;
    let total_balance = 0;
    for (const row of r) {
      invoices.push({
        invoice_code: row[0],
        amount: row[1],
        balance: row[2],
        rep_name: row[3],
        customer_name: row[4],
        address: row[5],
        created_at: row[6],
      });
      total_amount = row[7];
      total_balance = row[8];
    }
    const totals = { total_amount, total_balance };
    return { totals, invoices };
  }

  async get_overdue_invoices_by_rep(days, rep_id) {
    const d = Number(days);
    let r;
    try {
      r = await objs(
        pool,
        `
        SELECT
        i.invoice_id,
        i.invoice_code,
        c.name                                                  AS customer_name,
        r.name                                                  AS rep_name,
        a.address                                               AS customer_address,
        i.amount,
        i.balance,
        i.created_at,
        DATE_ADD(DATE(i.created_at), INTERVAL ? DAY)            AS due_date,
        TIMESTAMPDIFF(DAY, i.created_at, NOW())                 AS days_outstanding,

        COALESCE((
            SELECT SUM(p.amount)
            FROM payments p
            WHERE p.invoice_id = i.invoice_id
              AND p.payDate >= CAST(DATE(i.created_at) AS CHAR)
              AND p.payDate <= CAST(DATE_ADD(DATE(i.created_at), INTERVAL ? DAY) AS CHAR)
        ), 0)                                                   AS paid_within_period,

        i.amount - COALESCE((
            SELECT SUM(p.amount)
            FROM payments p
            WHERE p.invoice_id = i.invoice_id
              AND p.payDate >= CAST(DATE(i.created_at) AS CHAR)
              AND p.payDate <= CAST(DATE_ADD(DATE(i.created_at), INTERVAL ? DAY) AS CHAR)
        ), 0)                                                   AS due_at_period

    FROM invoices i
    JOIN customers c ON i.customer_id  = c.id
    JOIN reps      r ON i.rep_id       = r.id
    LEFT JOIN addresses a ON c.address_id = a.id
    WHERE i.balance > 0
      AND i.rep_id = ?
      AND TIMESTAMPDIFF(DAY, i.created_at, NOW()) >= ?
    ORDER BY days_outstanding DESC
`,
        [d, d, d, rep_id, d]
      );
    } catch (e) {
      console.error(`[DB ERROR] get_overdue_invoices_by_rep: ${e.message}`);
      return [];
    }

    return r.map((row) => ({
      invoice_id: row.invoice_id,
      invoice_code: row.invoice_code,
      customer_name: row.customer_name,
      address: row.customer_address,
      rep_name: row.rep_name,
      amount: row.amount,
      balance: row.balance,
      created_at: row.created_at,
      due_date: row.due_date,
      days_outstanding: row.days_outstanding,
      paid_within_period: row.paid_within_period, // paid up to due date
      due_at_period: row.due_at_period, // what was still owed
    }));
  }

  async getInvoiceReportByRep(repId, limit, offset, fromDate, toDate) {
    const r = await rows(
      pool,
      `SELECT invoice_id, invoice_code, amount, balance, reps.name, customers.name,
   addresses.address, invoices.created_at,
   SUM(amount) OVER() AS total_amount,
   SUM(balance) OVER() AS total_balance,
   COUNT(*) OVER() AS total_count
FROM invoices
JOIN customers ON invoices.customer_id = customers.id
JOIN reps ON invoices.rep_id = reps.id
JOIN addresses ON customers.address_id = addresses.id
WHERE invoices.rep_id = ?
  AND invoices.created_at BETWEEN ? AND ?
ORDER BY invoices.created_at DESC
LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`,
      [parseInt(repId, 10), `${fromDate} 00:00:00`, `${toDate} 23:59:59`]
    );

    const invoices = [];
    let total_amount = 0;
    let total_balance = 0;
    let total_count = 0;
    for (const row of r) {
      invoices.push({
        invoice_id: row[0],
        invoice_code: row[1],
        amount: row[2],
        balance: row[3],
        customer_name: row[5],
        address: row[6],
        created_at: row[7],
      });
      total_amount = row[8];
      total_balance = row[9];
      total_count = row[10];
    }
    const totals = { total_amount, total_balance, total_count };
    return { totals, invoices };
  }

  async deleteAddress(addressId) {
    // check if any customers are using this address
    const r = await rows(pool, 'SELECT COUNT(*) FROM customers WHERE address_id = ?', [addressId]);
    if (r.length && r[0][0] > 0) return 'in_use';

    await run(pool, 'DELETE FROM addresses WHERE id = ?', [addressId]);
    return true;
  }

  async deleteRep(repId) {
    // check if any invoices are using this rep
    const r = await rows(pool, 'SELECT COUNT(*) FROM invoices WHERE rep_id = ?', [repId]);
    if (r.length && r[0][0] > 0) return 'in_use';

    await run(pool, 'DELETE FROM reps WHERE id = ?', [repId]);
    return true;
  }

  async getRepSummary(limit, offset) {
    const r = await rows(
      pool,
      `
      SELECT reps.name,
             SUM(invoices.amount) AS total_amount,
             SUM(invoices.balance) AS total_balance,
             COUNT(*) OVER() AS total_count
      FROM invoices
      JOIN reps ON invoices.rep_id = reps.id
      GROUP BY reps.id, reps.name
      ORDER BY reps.name
      LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
      `
    );

    const out = [];
    let total_count = 0;
    for (const row of r) {
      out.push({
        rep_name: row[0],
        total_amount: row[1],
        total_balance: row[2],
      });
      total_count = row[3];
    }
    return { rows: out, total_count };
  }

  // ------------------------------------------------------------------ cheque returns

  async getUnSettledChequeReturnsByCustomer(customerId, search, limit, offset) {
    const customer_condition = customerId ? 'AND c_all.id = ?' : '';
    const search_condition = search
      ? 'AND (cd_all.cheque_number LIKE ? OR i_all.invoice_code LIKE ? OR c_all.name LIKE ?)'
      : '';

    // placeholders appear in this order: customerId, then :search three times
    const params = [];
    if (customerId) params.push(customerId);
    if (search) params.push(`%${search}%`, `%${search}%`, `%${search}%`);

    const r = await rows(
      pool,
      `
      WITH RECURSIVE return_chain(return_id, cheque_detail_id, parent_return_payment_id) AS (
          SELECT id, cheque_detail_id, parent_return_payment_id
          FROM cheque_returns

          UNION ALL

          SELECT rc.return_id, cr_parent.cheque_detail_id, cr_parent.parent_return_payment_id
          FROM return_chain rc
          JOIN cheque_return_payments crp ON rc.parent_return_payment_id = crp.id
          JOIN cheque_returns cr_parent ON crp.cheque_return_id = cr_parent.id
          WHERE rc.cheque_detail_id IS NULL
      )
      SELECT
          GROUP_CONCAT(cr.id)                                                             AS return_ids,
          cd_all.cheque_number,
          cd_all.account_id,
          SUM(cd_all.amount)                                                              AS original_amount,
          COALESCE(SUM(paid.paid_amount), 0)                                              AS paid_amount,
          SUM(cd_all.amount) - COALESCE(SUM(paid.paid_amount), 0)                        AS remaining,
          MAX(cr.returned_at)                                                             AS returned_at,
          cd_all.date                                                                     AS cheque_date,
          cd_all.source,
          GROUP_CONCAT(CONCAT(cd_all.detail_id, ':', i_all.invoice_id, ':', i_all.invoice_code)) AS cheque_invoice_map,
          c_all.name                                                                      AS customer_name
      FROM cheque_returns cr
      JOIN (
          SELECT
              cd.id           AS detail_id,
              cd.account_id,
              cd.cheque_number,
              cd.amount,
              cd.date,
              p.invoice_id,
              'ORIGINAL'      AS source,
              NULL            AS return_payment_id
          FROM chequeDetails cd
          JOIN payments p ON cd.cheque_id = p.pay_id

          UNION ALL

          SELECT
              crcd.id         AS detail_id,
              crcd.account_id,
              crcd.cheque_number,
              crcd.amount,
              crcd.date,
              p.invoice_id,
              'REPLACEMENT'   AS source,
              crcd.return_payment_id
          FROM cheque_return_cheque_details crcd
          JOIN cheque_return_payments crp2 ON crcd.return_payment_id = crp2.id
          -- use return_chain to walk back to the original chequeDetails
          JOIN return_chain rc ON crp2.cheque_return_id = rc.return_id
                              AND rc.cheque_detail_id IS NOT NULL
          JOIN chequeDetails cd2 ON rc.cheque_detail_id = cd2.id
          JOIN payments p ON cd2.cheque_id = p.pay_id
      ) cd_all ON (
          cr.cheque_detail_id = cd_all.detail_id AND cd_all.source = 'ORIGINAL'
          OR
          cr.parent_return_payment_id = cd_all.return_payment_id AND cd_all.source = 'REPLACEMENT'
      )
      JOIN invoices i_all   ON cd_all.invoice_id = i_all.invoice_id
      JOIN customers c_all  ON i_all.customer_id = c_all.id
      LEFT JOIN (
          SELECT cheque_return_id, SUM(amount) AS paid_amount
          FROM cheque_return_payments
          GROUP BY cheque_return_id
      ) paid ON paid.cheque_return_id = cr.id
      WHERE cr.is_settled = 0
      ${customer_condition}
      ${search_condition}
      GROUP BY cd_all.cheque_number, cd_all.account_id, DATE(cd_all.date)
      ORDER BY MAX(cr.returned_at) ASC
      LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
  `,
      params
    );

    const returns = [];
    for (const row of r) {
      const return_ids_raw = str(row[0]);
      const return_ids = return_ids_raw ? return_ids_raw.split(',').map((i) => parseInt(i, 10)) : [];

      const cheque_invoice_raw = str(row[9]);
      const cheque_invoice_map = {};
      if (cheque_invoice_raw) {
        for (const pair of cheque_invoice_raw.split(',')) {
          const [detail_id, invoice_id, invoice_code] = pair.split(':');
          cheque_invoice_map[parseInt(detail_id, 10)] = {
            invoice_id: parseInt(invoice_id, 10),
            invoice_code,
          };
        }
      }

      returns.push({
        return_ids,
        cheque_number: row[1],
        account_id: row[2],
        original_amount: row[3],
        paid_amount: row[4],
        remaining: row[5],
        returned_at: row[6],
        cheque_date: row[7],
        source: row[8],
        cheque_invoice_map,
        customer_name: row[10],
      });
    }
    return returns;
  }

  async getUnSettledChequeReturnsCountByCustomer(customerId, searchText) {
    let search_condition = '';
    if (searchText && searchText.trim()) {
      search_condition = 'AND cd_all.cheque_number LIKE ?';
    }

    // placeholders appear in this order: customerId, then searchText
    const params = [customerId];
    if (searchText && searchText.trim()) params.push(`%${searchText.trim()}%`);

    const r = await rows(
      pool,
      `
      WITH RECURSIVE return_chain(start_return_id, cheque_detail_id, parent_return_payment_id) AS (
          SELECT id, cheque_detail_id, parent_return_payment_id
          FROM cheque_returns
          UNION ALL
          SELECT rc.start_return_id, cr_parent.cheque_detail_id, cr_parent.parent_return_payment_id
          FROM return_chain rc
          JOIN cheque_return_payments crp ON rc.parent_return_payment_id = crp.id
          JOIN cheque_returns cr_parent ON crp.cheque_return_id = cr_parent.id
          WHERE rc.cheque_detail_id IS NULL
      ),
      resolved_chain AS (
          SELECT DISTINCT start_return_id AS return_id, cheque_detail_id
          FROM return_chain
          WHERE cheque_detail_id IS NOT NULL
      )
      SELECT COUNT(*) FROM (
          SELECT cd_all.cheque_number, cd_all.account_id, DATE(cd_all.date) AS cheque_day
          FROM cheque_returns cr
          JOIN resolved_chain rc ON cr.id = rc.return_id
          JOIN chequeDetails cd_all ON rc.cheque_detail_id = cd_all.id
          JOIN payments p ON cd_all.cheque_id = p.pay_id
          JOIN invoices i ON p.invoice_id = i.invoice_id
          JOIN customers c ON i.customer_id = c.id
          WHERE cr.is_settled = 0
          AND c.id = ?
          ${search_condition}
          GROUP BY cd_all.cheque_number, cd_all.account_id, DATE(cd_all.date)
      ) AS t
  `,
      params
    );

    if (r.length) return r[0][0];
    return 0;
  }

  /**
   * return_ids        : list of cheque_returns.id in the merged group
   * cheque_invoice_map: {detail_id: {"invoice_id": int, "invoice_code": str}}
   * account_id        : bank account for the new replacement cheque
   * chequeNumber      : new cheque number
   * newPayDate        : payment date / new cheque date
   */
  async redepositCheque(return_ids, cheque_invoice_map, account_id, chequeNumber, lastPaydate, newPayDate) {
    return withTransaction(async (conn) => {
      for (const return_id of return_ids) {
        // Step 1: Get this return's own amount and detail_id
        const { amount, detail_id } = await this._getReturnAmountDetail(conn, return_id);

        // Step 2: Resolve invoice_id from cheque_invoice_map
        if (!hasEntry(cheque_invoice_map, detail_id)) {
          throw new Error(`detail_id ${detail_id} not found in cheque_invoice_map`);
        }
        const invoice_id = cheque_invoice_map[detail_id].invoice_id;

        // Step 3: Check invoice balance won't go negative
        const bal = await rows(conn, 'SELECT balance FROM invoices WHERE invoice_id = ?', [invoice_id]);
        if (!bal.length) throw new Error(`Invoice ${invoice_id} not found`);
        const current_balance = bal[0][0];
        if (current_balance - amount < 0) {
          throw new Error(
            `Payment exceeds invoice balance for invoice ${invoice_id}. ` +
              `Balance: ${current_balance}, attempted: ${amount}`
          );
        }

        // Step 4: Insert cheque_return_payments
        const ins = await run(
          conn,
          `INSERT INTO cheque_return_payments (cheque_return_id, amount, payment_type, pay_date)
           VALUES (?, ?, 'CHEQUE', ?)`,
          [return_id, amount, newPayDate]
        );
        const return_payment_id = ins.insertId;

        // Step 5: Insert cheque_return_cheque_details
        await run(
          conn,
          `INSERT INTO cheque_return_cheque_details
               (return_payment_id, cheque_number, account_id, amount, date)
           VALUES (?, ?, ?, ?, ?)`,
          [return_payment_id, chequeNumber, account_id, amount, newPayDate]
        );

        // Step 6: Decrement invoice balance
        await run(conn, 'UPDATE invoices SET balance = balance - ? WHERE invoice_id = ?', [amount, invoice_id]);

        // Step 7: Check if this individual return is now fully settled
        await this._settleIfPaid(conn, return_id);
      }
      return true;
    });
  }

  // ------------------------------------------------------------------ bank accounts

  // new implementation
  async add_bank_account(bank_code, account_number, customer_id) {
    await run(
      pool,
      `INSERT INTO bankAccounts (bank_code,account_number,customer_id)
       VALUES (?,?,?)`,
      [bank_code, account_number, customer_id]
    );
    return true;
  }

  async get_bank_accounts(customerId) {
    const r = await rows(
      pool,
      `SELECT id,bank_code,account_number FROM bankAccounts
       WHERE customer_id = ?`,
      [customerId]
    );
    return r.map((row) => ({ id: row[0], bank_code: row[1], account_number: row[2] }));
  }

  /**
   * cheque_type        : 'ORIGINAL' | 'REPLACEMENT'
   * cheque_invoice_map : {detail_id: {"invoice_id": int, "invoice_code": str}}
   * Returns [ok, message] on validation/success, and false when the transaction fails (same as Python).
   */
  async payChequeReturn(cheque_type, account_id, cash_amount, pay_date, cheque_number, return_ids, cheque_invoice_map) {
    if (cheque_type !== 'ORIGINAL' && cheque_type !== 'REPLACEMENT') {
      return [false, `Invalid cheque_type: ${cheque_type}`];
    }

    try {
      return await withTransaction(async (conn) => {
        // Step 1: Collect all returns with amounts and invoice info
        const returns = [];
        for (const return_id of return_ids) {
          const { amount, detail_id } = await this._getReturnAmountDetail(conn, return_id);

          if (!hasEntry(cheque_invoice_map, detail_id)) {
            throw new Error(`detail_id ${detail_id} not found in cheque_invoice_map`);
          }

          const invoice_id = cheque_invoice_map[detail_id].invoice_id;
          returns.push({ return_id, amount, detail_id, invoice_id });
        }

        // Step 2: Validate cash_amount against total remaining balance
        const total_owed = returns.reduce((s, r) => s + r.amount, 0);

        // Subtract already-paid amounts per return
        let total_already_paid = 0;
        for (const r of returns) {
          const paid = await rows(
            conn,
            `SELECT COALESCE(SUM(amount), 0)
             FROM cheque_return_payments
             WHERE cheque_return_id = ?`,
            [r.return_id]
          );
          if (!paid.length) throw new Error(`Failed to fetch paid amount for return ${r.return_id}`);
          total_already_paid += paid[0][0];
        }

        const remaining_allowed = total_owed - total_already_paid;

        if (remaining_allowed <= 0) {
          throw new Error('This cheque is already fully settled.');
        }

        if (cash_amount > remaining_allowed) {
          throw new Error(
            `Cash amount (${cash_amount}) exceeds remaining cheque balance ` +
              `(${remaining_allowed}). Maximum allowed: ${remaining_allowed}`
          );
        }

        // Step 3: Sort smallest-first, allocate cash
        returns.sort((a, b) => a.amount - b.amount);
        let remaining = cash_amount;

        for (const item of returns) {
          if (remaining <= 0) break;

          const return_id = item.return_id;
          const invoice_id = item.invoice_id;
          const owed = item.amount;

          // How much of this return is still unpaid?
          const paid = await rows(
            conn,
            `SELECT COALESCE(SUM(amount), 0)
             FROM cheque_return_payments
             WHERE cheque_return_id = ?`,
            [return_id]
          );
          if (!paid.length) throw new Error(`Failed to fetch paid amount for return ${return_id}`);
          const already_paid = paid[0][0];
          const still_owed = owed - already_paid;

          if (still_owed <= 0) continue;

          const allocated = Math.min(still_owed, remaining);
          remaining -= allocated;

          // Check invoice balance won't go negative
          const bal = await rows(conn, 'SELECT balance FROM invoices WHERE invoice_id = ?', [invoice_id]);
          if (!bal.length) throw new Error(`Invoice ${invoice_id} not found`);
          const current_balance = bal[0][0];
          if (current_balance - allocated < 0) {
            throw new Error(
              `Cash payment exceeds invoice balance for invoice ${invoice_id}. ` +
                `Balance: ${current_balance}, attempted: ${allocated}`
            );
          }

          // Insert cheque_return_payments
          await run(
            conn,
            `INSERT INTO cheque_return_payments
                 (cheque_return_id, amount, payment_type, pay_date)
             VALUES (?, ?, 'CASH', ?)`,
            [return_id, allocated, pay_date]
          );

          // Decrement invoice balance
          await run(conn, 'UPDATE invoices SET balance = balance - ? WHERE invoice_id = ?', [allocated, invoice_id]);

          // Step 4: Check if this individual return is now fully settled
          await this._settleIfPaid(conn, return_id);
        }

        return [true, 'Payment applied successfully'];
      });
    } catch (e) {
      console.error('[payChequeReturn]', e.message);
      return false;
    }
  }

  // cheque returning with merging multiple cheques
  async filterChequesByNumber(cheque_number, limit, offset) {
    const r = await rows(
      pool,
      `
WITH RECURSIVE return_chain(start_return_id, cheque_detail_id, parent_return_payment_id) AS (
    SELECT id, cheque_detail_id, parent_return_payment_id
    FROM cheque_returns
    UNION ALL
    SELECT rc.start_return_id, cr_parent.cheque_detail_id, cr_parent.parent_return_payment_id
    FROM return_chain rc
    JOIN cheque_return_payments crp ON rc.parent_return_payment_id = crp.id
    JOIN cheque_returns cr_parent ON crp.cheque_return_id = cr_parent.id
    WHERE rc.cheque_detail_id IS NULL
),
resolved_chain AS (
    SELECT DISTINCT start_return_id AS return_id, cheque_detail_id
    FROM return_chain
    WHERE cheque_detail_id IS NOT NULL
)
SELECT * FROM (
    SELECT
        MIN(c.id) AS id,
        c.cheque_number,
        c.account_id,
        SUM(c.amount) AS amount,
        c.date,
        MAX(c.is_returned) AS is_returned,
        (
            SELECT COALESCE(MIN(cr2.is_settled), 0)
            FROM cheque_returns cr2
            WHERE cr2.id IN (
                SELECT start_return_id FROM return_chain
                WHERE cheque_detail_id IN (
                    SELECT id FROM chequeDetails
                    WHERE cheque_number = c.cheque_number
                    AND account_id = c.account_id
                    AND DATE(\`date\`) = DATE(c.date)
                )
            )
        ) AS is_settled,
        'ORIGINAL' AS cheque_source,
        GROUP_CONCAT(c.id) AS merged_ids,
        GROUP_CONCAT(CONCAT(c.id, ':', p.invoice_id, ':', i.invoice_code)) AS cheque_invoice_map,
        ba.account_number,
        ba.bank_code,
        cu.name AS customer_name
    FROM chequeDetails c
    JOIN payments p ON c.cheque_id = p.pay_id
    JOIN invoices i ON p.invoice_id = i.invoice_id
    JOIN bankAccounts ba ON c.account_id = ba.id
    LEFT JOIN customers cu ON cu.id = ba.customer_id
    WHERE c.cheque_number LIKE ?
    GROUP BY c.account_id, c.cheque_number, DATE(c.date)

    UNION ALL

    SELECT
        MIN(rcd.id) AS id,
        rcd.cheque_number,
        rcd.account_id,
        SUM(rcd.amount) AS amount,
        rcd.date,
        MAX(rcd.is_returned) AS is_returned,
        (
            SELECT COALESCE(MIN(cr2.is_settled), 0)
            FROM cheque_returns cr2
            WHERE cr2.id IN (
                SELECT start_return_id FROM return_chain
                WHERE cheque_detail_id IN (
                    SELECT rc2.cheque_detail_id
                    FROM return_chain rc2
                    JOIN cheque_return_payments crp2 ON crp2.cheque_return_id = rc2.start_return_id
                    WHERE crp2.id IN (
                        SELECT return_payment_id FROM cheque_return_cheque_details
                        WHERE cheque_number = rcd.cheque_number
                        AND account_id = rcd.account_id
                        AND DATE(\`date\`) = DATE(rcd.date)
                    )
                )
            )
        ) AS is_settled,
        'REPLACEMENT' AS cheque_source,
        GROUP_CONCAT(rcd.id) AS merged_ids,
        GROUP_CONCAT(
            CONCAT(rcd.id, ':', (
                SELECT MIN(p2.invoice_id)
                FROM cheque_return_payments crp2
                JOIN resolved_chain rc2 ON crp2.cheque_return_id = rc2.return_id
                JOIN chequeDetails cd2 ON rc2.cheque_detail_id = cd2.id
                JOIN payments p2 ON cd2.cheque_id = p2.pay_id
                WHERE crp2.id = rcd.return_payment_id
            ), ':', (
                SELECT MIN(i2.invoice_code)
                FROM cheque_return_payments crp2
                JOIN resolved_chain rc2 ON crp2.cheque_return_id = rc2.return_id
                JOIN chequeDetails cd2 ON rc2.cheque_detail_id = cd2.id
                JOIN payments p2 ON cd2.cheque_id = p2.pay_id
                JOIN invoices i2 ON p2.invoice_id = i2.invoice_id
                WHERE crp2.id = rcd.return_payment_id
            ))
        ) AS cheque_invoice_map,
        ba.account_number,
        ba.bank_code,
        cu.name AS customer_name
    FROM cheque_return_cheque_details rcd
    JOIN bankAccounts ba ON rcd.account_id = ba.id
    LEFT JOIN customers cu ON cu.id = ba.customer_id
    JOIN cheque_return_payments crp ON crp.id = rcd.return_payment_id
    WHERE rcd.cheque_number LIKE ?
    GROUP BY rcd.account_id, rcd.cheque_number, DATE(rcd.date)
) AS t
ORDER BY DATE(t.\`date\`) DESC
LIMIT ? OFFSET ?
`,
      [`${cheque_number}%`, `${cheque_number}%`, Number(limit), Number(offset)]
    );

    const cheques = [];
    for (const row of r) {
      const merged_ids_raw = str(row[8]);
      const merged_ids = merged_ids_raw ? merged_ids_raw.split(',').map((i) => parseInt(i, 10)) : [];

      const cheque_invoice_raw = str(row[9]);
      const cheque_invoice_map = {};
      if (cheque_invoice_raw) {
        for (const pair of cheque_invoice_raw.split(',')) {
          const [cheque_id, invoice_id, invoice_code] = pair.split(':');
          cheque_invoice_map[parseInt(cheque_id, 10)] = {
            invoice_id: parseInt(invoice_id, 10),
            invoice_code,
          };
        }
      }

      cheques.push({
        id: row[0],
        cheque_number: row[1],
        account_id: row[2],
        amount: row[3],
        date: row[4],
        is_returned: row[5],
        is_settled: row[6],
        cheque_source: row[7],
        merged_ids,
        cheque_invoice_map,
        account_number: row[10],
        bank_code: row[11],
        customer_name: row[12],
      });
    }
    return cheques;
  }

  async filterChequesByNumberCount(cheque_number) {
    const r = await rows(
      pool,
      `
      SELECT COUNT(*) FROM (
          SELECT c.account_id, c.cheque_number
          FROM chequeDetails c
          JOIN payments p ON c.cheque_id = p.pay_id
          WHERE c.cheque_number LIKE ?
          GROUP BY c.account_id, c.cheque_number, DATE(c.date)

          UNION ALL

          SELECT rc.account_id, rc.cheque_number
          FROM cheque_return_cheque_details rc
          WHERE rc.cheque_number LIKE ?
          GROUP BY rc.account_id, rc.cheque_number, DATE(rc.date)
      ) AS t
  `,
      [`%${cheque_number}%`, `%${cheque_number}%`]
    );
    if (r.length) return r[0][0];
    return 0;
  }

  /**
   * cheque_source      : 'ORIGINAL' or 'REPLACEMENT'
   * merged_ids         : list of chequeDetails ids (ORIGINAL) or cheque_return_cheque_details ids (REPLACEMENT)
   * cheque_invoice_map : {cheque_id: {"invoice_id": int, "invoice_code": str}}
   */
  async returnCheque(cheque_source, merged_ids, cheque_invoice_map) {
    return withTransaction(async (conn) => {
      for (const cheque_id of merged_ids) {
        const invoice_id = cheque_invoice_map[cheque_id].invoice_id;
        let amount;

        if (cheque_source === 'ORIGINAL') {
          // 1. Get cheque amount
          const a = await rows(conn, 'SELECT amount FROM chequeDetails WHERE id = ?', [cheque_id]);
          if (!a.length) throw new Error(`chequeDetails not found for id ${cheque_id}`);
          amount = a[0][0];

          // 2. Insert into cheque_returns
          await run(
            conn,
            `INSERT INTO cheque_returns (cheque_detail_id, parent_return_payment_id, is_settled)
             VALUES (?, NULL, 0)`,
            [cheque_id]
          );

          // 3. Mark chequeDetails.is_returned = 1
          await run(conn, 'UPDATE chequeDetails SET is_returned = 1 WHERE id = ?', [cheque_id]);
        } else if (cheque_source === 'REPLACEMENT') {
          // 1. Get cheque amount
          const a = await rows(conn, 'SELECT amount FROM cheque_return_cheque_details WHERE id = ?', [cheque_id]);
          if (!a.length) throw new Error(`cheque_return_cheque_details not found for id ${cheque_id}`);
          amount = a[0][0];

          // 2. Get return_payment_id directly from cheque_return_cheque_details
          //    (it IS a cheque_return_payments.id — no join needed)
          const p = await rows(conn, 'SELECT return_payment_id FROM cheque_return_cheque_details WHERE id = ?', [cheque_id]);
          if (!p.length) {
            throw new Error(`Could not resolve return_payment_id for replacement cheque ${cheque_id}`);
          }
          const parent_return_payment_id = p[0][0];

          // 3. Insert into cheque_returns linked via parent_return_payment_id
          await run(
            conn,
            `INSERT INTO cheque_returns (cheque_detail_id, parent_return_payment_id, is_settled)
             VALUES (NULL, ?, 0)`,
            [parent_return_payment_id]
          );

          // 4. Mark cheque_return_cheque_details.is_returned = 1
          await run(conn, 'UPDATE cheque_return_cheque_details SET is_returned = 1 WHERE id = ?', [cheque_id]);
        }

        // 5. Increment invoice balance by this cheque's amount
        await run(conn, 'UPDATE invoices SET balance = balance + ? WHERE invoice_id = ?', [amount, invoice_id]);
      }
      return true;
    });
  }

  /**
   * return_ids        : list of cheque_returns.id in the merged group
   * cheque_invoice_map: {detail_id: {"invoice_id": int, "invoice_code": str}}
   * account_id        : bank account for the new replacement cheque
   * chequeNumber      : new cheque number
   * payDate           : payment date (also stored as the new cheque date, as in the original)
   * new_cheque_amount : if null/undefined, uses each return's full amount (classic redeposit)
   *                     if set, allocates from pool smallest-first (settle with new cheque)
   */
  async settleWithCheque(return_ids, cheque_invoice_map, account_id, chequeNumber, payDate, newDate, new_cheque_amount = null) {
    return withTransaction(async (conn) => {
      // Step 1: Collect all returns with amounts and invoice info
      const returns = [];
      for (const return_id of return_ids) {
        const { amount, detail_id } = await this._getReturnAmountDetail(conn, return_id);

        if (!hasEntry(cheque_invoice_map, detail_id)) {
          throw new Error(`detail_id ${detail_id} not found in cheque_invoice_map`);
        }

        const invoice_id = cheque_invoice_map[detail_id].invoice_id;
        returns.push({ return_id, amount, detail_id, invoice_id });
      }

      // Step 2: Sort smallest first (matters for partial allocation)
      returns.sort((a, b) => a.amount - b.amount);

      // Step 3: Allocate
      // If new_cheque_amount is None, each return gets its full amount (redeposit mode)
      // If set, allocate from pool smallest-first (settle mode)
      let remaining = new_cheque_amount == null ? null : new_cheque_amount; // null means unlimited

      for (const item of returns) {
        if (remaining !== null && remaining <= 0) break;

        const return_id = item.return_id;
        const invoice_id = item.invoice_id;
        const owed = item.amount;
        const allocated = remaining !== null ? Math.min(owed, remaining) : owed;
        if (remaining !== null) remaining -= allocated;

        // Check invoice balance won't go negative
        const bal = await rows(conn, 'SELECT balance FROM invoices WHERE invoice_id = ?', [invoice_id]);
        if (!bal.length) throw new Error(`Invoice ${invoice_id} not found`);
        const current_balance = bal[0][0];
        if (current_balance - allocated < 0) {
          throw new Error(
            `Payment exceeds invoice balance for invoice ${invoice_id}. ` +
              `Balance: ${current_balance}, attempted: ${allocated}`
          );
        }

        // Insert cheque_return_payments
        const ins = await run(
          conn,
          `INSERT INTO cheque_return_payments
               (cheque_return_id, amount, payment_type, pay_date)
           VALUES (?, ?, 'CHEQUE', ?)`,
          [return_id, allocated, payDate]
        );
        const return_payment_id = ins.insertId;

        // Insert cheque_return_cheque_details
        await run(
          conn,
          `INSERT INTO cheque_return_cheque_details
               (return_payment_id, cheque_number, account_id, amount, date)
           VALUES (?, ?, ?, ?, ?)`,
          [return_payment_id, chequeNumber, account_id, allocated, payDate]
        );

        // Decrement invoice balance
        await run(conn, 'UPDATE invoices SET balance = balance - ? WHERE invoice_id = ?', [allocated, invoice_id]);

        // Check if this return is now fully settled
        await this._settleIfPaid(conn, return_id);
      }

      return true;
    });
  }

  /**
   * return_ids        : list of cheque_returns.id in the merged group
   * cheque_invoice_map: {detail_id: {"invoice_id": int, "invoice_code": str}}
   * stock_amount      : total stock value to allocate smallest-first
   * payDate           : payment date
   */
  async settleWithStock(return_ids, cheque_invoice_map, stock_amount, payDate) {
    return withTransaction(async (conn) => {
      // Step 1: Collect all returns with amounts and invoice info
      const returns = [];
      for (const return_id of return_ids) {
        const { amount, detail_id } = await this._getReturnAmountDetail(conn, return_id);

        if (!hasEntry(cheque_invoice_map, detail_id)) {
          throw new Error(`detail_id ${detail_id} not found in cheque_invoice_map`);
        }

        const invoice_id = cheque_invoice_map[detail_id].invoice_id;
        returns.push({ return_id, amount, detail_id, invoice_id });
      }

      // Step 2: Sort smallest first
      returns.sort((a, b) => a.amount - b.amount);

      // Step 3: Allocate stock amount across returns
      let remaining = stock_amount;

      for (const item of returns) {
        if (remaining <= 0) break;

        const return_id = item.return_id;
        const invoice_id = item.invoice_id;
        const owed = item.amount;
        const allocated = Math.min(owed, remaining);
        remaining -= allocated;

        // Check invoice balance won't go negative
        const bal = await rows(conn, 'SELECT balance FROM invoices WHERE invoice_id = ?', [invoice_id]);
        if (!bal.length) throw new Error(`Invoice ${invoice_id} not found`);
        const current_balance = bal[0][0];
        if (current_balance - allocated < 0) {
          throw new Error(
            `Stock payment exceeds invoice balance for invoice ${invoice_id}. ` +
              `Balance: ${current_balance}, attempted: ${allocated}`
          );
        }

        // Insert cheque_return_payments with STOCK_RETURN type
        await run(
          conn,
          `INSERT INTO cheque_return_payments
               (cheque_return_id, amount, payment_type, pay_date)
           VALUES (?, ?, 'STOCK_RETURN', ?)`,
          [return_id, allocated, payDate]
        );

        // Decrement invoice balance
        await run(conn, 'UPDATE invoices SET balance = balance - ? WHERE invoice_id = ?', [allocated, invoice_id]);

        // Check if this return is now fully settled
        await this._settleIfPaid(conn, return_id);
      }

      return true;
    });
  }

  async getChequeReturnPayments(return_id) {
    const r = await rows(
      pool,
      `
    WITH RECURSIVE

    payment_chain(
        payment_id,
        cheque_return_id,
        parent_payment_id,
        amount,
        payment_type,
        pay_date
    ) AS (
        -- Base: payments directly on this specific return
        SELECT
            crp.id,
            crp.cheque_return_id,
            CAST(NULL AS SIGNED),
            crp.amount,
            crp.payment_type,
            crp.pay_date
        FROM cheque_return_payments crp
        WHERE crp.cheque_return_id = ?

        UNION ALL

        -- Recurse: payments on returns triggered by replacement cheques from above
        SELECT
            crp2.id,
            crp2.cheque_return_id,
            pc.payment_id,
            crp2.amount,
            crp2.payment_type,
            crp2.pay_date
        FROM payment_chain pc
        JOIN cheque_returns cr ON cr.parent_return_payment_id = pc.payment_id
        JOIN cheque_return_payments crp2 ON crp2.cheque_return_id = cr.id
    )

    SELECT
        pc.payment_id,
        pc.cheque_return_id,
        pc.parent_payment_id,
        pc.amount,
        pc.payment_type,
        pc.pay_date,
        crcd.cheque_number      AS replacement_cheque_number,
        crcd.date               AS replacement_cheque_date,
        crcd.is_returned        AS replacement_is_returned,
        crcd.account_id         AS replacement_account_id,
        ba.account_number,
        ba.bank_code
    FROM payment_chain pc
    LEFT JOIN cheque_return_cheque_details crcd ON crcd.return_payment_id = pc.payment_id
    LEFT JOIN bankAccounts ba ON ba.id = crcd.account_id
    ORDER BY pc.pay_date ASC, pc.payment_id ASC
    `,
      [return_id]
    );

    // unchanged from original
    const nodes = new Map();
    const merge_map = new Map();

    for (const row of r) {
      const payment_id = row[0];
      const payment_type = row[4];
      const parent_id = row[2];

      if (nodes.has(payment_id)) {
        if (payment_type === 'CHEQUE') {
          const repl_acc_id = row[9];
          const merge_key = JSON.stringify([row[6], repl_acc_id]);
          const seen = merge_map.get(payment_id) || new Set();
          if (!seen.has(merge_key)) {
            nodes.get(payment_id).replacement_accounts.push({
              account_id: repl_acc_id,
              account_number: row[10],
              bank_code: row[11],
            });
            if (!merge_map.has(payment_id)) merge_map.set(payment_id, new Set());
            merge_map.get(payment_id).add(merge_key);
          }
        }
        continue;
      }

      const node = {
        payment_id,
        cheque_return_id: row[1],
        parent_payment_id: parent_id,
        amount: row[3],
        payment_type,
        pay_date: row[5],
        replacement_cheque_number: null,
        replacement_cheque_date: null,
        replacement_is_returned: null,
        replacement_accounts: [],
        child_return_payments: [],
      };

      if (payment_type === 'CHEQUE') {
        const cheque_num = row[6];
        const repl_acc_id = row[9];
        node.replacement_cheque_number = cheque_num;
        node.replacement_cheque_date = row[7];
        node.replacement_is_returned = row[8];
        node.replacement_accounts.push({
          account_id: repl_acc_id,
          account_number: row[10],
          bank_code: row[11],
        });
        merge_map.set(payment_id, new Set([JSON.stringify([cheque_num, repl_acc_id])]));
      }

      nodes.set(payment_id, node);
    }

    const roots = [];
    for (const node of nodes.values()) {
      const parent_id = node.parent_payment_id;
      if (parent_id === null || parent_id === undefined || !nodes.has(parent_id)) {
        roots.push(node);
      } else {
        nodes.get(parent_id).child_return_payments.push(node);
      }
    }

    return roots;
  }

  async deleteItem(account_id) {
    // Check if this bank account belongs to any cheque
    try {
      const check = await rows(pool, `SELECT COUNT(*) FROM chequeDetails WHERE account_id = ?`, [account_id]);
      if (!check.length) return false;

      if (check[0][0] > 0) return false;

      // Safe to delete
      await run(pool, 'DELETE FROM bankAccounts WHERE id = ?', [account_id]);
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = new DBFunctions();
module.exports.DBFunctions = DBFunctions;

/*
 * ---------------------------------------------------------------------------
 * NOTES ON WHAT CHANGED (dialect only, no logic changes)
 * ---------------------------------------------------------------------------
 * date('now','localtime')            -> CURDATE() / NOW()   (session time zone set in db.js)
 * strftime('%Y-%m', x)               -> DATE_FORMAT(x, '%Y-%m')
 * date(x, '+N days')                 -> DATE_ADD(DATE(x), INTERVAL N DAY)
 * CAST(julianday(a)-julianday(b) AS INTEGER) -> TIMESTAMPDIFF(DAY, b, a)
 * a || ':' || b                      -> CONCAT(a, ':', b)
 * INSERT OR IGNORE                   -> INSERT IGNORE
 * derived tables                     -> given an alias (MySQL requires it)
 * NULL in a recursive CTE anchor     -> CAST(NULL AS SIGNED) (MySQL would infer a bad column type)
 * QSqlQuery.lastInsertId()           -> result.insertId
 * PRAGMA foreign_keys = ON           -> not needed, InnoDB always enforces FKs
 * ensure_db_open()                   -> connection pool in db.js
 * db.transaction()/commit()/rollback()-> withTransaction() in db.js
 *
 * Python defined deleteCustomer() twice; the later one (blocks deletion if the customer has
 * invoices) is the one that was actually active, so that is the one ported.
 */
