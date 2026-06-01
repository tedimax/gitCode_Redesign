/**
 * gitCode_Redesign - Test Suite
 */

/**
 * Triggers the dynamic Annual Report generation for 2023.
 * Target sheet: 2023_Redesign (configured in Registry row 93)
 */
function test_AnnualReportRedesign() {
  // 1. Initialize the system and registries
  initialize();
  
  const longName = "AnnualSummaries_2023_Redesign";
  
  // 2. Get the specialized AnnualSheet instance
  const reportTable = getSheetInstance(longName);
  
  if (!reportTable) {
    myLog("error", "FAILED: Could not find configuration for %s. Ensure row 93 in the Sheets tab is correct.", longName);
    return;
  }
  
  myLog("info", "Starting Dynamic Report Sync for %s...", longName);
  
  try {
    // 3. Execute the standard sync lifecycle
    // This will discover sections, build formulas, and commit to the sheet
    const stats = reportTable.runSync();
    
    myLog("info", "SUCCESS: Sync complete. Stats: %s", JSON.stringify(stats));
    myLog("info", "Please check the '2023_Redesign' tab in your Annual Summaries spreadsheet.");
  } catch (e) {
    myLog("error", "Sync failed: %s", e.message);
    if (e.stack) myLog("error", "Stack trace: %s", e.stack);
  }
}

/**
 * Diagnostic test to verify boundary date calculations and deduplication filter.
 */
function test_BoundaryDateGuard() {
  initialize();
  myLog("info", "--- Running Boundary Date Guard Diagnostic Test ---");

  try {
    // 1. Resolve a target table, e.g., "Ledgers_Bank"
    const targetTable = Utils.getSheetInstance("Ledgers_Bank");
    if (!targetTable) {
      myLog("warn", "Ledgers_Bank not found in registry. Skipping real sheet check.");
      return;
    }

    // 2. Resolve date columns
    const dateFieldName = targetTable.getProperty("DateField") || "Date";
    const dateColOffset = targetTable.getColOffset(dateFieldName);
    myLog("info", "Date Field: %s, Column Offset: %d", dateFieldName, dateColOffset);

    // 3. Inspect target window rows
    const targetRows = targetTable.getWindow();
    myLog("info", "Target window row count: %d", targetRows.length);
    if (targetRows.length > 0) {
      const firstRowDateRaw = targetRows[0][dateColOffset];
      myLog("info", "Target first row date raw: %s", firstRowDateRaw);
      const parsed = firstRowDateRaw instanceof Date ? firstRowDateRaw : new Date(firstRowDateRaw);
      myLog("info", "Parsed Boundary Date: %s (Time: %d)", parsed, parsed.getTime());
    } else {
      myLog("info", "Target window is empty.");
    }
    
    myLog("info", "SUCCESS: Diagnostic complete.");
  } catch (e) {
    myLog("error", "Diagnostic failed: %s", e.message);
  }
}

/**
 * Temp Debug: Logs dates from row 700 to 735 for Cashbox to inspect physical order and values.
 */
function debugCashboxDates() {
  initialize();
  myLog("info", "--- Cashbox Date Debugger (Rows 700 to 735) ---");
  try {
    const table = Utils.getSheetInstance("ManualEntry_Cashbox") || Utils.getSheetInstance("Ledgers_Cash");
    if (!table) {
      myLog("error", "Could not find Cashbox or Ledgers_Cash sheet instance.");
      return;
    }
    const dateFieldName = table.getProperty("DateField") || "Date";
    const dateColOffset = table.getColOffset(dateFieldName);
    myLog("info", "Target sheet: %s, Date field: %s (Col Offset: %d)", table.longName, dateFieldName, dateColOffset);

    const sheet = table.sheet;
    const lastRow = sheet.getLastRow();
    myLog("info", "Sheet physical lastRow: %d", lastRow);

    const startRow = 700;
    const numRows = Math.min(36, lastRow - startRow + 1);
    if (numRows <= 0) {
      myLog("warn", "Sheet has fewer than 700 rows.");
      return;
    }

    const rangeValues = sheet.getRange(startRow, dateColOffset + 1, numRows, 1).getValues();
    for (let i = 0; i < rangeValues.length; i++) {
      const pRow = startRow + i;
      const val = rangeValues[i][0];
      let dateStr = "Non-Date";
      if (val instanceof Date) {
        dateStr = val.toISOString().split('T')[0];
      } else if (val) {
        const d = new Date(val);
        dateStr = isNaN(d.getTime()) ? String(val) : d.toISOString().split('T')[0];
      }
      myLog("info", "Physical Row %d: %s (Raw: %s)", pRow, dateStr, String(val));
    }
  } catch (e) {
    myLog("error", "Debug run failed: %s", e.message);
  }
}

/**
 * Temp Debug: Logs all unique prefixes / target fields in NewAccounts_NewFormulas to find the discrepancy.
 */
function debugFormulaKeys() {
  initialize();
  myLog("info", "--- NewFormulas Key Debugger ---");
  try {
    const formulasTable = globals.formulasObj;
    if (!formulasTable) {
      myLog("error", "Could not find NewAccounts_NewFormulas sheet.");
      return;
    }
    const targetFieldOff = formulasTable.getColOffset(CONFIG_CONSTANTS.FORMULAS_CONFIG_PK);
    myLog("info", "Target field col offset: %d", targetFieldOff);

    const values = formulasTable.sheet.getRange(2, targetFieldOff + 1, formulasTable.sheet.getLastRow() - 1, 1).getValues();
    const matches = [];
    values.forEach((row, idx) => {
      const val = String(row[0] || "").trim();
      if (val && !val.startsWith("//") && !val.startsWith("#")) {
        if (val.toLowerCase().includes("generated") || val.toLowerCase().includes("schedule") || val.toLowerCase().includes("trans")) {
          matches.push(`Row ${idx + 2}: ${val}`);
        }
      }
    });

    myLog("info", "Found %d matching target fields in NewFormulas:", matches.length);
    matches.forEach(m => myLog("info", "  %s", m));
  } catch (e) {
    myLog("error", "Failed to debug formula keys: %s", e.message);
  }
}

/**
 * Diagnostic test to dump columns and first row of ManualEntry_ScheduledTransactions
 */
function inspectScheduledSheet() {
  initialize();
  myLog("info", "--- Inspecting ManualEntry_ScheduledTransactions ---");
  try {
    const table = Utils.getSheetInstance("ManualEntry_ScheduledTransactions");
    if (!table) {
      myLog("error", "Could not find ManualEntry_ScheduledTransactions instance.");
      return;
    }
    myLog("info", "Columns: %s", JSON.stringify(table.getLabels()));
    const window = table.getWindow();
    if (window.length > 0) {
      myLog("info", "Row 1: %s", JSON.stringify(window[0]));
    }
  } catch (e) {
    myLog("error", "Inspection failed: %s", e.message);
  }
}

/**
 * Diagnostic test to dump all formulas defined in the NewAccounts_Formulas sheet.
 */
function dumpAllFormulas() {
  initialize();
  myLog("info", "--- Dumping All Formulas ---");
  try {
    const formulasTable = globals.formulasObj;
    if (!formulasTable) {
      myLog("error", "Could not find NewAccounts_Formulas sheet.");
      return;
    }
    const window = formulasTable.getWindow();
    myLog("info", "Total formula rows: %d", window.length);
    const labels = formulasTable.getLabels();
    myLog("info", "Formula labels: %s", JSON.stringify(labels));
    
    const targetFieldOff = formulasTable.getColOffset(CONFIG_CONSTANTS.FORMULAS_CONFIG_PK);
    const formulaOff = formulasTable.getColOffset("Formula");
    
    window.forEach((row, idx) => {
      const target = String(row[targetFieldOff] || "").trim();
      const formula = String(row[formulaOff] || "").trim();
      if (target || formula) {
        myLog("info", "Row %d | Target: %s | Formula: %s", idx + 2, target, formula);
      }
    });
  } catch (e) {
    myLog("error", "Failed to dump formulas: %s", e.message);
  }
}

function debugBookingsFormulas() {
  initialize();
  myLog("info", "=== debugBookingsFormulas ===");
  try {
    const config = Registry.getSheetConfig("Ledgers_Bookings");
    myLog("info", "Ledgers_Bookings config properties: %s", JSON.stringify(config));
    
    const formulas = Registry.getFormulasFor("Ledgers_Bookings");
    myLog("info", "Ledgers_Bookings formulas count: %d", formulas.length);
    formulas.forEach(f => {
      myLog("info", "  Field: %s | Formula: %s", f.targetField, f.formula);
    });
  } catch (e) {
    myLog("error", "Error: %s", e.message);
  }
}

function debugBookingsWindow() {
  initialize();
  myLog("info", "=== debugBookingsWindow ===");
  try {
    const bookingsConfig = Registry.getSheetConfig("Ledgers_Bookings");
    myLog("info", "Ledgers_Bookings Config: %s", JSON.stringify(bookingsConfig));

    const rawSMAppConfig = Registry.getSheetConfig("ImportsArchive_RawSMApp");
    myLog("info", "ImportsArchive_RawSMApp Config: %s", JSON.stringify(rawSMAppConfig));

    const rawSMAppTable = Utils.getSheetInstance("ImportsArchive_RawSMApp");
    const rawSMAppSheet = rawSMAppTable.sheet;
    const rawSMAppLastRow = rawSMAppSheet.getLastRow();
    myLog("info", "ImportsArchive_RawSMApp - Sheet range check: FirstRow config is %d. Total physical rows: %d.", 
      rawSMAppTable.firstDataRowIndex, rawSMAppLastRow);

    const appDateCol = rawSMAppTable.getColOffset("Appointment date");
    myLog("info", "ImportsArchive_RawSMApp - 'Appointment date' col offset: %d", appDateCol);

    if (appDateCol !== -1) {
      const allDates = rawSMAppSheet.getRange(2, appDateCol + 1, rawSMAppLastRow - 1, 1).getValues();
      let foundCount = 0;
      allDates.forEach((valArr, idx) => {
        const val = valArr[0];
        const rowNum = idx + 2;
        let d = null;
        if (val instanceof Date) d = val;
        else if (val) d = new Date(val);
        
        if (d && !isNaN(d.getTime())) {
          const dateStr = d.toISOString().split('T')[0];
          if (dateStr.startsWith("2025-03-14") || dateStr.startsWith("2025-03-15") || dateStr.startsWith("2025-03-13")) {
            myLog("info", "Found date row: Physical Row %d, Date: %s (Raw: %s)", rowNum, dateStr, String(val));
            foundCount++;
          }
        }
      });
      myLog("info", "Search complete. Found %d matching date rows in raw sheet.", foundCount);
    }
  } catch (e) {
    myLog("error", "Error: %s", e.message);
  }
}

function debugRawRowDetail() {
  initialize();
  myLog("info", "=== debugRawRowDetail ===");
  try {
    const rawSMAppTable = Utils.getSheetInstance("ImportsArchive_RawSMApp");
    const labels = rawSMAppTable.getLabels();
    myLog("info", "RawSMApp Labels: %s", JSON.stringify(labels));

    const rows = [1320, 1321, 1322, 1323, 1324];
    rows.forEach(pRow => {
      if (pRow <= rawSMAppTable.sheet.getLastRow()) {
        const rowValues = rawSMAppTable.sheet.getRange(pRow, 1, 1, labels.length).getValues()[0];
        const rowObj = labels.reduce((obj, label, idx) => {
          obj[label] = rowValues[idx];
          return obj;
        }, {});
        myLog("info", "Row %d: %s", pRow, JSON.stringify(rowObj));
      }
    });
  } catch (e) {
    myLog("error", "Error: %s", e.message);
  }
}

function debugMergedAccountRows() {
  initialize();
  myLog("info", "=== debugMergedAccountRows ===");
  try {
    const table = Utils.getSheetInstance("AnnualSummaries_Merged");
    const lastRow = table.getLastRowIndex();
    myLog("info", "Physical last row index of Merged: %d", lastRow);
    const cols = table.getSymbolicOffsets();
    myLog("info", "Columns offsets: %s", JSON.stringify(cols));
    
    // Read the window
    const data = table.getWindow();
    myLog("info", "Window length: %d", data.length);
    
    // Find ACCOUNT rows
    const entryTypeOff = cols.entryType;
    const fyOff = cols.fy;
    const accountOff = cols.account;
    const balanceOff = cols.balance;
    const lastBalanceOff = cols.lastBalance;
    const clearedOff = cols.cleared;
    
    let count = 0;
    data.forEach((row, idx) => {
      const type = String(row[entryTypeOff] || "").trim().toUpperCase();
      if (type === "ACCOUNT") {
        count++;
        myLog("info", "Row %d (idx %d): FY=%s, Account=%s, Balance=%s, LastBalance=%s, Cleared=%s", 
          idx + table.firstDataRowIndex, 
          idx,
          row[fyOff], 
          row[accountOff], 
          row[balanceOff], 
          row[lastBalanceOff], 
          row[clearedOff]
        );
      }
    });
    myLog("info", "Total ACCOUNT rows found in window: %d", count);
  } catch (e) {
    myLog("error", "Error: %s", e.message);
  }
}

function debugMergedSourcesAndColumns() {
  initialize();
  myLog("info", "=== debugMergedSourcesAndColumns ===");
  try {
    const sheetsTable = globals.sheetsObj;
    const mergeSheetsRaw = sheetsTable.lookupValue("LongName", "SourceSheets", "AnnualSummaries_Merged")
                       || sheetsTable.lookupValue("LongName", "SourceSheet",  "AnnualSummaries_Merged")
                       || sheetsTable.lookupValue("LongName", "MergeSheets",  "AnnualSummaries_Merged");
    
    myLog("info", "SourceSheets Raw: %s", mergeSheetsRaw);
    if (!mergeSheetsRaw) return;
    
    const sourceNames = String(mergeSheetsRaw).split(",").map(s => s.trim());
    sourceNames.forEach((name, idx) => {
      try {
        const instance = getSheetInstance(name);
        if (instance) {
          const labels = instance.getLabels();
          myLog("info", "Source %d: %s | Labels: %s", idx, name, JSON.stringify(labels));
        } else {
          myLog("warn", "Source %d: %s | Could not resolve instance", idx, name);
        }
      } catch (e) {
        myLog("error", "Source %d: %s | Error: %s", idx, name, e.message);
      }
    });
  } catch (e) {
    myLog("error", "Error: %s", e.message);
  }
}




