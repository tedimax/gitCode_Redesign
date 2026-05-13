"use strict";

/**
 * gitCode_Redesign - Test Runner Suite
 * Orchestrates batch report generation for validation.
 */
function runAnnualReportTestSuite() {
  initialize();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const startYear = 2016;
  const endYear = 2027;

  myLog("info", "TEST SUITE: Starting batch report generation from %d to %d", startYear, endYear);

  // PERFORMANCE: Ingest ONCE, Report MANY
  // We create one master engine, force a full load of the entire history,
  // and then reuse that populated engine to generate every report in the loop.
  const masterProps = {
    CreateIfMissing: true,
    FullLoad: true,
    SourceFirstRow: 2
  };
  const masterEngine = new AnnualSheet(ss, "AnnualSummaries_Report", masterProps);
  masterEngine.ledger.loadFull();

  for (let year = startYear; year <= endYear; year++) {
    const reportSheetName = `Test_${year}`;
    myLog("info", "TEST SUITE: Processing FY%d into sheet '%s'", year, reportSheetName);

    try {
      // 1. Generate the report matrix using the already-populated master engine
      const matrix = masterEngine.importData(year);

      // 2. Write to the specific test sheet
      _writeToNewTestSheet(ss, reportSheetName, matrix);

      // 3. Trigger styling
      masterEngine._applyStyles(matrix, reportSheetName);

      myLog("info", "TEST SUITE: Successfully generated %s", reportSheetName);
    } catch (e) {
      myLog("error", "TEST SUITE: Failed to generate report for %d. Error: %s", year, e.message);
    }
  }

  myLog("info", "TEST SUITE: Batch generation complete.");
}

/**
 * gitCode_Redesign - Backward Validation Suite
 * Runs the reporting engine using the optimized backward-scan logic
 * to compare against the 'Deep Audit' results.
 */
function runBackwardReportTestSuite() {
  initialize();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const startYear = 2027;
  const endYear = 2016;

  myLog("info", "BACKWARD TEST SUITE: Starting validation from %d down to %d", startYear, endYear);

  for (let year = startYear; year >= endYear; year--) {
    const reportSheetName = `Test_Backwards_${year}`;
    myLog("info", "BACKWARD TEST SUITE: Processing FY%d into sheet '%s'", year, reportSheetName);

    try {
      // PROD MODE: Use Registry boundaries and optimized backward scanning
      const props = {
        SheetName: reportSheetName,
        CreateIfMissing: true,
        year: year,
        FullLoad: false // Targeted backward scan
      };

      const reportEngine = new AnnualSheet(ss, "AnnualSummaries_Report", props);
      reportEngine.runSync();

      myLog("info", "BACKWARD TEST SUITE: Successfully generated %s", reportSheetName);
    } catch (e) {
      myLog("error", "BACKWARD TEST SUITE: Failed for %d. Error: %s", year, e.message);
    }
  }

  myLog("info", "BACKWARD TEST SUITE: Batch validation complete.");
}

/**
 * gitCode_Redesign - Longitudinal Trend Audit
 * Generates a comprehensive trend matrix for key financial indicators
 * from 2016 to 2027 in a single wide-format sheet.
 */
function test_LongitudinalAnalysis() {
  initialize();
  
  // Resolve the target metadata manually to avoid "Sheet Not Found" crash if it doesn't exist yet
  const config = Registry.getSheetConfig("AnnualSummaries_LongitudinalTrend");
  if (!config) throw new Error("Registry Failure: 'AnnualSummaries_LongitudinalTrend' not found in Sheets config.");
  
  const ssid = globals.ssMap.get(config.SpreadSheetName) || globals.defaultSSID;
  const ss = SpreadsheetApp.openById(ssid);
  const targetSheetName = config.SheetName;
  
  myLog("info", "LONGITUDINAL AUDIT: Starting full-history trend analysis targeting %s (%s)...", targetSheetName, ssid);

  // 1. Load the Names Table for Reference
  const namesTable = getSheetInstance(CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE);
  const nData = namesTable.getWindow();
  myLog("info", "DIAGNOSTIC: Names Table Row 1 -> %s", JSON.stringify(nData[0]));

  // 2. Ingest EVERYTHING (Deep Audit from Row 2)
  const sourceTable = getSheetInstance(CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE);
  sourceTable._isFetched = false; 
  sourceTable.firstDataRowIndex = 2;
  sourceTable.fetch(2); 
  myLog("info", "DIAGNOSTIC: Ledger Row 1 -> %s", JSON.stringify(sourceTable.getWindow()[0]));

  const ledger = new AnnualLedger(sourceTable);
  ledger.loadFull();
  
  const reporter = new AnnualReporter();
  const history = reporter.getLongitudinalReport(ledger.getFacts());
  myLog("info", "LONGITUDINAL AUDIT: Ingested %d years from %d rows.", history.length, sourceTable.getWindow().length);

  // 3. Standalone Matrix Generation (Isolated in Test Runner)
  const expenseBuckets = ["Broadband", "Business rates", "Electricity", "Water", "Insurance", "Fire"];
  const revenueBuckets = ["Village hall hire", "Donations", "Grants"];
  
  const headers = [
    "Year", "Total Assets", "Total Income", "Total Expenditure", "Net Surplus/Deficit",
    "Net: Social Events", "Net: General", 
    ...expenseBuckets.map(c => `Exp: ${c}`),
    ...revenueBuckets.map(c => `Rev: ${c}`)
  ];
  const matrix = [headers];

  history.forEach(report => {
    const row = [
      report.year,
      report.assets.total,
      report.totals.in,
      report.totals.out,
      report.totals.net
    ];

    const social = report.categoryGroups.find(g => g.groupLabel.toUpperCase().includes("SOCIAL"));
    const general = report.categoryGroups.find(g => g.groupLabel.toUpperCase().includes("GENERAL"));
    row.push(social ? social.groupNet : 0);
    row.push(general ? general.groupNet : 0);

    const allStats = report.categoryGroups.reduce((acc, g) => acc.concat(g.categories), []);

    expenseBuckets.forEach(kw => {
      const sum = allStats
        .filter(s => s.name.toLowerCase().includes(kw.toLowerCase()))
        .reduce((sum, s) => sum + s.out, 0);
      row.push(sum);
    });

    revenueBuckets.forEach(kw => {
      const sum = allStats
        .filter(s => s.name.toLowerCase().includes(kw.toLowerCase()))
        .reduce((sum, s) => sum + s.in, 0);
      row.push(sum);
    });

    matrix.push(row);
  });

  // 5. Persist and Style
  const sheet = _writeToNewTestSheet(ss, targetSheetName, matrix);
  if (sheet) {
    const range = sheet.getRange(1, 1, matrix.length, headers.length);
    range.setFontFamily("Montserrat").setFontSize(10).setVerticalAlignment("middle");
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("center");
    sheet.getRange(2, 1, matrix.length - 1, 1).setHorizontalAlignment("center").setFontWeight("bold");
    sheet.getRange(2, 2, matrix.length - 1, headers.length - 1).setNumberFormat("#,##0.00").setHorizontalAlignment("right");
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    for (let c = 1; c <= headers.length; c++) sheet.autoResizeColumn(c);
  }

  myLog("info", "LONGITUDINAL AUDIT: Complete. Output written to %s.", targetSheetName);
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

/**
 * gitCode_Redesign - Formula Porting Validation
 * Tests the new 'merge' and 'truth' functions using a UnionTable driver.
 */
function test_FormulaPorting() {
  initialize();
  myLog("info", "Starting Formula Porting Test...");

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Setup a Virtual Union Driver
    // In production, this would be defined in your 'NewAccounts_Sheets' file
    const unionProps = {
      Sources: "Ledgers_Bank, Ledgers_Cash", // Example sources
      SheetType: "UnionTable"
    };
    const driver = new UnionTable(ss, "Test_Union_Driver", unionProps);
    
    // 2. Setup the Import Table with the new formulas
    const importProps = {
      SourceSheet: "Test_Union_Driver",
      ImportMethod: "replace"
    };
    
    // Inject test formulas into the registry mock (for testing)
    // In production, these would be in your 'NewAccounts_NewFormulas' sheet
    // Example: [Amount] = merge(Ledgers_Bank, Ledgers_Cash)
    // Example: [IsCleared] = truth([Group])
    // Example (Chained Lookup):
    // [GroupID] = lookup(AnnualSummaries_Groups, PK, Group, [PK])
    // [YearID]  = lookup(AnnualSummaries_Groups, Group, FY, calc.GroupID)
    // Example (PK Generation):
    // [NewPK]   = pk(getKeyPrefix(), [DatePaid], [TransactionID])
    // Example (Nested Hash PK):
    // [HashPK]  = pk(getKeyPrefix(), [DatePaid], hash([Reference], [Amount], [Balance]))
    
    const importer = new ImportTable(ss, "Test_Ported_Result", importProps);
    
    myLog("info", "DRIVER: Created UnionTable from %s. Total Rows: %d", 
      unionProps.Sources, driver.getWindow().length);

    // 3. Run Transformation
    const result = importer.transform();
    
    if (result && result.length > 0) {
      _writeToNewTestSheet(ss, "TEST_Ported_Result", result);
      myLog("info", "Test Complete: Check 'TEST_Ported_Result' for vertical merge and boolean truth values.");
    } else {
      myLog("warn", "Test yielded no results. Ensure 'Ledgers_Bank' and 'Ledgers_Cash' have data.");
    }
    
  } catch (e) {
    myLog("error", "Formula Porting Test Failed: %s", e.message);
    if (e.stack) myLog("error", "Stack: %s", e.stack);
  }
}
