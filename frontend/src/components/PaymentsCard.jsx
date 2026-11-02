const PaymentsCard = () => {
  const payments = [
    { label: "Cash Payments", value: "Rs. 200,000", color: "#16a34a" },
    { label: "Cheque Payments", value: "Rs. 40,000", color: "#2563eb" },
  ];

  return (
    <div className="card">
      <h2 className="card-title">Payments Breakdown</h2>
      <div className="stat-list">
        {payments.map((p, i) => (
          <div className="stat-row" key={i}>
            <span className="stat-label">
              <span className="dot" style={{ background: p.color }}></span>
              {p.label}
            </span>
            <span className="stat-value">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PaymentsCard;