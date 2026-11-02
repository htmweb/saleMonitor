// db.js — MySQL (AWS RDS) connection pool + helpers
// npm i mysql2 dotenv
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

// The old SQLite code used date('now','localtime'). RDS runs in UTC, so we pin every
// connection's session time zone to your local offset so CURDATE()/NOW() mean the same thing.
const TZ_OFFSET = process.env.DB_TIMEZONE || '+05:30'; // Sri Lanka

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  charset: 'utf8mb4_unicode_ci', // matches schema.sql collation
  dateStrings: true,             // DATETIME comes back as 'YYYY-MM-DD HH:MM:SS' strings, like SQLite did
  decimalNumbers: true,          // SUM() returns DECIMAL in MySQL -> give JS numbers, like SQLite did
  ssl: process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA) } : undefined,
});

// Runs on every new pooled connection.
pool.on('connection', (conn) => {
  conn.query(
    `SET SESSION time_zone = '${TZ_OFFSET}',
       sql_mode = (SELECT REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', '')),
       group_concat_max_len = 1000000`,
    (err) => { if (err) console.error('[DB] session init failed:', err.message); }
  );
});

const clean = (params = []) => params.map((v) => (v === undefined ? null : v)); // undefined -> NULL (like Python None)

// SELECT -> array of arrays, so row[0], row[1] ... mirror query.value(0), query.value(1) ...
async function rows(conn, sql, params = []) {
  const [r] = await conn.query({ sql, rowsAsArray: true }, clean(params));
  return r;
}

// SELECT -> array of objects (used where the Python code read columns by name)
async function objs(conn, sql, params = []) {
  const [r] = await conn.query(sql, clean(params));
  return r;
}

// INSERT / UPDATE / DELETE -> ResultSetHeader (insertId, affectedRows)
async function run(conn, sql, params = []) {
  const [res] = await conn.query(sql, clean(params));
  return res;
}

// Equivalent of db.transaction() ... db.commit() / db.rollback()
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, rows, objs, run, withTransaction };
