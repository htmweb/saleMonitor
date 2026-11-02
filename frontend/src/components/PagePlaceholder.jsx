const PagePlaceholder = ({ title, subtitle, children }) => {
  return (
    <main className="dashboard">
      <div className="dashboard-header">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>

      <div className="card" style={{ padding: "32px", textAlign: "center" }}>
        {children || (
          <p style={{ color: "#64748b", margin: 0 }}>
            This page is under construction. Add your content here.
          </p>
        )}
      </div>
    </main>
  );
};

export default PagePlaceholder;