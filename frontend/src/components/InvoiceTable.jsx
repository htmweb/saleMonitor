import { useState } from "react";

const InvoiceTable = ({ data }) => {
  const [page, setPage] = useState(1);
  const perPage = 5;
  const totalPages = Math.ceil(data.length / perPage);
  const visible = data.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="card table-card">
      <h2 className="card-title">Recent Invoices</h2>

      <div className="table-wrapper">
        <table className="invoice-table">
          <thead>
            <tr>
              <th>Invoice ID</th>
              <th>Customer Name</th>
              <th>Amount</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.id}</td>
                <td>{inv.customer}</td>
                <td>Rs. {inv.amount.toLocaleString()}</td>
                <td>{inv.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <span className="page-info">
          {(page - 1) * perPage + 1}–
          {Math.min(page * perPage, data.length)} of {data.length}
        </span>
        <div className="pagination">
          <button
            className="page-btn"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Back
          </button>
          <button
            className="page-btn"
            disabled={page === totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
};

export default InvoiceTable;