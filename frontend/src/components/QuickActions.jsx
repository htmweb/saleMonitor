const QuickActions = () => {
  const actions = [
    { label: "Add Sales Rep", type: "primary" },
    { label: "New Customer", type: "primary" },
    { label: "Add Address", type: "primary" },
    { label: "Delete Rep", type: "danger" },
    { label: "Delete Address", type: "danger" },
    { label: "Update Customer", type: "danger" },
    { label: "Delete Customer", type: "danger" },
  ];

  return (
    <div className="card quick-actions">
      <h2 className="card-title">Quick Actions</h2>
      <div className="actions-grid">
        {actions.map((a, i) => (
          <button
            key={i}
            className={`action-btn ${a.type === "danger" ? "danger" : ""}`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default QuickActions;