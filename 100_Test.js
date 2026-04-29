"use strict";

/**
 * gitCode_Redesign - Comprehensive Diagnostic Suite
 * Use these functions to verify the system integrity after architectural changes.
 */

/**
 * PERFORMS A REAL IMPORT
 * Use this to trigger a transformation and commit cycle for a specific target.
 */
function test_RunImport() {
  const targetName = "NewAccounts_TestSheetDest";
  
  try {
    myLog("info", ">>> STARTING IMPORT: %s <<<", targetName);
    
    // 1. Initialize
    initialize();
    
    // 2. Resolve Instance
    const table = getSheetInstance(targetName);
    if (!(table instanceof ImportTable)) {
      throw new Error("Target " + targetName + " is not an ImportTable. Check SheetType in registry.");
    }
    
    // 3. Execute Transform
    myLog("info", "Step 1: Transforming data from source...");
    table.transform();
    
    // 4. Execute Commit
    myLog("info", "Step 2: Committing changes to sheet...");
    const stats = table.commit(); // Falls back to configured ImportMethod
    
    // 5. Memory Management
    myLog("info", "Step 3: Flushing memory to prevent GC limits...");
    table.flushMemory();

    myLog("info", ">>> IMPORT SUCCESSFUL <<<");
    myLog("info", "  - Target: %s", targetName);
    myLog("info", "  - Total Processed: %d", table.windowDataLength);
    myLog("info", "  - Results: %d added, %d updated", stats.added, stats.updated);
    
  } catch (e) {
    myLog("error", "!!! IMPORT FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  } finally {
    if (typeof AuditUtils !== 'undefined') AuditUtils.flush();
  }
}

/**
 * LEGACY DIAGNOSTICS
 * Kept for reference and internal validation.
 */
function runAllDiagnostics() {
  myLog("info", "=== STARTING SYSTEM DIAGNOSTICS ===");
  try {
    diag_Registry();
    diag_Formulas();
    diag_RegistryIntegrity();
    diag_FormulaContextCache();
    diag_ExpansionMath();
    
    // Test the full cycle using the user's test sheets
    diag_Lifecycle("NewAccounts_TestSheetDest"); 
    
    myLog("info", "=== ALL DIAGNOSTICS PASSED ===");
  } catch (e) {
    myLog("error", "DIAGNOSTIC FAILURE: %s", e.message);
  }
}

/**
 * Diagnostic 1: Registry Initialization
 * Verifies that the system hydrates correctly from the Sheets/DataTypes tables.
 */
function diag_Registry() {
  initialize();
  myLog("info", "[Diag] Checking Registry State...");
  
  const ssidCount = globals.ssMap.size;
  const typeCount = globals.dataTypesMap.size;
  
  myLog("info", "  - SSID Map: %d entries", ssidCount);
  myLog("info", "  - DataType Map: %d entries", typeCount);
  
  if (ssidCount === 0) throw new Error("Registry Error: SSID map is empty.");
  myLog("info", "[PASS] Registry Hydration");
}

/**
 * Diagnostic 2: Formula Parser & Dependencies
 * Verifies the new [Bracket] syntax and topological sorting.
 */
function diag_Formulas() {
  myLog("info", "[Diag] Testing Formula Engine...");

  // 1. Test Bracket Parsing
  const rawFormula = "[Net] * 1.2 + Other_Sheet[Value]";
  const parsed = FormulaUtils.parse(rawFormula, "Source_Sheet");
  myLog("info", "  - Raw: %s", rawFormula);
  myLog("info", "  - Parsed: %s", parsed);

  if (!parsed.includes('utils.getVal("Source_Sheet", "Net"')) {
    throw new Error("Formula Parser failed to resolve default [Net] shorthand.");
  }
  if (!parsed.includes('utils.getVal("Other_Sheet", "Value"')) {
    throw new Error("Formula Parser failed to resolve explicit Other_Sheet[Value] syntax.");
  }

  // 2. Test Dependency Sorting
  const rawMap = new Map([
    ["Total", "calc.Net + calc.Tax"],
    ["Tax", "[Net] * 0.2"],
    ["Net", "100"]
  ]);
  const compiledMap = new Map([
    ["Total", () => {}],
    ["Tax", () => {}],
    ["Net", () => {}]
  ]);

  const sorted = FormulaUtils.resolveDependencies(compiledMap, rawMap);
  const order = Array.from(sorted.keys()).join(" -> ");
  myLog("info", "  - Dependency Order: %s", order);

  if (order !== "Net -> Tax -> Total") {
    throw new Error(`Topological Sort failed. Expected Net->Tax->Total, got ${order}`);
  }

  myLog("info", "[PASS] Formula Engine & Dependencies");
}

/**
 * Diagnostic 3: Full Lifecycle (Transform & Commit)
 * Runs a complete data cycle for a specific table.
 */
function diag_Lifecycle(longName) {
  myLog("info", "[Diag] Testing Full Lifecycle for: %s", longName);
  
  const table = getSheetInstance(longName);
  if (!table) throw new Error(`Could not find table instance for ${longName}`);

  myLog("info", "  - Factory created instance of: %s", table.constructor.name);
  myLog("info", "  - Registry SheetType was: %s", table.getProperty("SheetType"));

  if (table.constructor.name !== "ImportTable") {
    throw new Error(`Target ${longName} must be an ImportTable to run transform(). Check the SheetType column in your registry.`);
  }

  myLog("info", "  - Step 1: Transforming rows...");
  table.transform();
  myLog("info", "  - Transformed %d rows in memory.", table._newData.length);

  myLog("info", "  - Step 2: Committing changes (Using configured mode)...");
  // This will trigger the configured persistence logic
  table.commit();

  myLog("info", "[PASS] Full Lifecycle for %s", longName);
  if (typeof AuditUtils !== 'undefined') AuditUtils.flush();
}

/**
 * Quick test for String Sanitization
 */
function testStringUtils() {
  const result = StringUtils.toRangeName("My Sheet Name 123");
  myLog("info", "Sanitized Name: %s", result);
  return result === "My_Sheet_Name_123";
}

/**
 * Diagnostic 4: Audit Logger
 * Injects a fake error and flushes it to verify SyncAudit connectivity.
 */
function test_AuditLogger() {
  myLog("info", "[Diag] Testing Audit Logger...");
  initialize();

  if (typeof AuditUtils === 'undefined') {
    throw new Error("AuditUtils is not defined!");
  }

  myLog("info", "  - Injecting artificial error...");
  AuditUtils.logError(
    "Test_System",
    999,
    "TestField",
    "This is an artificial test error to verify the SyncAudit sheet is wired correctly."
  );

  myLog("info", "  - Flushing to NewAccounts_SyncAudit...");
  AuditUtils.flush("NewAccounts_SyncAudit");

  myLog("info", "[PASS] Audit flushed. Please check the bottom of your NewAccounts_SyncAudit sheet!");
}

/**
 * Diagnostic 5: Registry Integrity
 * Verifies that the new Registry singleton correctly indexes sheets and formulas.
 */
function diag_RegistryIntegrity() {
  initialize();
  myLog("info", "[Diag] Testing Registry Integrity...");

  const testTable = "NewAccounts_TestSheetDest";
  const config = Registry.getSheetConfig(testTable);
  if (!config.LongName) {
    throw new Error(`Registry failed to find config for ${testTable}`);
  }

  const formulas = Registry.getFormulasFor(testTable);
  myLog("info", "  - Found %d formula entries for %s", formulas.length, testTable);

  myLog("info", "[PASS] Registry Integrity");
}

/**
 * Diagnostic 7: Formula Context Caching
 * Verifies that the formula context remembers sheet instances to avoid redundant lookups.
 */
function diag_FormulaContextCache() {
  initialize();
  myLog("info", "[Diag] Testing Context Caching...");

  const context = FormulaUtils.createContext();
  const testSheet = CONFIG_CONSTANTS.SHEETS_CONFIG_NAME;
  
  // 1. First lookup
  const val1 = context.getVal(testSheet, "LongName", 0);
  
  // 2. Second lookup (Should be from internal cache)
  const val2 = context.getVal(testSheet, "LongName", 0);
  
  if (val1 !== val2 || !val1) {
    throw new Error("Context Cache failed to return consistent data.");
  }

  myLog("info", "[PASS] Context Caching");
}

/**
 * Diagnostic 8: Date Expansion Math
 * Verifies that the Temporal API correctly calculates monthly/weekly recurring dates.
 */
function diag_ExpansionMath() {
  myLog("info", "[Diag] Testing Date Expansion Math...");
  
  // 1. Test Monthly (Jan 1st to Mar 1st)
  const monthly = DateUtils.getScheduledDates("2024-01-01", "2024-03-01", "Monthly", 1);
  myLog("info", "  - Monthly (Jan to Mar): %s", monthly.map(d => d.toString()).join(", "));
  if (monthly.length !== 3) {
    throw new Error("Expansion Math: Monthly failed to generate 3 instances.");
  }

  // 2. Test Bi-Weekly (Jan 1st to Jan 31st)
  const biweekly = DateUtils.getScheduledDates("2024-01-01", "2024-01-31", "Weekly", 2);
  myLog("info", "  - Bi-Weekly (Jan): %s", biweekly.map(d => d.toString()).join(", "));
  // Expected: Jan 1, Jan 15, Jan 29
  if (biweekly.length !== 3) {
    throw new Error("Expansion Math: Bi-weekly failed to generate 3 instances.");
  }

  // 3. Test Year End Boundary (Dec to Jan)
  const yearly = DateUtils.getScheduledDates("2023-12-01", "2024-01-01", "Monthly", 1);
  myLog("info", "  - Boundary (Dec to Jan): %s", yearly.map(d => d.toString()).join(", "));
  if (yearly.length !== 2) {
    throw new Error("Expansion Math: Year boundary failed.");
  }

  myLog("info", "[PASS] Expansion Math");
}

/**
 * TEST: Recreate Reconcile Table
 * Use this to trigger the startNewReconciliation workflow manually.
 * Requires: AnnualSummaries_NewMerged and AnnualSummaries_NewReconcile
 */
function test_RecreateReconcile() {
  try {
    myLog("info", ">>> STARTING RECONCILE RECREATE <<<");
    initialize();
    
    const recTable = getSheetInstance("AnnualSummaries_NewReconcile");
    if (!recTable) throw new Error("Could not instantiate AnnualSummaries_NewReconcile");
    
    recTable.startNewReconciliation();
    
    myLog("info", ">>> RECREATE COMPLETE <<<");
  } catch (e) {
    myLog("error", "!!! RECREATE FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  }
}

/**
 * TEST: Process Balanced Rows
 * Use this to trigger the commit of balanced groups to the Groups and Merged tables.
 * Requires: AnnualSummaries_NewReconcile, AnnualSummaries_NewGroups, AnnualSummaries_NewMerged, and NewAccount_ReconcileLog
 */
function test_CommitBalancedGroups() {
  try {
    myLog("info", ">>> STARTING BALANCED GROUPS COMMIT <<<");
    initialize();
    
    const recTable = getSheetInstance("AnnualSummaries_NewReconcile");
    if (!recTable) throw new Error("Could not instantiate AnnualSummaries_NewReconcile");
    
    recTable.processBalancedRows();
    
    myLog("info", ">>> COMMIT COMPLETE <<<");
  } catch (e) {
    myLog("error", "!!! COMMIT FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  }
}

/**
 * TEST: Set Named Ranges for Active Sheet
 * Explicitly recreates the Named Ranges (Sheet extent, Data extent, and Column extents)
 * for the currently active sheet in the Google Sheets UI.
 */
function test_SetNamedRangesForActiveSheet() {
  try {
    myLog("info", ">>> STARTING NAMED RANGE REBUILD <<<");
    initialize();
    
    // Resolve instance for the currently active sheet
    const activeSheet = SpreadsheetApp.getActiveSheet();
    const activeSheetName = activeSheet.getName();
    
    // Attempt to lookup the correct LongName from the registry
    let targetLongName = activeSheetName; // Fallback
    const sheetNameOff = globals.sheetsObj.getColOffset("SheetName");
    const longNameOff = globals.sheetsObj.getColOffset("LongName");
    
    if (sheetNameOff !== -1 && longNameOff !== -1) {
      const window = globals.sheetsObj.getWindow();
      for (let i = 0; i < window.length; i++) {
        if (String(window[i][sheetNameOff]).trim() === activeSheetName) {
          targetLongName = String(window[i][longNameOff]).trim();
          break;
        }
      }
    }
    
    myLog("info", "Active UI Sheet: %s -> Registry Target: %s", activeSheetName, targetLongName);
    
    const table = getSheetInstance(targetLongName);
    if (!table) {
      throw new Error(`Could not instantiate table for ${targetLongName}. Ensure it is configured in the Registry.`);
    }
    
    // Trigger the named range rebuild
    table.writeNamedRanges();
    
    myLog("info", ">>> NAMED RANGE REBUILD COMPLETE for %s <<<", targetLongName);
  } catch (e) {
    myLog("error", "!!! NAMED RANGE REBUILD FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  }
}

/**
 * TEST: Set Named Ranges for Specific Sheet
 * Explicitly recreates the Named Ranges (Sheet extent, Data extent, and Column extents)
 * for a specifically targeted LongName.
 */
function test_SetNamedRangesForSpecificSheet() {
  try {
    // 1. ---> TYPE YOUR TARGET LONG NAME HERE <---
    const targetLongName = "AnnualSummaries_NewReconcile"; 
    
    myLog("info", ">>> STARTING NAMED RANGE REBUILD for %s <<<", targetLongName);
    initialize();
    
    const table = getSheetInstance(targetLongName);
    if (!table) {
      throw new Error(`Could not instantiate table for ${targetLongName}. Ensure it is configured in the Registry.`);
    }
    
    // Trigger the named range rebuild
    table.writeNamedRanges();
    
    myLog("info", ">>> NAMED RANGE REBUILD COMPLETE for %s <<<", targetLongName);
  } catch (e) {
    myLog("error", "!!! NAMED RANGE REBUILD FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  }
}

/**
 * TEST: Verify FileTable Ingestion
 * Instantiates a FileTable and triggers a fetch from Google Drive,
 * ensuring that the CSV/Excel file is parsed into memory correctly.
 */
function test_FileTableIngestion() {
  try {
    // ---> Type the LongName of the FileTable you want to test <---
    const targetLongName = "ImportsArchive_FileSMApp"; 
    
    myLog("info", ">>> STARTING FILE TABLE INGESTION TEST for %s <<<", targetLongName);
    initialize();
    
    const table = getSheetInstance(targetLongName);
    if (!table) {
      throw new Error(`Could not instantiate table for ${targetLongName}. Ensure it is configured in the Registry.`);
    }
    
    // Trigger the Drive fetch and parsing
    const dataWindow = table.getWindow();
    const labels = table.getColLabels();
    
    myLog("info", ">>> INGESTION SUCCESSFUL <<<");
    myLog("info", "  - Parsed Labels: %s", labels.join(", "));
    myLog("info", "  - Data Rows in RAM: %d", table.windowDataLength);
    
    if (dataWindow.length > 0) {
      myLog("info", "  - Sample Row 1: %s", JSON.stringify(dataWindow[0]));
    }
    
  } catch (e) {
    myLog("error", "!!! FILE TABLE INGESTION FAILED !!!");
    myLog("error", "  - Reason: %s", e.message);
    myLog("error", "  - Stack: %s", e.stack);
  }
}
