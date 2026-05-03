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
  DEFAULT_TIMEZONE: "Europe/London",
  DECIMAL_PRECISION: 2,
  HASH_PREFIX: "#",
  RANGE_NAME_REGEX: /[^a-zA-Z0-9_]/g,
  USE_NATIVE_DATES_FOR_SHEET: true, // Toggle between true (Native Date) and false (ISO String)
  DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE: "AnnualSummaries_Merged",
  DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE: "AnnualSummaries_Names",
  DEFAULT_ASSET_LEDGERS: ["Ledgers_Bank", "Ledgers_Cash", "Ledgers_Assets"]
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