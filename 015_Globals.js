"use strict";

/**
 * gitCode_Redesign - Global State Management
 * Holds singleton instances and bootstrapped registries.
 */
const globals = {
  initialized: false,
  ssMap: new Map(),           // SpreadsheetName -> SSID
  sheetInstances: {},         // longName -> Instance
  spreadsheetInstances: {},    // SSID -> Spreadsheet Object
  
  // Registry of constructor mappings
  tableMap: {}, // Dynamically populated by classes upon load
  
  // Shortcuts
  defaultSSID: CONFIG_CONSTANTS.ANCHOR_SSID,
  sheetsLongSheetName: CONFIG_CONSTANTS.SHEETS_CONFIG_NAME,
  
  // State
  activeSS: null,
  activeSSID: null,
  activeSSName: null,
  activeSheet: null,
  activeSheetName: null,
  activeLongSheetName: null,
  
  // Config Objects (Singletons)
  sheetsObj: null,
  dataTypesObj: null,
  formulasObj: null,
  dataTypesMap: new Map() // Key: longName:columnName -> Type
};

// Logger (Placeholder until full util implemented)
function myLog(level, msg, ...args) {
  if (level === "error") console.error(msg, ...args);
  else console.log(msg, ...args);
}
