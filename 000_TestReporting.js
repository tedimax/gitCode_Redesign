"use strict";

/**
 * gitCode_Redesign - Reporting Test Suite
 * Validates the Annual and Longitudinal reporting services.
 */

/**
 * Tests the full orchestration of a single annual report.
 */
function test_SingleYearReport() {
  initialize(); // Bootstrap the registry
  const targetYear = "2023";
  myLog("info", "Starting Single Year Test for %s...", targetYear);

  try {
    // 1. Resolve the correct target spreadsheet (Mirroring production logic)
    const ss = _resolveAnnualSummariesSS();
    myLog("info", "Targeting Spreadsheet: %s (%s)", ss.getName(), ss.getId());

    // 2. Initialize the Orchestrator
    // We pass CreateIfMissing to allow instantiation of a new test sheet
    const service = new AnnualSheet(ss, "AnnualSummaries_Report", { 
      SheetName: `TEST_Annual_${targetYear}`, 
      CreateIfMissing: true 
    });

    // 3. Import the Data
    const matrix = service.importData(targetYear);

    // 4. Write to a NEW test sheet
    _writeToNewTestSheet(ss, `TEST_Annual_${targetYear}`, matrix);

    // 5. Trigger the styling pass
    service.afterSync({}, matrix);

    myLog("info", "Test Complete: See sheet 'TEST_Annual_%s' in %s", targetYear, ss.getName());
  } catch (e) {
    myLog("error", "Single Year Test Failed: %s", e.message);
    if (e.stack) myLog("error", "Stack: %s", e.stack);
  }
}

/**
 * Tests the longitudinal "Fact Engine" across multiple years.
 */
function test_LongitudinalAnalysis() {
  initialize();
  myLog("info", "Starting Longitudinal Trend Test...");

  try {
    const ss = _resolveAnnualSummariesSS();
    // Use the production report context so we inherit the correct data source (AnnualSummaries_Merged)
    const service = new AnnualSheet(ss, "AnnualSummaries_Report", { 
      SheetName: "TEST_TEMP",
      CreateIfMissing: true 
    });

    // 1. Get the raw multi-year facts
    const facts = service.ledger.getFacts();

    // 2. Get the longitudinal analysis report
    const history = service.reporter.getLongitudinalReport(facts);

    // 3. Build a summary matrix
    const trendMatrix = [
      ["Financial Year", "Total Assets", "Total Income", "Total Expenditure", "Net Surplus/Deficit"]
    ];

    history.forEach(report => {
      trendMatrix.push([
        report.year,
        report.assets.total,
        report.totals.in,
        report.totals.out,
        report.totals.net
      ]);
    });

    // 4. Write results to a new test sheet
    const sheet = _writeToNewTestSheet(ss, "TEST_Longitudinal_Trend", trendMatrix);
    
    // 5. Premium Styling (Safe for 0-row results)
    if (sheet && history.length > 0) {
      sheet.getRange(1, 1, 1, 5).setFontFamily("Montserrat").setFontSize(10).setFontWeight("bold").setBackground("#f3f3f3");
      sheet.getRange(2, 1, history.length, 5).setFontFamily("Montserrat").setFontSize(10).setHorizontalAlignment("right");
      sheet.getRange(2, 2, history.length, 4).setNumberFormat("£#,##0.00;[Red]-£#,##0.00;\"\"");
      sheet.setColumnWidth(1, 150);
      sheet.setColumnWidths(2, 4, 120);
    }

    myLog("info", "Longitudinal Test Complete: See sheet 'TEST_Longitudinal_Trend' in %s", ss.getName());
  } catch (e) {
    myLog("error", "Longitudinal Test Failed: %s", e.message);
  }
}

/**
 * Helper: Strictly resolves the AnnualSummaries spreadsheet.
 * Uses the production registry config for "AnnualSummaries_Merged" to find the SSID.
 */
function _resolveAnnualSummariesSS() {
  const config = Registry.getSheetConfig("AnnualSummaries_Merged");
  const ssName = config.SpreadSheetName || "AnnualSummaries";
  
  const ssid = globals.ssMap.get(ssName);
  if (!ssid) {
    throw new Error(`Registry Failure: Could not find SSID for spreadsheet group "${ssName}". Found ssMap entries: ${Array.from(globals.ssMap.keys()).join(", ")}`);
  }
  
  return SpreadsheetApp.openById(ssid);
}

/**
 * Helper: Safely inserts a new sheet for testing.
 */
function _writeToNewTestSheet(ss, name, matrix) {
  if (!matrix || matrix.length === 0) return;

  let sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.clear();
    sheet.clearFormats();
  } else {
    sheet = ss.insertSheet(name);
  }

  sheet.getRange(1, 1, matrix.length, matrix[0].length).setValues(matrix);
  return sheet;
}
