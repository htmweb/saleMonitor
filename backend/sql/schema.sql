SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','staff') NOT NULL DEFAULT 'staff',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS addresses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    address VARCHAR(255) NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    address_id INT NULL,
    shop_address TEXT NULL,
    mobile VARCHAR(30) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
    invoice_id INT AUTO_INCREMENT PRIMARY KEY,
    rep_id INT NOT NULL,
    customer_id INT NOT NULL,
    invoice_code VARCHAR(50) NOT NULL,
    amount BIGINT NOT NULL,
    balance BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (rep_id) REFERENCES reps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
    pay_id INT AUTO_INCREMENT PRIMARY KEY,
    invoice_id INT NOT NULL,
    amount BIGINT NOT NULL,
    payment_method VARCHAR(10) NOT NULL CHECK (payment_method IN ('CASH', 'CHEQUE')),
    payDate VARCHAR(20) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bankAccounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bank_code VARCHAR(20) NOT NULL,
    account_number VARCHAR(50) NOT NULL,
    customer_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chequeDetails (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cheque_id INT NOT NULL,
    cheque_number VARCHAR(50) NOT NULL,
    account_id INT NOT NULL,
    amount BIGINT NOT NULL,
    is_returned TINYINT(1) DEFAULT 0,
    date VARCHAR(20) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cheque_id) REFERENCES payments(pay_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES bankAccounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mark original cheque as returned + keep history
CREATE TABLE IF NOT EXISTS cheque_returns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cheque_detail_id INT NULL,                -- original chequeDetails id
    parent_return_payment_id INT NULL DEFAULT NULL,         -- if this return came from a replacement cheque
    returned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_settled TINYINT(1) DEFAULT 0,
    FOREIGN KEY (cheque_detail_id) REFERENCES chequeDetails(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_return_payment_id) REFERENCES cheque_return_payments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payments made after any cheque return (cash, stock return, or new cheque)
CREATE TABLE IF NOT EXISTS cheque_return_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cheque_return_id INT NOT NULL,
    amount BIGINT NOT NULL,
    payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('CASH', 'STOCK_RETURN', 'CHEQUE')),
    pay_date VARCHAR(20) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cheque_return_id) REFERENCES cheque_returns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- If replacement payment is a cheque, store its details here
CREATE TABLE IF NOT EXISTS cheque_return_cheque_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    return_payment_id INT NOT NULL,
    cheque_number VARCHAR(50) NOT NULL,
    account_id INT NOT NULL,
    amount BIGINT NOT NULL,
    is_returned TINYINT(1) DEFAULT 0,          -- if this replacement cheque also bounces
    date VARCHAR(20) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (return_payment_id) REFERENCES cheque_return_payments(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES bankAccounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
