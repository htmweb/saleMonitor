import { useState } from "react";
import SummaryCard from "../components/SummaryCard";
import PaymentsCard from "../components/PaymentsCard";
import QuickActions from "../components/QuickActions";
import InvoiceTable from "../components/InvoiceTable";
import "../css/Dashboard.css";

const Dashboard = () => {
  const [invoices] = useState([
    { id: "INV-001", customer: "John Doe", amount: 45000, date: "2024-06-01" },
    { id: "INV-002", customer: "Jane Smith", amount: 27500, date: "2024-06-01" },
    { id: "INV-003", customer: "Acme Corp", amount: 90000, date: "2024-05-31" },
    { id: "INV-004", customer: "Beta Ltd", amount: 12000, date: "2024-05-31" },
    { id: "INV-005", customer: "Gamma Inc", amount: 67000, date: "2024-05-30" },
    { id: "INV-006", customer: "Delta Co", amount: 34000, date: "2024-05-30" },
    { id: "INV-007", customer: "Omega LLC", amount: 88000, date: "2024-05-29" },
  ]);

  return (
    <main className="dashboard">
      <div className="dashboard-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Overview of your daily sales activity</p>
      </div>

      <div className="stats-grid">
        <SummaryCard />
        <PaymentsCard />
      </div>

      <QuickActions />

      <InvoiceTable data={invoices} />
    </main>
  );
};

export default Dashboard;