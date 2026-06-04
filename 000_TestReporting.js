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
    const matrix = service.prepare(targetYear);

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

/**
 * Debugging utility to inspect the FY2027 Current account discrepancy of £29.99.
 */
function debugFY2027Discrepancy() {
  initialize();
  myLog("info", "Starting debug of FY2027 discrepancy...");
  try {
    // Look up NewFormulas sheet first
    const formulaTable = getSheetInstance("NewAccounts_NewFormulas");
    if (formulaTable) {
      formulaTable.fetch(formulaTable.firstDataRowIndex);
      const fData = formulaTable.getWindow();
      const fLabels = formulaTable.getLabels();
      myLog("info", `--- Printing NewAccounts_NewFormulas (Total: ${fData.length} rows, Labels: ${fLabels.join(", ")}) ---`);
      fData.slice(0, 20).forEach((row, rIdx) => {
        const rowDetails = fLabels.map((lbl, cIdx) => `${lbl}: "${row[cIdx]}"`).join(", ");
        myLog("info", `Row ${rIdx + 2}: ${rowDetails}`);
      });
    }

    const ss = _resolveAnnualSummariesSS();
    const sheetName = "AnnualSummaries_Merged";
    const table = getSheetInstance(sheetName);
    
    // Ensure all data is fetched
    table.fetch(table.firstDataRowIndex);
    const data = table.getWindow();
    const cols = table.getSymbolicOffsets();
    const winStart = table._windowStartRow;
    
    myLog("info", `Total rows fetched: ${data.length}, winStart: ${winStart}`);
    
    // Find all 'Current' account rows
    const currentRows = [];
    let sumClearedActivity2027 = 0;
    let sumClearedAccount2027 = 0;
    
    data.forEach((row, idx) => {
      const pRow = winStart + idx;
      const acc = String(row[cols.account] || "").trim();
      if (acc.toUpperCase() !== "CURRENT") return;
      
      const fy = String(row[cols.fy] || "").trim();
      const type = String(row[cols.entryType] || "").trim().toUpperCase();
      const cleared = (row[cols.cleared] === true || String(row[cols.cleared]).trim().toUpperCase() === "TRUE");
      const amount = Number(row[cols.amount] || 0);
      const isLastBal = (row[cols.lastBalance] === true || String(row[cols.lastBalance]).trim().toUpperCase() === "TRUE");
      const balance = Number(row[cols.balance] || 0);
      const pk = String(row[cols.pk] || "");
      const date = String(row[cols.date] || "");
      const desc = String(row[cols.description] || "");
      const cat = String(row[cols.category] || "");
      const grp = String(row[cols.group] || "");

      const rowData = { pRow, fy, type, cleared, amount, isLastBal, balance, pk, date, desc, cat, grp };
      currentRows.push(rowData);
      
      let matchedFY = fy;
      if (matchedFY.length > 4) matchedFY = matchedFY.substring(0, 4);

      if (matchedFY === "2027" && cleared) {
        if (type === "ACTIVITY") {
          sumClearedActivity2027 += amount;
        } else if (type === "ACCOUNT") {
          sumClearedAccount2027 += amount;
        }
      }
    });
    
    myLog("info", `Sum of Cleared ACTIVITY for Current in FY2027: £${sumClearedActivity2027.toFixed(2)}`);
    myLog("info", `Sum of Cleared ACCOUNT for Current in FY2027: £${sumClearedAccount2027.toFixed(2)}`);
    
    myLog("info", "--- ALL Cleared Rows for Current in FY2027 ---");
    currentRows.forEach(r => {
      let matchedFY = r.fy;
      if (matchedFY.length > 4) matchedFY = matchedFY.substring(0, 4);
      if (matchedFY === "2027" && r.cleared) {
        myLog("info", `Row ${r.pRow}: FY=${r.fy}, Type=${r.type}, Amount=£${r.amount.toFixed(2)}, Group=${r.grp}, PK=${r.pk}`);
      }
    });
    
    // Find LastBalance rows for Current
    const lastBals = currentRows.filter(r => r.isLastBal);
    myLog("info", "--- Last Balance Rows for Current ---");
    lastBals.forEach(r => {
      myLog("info", `Row ${r.pRow}: FY=${r.fy}, Date=${r.date}, Balance=£${r.balance.toFixed(2)}, PK=${r.pk}`);
    });
    
    // Find any rows with amount +/- 29.99
    const match2999 = currentRows.filter(r => Math.abs(Math.abs(r.amount) - 29.99) < 0.01);
    myLog("info", "--- Rows matching +/- 29.99 ---");
    match2999.forEach(r => {
      myLog("info", `Row ${r.pRow}: FY=${r.fy}, Type=${r.type}, Cleared=${r.cleared}, Date=${r.date}, Amount=£${r.amount.toFixed(2)}, PK=${r.pk}, Group=${r.grp}, Desc=${r.desc}`);
    });
    
    // Let's also check if there are any rows around the FY2026/FY2027 transition
    // E.g., rows from 10940 to 10950
    myLog("info", "--- Detailed rows (10940 to 10950) ---");
    currentRows.forEach(r => {
      if (r.pRow >= 10940 && r.pRow <= 10950) {
        myLog("info", `Row ${r.pRow}: FY=${r.fy}, Type=${r.type}, Cleared=${r.cleared}, Date=${r.date}, Amount=£${r.amount.toFixed(2)}, Balance=£${r.balance.toFixed(2)}, LastBal=${r.isLastBal}, PK=${r.pk}`);
      }
    });
    
  } catch (e) {
    myLog("error", `Debug failed: ${e.message}`);
    if (e.stack) myLog("error", e.stack);
  }
}
