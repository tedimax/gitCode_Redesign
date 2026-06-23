"use strict";

/**
 * gitCode_Redesign - Entry Point Utilities
 * Internal helpers for Registry orchestration, window calculation, and triggering.
 */

/**
 * Internal Helper: Resolves the active reconciliation table instance.
 */
function _getReconciliationInstance() {
  try {
    // MIGRATION ALERT: Eventually switch this from "NewReconcile" to "Reconcile"
    const longName = "Reconciliation_NewReconcile"; 
    const table = Utils.getSheetInstance(longName);
    if (!table) throw new Error(`Could not find table instance for ${longName}`);
    return table;
  } catch (e) {
    myLog("error", "Failed to resolve Reconciliation Table: %s", e.message);
    SpreadsheetApp.getUi().alert("Reconciliation Error: Could not find the Reconcile sheet configuration in the Registry.");
    return null;
  }
}

/**
 * Core Orchestrator: Imports a sheet by its unique LongName.
 * @param {string} longName
 * @param {boolean} forceUpdate - If true, uses the Fluent API to force update mode.
 */
function _importNamedSheet(longName, forceUpdate = false, suppressAlerts = false, triggerDownstream = true) {
  initialize();
  if (CONFIG_CONSTANTS.GLOBAL_SHEET_NAMES.includes(longName)) {
    longName = Registry.resolveGlobalSheetName(longName).LongName;
  }
  Registry.refresh();
  myLog("info", "Importing sheet: %s (Force Update: %s)", longName, forceUpdate);
  
  try {
    const config = Registry.getSheetConfig(longName);
    if (!config) {
      throw new Error(`Registry Failure: LongName '${longName}' not found in NewAccounts_Sheets.`);
    }
    
    const table = Utils.getSheetInstance(longName);
    if (table && typeof table.execute === 'function') {
      if (forceUpdate) table.withUpdateMode();
      const stats = table.execute();
      
      // Sync the State Machine: Mark as processed even if run individually
      const sheetsTable = globals.sheetsObj;
      if (sheetsTable.column.process !== -1) {
        const regRowOff = sheetsTable.getRowOffset(longName);
        if (regRowOff !== undefined) {
           const physicalRow = regRowOff + sheetsTable.firstDataRowIndex;
           sheetsTable.sheet.getRange(physicalRow, sheetsTable.column.process + 1).setValue(false);
        }
      }

      myLog("info", "Finished importing %s", longName);
      if (triggerDownstream) {
        _triggerDownstreamSheets(longName);
      }
    } else {
      myLog("warn", "Sheet %s does not support execution.", longName);
    }
  } catch (e) {
    myLog("error", "Failed to import sheet %s: %s", longName, e.message);
    if (!suppressAlerts) SpreadsheetApp.getUi().alert(`Import Error [${longName}]: ${e.message}`);
    throw e; // Rethrow to propagate failure and terminate the run!
  }
}

/**
 * Internal Helper: Marks downstream sheets as "Pending" (Process = TRUE) 
 * based on the SHEET_DEPENDENCY_MAP.
 */
function _triggerDownstreamSheets(longName) {
  const map = CONFIG_CONSTANTS.SHEET_DEPENDENCY_MAP;
  const downstream = map[longName];
  
  if (!downstream || !downstream.length) return;

  myLog("info", "Triggers: %s import complete. Queuing downstream tasks: %s", longName, downstream.join(", "));
  
  const sheetsTable = globals.sheetsObj;
  if (sheetsTable.column.process === -1) return;

  downstream.forEach(targetLongName => {
    const config = Registry.getSheetConfig(targetLongName);
    if (!config) {
      myLog("warn", "Triggers: Could not find downstream sheet '%s' in Registry.", targetLongName);
      return;
    }

    const regRowOff = sheetsTable.getRowOffset(targetLongName);
    if (regRowOff !== undefined) {
      const physicalRow = regRowOff + sheetsTable.firstDataRowIndex;
      sheetsTable.sheet.getRange(physicalRow, sheetsTable.column.process + 1).setValue(true);
      myLog("info", "Triggers: Set %s to Process=TRUE", targetLongName);
    }
  });
}

/**
 * Helper: Prompts the user for the Financial Year.
 * Defaults to the current FY based on the 1st April rule.
 */
function _promptForYear() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Set Import Window', 'Enter Financial Year (e.g., 2023) or leave blank for a FULL import:', ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  const val = response.getResponseText().trim();
  return val ? Number(val) : "FULL";
}

/**
 * Core Orchestrator: Calculates FirstRow/LastRow and saves to Registry by LongName.
 */
function _calculateAndSaveWindow(longName, year) {
  initialize();
  myLog("info", "Setting Import Window for %s (%s)", longName, year === "FULL" ? "FULL" : "FY" + year);
  
  try {
    const config = Registry.getSheetConfig(longName);
    if (!config) throw new Error(`LongName '${longName}' not found in Registry.`);
    
    // SKIP LOGIC: External files (FileTable) and Archives should not have windows calculated
    const type = config.SheetType || "Table";
    if (type === "FileTable") {
      myLog("info", "Skipping window calculation for %s (%s). It should be imported in full.", longName, type);
      return;
    }

    const table = Utils.getSheetInstance(config.LongName);
    if (!table || !table.sheet) throw new Error(`Physical sheet for ${longName} not found.`);

    // 1. Calculate Rows
    let firstRow, lastRow;
    
    if (year === "FULL") {
      const labelRow = Number(config.LabelRow || config.labelrow || 1);
      firstRow = labelRow + 1;
      lastRow = table.sheet.getLastRow();
    } else {
      const targetDate = new Date(year - 1, 3, 1); // 1st April (Start of the Financial Year)
      const dateFieldName = table.getDateFieldName();
      let calculatedFirstRow = table.calculateFirstRowByDate(targetDate, dateFieldName);
      lastRow = table.sheet.getLastRow();
      // Set the first row to the last row that is dated before the FY (the row immediately preceding the first row of the FY)
      const labelRow = Number(config.LabelRow || config.labelrow || 1);
      firstRow = Math.max(labelRow + 1, calculatedFirstRow - 1);
    }

    // 2. Resolve Registry Columns
    const sheetsTable = globals.sheetsObj;
    
    const firstRowCol = sheetsTable.column.firstrow;
    const lastRowCol = sheetsTable.column.lastrow;
    const fromFYCol = sheetsTable.column.fromfy;

    if (firstRowCol === undefined || lastRowCol === undefined) {
      myLog("error", "Registry Column Map: %s", JSON.stringify(sheetsTable.column));
      throw new Error(`Registry Metadata Error: Could not find "FirstRow" or "LastRow" columns in NewAccounts_Sheets.`);
    }
    
    // Convert to 1-indexed column numbers
    const firstRowColIdx = firstRowCol + 1;
    const lastRowColIdx = lastRowCol + 1;
    const fromFYColIdx = fromFYCol !== undefined ? fromFYCol + 1 : -1;
    
    myLog("trace", "Resolved Registry Columns -> FirstRow: %d, LastRow: %d, FromFY: %d", firstRowColIdx, lastRowColIdx, fromFYColIdx);

    // Force a fresh fetch of the Registry to ensure row offsets are accurate
    sheetsTable.fetchWindow();

    const regRowOff = sheetsTable.getRowOffset(longName);
    if (regRowOff === undefined) throw new Error(`Could not find ${longName} row in NewAccounts_Sheets.`);
    
    const physicalRegRow = regRowOff + sheetsTable.firstDataRowIndex;
    
    // 3. Persist to Registry
    sheetsTable.sheet.getRange(physicalRegRow, firstRowColIdx).setValue(firstRow);
    sheetsTable.sheet.getRange(physicalRegRow, lastRowColIdx).setValue(lastRow);
    
    if (fromFYColIdx !== -1) {
      const fromFYValue = (year === "FULL") ? "" : new Date(Number(year) - 1, 3, 1); // 1st April of (year - 1)
      sheetsTable.sheet.getRange(physicalRegRow, fromFYColIdx).setValue(fromFYValue);
      myLog("info", "Updated Registry for %s: FirstRow=%d, LastRow=%d, FromFY=%s", longName, firstRow, lastRow, String(fromFYValue));
    } else {
      myLog("info", "Updated Registry for %s: FirstRow=%d, LastRow=%d", longName, firstRow, lastRow);
    }
  } catch (e) {
    myLog("error", "Failed to set window for %s: %s", longName, e.message);
  }
}

/**
 * Core Orchestrator: Sets named ranges for a sheet by its unique LongName.
 */
function _defineNamedRangeForSheet(longName) {
  initialize();
  if (CONFIG_CONSTANTS.GLOBAL_SHEET_NAMES.includes(longName)) {
    longName = Registry.resolveGlobalSheetName(longName).LongName;
  }
  myLog("info", "Defining Named Ranges for: %s", longName);
  
  try {
    const config = Registry.getSheetConfig(longName);
    if (!config) {
      throw new Error(`Registry Failure: LongName '${longName}' not found in NewAccounts_Sheets.`);
    }
    
    const table = Utils.getSheetInstance(config.LongName);
    if (table && typeof table.writeNamedRanges === 'function') {
      table.writeNamedRanges();
      myLog("info", "Finished defining ranges for %s", longName);
    } else {
      myLog("warn", "Sheet %s does not support Named Range generation.", longName);
    }
  } catch (e) {
    myLog("error", "Failed to define ranges for %s: %s", longName, e.message);
  }
}

/**
 * Core Orchestrator
 * Uses the year-specific configuration defined in the Registry (e.g., AnnualSummaries_2023).
 * @param {number} year
 * @param {number|null} forceSourceFirstRow - Optional override for batch runs.
 */
function _runAnnualReportForYear(year, forceSourceFirstRow = null, forceFullLoad = false) {
  initialize();
  const longName = `AnnualSummaries_${year}`;
  
  myLog("info", "Orchestrating Annual Report for FY%d...", year);

  const report = Utils.getSheetInstance(longName);
  if (!report) {
    throw new Error(`Registry Failure: Configuration for '${longName}' was not found. Entry must exist in NewAccounts_Sheets.`);
  }

  // Configure and run using Fluent API
  report.forYear(year);
  if (forceSourceFirstRow !== null) {
    report.withSourceRow(forceSourceFirstRow);
  }
  if (forceFullLoad) {
    report.withFullLoad();
  }
  
  report.execute();
  myLog("info", "Annual Report for %d complete.", year);
}

/**
 * Helper: Recursively finds all downstream dependents for a set of sheets.
 */
function _expandDependencies(longNames) {
  const map = CONFIG_CONSTANTS.SHEET_DEPENDENCY_MAP;
  const expanded = new Set(longNames);
  const queue = [...longNames];

  while (queue.length > 0) {
    const current = queue.shift();
    const targets = map[current] || [];
    targets.forEach(t => {
      if (!expanded.has(t)) {
        expanded.add(t);
        queue.push(t);
      }
    });
  }
  return Array.from(expanded);
}

/**
 * Helper: Orders a list of sheets so that sources are processed before targets.
 * (Topological Sort based on SHEET_DEPENDENCY_MAP)
 */
function _sortSheetsByDependency(longNames) {
  const map = CONFIG_CONSTANTS.SHEET_DEPENDENCY_MAP;
  const sorted = [];
  const visited = new Set();
  const visiting = new Set(); // For cycle detection

  function visit(node) {
    if (visiting.has(node)) throw new Error("Dependency cycle detected involving: " + node);
    if (visited.has(node)) return;

    visiting.add(node);
    
    // Find everything this node depends on (it's a target in the map)
    for (const [source, targets] of Object.entries(map)) {
      if (targets.includes(node)) {
        visit(source);
      }
    }
    
    visiting.delete(node);
    visited.add(node);
    
    // Only add to result if it was in our original (or expanded) set
    if (longNames.includes(node)) {
      sorted.push(node);
    }
  }

  longNames.forEach(visit);
  return sorted;
}

