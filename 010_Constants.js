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
  CLEAN_NAME_REGEX: /[^\w\s-:]/gi, // Added colon to safe list
  RANGE_NAME_REGEX: /[^a-zA-Z0-9_]/g,
  USE_NATIVE_DATES_FOR_SHEET: true, // Toggle between true (Native Date) and false (ISO String)
  DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE: "AnnualSummaries_Merged",
  DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE: "AnnualSummaries_Names"
};