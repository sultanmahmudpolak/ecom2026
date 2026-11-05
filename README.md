# StockMaster BD (স্টকমাস্টার বিডি) — Super Shop & Distribution Management System

**StockMaster BD** is an enterprise-grade Retail POS, Wholesale Distribution, Multi-Warehouse Inventory, and Financial Ledger System engineered specifically for **PHP 8.2+ and MySQL/MariaDB on cPanel Shared Hosting**.

---

## Project Folder Structure

```text
├── src/                                  # React + TypeScript Frontend Source Code
│   ├── config/api.ts                     # Single centralized PHP REST API Base URL configuration
│   ├── services/apiClient.ts             # Server REST API client with CSRF & Idempotency headers
│   ├── components/                       # 17 Business Modules (POS, Wholesale, WAC Valuation, Returns, Audit, etc.)
│   └── context/AppContext.tsx            # Server-synchronized application state
├── backend/                              # PHP 8.2+ REST API Backend (Zero Node.js dependency in production)
│   ├── api/
│   │   ├── index.php                     # Public API Entry Point
│   │   └── .htaccess                     # Apache/LiteSpeed URL routing & security protection
│   ├── config/
│   │   └── Database.php                  # PDO MySQL connection manager (loads secrets outside public_html)
│   ├── middleware/
│   │   └── SecurityMiddleware.php        # Secure session cookies, CSRF verification, session_regenerate_id(), RBAC
│   ├── validators/
│   │   └── InputValidator.php            # Server-side validation of quantities, DECIMAL money, BD phones
│   ├── repositories/
│   │   └── InventoryRepository.php       # Row-level locking (FOR UPDATE), Weighted Average Cost, Stock Ledger
│   ├── services/
│   │   └── TransactionService.php        # ACID database transactions for Sales, Purchases, Returns & Ledgers
│   └── controllers/
│       └── ApiController.php             # JSON REST API endpoint dispatcher
├── database/
│   ├── schema.sql                        # Complete MySQL/MariaDB InnoDB Schema (16 tables, Foreign Keys, Indexes)
│   └── demo_seed.sql                     # Initial Bangladeshi seed data for phpMyAdmin import
└── deployment/
    ├── cpanel_deployment_guide.md        # Step-by-step beginner guide for cPanel shared hosting
    ├── environment_configuration_example.txt # Out-of-webroot database credentials template
    └── backup_restore_guide.md           # MySQL backup & restore instructions
```

---

## 17 Implemented Business Modules

1. **Dashboard**: Real-time retail POS sales, wholesale distribution sales, gross/net profit, WAC inventory asset value, customer dues, supplier payables.
2. **Products, Categories, SKU & Barcode**: Full Bangla/English catalog with Weighted Average Cost (`avg_cost`), purchase cost, retail price, and wholesale price.
3. **Suppliers & Customers**: Complete directories with credit limits, opening balances, and live receivables/payables.
4. **Warehouses & Branches**: Multi-branch stock matrix across retail outlets, central godowns, and distribution hubs.
5. **Opening Stock & Stock Movement Ledger**: Immutable audit trail of every stock inflow and outflow (`OPENING_STOCK`, `PURCHASE_RECEIPT`, `PURCHASE_RETURN`, `POS_SALE`, `WHOLESALE_CHALLAN`, `SALE_RETURN`, `TRANSFER_IN`, `TRANSFER_OUT`, `ADJUSTMENT`).
6. **Purchase Orders & Goods Receipts (GRN)**: Automatic recalculation of Weighted Average Cost (`avg_cost`) upon receiving goods.
7. **Purchase Returns (Debit Notes)**: Reverses defective/returned supplier stock and reduces supplier payable balance via reversal records.
8. **POS & Sales Invoices**: Fast barcode scanning, split payments, idempotency protection against duplicate submissions, and 80mm thermal receipts.
9. **Sales Returns & Refunds (Credit Notes)**: Restores returned customer items to inventory and adjusts customer due or issues cash refund without deleting posted invoices.
10. **Customer Payments & Due Ledger**: Double-entry customer statement tracking invoices, returns, and due collections.
11. **Supplier Payments & Payable Ledger**: Full supplier statement tracking GRN bills, purchase returns, and payment vouchers.
12. **Wholesale Distribution & Delivery Challans**: B2B order booking with printable A4 Delivery Challan & Gate Pass.
13. **Expenses**: Categorized store and warehouse operating expenses.
14. **Inventory Valuation & Weighted Average Costing (WAC)**: Real-time item-wise WAC calculation, total cost valuation, retail valuation, and margin analysis.
15. **Reports, CSV Export & Printable Invoices**: 1-click UTF-8 CSV exports (Excel compatible with Bangla support) and thermal/A4 printouts.
16. **Users, Roles & Permissions**: Server-enforced RBAC (`super_admin`, `store_manager`, `cashier`, `distribution_mgr`, `auditor`).
17. **Audit Logs & cPanel Deployment Center**: Immutable security audit trail + interactive PHP/MySQL file inspector and downloader right inside the UI.
