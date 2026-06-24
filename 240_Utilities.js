"use strict";

/**
 * gitCode_Redesign - General Utilities & Factory
 * Contains the Singleton Factory and functional helpers.
 */
const Utils = (() => {

  /**
   * Spreadsheet Singleton Factory
   */
  const getSpreadsheetInstance = (ssid) => {
    if (!ssid) return null;
    if (globals.spreadsheetInstances[ssid]) return globals.spreadsheetInstances[ssid];
    
    const ss = SpreadsheetApp.openById(ssid);
    globals.spreadsheetInstances[ssid] = ss;
    return ss;
  };

  /**
   * Table Singleton Factory
   * Resolves instances based on the NewAccounts_Sheets registry.
   * @param {string} longName
   * @param {string} ssidOverride - Optional SSID to force a specific spreadsheet.
   */
  const getSheetInstance = (longName, ssidOverride = null) => {
    if (!longName) return null;
    if (typeof CONFIG_CONSTANTS !== 'undefined' && CONFIG_CONSTANTS.GLOBAL_SHEET_NAMES && CONFIG_CONSTANTS.GLOBAL_SHEET_NAMES.includes(longName)) {
      if (typeof Registry !== 'undefined' && typeof Registry.resolveGlobalSheetName === 'function') {
        longName = Registry.resolveGlobalSheetName(longName).LongName;
      }
    }
    if (globals.sheetInstances[longName]) return globals.sheetInstances[longName];

    // Read hydrated config from Registry (needed to determine Type/SSID)
    const config = Registry.getSheetConfig(longName);
    
    // Resolve SSID (Priority: Override > Config > Default)
    const ssName = config.SpreadSheetName || longName.split("_")[0];
    const ssid = ssidOverride || globals.ssMap.get(ssName) || globals.defaultSSID;
    const ss = getSpreadsheetInstance(ssid);

    // Instantiate correct Type
    const type = config.SheetType || "Table";
    const Constructor = globals.tableMap[type] || globals.tableMap['Table'];
    
    myLog("trace", "Instantiating %s as %s (SSID: %s)", longName, Constructor.name, ssid);

    // Pass the Registry config to the constructor so the table knows its Key/Properties
    const instance = new Constructor(ss, longName, config);
    globals.sheetInstances[longName] = instance;
    
    return instance;
  };

  /**
   * Resolves all source sheet instances configured for an ImportTable.
   * If a source sheet is a Union configuration sheet (e.g. NewAccounts_Union),
   * it dynamically parses its physical "Source" column to resolve the constituent sheets in order.
   */
  const getSourceSheets = (tableInstance) => {
    // 0. Explicit override via Fluent API
    const override = tableInstance._sourceOverride;
    if (override) {
      const instance = getSheetInstance(override);
      return instance ? [instance] : [];
    }

    // 1. Comma-separated list from properties (SourceSheets or SourceSheet)
    const explicitSource = tableInstance.getProperty("SourceSheets") || tableInstance.getProperty("SourceSheet");
    if (explicitSource) {
      const sourceNames = String(explicitSource).split(",").map(s => s.trim());
      return sourceNames.map(name => getSheetInstance(name)).filter(Boolean);
    }

    throw new Error(`Registry Ingestion Error: No 'SourceSheets' driver was defined for the transformation table "${tableInstance.longName}".\n\n` +
      `👉 Action Required: Open your 'NewAccounts_Sheets' configuration table and make sure the 'SourceSheets' column is populated with the correct driver sheet name(s) for "${tableInstance.longName}".`);
  };

  /**
   * Determines the primary source table (the loop driver) for an ImportTable instance.
   * Maintains backwards compatibility by returning the first source.
   */
  const getSourceSheet = (tableInstance) => {
    const sheets = getSourceSheets(tableInstance);
    return sheets.length > 0 ? sheets[0] : null;
  };

  /**
   * Cleans a string to meet Google Sheets stricter Named Range rules:
   * - Only letters, numbers, underscores.
   * - Must not start with a number.
   * - Must not be "true" or "false".
   * - Must not match A1 or R1C1 reference styles.
   */
  const cleanNameForRange = (name) => {
    if (!name) return "Unknown";
    let cleaned = String(name).replace(/[^a-zA-Z0-9_]/g, "");
    if (/^[0-9]/.test(cleaned)) cleaned = "_" + cleaned;
    if (/^(true|false)$/i.test(cleaned)) cleaned = cleaned + "_";
    if (/^[A-Za-z]+[0-9]+$/.test(cleaned) || /^R[0-9]+C[0-9]+$/i.test(cleaned)) {
      cleaned = cleaned + "_";
    }
    return cleaned;
  };

  /**
   * Displays a UI Toast notification when a table begins importing.
   * Extracts the source sheet dynamically and logs the execution start.
   * 
   * @param {Table} tableInstance - The target table running the import.
   * @param {string} methodOverride - The persistence mode (e.g. 'replace', 'update').
   */
  const displayStartToast = (tableInstance, methodOverride = null) => {
    let sourceName = "N/A";
    try {
      const src = getSourceSheet(tableInstance);
      if (src) sourceName = src.longName || src.sheetName || "N/A";
    } catch (e) {
      // Safe bypass if no source exists (e.g. standalone tables)
    }

    if (sourceName === "N/A" && tableInstance.getProperty("sheettype") === "FileTable") {
      sourceName = tableInstance.getProperty("FolderId") || tableInstance.getProperty("FileId") || "Google Drive Folder";
    }

    const method = methodOverride || tableInstance.getProperty("importmethod") || "replace";
    const startMsg = `Source: ${sourceName}\nMethod: ${method}`;
    const startTitle = `🔄 Importing ${tableInstance.longName}...`;
    
    myLog("info", `\n============================================================\n🔄 IMPORT START: ${tableInstance.longName}\n   Source: ${sourceName}\n   Method: ${method}\n============================================================`);
    
    try {
      SpreadsheetApp.getActive().toast(startMsg, startTitle, 10);
    } catch (e) {
      myLog("warn", "Failed to display start toast: %s", e.message);
    }
  };

  /**
   * Displays a UI Toast notification when a table finishes importing.
   * Parses the execution stats to provide a clear summary of changes.
   * 
   * @param {Table} tableInstance - The target table that just finished.
   * @param {Object} stats - The persistence statistics {added, updated, deleted, mode}.
   * @param {string} methodOverride - The persistence mode.
   */
  const displayFinishToast = (tableInstance, stats, methodOverride = null) => {
    let finishMsg = "No changes (Up to date)";
    if (stats) {
      const modeStr = String(stats.mode || methodOverride || tableInstance.getProperty("importmethod") || "replace").toLowerCase();
      if (modeStr === "replace" || modeStr === "replacerows" || (stats.added > 0 && stats.updated === 0 && stats.deleted === 0)) {
        finishMsg = `Replaced: ${stats.added || 0} rows`;
      } else {
        const parts = [];
        if (stats.added) parts.push(`Added: ${stats.added}`);
        if (stats.updated) parts.push(`Updated: ${stats.updated}`);
        if (stats.deleted) parts.push(`Deleted: ${stats.deleted}`);
        finishMsg = parts.length ? parts.join(", ") : "No changes (Up to date)";
      }
    }
    const finishTitle = `✅ Complete: ${tableInstance.longName}`;
    
    myLog("info", `\n============================================================\n✅ IMPORT COMPLETE: ${tableInstance.longName}\n   Status: ${finishMsg}\n============================================================`);
    
    try {
      SpreadsheetApp.getActive().toast(finishMsg, finishTitle, 5);
    } catch (e) {
      myLog("warn", "Failed to display finish toast: %s", e.message);
    }
  };

  return {
    getSpreadsheetInstance,
    getSheetInstance,
    getSourceSheets,
    getSourceSheet,
    cleanNameForRange,
    displayStartToast,
    displayFinishToast
  };
})();


// Assign to global scope for easier access
const getSheetInstance = Utils.getSheetInstance;
const getSpreadsheetInstance = Utils.getSpreadsheetInstance;
