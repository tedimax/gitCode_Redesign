"use strict";

/**
 * gitCode_Redesign - Entry Points
 * Primary UI triggers for annual reporting.
 */

/**
 * Entry Point: Runs the report for the current active sheet.
 * Checks if the active sheet belongs to an annual report context.
 */
function runActiveAnnualSheet() {
  initialize();
  const activeSheet = SpreadsheetApp.getActiveSheet();
  const sheetName = activeSheet.getName();
  
  // Validate if it's a 4-digit year
  const yearMatch = sheetName.match(/^\d{4}$/);
  if (!yearMatch) {
    throw new Error(`Active context error: The sheet "${sheetName}" is not a valid annual report sheet. Please switch to a sheet named with a 4-digit year (e.g., 2023).`);
  }
  
  const year = Number(yearMatch[0]);
  myLog("info", "Entry Point: running active annual sheet for year %d", year);
  _runAnnualReportForYear(year); 
}

/**
 * Entry Point: Batch run for all years.
 * Forces SourceFirstRow to 2 for the full scan.
 */
function runAllAnnualReports() {
  initialize();
  const startYear = 2016;
  const endYear = 2027;
  
  myLog("info", "Entry Point: Starting batch run for all years (%d to %d)", startYear, endYear);
  
  for (let year = startYear; year <= endYear; year++) {
    _runAnnualReportForYear(year, 2); // Force SourceFirstRow to 2
  }
  
  myLog("info", "Entry Point: Batch run complete.");
}

// Individual year entry points
function runYear2016() { _runAnnualReportForYear(2016); }
function runYear2017() { _runAnnualReportForYear(2017); }
function runYear2018() { _runAnnualReportForYear(2018); }
function runYear2019() { _runAnnualReportForYear(2019); }
function runYear2020() { _runAnnualReportForYear(2020); }
function runYear2021() { _runAnnualReportForYear(2021); }
function runYear2022() { _runAnnualReportForYear(2022); }
function runYear2023() { _runAnnualReportForYear(2023); }
function runYear2024() { _runAnnualReportForYear(2024); }
function runYear2025() { _runAnnualReportForYear(2025); }
function runYear2026() { _runAnnualReportForYear(2026); }
function runYear2027() { _runAnnualReportForYear(2027); }

/**
 * Core Orchestrator
 * Uses the year-specific configuration defined in the Registry (e.g., AnnualSummaries_2023).
 * Fails fast if the configuration is missing.
 * @param {number} year
 * @param {number|null} forceSourceFirstRow - Optional override for batch runs.
 */
function _runAnnualReportForYear(year, forceSourceFirstRow = null) {
  initialize();
  
  // 1. Resolve the Year-Specific LongName (Fail Fast)
  const longName = `AnnualSummaries_${year}`;
  const config = Registry.getSheetConfig(longName);
  
  if (!config || !config.LongName) {
    throw new Error(`Registry Failure: Configuration for '${longName}' was not found. Every annual report year must have a corresponding entry in the Sheets registry (e.g. LongName = AnnualSummaries_${year}).`);
  }

  // 2. Resolve Spreadsheet
  const ssName = config.SpreadSheetName || "AnnualSummaries";
  const ssid = globals.ssMap.get(ssName);
  if (!ssid) {
    throw new Error(`Bootstrap Failure: Spreadsheet "${ssName}" not found in SSID Map. Please check your "NewAccounts_Sheets" configuration.`);
  }

  const ss = SpreadsheetApp.openById(ssid);

  // 3. Construct Runtime Properties
  const props = Object.assign({}, config, {
    SheetName: String(year), // Ensure the physical sheet is named exactly as the year
    CreateIfMissing: true,
    year: year,
    FullLoad: false,         // Optimized backward scan
    ImportMethod: "replace"   // Ensure we overwrite existing sheets
  });

  if (forceSourceFirstRow !== null) {
    props.SourceFirstRow = forceSourceFirstRow;
    myLog("info", "Orchestration: Forcing SourceFirstRow override to %d", forceSourceFirstRow);
  }

  myLog("info", "Orchestrating Annual Report for FY%d using registry configuration '%s'.", year, longName);

  // 4. Instantiate and Run
  const engine = new AnnualSheet(ss, longName, props);
  engine.runSync();
  
  myLog("info", "Annual Report for %d complete.", year);
}
