import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import "../css/NavBar.css";

const navLinks = [
  { name: "Dashboard", to: "/dashboard" },
  { name: "Customers", to: "/customers" },
  { name: "Sales Reps", to: "/salesreps" },
  { name: "Invoices", to: "/invoices" },
  { name: "Reports", to: "/reports" },
];

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();

  const handleSignOut = () => {
    setIsOpen(false);
    // TODO: clear auth/token here, then redirect
    navigate("/dashboard");
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <NavLink to="/dashboard" className="navbar-logo">
          <p className="title">SalesMS</p>
        </NavLink>

        <button
          className={`hamburger ${isOpen ? "open" : ""}`}
          onClick={() => setIsOpen(!isOpen)}
          aria-label="Toggle menu"
          aria-expanded={isOpen}
        >
          <span></span>
          <span></span>
          <span></span>
        </button>

        <ul className={`nav-links ${isOpen ? "open" : ""}`}>
          {navLinks.map((link) => (
            <li key={link.to}>
              <NavLink
                to={link.to}
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
                onClick={() => setIsOpen(false)}
              >
                {link.name}
              </NavLink>
            </li>
          ))}
          <li>
            <button className="nav-btn" onClick={handleSignOut}>
              Sign Out
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Navbar;