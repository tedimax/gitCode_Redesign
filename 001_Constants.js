const MERGED_TABLE_NAME = "Merged";
const GLOBAL_SHEET_NAMES = ["Merged"];

const CONFIG_CONSTANTS = {
  VERSION: "v1.1.27-symbolic-20260614-1640",
  LOG_LEVEL: "info",
  GLOBAL_SHEET_NAMES: GLOBAL_SHEET_NAMES,
  ANCHOR_SSID: "13Uv4dP6fSnEyrU1GXvKvgKziLakeuWTjXOZiyNpFlPU", // NewAccounts SSID
  SHEETS_CONFIG_NAME: "NewAccounts_Sheets",
  DATATYPES_SHEET_NAME: "NewAccounts_DataTypes",
  FORMULAS_SHEET_NAME: "NewAccounts_NewFormulas",
  SHEETS_CONFIG_PK: "LongName",
  DATATYPES_CONFIG_PK: "TargetField",
  FORMULAS_CONFIG_PK: "TargetField",
  HISTORICAL_PREFIX_MAP: {
    "SqFee": "Ledgers_SquareFees",
    "SqPay": "Ledgers_SquarePayments",
    "SqDep": "Ledgers_SquareDeposits",
    "SqTx": "Ledgers_SquareTransactions",
    "Tx": "Ledgers_Transactions",
    "Bank": "Ledgers_Bank",
    "Cash": "Ledgers_Cash",
    "Asset": "Ledgers_Assets",
    "Book": "Ledgers_Bookings",
    "Transaction": "Ledgers_GeneratedTransactions",
    "Hundred": "Ledgers_GeneratedTransactions"
  },
  SHEET_CHUNK_SIZE: 500,
  CORRECTIONS_SHEET_NAME: "NewAccounts_Corrections",
  CORRECTIONS_CONFIG_PK: "GlobalID",
  DEFAULT_FIRST_ROW: 2,
  DEFAULT_LABEL_ROW: 1,
  DEFAULT_TIMEZONE: "Europe/London",
  DECIMAL_PRECISION: 2,
  FUZZY_NUMERIC_THRESHOLD: 1e-6,
  FUZZY_BALANCE_THRESHOLD: 0.03,
  HASH_PREFIX: "#",
  RANGE_NAME_REGEX: /[^a-zA-Z0-9_]/g,
  USE_NATIVE_DATES_FOR_SHEET: true, // Toggle between true (Native Date) and false (ISO String)
  DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE: MERGED_TABLE_NAME,
  MERGED_TABLE_NAME: MERGED_TABLE_NAME,
  RECONCILE_IDENTIFIER_FIELDS: ["pk", "fk", "depositId", "paymentId"],
  DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE: "AnnualSummaries_Names",
  DEFAULT_ASSET_LEDGERS: ["Ledgers_Bank", "Ledgers_Cash", "Ledgers_Assets"],
  // Definitive mapping of high-fidelity LongNames to user-friendly labels
  CORE_SHEET_CONFIG: [
    // Staging Sheets (Drive -> Spreadsheet)
    { label: "📁 File Bank", longName: "ImportsArchive_FileBank" },
    { label: "📁 File Setmore Appointments", longName: "ImportsArchive_FileSMApp" },
    { label: "📁 File Setmore Payments", longName: "ImportsArchive_FileSMPay" },
    { label: "📁 File Square Transfers", longName: "ImportsArchive_FileSQTF" },
    { label: "📁 File Square Transactions", longName: "ImportsArchive_FileSQTX" },

    // Archive Sheets (Stage -> Archive)
    { label: "📥 Raw Bank", longName: "ImportsArchive_RawBank" },
    { label: "📥 Raw Square Transfers", longName: "ImportsArchive_RawSQTF" },
    { label: "📥 Raw Square Transactions", longName: "ImportsArchive_RawSQTX" },
    { label: "📥 Raw Setmore Payments", longName: "ImportsArchive_RawSMPay" },
    { label: "📥 Raw Setmore Appointments", longName: "ImportsArchive_RawSMApp" },
    
    // Ledger Sheets
    { label: "💰 Assets", longName: "Ledgers_Assets" },
    { label: "🏦 Bank", longName: "Ledgers_Bank" },
    { label: "💵 Cash", longName: "Ledgers_Cash" },
    { label: "📝 Transactions", longName: "Ledgers_Transactions" },
    { label: "⚙️ Generated", longName: "Ledgers_GeneratedTransactions" },
    { label: "📅 Bookings", longName: "Ledgers_Bookings" },
    { label: "💳 Payments", longName: "Ledgers_BookingPayments" },
    { label: "🟦 Square Transactions", longName: "Ledgers_SquareTransactions" },
    { label: "📦 Square Deposits", longName: "Ledgers_SquareDeposits" },
    { label: "💸 Square Fees", longName: "Ledgers_SquareFees" },
    { label: "💹 Square Payments", longName: "Ledgers_SquarePayments" },
    
    // Manual Entry Sheets
    { label: "✍️ Manual Ledger", longName: "ManualEntry_Ledger" },
    { label: "✍️ Manual Holdings", longName: "ManualEntry_Holdings" },
    { label: "✍️ Manual Cashbox", longName: "ManualEntry_Cashbox" },
    
    // Summary Sheets
    { label: "🔗 Merged", longName: MERGED_TABLE_NAME },
    { label: "🔍 Unchecked", longName: "Reconciliation_UnChecked" },
    { label: "🔄 Reconcile", longName: "Reconciliation_NewReconcile" }
  ],

  // Dependency Map: When Key is imported, mark all values as Pending (Process = TRUE)
  SHEET_DEPENDENCY_MAP: {
    // Stage -> Archive Links
    "ImportsArchive_FileBank": ["ImportsArchive_RawBank"],
    "ImportsArchive_FileSMApp": ["ImportsArchive_RawSMApp"],
    "ImportsArchive_FileSMPay": ["ImportsArchive_RawSMPay"],
    "ImportsArchive_FileSQTF": ["ImportsArchive_RawSQTF"],
    "ImportsArchive_FileSQTX": ["ImportsArchive_RawSQTX"],

    // Archive -> Ledger Links
    "ImportsArchive_RawBank": ["Ledgers_Bank", MERGED_TABLE_NAME],
 
    "ImportsArchive_RawCash": ["Ledgers_Cash", MERGED_TABLE_NAME],
    "ImportsArchive_RawSQTX": ["Ledgers_SquareTransactions", "Ledgers_SquareFees", "Ledgers_SquareDeposits", MERGED_TABLE_NAME],
    "ImportsArchive_RawSQTF": ["Ledgers_SquareFees", MERGED_TABLE_NAME],
    "ImportsArchive_RawSMPay": ["Ledgers_BookingPayments", MERGED_TABLE_NAME],
    "ImportsArchive_RawSMApp": ["Ledgers_Bookings", MERGED_TABLE_NAME],
    "Ledgers_Transactions": [MERGED_TABLE_NAME],
    "Ledgers_GeneratedTransactions": [MERGED_TABLE_NAME],
    "Ledgers_Bookings": ["Ledgers_BookingPayments", MERGED_TABLE_NAME],
    "Ledgers_Assets": [MERGED_TABLE_NAME],
    "Ledgers_Bank": [MERGED_TABLE_NAME],
    "Ledgers_Cash": [MERGED_TABLE_NAME],
    "Ledgers_SquareTransactions": [MERGED_TABLE_NAME],
    "Ledgers_SquareDeposits": [MERGED_TABLE_NAME],
    "Ledgers_SquareFees": [MERGED_TABLE_NAME],
    "Ledgers_SquarePayments": [MERGED_TABLE_NAME],
    "Ledgers_BookingPayments": [MERGED_TABLE_NAME],
    
    // Merged -> Unchecked Link
    [MERGED_TABLE_NAME]: ["Reconciliation_UnChecked"],
    "Reconciliation_UnChecked": ["Reconciliation_NewReconcile"],
    
    // Manual Entry Dependencies
    "ManualEntry_Ledger": [MERGED_TABLE_NAME],
    "ManualEntry_Holdings": [MERGED_TABLE_NAME],
    "ManualEntry_Cashbox": [MERGED_TABLE_NAME]
  },

  // Fields that must not be empty in data tables (Literal Column Headers)
  MANDATORY_TABLE_FIELDS: ["PK", "Amount", "Account", "FY", "Category", "Group", "EntryType"],

  // Required symbolic mappings for the AnnualLedger fact engine
  LEDGER_MANDATORY_SYMBOLS: ["fy", "account", "amount", "cleared", "entryType", "category", "pk"],

  // Setmore / Tuya configuration defaults
  SETMORE_REFRESH_TOKEN: "r1/32d63238a2MOPtQc-CtAnlGSU1WGi4BSp0LY5oZTI76lV",
  SETMORE_PAST: -7,
  SETMORE_FUTURE: 30,
  SETMORE_STAFF_NAME: "Booking",
  TUYA_PIN_LENGTH: 8,
  ONE_DAY_IN_SECONDS: 86400,
  TWO_DAYS_IN_SECONDS_MINUS_ONE: 172799,
  TUYA_PHASES: {
    0: "Deleted",
    1: "Not synced",
    2: "Synced",
    3: "Expired",
    4: "Deleted",
    7: "To be deleted"
  }
};

/**
 * Symbolic Column Mapping
 * Keys are symbolic field names used in logic.
 * Values are literal column headers in the Google Sheet.
 * Indexed by the Long Name of the table.
 */
const TABLE_COLUMN_MAP = {
  [MERGED_TABLE_NAME]: {
    amount: "Amount",
    account: "Account",
    cleared: "Cleared",
    fy: "FY",
    balance: "Balance",
    lastBalance: "LastBalance",
    pk: "PK",
    category: "Category",
    entryType: "EntryType",
    fk: "FK",
    depositId: "DepositID",
    paymentId: "PaymentID",
    group: "Group",
    date: "Date"
  },
  "AnnualSummaries_Names": {
    name: "Name",
    type: "Type"
  },
  "Reconciliation_NewReconcile": {
    pk: "PK",
    transaction: "Transaction",
    balanced: "Balanced",
    transactionFY: "TransactionFY",
    date: "Date"
  },
  "Reconciliation_NewGroups": {
    pk: "PK",
    group: "Group",
    cleared: "Cleared",
    fy: "FY"
  },
  "Reconciliation_Groups": {
    pk: "PK",
    group: "Group",
    cleared: "Cleared",
    fy: "FY"
  },
  "AnnualSummaries_NewReconcileLog": {
    sheetName: "SheetName",
    transactionId: "TransactionId",
    groupId: "GroupId",
    clearStatus: "ClearStatus"
  },
  "NewAccounts_ReconcileLog": {
    sheetName: "SheetName",
    transactionId: "TransactionId",
    groupId: "GroupId",
    clearStatus: "ClearStatus"
  },
  "NewAccounts_NewFormulas": {
    targetField: "TargetField",
    formula: "Formula"
  },
  "NewAccounts_Sheets": {
    longName: "LongName",
    keyPrefix: "KeyPrefix",
    firstrow: "FirstRow",
    labelrow: "LabelRow",
    process: "Process" // The state-machine column for batch imports
  },
  // Definition for Schedule-driven generation
  "ManualEntry_ScheduledTransactions": {
    dateStart: "DateStart",
    dateEnd: "DateEnd",
    interval: "Interval",
    unit: "Unit"
  },
  "Keys_SetmoreBookings": {
    key: "Key",
    start: "Start",
    end: "End",
    duration: "Duration",
    email: "Email",
    comment: "Comment",
    customer: "Customer",
    encryptedPin: "EncryptedPIN"
  },
  "Keys_TemporaryBookings": {
    email: "Email",
    encryptedPin: "EncryptedPIN",
    start: "Start"
  },
  "Keys_TuyaLogs": {
    id: "id",
    updateTime: "update_time"
  },
  "Keys_TuyaTempPINS": {
    id: "id",
    effectiveTime: "effective_time",
    invalidTime: "invalid_time",
    deliveryStatus: "delivery_status",
    phase: "phase"
  },
  "Keys_IssuedPINS": {
    id: "id",
    encryptedPin: "encryptedPIN",
    name: "name",
    appointmentTime: "appointment_time",
    effectiveTime: "effective_time",
    invalidTime: "invalid_time",
    issued: "Issued"
  }
};

/**
 * Styling Constants for Financial Reports
 */
const REPORT_STYLE_CONSTANTS = {
  CURRENCY_FORMAT: '£#,##0.00;[Red]-£#,##0.00;""',
  LABEL_COLUMN_WIDTH: 280,
  DATA_COLUMN_WIDTH: 120
};

/**
 * Visual Style Definitions for Reports
 */
const REPORT_STYLE_MAP = {
  "title": { fontSize: 14, fontWeight: "bold", horizontalAlignment: "center", merge: true },
  "sectionHeader": { fontSize: 12, fontWeight: "bold", horizontalAlignment: "right" },
  "columnHeader": { fontSize: 12, fontWeight: "bold", horizontalAlignment: "right" },
  "columnHeaderLabel": { fontSize: 10, fontWeight: "normal", horizontalAlignment: "right" },
  "categoryHeader": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right" },
  "categoryValue": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right" },
  "categoryValueRed": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right", fontColor: "red" },
  "grandTotalValue": { fontWeight: "bold" },
  "grandTotalValueRed": { fontWeight: "bold", fontColor: "red" },
  "expenditureValue": { fontColor: "red" },
  "alert": { fontColor: "red", fontWeight: "bold" },
  "alertNormal": { fontColor: "red" },
  "redFont": { fontColor: "red" },
  "blackFont": { fontColor: "black" },
  "currency": { numberFormat: REPORT_STYLE_CONSTANTS.CURRENCY_FORMAT }
};

/**
 * Sheet-Level Layout Configuration
 */
const REPORT_LAYOUT = {
  COLUMN_WIDTHS: [
    { index: 1, width: 280 },
    { index: 2, width: 120, count: 3 }
  ],
  // The bulk data area formatting (relative to startRow)
  DATA_REGION: {
    rowOffset: 2,
    col: 2,
    numCols: 3,
    styleId: "currency"
  }
};

// =========================================================================
// DYNAMIC ENTRY POINT GENERATOR
// =========================================================================

/**
 * Self-Generating Entry Points.
 * This block injects the necessary global functions into the Apps Script environment
 * to satisfy the Menu's requirements without hundreds of lines of hardcoded stubs.
 */
(function(scope) {
  
  // Calculate Current Financial Year using the ENDING year convention (April 1st start).
  // e.g. May 2026 is in FY 2026-27, named as 2027.
  // e.g. Feb 2026 is in FY 2025-26, named as 2026.
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentFY = (now.getMonth() >= 3) ? currentYear + 1 : currentYear;

  // 1. Generate Annual Report Year Stubs (2016 - Present)
  for (let y = 2016; y <= currentFY; y++) {
    scope[`runYear${y}`] = function() {
      _runAnnualReportForYear(y);
    };
  }

  // 2. Generate Core Sheet Stubs (Import, Range)
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => {
    const safeName = item.longName.replace(/[^a-zA-Z0-9]/g, '');
    
    // Import Trigger
    scope[`importSheet${safeName}`] = function() {
      _importNamedSheet(item.longName, false, false, false); // Do not trigger downstream sheets for single menu imports
    };
    
    // Range Trigger
    scope[`defineSheet${safeName}`] = function() {
      _defineNamedRangeForSheet(item.longName);
    };
  });

  // 3. Generate Current Year Run Stub
  scope[`runCurrentYear`] = function() {
    _runAnnualReportForYear(currentFY);
  };

})(this);
