const SummaryCard = () => {
  const stats = [
    { label: "Total Income", value: "Rs. 27,500" },
    { label: "Number of Invoices", value: "300" },
    { label: "Total Invoice Amount", value: "Rs. 520,000" },
  ];

  return (
    <div className="card">
      <h2 className="card-title">Today's Summary</h2>
      <div className="stat-list">
        {stats.map((s, i) => (
          <div className="stat-row" key={i}>
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SummaryCard;