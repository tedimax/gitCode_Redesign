"use strict";

/**
 * gitCode_Redesign - Entry Points
 * Primary execution layer for financial operations.
 * Calls utilities in 008_EntryPointUtils.js for lower-level work.
 */

function testImport() {
  _importNamedSheet("Reconciliation_Merged")
}
/**
 * Entry Point: Generates unique keys for rows in the current active sheet that have populated dates but missing key entries.
 */
function makeKeys() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  const activeSsid = activeSheet.getParent().getId();

  myLog("trace", "Generating keys for active sheet: %s", sheetName);

  try {
    const config = Registry.getSheetConfigBySheetName(sheetName, activeSsid);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }

    const longName = config.LongName;
    const isManualOrLedger = longName.startsWith("ManualEntry_") || longName.startsWith("Ledgers_");
    if (!isManualOrLedger) {
      throw new Error(`Sheet '${sheetName}' is not a manual entry or ledger sheet. Key generation is restricted to these types.`);
    }

    const table = Utils.getSheetInstance(longName);
    if (table && typeof table.makeKeys === 'function') {
      table.makeKeys();
      myLog("trace", "Finished generating keys for %s", sheetName);
      SpreadsheetApp.getUi().alert(`Success: Finished generating keys for active sheet "${sheetName}".`);
    } else {
      myLog("warn", "Sheet %s does not support key generation.", sheetName);
    }
  } catch (e) {
    myLog("error", "Failed to generate keys: %s", e.message);
    SpreadsheetApp.getUi().alert(`Key Generation Error: ${e.message}`);
  }
}


/**
 * Entry Point: Removes identical duplicate rows from the active sheet based on their Primary Key,
 * preserving only the first occurrence.
 */
function deduplicateActiveSheet() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  const activeSsid = activeSheet.getParent().getId();

  myLog("trace", "Deduplicating active sheet: %s", sheetName);

  try {
    const config = Registry.getSheetConfigBySheetName(sheetName, activeSsid);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }

    const longName = config.LongName;
    const table = Utils.getSheetInstance(longName);
    if (table && typeof table.deduplicate === 'function') {
      const stats = table.deduplicate();

      // Log each duplicate PK to SyncAudit
      if (stats.duplicatePKs && stats.duplicatePKs.length > 0) {
        stats.duplicatePKs.forEach(pk => {
          AuditUtils.logError(longName, sheetName, "Deduplication", `Removed duplicate PK: ${pk}`, "", pk);
        });
        AuditUtils.flush();
      }

      let alertMsg = `Deduplication Complete:\n\n` +
        `• Sheet: ${sheetName}\n` +
        `• Rows Before: ${stats.beforeCount}\n` +
        `• Rows After: ${stats.afterCount}\n` +
        `• Duplicates Removed: ${stats.duplicatesRemoved}`;

      if (stats.duplicatePKs && stats.duplicatePKs.length > 0) {
        alertMsg += `\n\nDuplicate PKs:\n` + stats.duplicatePKs.map(pk => `  • ${pk}`).join('\n');
      }

      SpreadsheetApp.getUi().alert(alertMsg);
    } else {
      throw new Error(`Sheet '${sheetName}' (${longName}) does not support deduplication operations.`);
    }
  } catch (e) {
    myLog("error", "Deduplication failed: %s", e.message);
    SpreadsheetApp.getUi().alert(`Deduplication Error: ${e.message}`);
  }
}



/**
 * Entry Point: Runs the report for the current active sheet.
 */
function runActiveAnnualSheet() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();

  const yearMatch = sheetName.match(/^\d{4}$/);
  if (!yearMatch) {
    throw new Error(`Active context error: The sheet "${sheetName}" is not a valid annual report sheet.`);
  }

  const year = Number(yearMatch[0]);
  myLog("trace", "Entry Point: running active annual sheet for year %d", year);
  _runAnnualReportForYear(year);
}

/**
 * Entry Point: Imports data for the current active sheet.
 */
function importActiveSheet() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  const activeSsid = activeSheet.getParent().getId();

  myLog("trace", "Importing data for active sheet: %s", sheetName);

  try {
    const config = Registry.getSheetConfigBySheetName(sheetName, activeSsid);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }

    const table = Utils.getSheetInstance(config.LongName);
    if (table && typeof table.execute === 'function') {
      const stats = table.execute();
      myLog("trace", "Finished importing data for %s", sheetName);
    } else {
      myLog("warn", "Sheet %s does not support direct import.", sheetName);
    }
  } catch (e) {
    myLog("error", "Failed to import data: %s", e.message);
  }
}

/**
 * Entry Point: Defines Named Ranges for the current active sheet.
 */
function defineActiveSheetNamedRanges() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  const activeSsid = activeSheet.getParent().getId();

  myLog("trace", "Defining Named Ranges for active sheet: %s", sheetName);

  try {
    const config = Registry.getSheetConfigBySheetName(sheetName, activeSsid);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }

    const table = Utils.getSheetInstance(config.LongName);
    if (table) {
      table.writeNamedRanges();
      myLog("trace", "Finished defining ranges for %s", sheetName);
    }
  } catch (e) {
    myLog("error", "Failed to define ranges: %s", e.message);
  }
}

/**
 * Entry Point: Batch run for all years.
 */
function runAllAnnualReports() {
  initialize();
  const startYear = 2016;
  const now = new Date();
  const currentYear = now.getFullYear();
  // FY is labelled by its END year (e.g. Apr 2026 - Mar 2027 = FY2027)
  const endYear = (now.getMonth() >= 3) ? currentYear + 1 : currentYear;

  myLog("trace", "Entry Point: Starting batch run for all years (%d to %d)", startYear, endYear);

  for (let year = startYear; year <= endYear; year++) {
    const isFirst = (year === startYear);
    _runAnnualReportForYear(year, 2, isFirst); // Force SourceFirstRow to 2, and FullLoad on the first pass
  }

  myLog("trace", "Entry Point: Batch run complete.");
}

/**
 * Entry Point: Starts a new reconciliation process.
 */
function startReconciliation() {
  initialize();
  myLog("trace", "Trigger: Start New Reconciliation");
  const recon = _getReconciliationInstance();
  if (recon) recon.startNewReconciliation();
}

/**
 * Entry Point: Saves the reconciled entries to the master ledger.
 */
function saveReconciliation() {
  initialize();
  myLog("trace", "Trigger: Save Reconciled Entries");
  const recon = _getReconciliationInstance();
  if (recon) recon.processBalancedRows();
}

/**
 * Entry Point: Processes all sheets marked 'TRUE' in the Process column.
 */
function importPendingSheets() {
  initialize();
  Registry.refresh();
  myLog("info", "Batch: Starting import of pending sheets...");


  if (globals.sheetsObj.column.process === -1) {
    throw new Error("Registry Error: The 'Process' column is missing from the Sheets configuration.");
  }

  let count = 0;
  const batchResults = [];

  const logCumulativeSummary = () => {
    let summary = `\n======================================================\n📊 BATCH IMPORT CUMULATIVE SUMMARY\n======================================================`;
    batchResults.forEach(r => {
      if (r.success) {
        const s = r.stats;
        let details = "No changes (Up to date)";
        if (s) {
          const parts = [];
          if (s.added) parts.push(`Added: ${s.added}`);
          if (s.updated) parts.push(`Updated: ${s.updated}`);
          if (s.deleted) parts.push(`Deleted: ${s.deleted}`);
          details = parts.length ? parts.join(", ") : "No changes (Up to date)";
        }
        summary += `\n✅ ${r.longName.padEnd(35)} | SUCCESS | ${details}`;
      } else {
        summary += `\n❌ ${r.longName.padEnd(35)} | FAILED  | Error: ${r.error}`;
      }
    });
    summary += `\n======================================================\nProcessed ${count} sheets.\n======================================================`;
    myLog("trace", summary);
  };

  const pendingSheets = [];
  globals.sheetsObj.getWindow().forEach(row => {
    const longName = row[globals.sheetsObj.column.longName];
    if (!longName) return;

    const config = Registry.getSheetConfig(longName);
    if (!config) return;

    const isPending = TypeUtils.isTrue(config.Process);
    if (!isPending) return;

    let orderVal = 9999;
    if (globals.sheetsObj.column.processOrder !== -1) {
      const cellVal = row[globals.sheetsObj.column.processOrder];
      if (cellVal !== undefined && cellVal !== null && cellVal !== "") {
        const parsed = parseInt(cellVal, 10);
        if (!isNaN(parsed)) {
          orderVal = parsed;
        }
      }
    }

    pendingSheets.push({
      longName,
      config,
      order: orderVal
    });
  });

  // 1. Sort by ProcessOrder as the baseline order
  pendingSheets.sort((a, b) => a.order - b.order);

  // 2. Apply topological sort to guarantee source sheets run before target sheets
  const pendingNames = pendingSheets.map(item => item.longName);
  const sortedNames = _sortSheetsByDependency(pendingNames);

  const itemMap = new Map(pendingSheets.map(item => [item.longName, item]));
  const sortedPendingSheets = sortedNames.map(name => itemMap.get(name)).filter(Boolean);

  try {
    sortedPendingSheets.forEach(item => {
      const longName = item.longName;
      myLog("trace", "Batch: Processing pending sheet: %s (Order: %d)", longName, item.order);
      try {
        const table = Utils.getSheetInstance(longName);
        if (table && typeof table.execute === "function") {
          const stats = table.execute();

          const regRowOff = globals.sheetsObj.getRowOffset(longName);
          const physicalRow = regRowOff + globals.sheetsObj.firstDataRowIndex;
          globals.sheetsObj.sheet.getRange(physicalRow, globals.sheetsObj.column.process + 1).setValue(false);

          count++;
          batchResults.push({ longName, success: true, stats });
        }
      } catch (e) {
        batchResults.push({ longName, success: false, error: e.message });
        logCumulativeSummary();
        myLog("error", "Batch Failure: Failed to import %s. Error: %s", longName, e.message);
        SpreadsheetApp.getUi().alert(`Batch Interrupted: ${longName} failed. \n\nError: ${e.message}`);
        throw e;
      }
    });

    logCumulativeSummary();
    SpreadsheetApp.getUi().alert(`Batch Complete: Imported ${count} pending sheets.`);
  } catch (e) {
    throw e;
  }
}

/**
 * Entry Point: Sets all Process flags to FALSE (The Brake).
 * Fast batch operation.
 */
function resetPendingSheets() {
  initialize();
  myLog("trace", "Registry: Resetting all pending flags to FALSE.");

  if (globals.sheetsObj.column.process === -1) return;

  const rowCount = globals.sheetsObj.sheet.getLastRow() - globals.sheetsObj.firstDataRowIndex + 1;
  if (rowCount <= 0) return;

  const data = Array(rowCount).fill([false]);
  globals.sheetsObj.sheet.getRange(globals.sheetsObj.firstDataRowIndex, globals.sheetsObj.column.process + 1, rowCount, 1).setValues(data);

  SpreadsheetApp.getUi().alert("Success: All sheets marked as CLEAN (no pending imports).");
}

/**
 * Entry Point: Sets all Process flags to TRUE (The Accelerator).
 * Fast batch operation.
 */
function markAllDirty() {
  initialize();
  myLog("trace", "Registry: Marking runnable sheets as DIRTY.");

  if (globals.sheetsObj.column.longName === -1) {
    throw new Error("Registry Error: The 'LongName' column is missing from the Sheets configuration.");
  }

  const rows = globals.sheetsObj.getWindow();
  const rowCount = rows.length;
  if (rowCount <= 0) return;

  const data = rows.map(row => {
    const typeStr = globals.sheetsObj.column.sheetType !== -1 ? String(row[globals.sheetsObj.column.sheetType] || "").trim().toLowerCase() : "";
    const isRunnable = typeStr === "importtable" || typeStr === "generatetable" || typeStr === "filetable";
    return [isRunnable];
  });

  globals.sheetsObj.sheet.getRange(globals.sheetsObj.firstDataRowIndex, globals.sheetsObj.column.process + 1, rowCount, 1).setValues(data);

  const dirtyCount = data.filter(d => d[0] === true).length;
  SpreadsheetApp.getUi().alert(`Success: Marked ${dirtyCount} runnable sheets as DIRTY. Use 'Import Pending Sheets' to run.`);
}




/**
 * Entry Point: Sets windows for all core sheets.
 */
function setAllWindows() {
  const year = _promptForYear();
  if (year === null) return;

  initialize();
  Registry.refresh();

  if (globals.sheetsObj.column.longName === -1) {
    throw new Error("Registry Error: The 'LongName' column is missing from the Sheets configuration.");
  }

  if (globals.sheetsObj.column.deltaDate === -1) {
    throw new Error("Registry Error: The 'DeltaDate' column is missing from the Sheets configuration.");
  }

  let calculatedCount = 0;
  globals.sheetsObj.getWindow().forEach(row => {
    const longName = row[globals.sheetsObj.column.longName];
    if (longName) {
      const isWindowed = TypeUtils.isTrue(row[globals.sheetsObj.column.deltaDate]);
      if (isWindowed) {
        _calculateAndSaveWindow(longName, year);
        calculatedCount++;
      }
    }
  });

  const msg = (year === "FULL")
    ? `Finished setting windows for all ${calculatedCount} target, manual entry, and summary sheets to FULL IMPORT.`
    : `Finished setting windows for all ${calculatedCount} target, manual entry, and summary sheets for FY${year}.`;
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Entry Point: Sets all named ranges for all core logical sheets.
 */
function defineAllNamedRanges() {
  myLog("trace", "Starting batch Named Range definition...");
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => _defineNamedRangeForSheet(item.longName));
  myLog("trace", "Batch Named Range definition complete.");
}

// =========================================================================
// REPAIR MANAGER (HTML INTERFACE)
// =========================================================================

/**
 * Entry Point: Opens the Repair Manager Dialog.
 */
function showRepairManager() {
  initialize();
  const template = HtmlService.createTemplateFromFile('RepairManager');

  // Inject configuration data eagerly so client-side won't need to query them asynchronously
  template.sheetConfigsJson = JSON.stringify(getCoreSheetConfigs() || []);
  template.dependencyMapJson = JSON.stringify(getSheetDependencyMap() || {});

  // Inject the current FY window year
  /** @type {any} */ // This tells the type checker to allow any assignment
  let currentFYWindow = "FULL"; // First declaration

  try {
    currentFYWindow = getCurrentFYWindow();
  } catch (e) {
    myLog("warn", `Failed to retrieve current FY window: ${e.message}`);
  }

  template.currentFYWindow = currentFYWindow;

  const html = template.evaluate()
    .setWidth(450)
    .setHeight(620)
    .setTitle('🛠️ Repair Manager');

  SpreadsheetApp.getUi().showModalDialog(html, '🛠️ Repair Manager');
}

/**
 * Server Function: Dynamically retrieves the current active Financial Year window year.
 * Returns the 4-digit ending year convention (e.g. 2027), or "FULL" for all years.
 */
function getCurrentFYWindow() {
  initialize();

  if (globals.sheetsObj.column.deltaDate === -1 || globals.sheetsObj.column.fromFy === -1) {
    return "FULL";
  }

  globals.sheetsObj.fetchWindow();

  // Find the first sheet where DeltaDate is TRUE and FromFY has a value
  for (let idx = 0; idx < globals.sheetsObj.windowDataLength; idx++) {
    const row = globals.sheetsObj.getWindow()[idx];
    const isWindowed = TypeUtils.isTrue(row[globals.sheetsObj.column.deltaDate]);
    if (isWindowed) {
      const fromFYRaw = row[globals.sheetsObj.column.fromFy];
      if (fromFYRaw !== undefined && fromFYRaw !== null && fromFYRaw !== "") {
        let fromFY = null;
        if (fromFYRaw instanceof Date) {
          const y = fromFYRaw.getFullYear();
          const m = fromFYRaw.getMonth();
          fromFY = (m >= 3) ? y + 1 : y;
        } else if (typeof fromFYRaw === 'number') {
          fromFY = fromFYRaw;
        } else {
          const parsedNum = Number(fromFYRaw);
          if (!isNaN(parsedNum) && parsedNum > 0) {
            fromFY = parsedNum;
          } else {
            const parsedDate = new Date(fromFYRaw);
            if (!isNaN(parsedDate.getTime())) {
              const y = parsedDate.getFullYear();
              const m = parsedDate.getMonth();
              fromFY = (m >= 3) ? y + 1 : y;
            }
          }
        }
        if (fromFY !== null && !isNaN(fromFY) && fromFY > 0) {
          return fromFY;
        }
      }
    }
  }
  return "FULL";
}

/**
 * Server Function: Recalculates and updates the window offsets for all windowed sheets in the Registry.
 * @param {string|number|null} yearVal - The target year (e.g. 2027) or null/empty for all years.
 */
function updateFYWindow(yearVal) {
  initialize();
  Registry.refresh();


  if (globals.sheetsObj.column.longName === -1 || globals.sheetsObj.column.deltaDate === -1) {
    throw new Error("Registry Error: Required columns (LongName or DeltaDate) missing.");
  }

  // Clean up input
  let year;
  if (yearVal === null || yearVal === undefined || String(yearVal).trim() === "" || String(yearVal).trim().toLowerCase() === "null") {
    year = "FULL";
  } else {
    const parsed = Number(String(yearVal).trim());
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid year entered: "${yearVal}". Please enter a valid 4-digit year (e.g. 2027) or leave blank.`);
    }
    year = parsed;
  }

  let calculatedCount = 0;
  globals.sheetsObj.getWindow().forEach(row => {
    const longName = row[globals.sheetsObj.column.longName];
    if (longName) {
      const isWindowed = TypeUtils.isTrue(row[globals.sheetsObj.column.deltaDate]);
      if (isWindowed) {
        _calculateAndSaveWindow(longName, year);
        calculatedCount++;
      }
    }
  });

  // Force refresh Registry config so the rest of the application gets the new settings
  Registry.refresh();

  return {
    year: year === "FULL" ? "All Years" : String(year),
    calculatedCount: calculatedCount
  };
}

/**
 * Server Function: Returns the list of core sheets for the dialog.
 */
function getCoreSheetConfigs() {
  return CONFIG_CONSTANTS.CORE_SHEET_CONFIG
    .filter(item => !item.longName.startsWith("ManualEntry_"))
    .map(item => ({
      label: item.label,
      longName: item.longName
    }));
}

/**
 * Server Function: Returns the centralized sheet dependency map for interactive dependency tracking.
 */
function getSheetDependencyMap() {
  return CONFIG_CONSTANTS.SHEET_DEPENDENCY_MAP;
}

/**
 * Server Function: Runs repair for a single sheet, suppressing server-side alerts so the client UI handles them.
 */
function runRepairSingle(longName) {
  initialize();
  myLog("trace", "Repair: Processing single sheet %s...", longName);

  // Specialized handling for Reconcile sheet
  if (longName === "Reconciliation_NewReconcile") {
    const recon = _getReconciliationInstance();
    if (recon) {
      recon.startNewReconciliation();
    }
    return;
  }

  // Repair manager should force update mode EXCEPT for FileTable (Drive staging) and GenerateTable sheets,
  // which must always be replaced.
  const config = Registry.getSheetConfig(longName);
  const isFileTable = (config && config.SheetType === "FileTable") || longName.startsWith("ImportsArchive_File");
  const isGenerateTable = (config && config.SheetType === "GenerateTable") || longName === "Ledgers_GeneratedTransactions";
  const forceUpdate = !isFileTable && !isGenerateTable;

  _importNamedSheet(longName, forceUpdate, true); // Suppress Alerts
}

/**
 * Entry Point: Synchronizes the Setmore bookings/calendar to Google Sheet.
 */
function syncCalendar() {
  initialize();
  getSheetInstance("Keys_SetmoreBookings").sync();
}

/**
 * Entry Point: Synchronizes locks door logs from Tuya Cloud.
 */
function syncTuyaLogs() {
  initialize();
  getSheetInstance("Keys_TuyaLogs").updateLockLogs();
}

/**
 * Entry Point: Synchronizes temporary door lock PINs from Tuya Cloud.
 */
function syncTempPINS() {
  initialize();
  getSheetInstance("Keys_TuyaTempPINS").updateTemporaryPINS();
}

/**
 * Entry Point: Issues new temporary PINs for bookings.
 */
function issueTempPINs() {
  initialize();
  getSheetInstance("Keys_IssuedPINS").issueTempPINs();
}

/**
 * Entry Point: Orchestrator to update all PINs, logs, and calendar together.
 */
function updatePINSFromCalendar() {
  initialize();
  getSheetInstance("Keys_SetmoreBookings").sync();
  getSheetInstance("Keys_IssuedPINS").issueTempPINs();
  getSheetInstance("Keys_TuyaTempPINS").updateTemporaryPINS();
  getSheetInstance("Keys_TuyaLogs").updateLockLogs();
}

/**
 * Decrypts an encrypted passcode to reveal the last 8 digits of the cell number.
 * Supports single values as well as ranges (2D arrays).
 *
 * @param {string|string[][]} encryptedPIN The encrypted PIN value or range of values.
 * @return {string|string[][]} The decrypted 8-digit PIN string or range of strings.
 * @customfunction
 */
function DECODE_PIN(encryptedPIN) {
  if (encryptedPIN === null || encryptedPIN === undefined || encryptedPIN === "") {
    return "";
  }

  if (Array.isArray(encryptedPIN)) {
    // @ts-ignore
    return encryptedPIN.map(row => {
      if (Array.isArray(row)) {
        return row.map(cell => DECODE_PIN(cell));
      }
      return DECODE_PIN(row);
    });
  }

  try {
    return CryptoUtils.decrypt(String(encryptedPIN));
  } catch (e) {
    return "Error: " + e.message;
  }
}

/**
 * Entry Point: Sets the system logging level to 'All'.
 */
function setLogLevelAll() {
  _setLogLevel("All");
}

/**
 * Entry Point: Sets the system logging level to 'Trace'.
 */
function setLogLevelTrace() {
  _setLogLevel("Trace");
}

/**
 * Entry Point: Sets the system logging level to 'trace'.
 */
function setLogLeveltrace() {
  _setLogLevel("trace");
}

/**
 * Entry Point: Sets the system logging level to 'Error'.
 */
function setLogLevelError() {
  _setLogLevel("Error");
}

/**
 * Entry Point: Sets the system logging level to 'None'.
 */
function setLogLevelNone() {
  _setLogLevel("None");
}

/**
 * Helper to update script properties and display a toast confirmation.
 */
function _setLogLevel(level) {
  try {
    if (typeof PropertiesService !== 'undefined') {
      PropertiesService.getScriptProperties().setProperty("LOG_LEVEL", level);
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) {
        ss.toast(`Log level set to ${level}`, "Settings Updated");
      }
    } else {
      throw new Error("PropertiesService is not available in this context.");
    }
  } catch (e) {
    console.error("Failed to set log level: " + e.message);
  }
}

