"use strict";

/**
 * gitCode_Redesign - Global State Management
 * Holds singleton instances and bootstrapped registries.
 */
const globals = {
  initialized: false,
  enableAuditAnalysis: true,   // Global toggle to enable/disable audit sheet reporting
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

// 1. Move static maps and cache variables completely outside the function
const LOG_LEVELS = { "all": 0, "trace": 0, "debug": 1, "info": 2, "warn": 3, "error": 4, "none": 5 };
let _cachedMinLevel = null;

function myLog(level, msg, ...args) {
  // 2. THE FAST PATH
  // Attempt a blazing-fast O(1) lookup. If the exact string matches, we use it;
  // otherwise, we fall back to normalization, defaulting to 2 (info).
  const currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS[String(level).toLowerCase().trim()] ?? 2;
  
  // If we've already initialized, immediately bail if the log level is too low
  if (_cachedMinLevel !== null) {
    if (currentLevel < _cachedMinLevel) return;
  } else {
    // 3. THE INITIALIZATION PATH (Runs exactly once per script execution instance)
    let logSetting = null;
    if (typeof PropertiesService !== 'undefined') {
      try {
        logSetting = PropertiesService.getScriptProperties().getProperty("LOG_LEVEL");
      } catch (e) {
        // Suppress properties fetch errors in headless environments
      }
    }
    
    if (!logSetting) {
      logSetting = (typeof CONFIG_CONSTANTS !== 'undefined' && CONFIG_CONSTANTS.LOG_LEVEL) || "info";
    }
    
    // Set the global cache
    _cachedMinLevel = LOG_LEVELS[String(logSetting).toLowerCase().trim()] ?? 2;
    
    // Check the fast path condition for this initial run
    if (currentLevel < _cachedMinLevel) return;
  }

  // 4. THE LOGGING PATH
  if (level === "error") console.error(msg, ...args);
  else console.log(msg, ...args);
}
