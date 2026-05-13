"use strict";

/**
 * gitCode_Redesign - Centralized Constants
 * All system-wide fixed values go here.
 */
const CONFIG_CONSTANTS = {
  ANCHOR_SSID: "13Uv4dP6fSnEyrU1GXvKvgKziLakeuWTjXOZiyNpFlPU", // NewAccounts SSID
  SHEETS_CONFIG_NAME: "NewAccounts_Sheets",
  DATATYPES_SHEET_NAME: "NewAccounts_DataTypes",
  FORMULAS_SHEET_NAME: "NewAccounts_NewFormulas",
  SHEETS_CONFIG_PK: "LongName",
  DATATYPES_CONFIG_PK: "TargetField",
  FORMULAS_CONFIG_PK: "TargetField",
  CORRECTIONS_SHEET_NAME: "NewAccounts_Corrections",
  CORRECTIONS_CONFIG_PK: "GlobalID",
  DEFAULT_FIRST_ROW: 2,
  DEFAULT_LABEL_ROW: 1,
  DEFAULT_TIMEZONE: "Europe/London",
  DECIMAL_PRECISION: 2,
  HASH_PREFIX: "#",
  RANGE_NAME_REGEX: /[^a-zA-Z0-9_]/g,
  USE_NATIVE_DATES_FOR_SHEET: true, // Toggle between true (Native Date) and false (ISO String)
  DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE: "AnnualSummaries_Merged",
  DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE: "AnnualSummaries_Names",
  DEFAULT_ASSET_LEDGERS: ["Ledgers_Bank", "Ledgers_Cash", "Ledgers_Assets"],
  MANDATORY_TABLE_FIELDS: ["Account", "EntryType", "FY", "Date", "Group", "Amount"],
  LEDGER_MANDATORY_SYMBOLS: ["amount", "account", "fy", "pk", "category", "entryType", "cleared"]
};

/**
 * Symbolic Column Mapping
 * Keys are symbolic field names used in logic.
 * Values are literal column headers in the Google Sheet.
 * Indexed by the Long Name of the table.
 */
const TABLE_COLUMN_MAP = {
  "AnnualSummaries_Merged": {
    amount: "Amount",
    account: "Account",
    cleared: "Cleared",
    fy: "FY",
    balance: "Balance",
    lastBalance: "LastBalance",
    pk: "PK",
    category: "Category",
    entryType: "EntryType"
  },
  "AnnualSummaries_Names": {
    name: "Name",
    type: "Type"
  },
  "AnnualSummaries_NewReconcile": {
    pk: "PK",
    transaction: "Transaction",
    balanced: "Balanced",
    transactionFY: "TransactionFY"
  },
  "AnnualSummaries_NewMerged": {
    cleared: "Cleared",
    pk: "PK",
    fk: "FK",
    depositId: "DepositID",
    paymentId: "PaymentID",
    entryType: "EntryType",
    account: "Account",
    group: "Group"
  },
  "AnnualSummaries_NewGroups": {
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
  "NewAccounts_NewFormulas": {
    targetField: "TargetField",
    formula: "Formula"
  },
  "NewAccounts_Sheets": {
    longName: "LongName",
    keyPrefix: "KeyPrefix"
  },
  // Template for Schedule-driven generation
  "Schedules": {
    dateStart: "DateStart",
    dateEnd: "DateEnd",
    interval: "Interval",
    unit: "Unit"
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