import { Link } from "react-router-dom";
import "../css/Dashboard.css";

const NotFound = () => (
  <main className="dashboard">
    <div className="dashboard-header">
      <h1 className="page-title">404 — Page Not Found</h1>
      <p className="page-subtitle">
        The page you're looking for doesn't exist.
      </p>
    </div>

    <div className="card" style={{ padding: "32px", textAlign: "center" }}>
      <Link
        to="/dashboard"
        style={{
          background: "#00007f",
          color: "#fff",
          padding: "10px 20px",
          borderRadius: "8px",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Go to Dashboard
      </Link>
    </div>
  </main>
);

export default NotFound;