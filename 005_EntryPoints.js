"use strict";

/**
 * gitCode_Redesign - Entry Points
 * Primary execution layer for financial operations.
 * Calls utilities in 008_EntryPointUtils.js for lower-level work.
 */


/**
 * Entry Point: Generates unique keys for rows in the current active sheet that have populated dates but missing key entries.
 */
function makeKeys() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  
  myLog("info", "Generating keys for active sheet: %s", sheetName);
  
  try {
    const config = Registry.getSheetConfigBySheetName(sheetName);
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
      myLog("info", "Finished generating keys for %s", sheetName);
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
  Registry.refresh();
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
  Registry.refresh();
  const sheetsTable = globals.sheetsObj;
  
  const longNameCol = sheetsTable.getColOffset("LongName");
  if (longNameCol === -1) {
    throw new Error("Registry Error: The 'LongName' column is missing from the Sheets configuration.");
  }
  
  const deltaDateCol = sheetsTable.getColOffset("DeltaDate");
  if (deltaDateCol === -1) {
    throw new Error("Registry Error: The 'DeltaDate' column is missing from the Sheets configuration.");
  }
  
  let calculatedCount = 0;
  sheetsTable.getWindow().forEach(row => {
    const longName = row[longNameCol];
    if (longName) {
      const isWindowed = TypeUtils.isTrue(row[deltaDateCol]);
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
  myLog("info", "Starting batch Named Range definition...");
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => _defineNamedRangeForSheet(item.longName));
  myLog("info", "Batch Named Range definition complete.");
}

/**
 * Entry Point: One-off recovery program to restore missing Group IDs to ledgers
 * and Group ID / Cleared status to the Merged sheet by matching ReconcileLog with Groups.
 */
function recoverReconciliationData() {
  initialize();
  myLog("info", "Starting Reconciliation Data Recovery...");

  // Load ReconcileLog with full load (firstrow = 2)
  const logConfig = Registry.getSheetConfig("NewAccounts_ReconcileLog");
  const logFullConfig = { ...logConfig, FirstRow: 2, firstrow: 2 };
  const logSSName = logConfig.SpreadSheetName || "NewAccounts";
  const logSSID = globals.ssMap.get(logSSName) || globals.defaultSSID;
  const ssLog = getSpreadsheetInstance(logSSID);
  const logTable = new Table(ssLog, "NewAccounts_ReconcileLog", logFullConfig);
  logTable.withoutValidation();

  // Load Groups with full load (firstrow = 2)
  const groupsConfig = Registry.getSheetConfig("AnnualSummaries_Groups");
  const groupsFullConfig = { ...groupsConfig, FirstRow: 2, firstrow: 2 };
  const groupsSSName = groupsConfig.SpreadSheetName || "AnnualSummaries";
  const groupsSSID = globals.ssMap.get(groupsSSName) || globals.defaultSSID;
  const ssGroups = getSpreadsheetInstance(groupsSSID);
  const groupsTable = new Table(ssGroups, "AnnualSummaries_Groups", groupsFullConfig);
  groupsTable.withoutValidation();

  // Load Merged table as a standard physical Table with full load (firstrow = 2)
  const config = Registry.getSheetConfig("AnnualSummaries_Merged");
  const physicalConfig = { ...config, SheetType: "Table", FirstRow: 2, firstrow: 2 };
  const ssName = config.SpreadSheetName || "AnnualSummaries";
  const ssid = globals.ssMap.get(ssName) || globals.defaultSSID;
  const ssMerged = getSpreadsheetInstance(ssid);
  const mergedTable = new Table(ssMerged, "AnnualSummaries_Merged", physicalConfig);
  mergedTable.withoutValidation();

  // Parse columns for ReconcileLog
  const logCols = logTable.getSymbolicOffsets();
  const logRows = logTable.getWindow();
  
  // Parse columns for Groups
  const groupCols = groupsTable.getSymbolicOffsets();
  const groupRows = groupsTable.getWindow();

  myLog("info", "Loaded %d log entries and %d groups.", logRows.length, groupRows.length);

  // 1. Build Groups map: PK -> GroupID (and FY)
  const groupsMap = new Map();
  groupRows.forEach((row, idx) => {
    const pk = String(row[groupCols.pk] || "").trim();
    const groupId = row[groupCols.group];
    const fy = row[groupCols.fy];
    if (pk && groupId !== undefined && groupId !== "") {
      groupsMap.set(pk.toLowerCase(), {
        pk,
        groupId: Number(groupId),
        fy: fy
      });
    }
  });

  // 2. Build Log map: PK -> GroupID (and SheetName)
  const logMap = new Map();
  logRows.forEach((row, idx) => {
    const pk = String(row[logCols.transactionId] || "").trim();
    const groupId = row[logCols.groupId];
    const sheetName = row[logCols.sheetName];
    if (pk && groupId !== undefined && groupId !== "") {
      logMap.set(pk.toLowerCase(), {
        pk,
        groupId: Number(groupId),
        sheetName
      });
    }
  });

  const ledgerInstances = {};
  const getFullLedger = (ledgerName) => {
    if (ledgerInstances[ledgerName]) return ledgerInstances[ledgerName];
    const conf = Registry.getSheetConfig(ledgerName);
    const fullConf = { ...conf, FirstRow: 2, firstrow: 2 };
    const ssN = conf.SpreadSheetName || ledgerName.split("_")[0];
    const ssId = globals.ssMap.get(ssN) || globals.defaultSSID;
    const lSS = getSpreadsheetInstance(ssId);
    const type = conf.SheetType || "Table";
    const Constructor = globals.tableMap[type] || globals.tableMap['Table'];
    const inst = new Constructor(lSS, ledgerName, fullConf);
    inst.withoutValidation();
    ledgerInstances[ledgerName] = inst;
    return inst;
  };

  let matchCount = 0;
  let ledgerUpdatesCount = 0;
  let mergedUpdatesCount = 0;
  let unresolvedLedgersCount = 0;

  // 3. Scan Groups map as the master source of truth for groupings
  groupsMap.forEach((groupEntry, pkLower) => {
    const groupId = groupEntry.groupId;
    const pk = groupEntry.pk;

    // A. Correct originating ledger
    const prefix = pk.includes('#') ? pk.split('#')[0] : "";
    let ledgerName = Registry.getLongNameByPrefix(prefix);
    
    // Fallback: Check if Reconcile Log has a different/explicit sheetName
    const logEntry = logMap.get(pkLower);
    if (!ledgerName && logEntry && logEntry.sheetName) {
      ledgerName = Registry.getLongNameByPrefix(logEntry.sheetName) || logEntry.sheetName;
    }

    if (ledgerName) {
      try {
        const ledger = getFullLedger(ledgerName);
        const rowOff = ledger.getRowOffset(pk);
        if (rowOff !== undefined) {
          const groupCol = ledger.getColOffset("Group");
          if (groupCol !== -1) {
            const physicalRow = ledger._windowStartRow + rowOff;
            const currentVal = ledger.get(rowOff, groupCol);
            if (Number(currentVal) !== groupId) {
              ledger.sheet.getRange(physicalRow, groupCol + 1).setValue(groupId);
              ledger.set(rowOff, groupCol, groupId); // update cache too
              ledgerUpdatesCount++;
              myLog("info", "Recovery: Updated Group ID to %d for PK '%s' in ledger '%s' at row %d", 
                groupId, pk, ledgerName, physicalRow);
            }
          }
        } else {
          myLog("warn", "Recovery: PK '%s' not found in ledger '%s'.", pk, ledgerName);
        }
      } catch (e) {
        myLog("error", "Recovery Error updating ledger '%s' for PK '%s': %s", ledgerName, pk, e.message);
      }
    } else {
      myLog("warn", "Recovery: Could not resolve originating ledger for PK '%s' (prefix: '%s').", pk, prefix);
      unresolvedLedgersCount++;
    }

    // B. Correct Merged table
    try {
      const rowOff = mergedTable.getRowOffset(pk);
      if (rowOff !== undefined) {
        const groupCol = mergedTable.getColOffset("Group");
        const clearedCol = mergedTable.getColOffset("Cleared");
        const physicalRow = mergedTable._windowStartRow + rowOff;
        
        let needsUpdate = false;
        if (groupCol !== -1 && Number(mergedTable.get(rowOff, groupCol)) !== groupId) {
          mergedTable.sheet.getRange(physicalRow, groupCol + 1).setValue(groupId);
          mergedTable.set(rowOff, groupCol, groupId);
          needsUpdate = true;
        }
        if (clearedCol !== -1 && !TypeUtils.isTrue(mergedTable.get(rowOff, clearedCol))) {
          mergedTable.sheet.getRange(physicalRow, clearedCol + 1).setValue(true);
          mergedTable.set(rowOff, clearedCol, true);
          needsUpdate = true;
        }

        if (needsUpdate) {
          mergedUpdatesCount++;
          myLog("info", "Recovery: Updated Merged sheet for PK '%s' to Group %d, Cleared = true at row %d", 
            pk, groupId, physicalRow);
        }
      } else {
        myLog("warn", "Recovery: PK '%s' not found in Merged sheet.", pk);
      }
    } catch (e) {
      myLog("error", "Recovery Error updating Merged table for PK '%s': %s", pk, e.message);
    }
    
    matchCount++;
  });

  myLog("info", "Reconciliation Data Recovery Complete.");
  const summary = `📊 RECOVERY SUMMARY:\n` +
                  `-------------------------\n` +
                  `✅ Groups processed: ${matchCount}\n` +
                  `⚠️ Unresolved ledger prefixes: ${unresolvedLedgersCount}\n` +
                  `✏️ Ledger updates written: ${ledgerUpdatesCount}\n` +
                  `✏️ Merged updates written: ${mergedUpdatesCount}\n` +
                  `-------------------------`;
  myLog("info", summary);
  SpreadsheetApp.getUi().alert(`Recovery Complete!\n\n${summary}`);
}

/**
 * Diagnostic Entry Point: Inspects specific PK status in Log, Groups, and Merged sheets.
 */
function debugSpecificPKs() {
  initialize();
  const targetPKs = [
    "SqFee#20260521_w0vTrWlYXvlmgjIe0mm4Wgkxkp7YY",
    "SqFee#20260521_wE3PeXSIUFpyTCTyOW2ReUvzVe9YY",
    "SqPay#20260521_w0vTrWlYXvlmgjIe0mm4Wgkxkp7YY",
    "SqPay#20260521_wE3PeXSIUFpyTCTyOW2ReUvzVe9YY",
    "Tx#20260521_6k6lx0",
    "Tx#20260521_v9dj5r"
  ];
  
  const ss = getSpreadsheetInstance(globals.defaultSSID);
  
  // 1. Check Reconcile Log
  const logTable = getSheetInstance("NewAccounts_ReconcileLog");
  logTable.withoutValidation();
  myLog("info", "--- CHECKING RECONCILE LOG ---");
  targetPKs.forEach(pk => {
    const rowOff = logTable.getRowOffset(pk);
    if (rowOff !== undefined) {
      myLog("info", "Found in ReconcileLog: PK='%s' | Row=%d | SheetName='%s' | GroupID=%s",
        pk, rowOff + logTable.firstDataRowIndex, logTable.get(rowOff, logTable.getColOffset("SheetName")), logTable.get(rowOff, logTable.getColOffset("GroupId")));
    } else {
      myLog("info", "NOT found in ReconcileLog: PK='%s'", pk);
    }
  });

  // 2. Check Groups
  const groupsTable = getSheetInstance("AnnualSummaries_Groups");
  groupsTable.withoutValidation();
  myLog("info", "--- CHECKING GROUPS SHEET ---");
  targetPKs.forEach(pk => {
    const rowOff = groupsTable.getRowOffset(pk);
    if (rowOff !== undefined) {
      myLog("info", "Found in Groups: PK='%s' | Row=%d | Group=%s",
        pk, rowOff + groupsTable.firstDataRowIndex, groupsTable.get(rowOff, groupsTable.getColOffset("Group")));
    } else {
      myLog("info", "NOT found in Groups: PK='%s'", pk);
    }
  });

  // 3. Check Merged
  const mergedTable = getSheetInstance("AnnualSummaries_Merged");
  mergedTable.withoutValidation();
  myLog("info", "--- CHECKING MERGED SHEET ---");
  targetPKs.forEach(pk => {
    const rowOff = mergedTable.getRowOffset(pk);
    if (rowOff !== undefined) {
      myLog("info", "Found in Merged: PK='%s' | Row=%d | Cleared=%s | Group=%s",
        pk, rowOff + mergedTable.firstDataRowIndex, mergedTable.get(rowOff, mergedTable.getColOffset("Cleared")), mergedTable.get(rowOff, mergedTable.getColOffset("Group")));
    } else {
      myLog("info", "NOT found in Merged: PK='%s'", pk);
    }
  });
}

// =========================================================================
// REPAIR MANAGER (HTML INTERFACE)
// =========================================================================

/**
 * Entry Point: Opens the Repair Manager Dialog.
 */
function showRepairManager() {
  const template = HtmlService.createTemplateFromFile('RepairManager');
  
  // Inject configuration data eagerly so client-side won't need to query them asynchronously
  template.sheetConfigsJson = JSON.stringify(getCoreSheetConfigs() || []);
  template.dependencyMapJson = JSON.stringify(getSheetDependencyMap() || {});
  
  const html = template.evaluate()
    .setWidth(450)
    .setHeight(550)
    .setTitle('🛠️ Repair Manager');
    
  SpreadsheetApp.getUi().showModalDialog(html, '🛠️ Repair Manager');
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
  myLog("info", "Repair: Processing single sheet %s...", longName);
  
  // Specialized handling for Reconcile sheet
  if (longName === "AnnualSummaries_NewReconcile") {
    const recon = _getReconciliationInstance();
    if (recon) {
      recon.startNewReconciliation();
    }
    return;
  }
  
  // Repair manager should force update mode EXCEPT for FileTable (Drive staging) sheets,
  // which must always be replaced.
  const config = Registry.getSheetConfig(longName);
  const isFileTable = (config && config.SheetType === "FileTable") || longName.startsWith("ImportsArchive_File");
  const forceUpdate = !isFileTable;
  
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
 * Entry Point: Sets the system logging level to 'Info'.
 */
function setLogLevelInfo() {
  _setLogLevel("Info");
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

