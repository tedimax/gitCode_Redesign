"use strict";

/**
 * gitCode_Redesign - Entry Points
 * Primary execution layer for financial operations.
 * Calls utilities in 008_EntryPointUtils.js for lower-level work.
 */


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
  myLog("info", "Entry Point: running active annual sheet for year %d", year);
  _runAnnualReportForYear(year); 
}

/**
 * Entry Point: Imports data for the current active sheet.
 */
function importActiveSheet() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  
  myLog("info", "Importing data for active sheet: %s", sheetName);
  
  try {
    const config = Registry.getSheetConfigBySheetName(sheetName);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }
    
    const table = Utils.getSheetInstance(config.LongName);
    if (table && typeof table.execute === 'function') {
      const stats = table.execute();
      myLog("info", "Finished importing data for %s", sheetName);
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
  
  myLog("info", "Defining Named Ranges for active sheet: %s", sheetName);
  
  try {
    const config = Registry.getSheetConfigBySheetName(sheetName);
    if (!config) {
      throw new Error(`Sheet '${sheetName}' not found in the Registry.`);
    }
    
    const table = Utils.getSheetInstance(config.LongName);
    if (table) {
      table.writeNamedRanges();
      myLog("info", "Finished defining ranges for %s", sheetName);
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
  
  myLog("info", "Entry Point: Starting batch run for all years (%d to %d)", startYear, endYear);
  
  for (let year = startYear; year <= endYear; year++) {
    const isFirst = (year === startYear);
    _runAnnualReportForYear(year, 2, isFirst); // Force SourceFirstRow to 2, and FullLoad on the first pass
  }
  
  myLog("info", "Entry Point: Batch run complete.");
}

/**
 * Entry Point: Starts a new reconciliation process.
 */
function startReconciliation() {
  initialize();
  myLog("info", "Trigger: Start New Reconciliation");
  const recon = _getReconciliationInstance();
  if (recon) recon.startNewReconciliation();
}

/**
 * Entry Point: Clears the current reconciliation state.
 */
function clearReconciliation() {
  initialize();
  myLog("info", "Trigger: Clear Reconciliation");
  const recon = _getReconciliationInstance();
  if (recon) {
    recon.clearDataArea();
    recon.restoreFormulas();
    myLog("info", "Reconciliation sheet cleared and formulas restored.");
  }
}

/**
 * Entry Point: Saves the reconciled entries to the master ledger.
 */
function saveReconciliation() {
  initialize();
  myLog("info", "Trigger: Save Reconciled Entries");
  const recon = _getReconciliationInstance();
  if (recon) recon.processBalancedRows();
}

/**
 * Entry Point: Processes all sheets marked 'TRUE' in the Process column.
 */
function importPendingSheets() {
  initialize();
  myLog("info", "Batch: Starting import of pending sheets...");

  const sheetsTable = globals.sheetsObj;
  const cols = sheetsTable.getSymbolicOffsets();
  
  if (cols.process === -1) {
    throw new Error("Registry Error: The 'Process' column is missing from the Sheets configuration.");
  }

  const longNameCol = sheetsTable.getColOffset("LongName");
  if (longNameCol === -1) {
    throw new Error("Registry Error: The 'LongName' column is missing from the Sheets configuration.");
  }

  const processOrderCol = sheetsTable.getColOffset("ProcessOrder");
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
    myLog("info", summary);
  };

  const pendingSheets = [];
  sheetsTable.getWindow().forEach(row => {
    const longName = row[longNameCol];
    if (!longName) return;

    const config = Registry.getSheetConfig(longName);
    if (!config) return;

    const isPending = TypeUtils.isTrue(config.Process);
    if (!isPending) return;

    let orderVal = 9999;
    if (processOrderCol !== -1) {
      const cellVal = row[processOrderCol];
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

  // Sort by ProcessOrder ascending
  pendingSheets.sort((a, b) => a.order - b.order);

  try {
    pendingSheets.forEach(item => {
      const longName = item.longName;
      myLog("info", "Batch: Processing pending sheet: %s (Order: %d)", longName, item.order);
      try {
        const table = Utils.getSheetInstance(longName);
        if (table && typeof table.execute === "function") {
          const stats = table.execute();
          
          const regRowOff = sheetsTable.getRowOffset(longName);
          const physicalRow = regRowOff + sheetsTable.firstDataRowIndex;
          sheetsTable.sheet.getRange(physicalRow, cols.process + 1).setValue(false);
          
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
  myLog("info", "Registry: Resetting all pending flags to FALSE.");
  const sheetsTable = globals.sheetsObj;
  const cols = sheetsTable.getSymbolicOffsets();
  if (cols.process === -1) return;

  const rowCount = sheetsTable.sheet.getLastRow() - sheetsTable.firstDataRowIndex + 1;
  if (rowCount <= 0) return;

  const data = Array(rowCount).fill([false]);
  sheetsTable.sheet.getRange(sheetsTable.firstDataRowIndex, cols.process + 1, rowCount, 1).setValues(data);
  
  SpreadsheetApp.getUi().alert("Success: All sheets marked as CLEAN (no pending imports).");
}

/**
 * Entry Point: Sets all Process flags to TRUE (The Accelerator).
 * Fast batch operation.
 */
function markAllDirty() {
  initialize();
  myLog("info", "Registry: Marking runnable sheets as DIRTY.");
  const sheetsTable = globals.sheetsObj;
  const cols = sheetsTable.getSymbolicOffsets();
  if (cols.process === -1) return;

  const longNameCol = sheetsTable.getColOffset("LongName");
  const typeCol = sheetsTable.getColOffset("SheetType");
  if (longNameCol === -1) {
    throw new Error("Registry Error: The 'LongName' column is missing from the Sheets configuration.");
  }

  const rows = sheetsTable.getWindow();
  const rowCount = rows.length;
  if (rowCount <= 0) return;

  const data = rows.map(row => {
    const typeStr = typeCol !== -1 ? String(row[typeCol] || "").trim().toLowerCase() : "";
    const isRunnable = typeStr === "importtable" || typeStr === "generatetable" || typeStr === "filetable";
    return [isRunnable];
  });

  sheetsTable.sheet.getRange(sheetsTable.firstDataRowIndex, cols.process + 1, rowCount, 1).setValues(data);
  
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
  const sheetsTable = globals.sheetsObj;
  const longNameCol = sheetsTable.getColOffset("LongName");
  
  let calculatedCount = 0;
  if (longNameCol !== -1) {
    sheetsTable.getWindow().forEach(row => {
      const longName = row[longNameCol];
      if (longName) {
        const isWindowed = longName.startsWith("Ledgers_") 
                        || longName.startsWith("ManualEntry_")
                        || longName.startsWith("ImportsArchive_Raw")
                        || longName === "AnnualSummaries_Merged"
                        || longName === "AnnualSummaries_UnChecked"
                        || longName === "AnnualSummaries_Groups";
        if (isWindowed) {
          _calculateAndSaveWindow(longName, year);
          calculatedCount++;
        }
      }
    });
  } else {
    // Fallback if LongName column mapping is unavailable
    CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => {
      const longName = item.longName;
      const isWindowed = longName.startsWith("Ledgers_") 
                      || longName.startsWith("ManualEntry_")
                      || longName.startsWith("ImportsArchive_Raw")
                      || longName === "AnnualSummaries_Merged"
                      || longName === "AnnualSummaries_UnChecked"
                      || longName === "AnnualSummaries_Groups";
      if (isWindowed) {
        _calculateAndSaveWindow(longName, year);
        calculatedCount++;
      }
    });
  }
  
  const msg = (year === "FULL")
    ? `Finished setting windows for all ${calculatedCount} target, manual entry, and summary sheets to FULL IMPORT.`
    : `Finished setting windows for all ${calculatedCount} target, manual entry, and summary sheets for FY${year}.`;
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Entry Point: Sets all named ranges for all core logical sheets.
 */
function defineAllNamedRanges() {
  myLog("info", "Starting batch Named Range definition...");
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => _defineNamedRangeForSheet(item.longName));
  myLog("info", "Batch Named Range definition complete.");
}

// =========================================================================
// REPAIR MANAGER (HTML INTERFACE)
// =========================================================================

/**
 * Entry Point: Opens the Repair Manager Dialog.
 */
function showRepairManager() {
  const html = HtmlService.createHtmlOutputFromFile('RepairManager')
    .setWidth(450)
    .setHeight(550)
    .setTitle('🛠️ Repair Manager');
  SpreadsheetApp.getUi().showModalDialog(html, '🛠️ Repair Manager');
}

/**
 * Server Function: Returns the list of core sheets for the dialog.
 */
function getCoreSheetConfigs() {
  return CONFIG_CONSTANTS.CORE_SHEET_CONFIG.map(item => ({
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
  myLog("info", "Repair: Processing single sheet %s...", longName);
  _importNamedSheet(longName, true, true); // Force Update mode, Suppress Alerts
}
