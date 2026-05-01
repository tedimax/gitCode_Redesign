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
