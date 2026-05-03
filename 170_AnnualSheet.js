"use strict";

/**
 * gitCode_Redesign - AnnualSheet (Level 4 Orchestrator)
 * A "Read-Once, Report-Many" Financial Fact Engine Orchestrator.
 * 
 * Composition:
 * - AnnualLedger: Ingestion and Fact Caching.
 * - AnnualReporter: Analysis and Report Generation.
 * - AnnualRenderer: Layout and Matrix Generation.
 */
class AnnualSheet extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);

    // 1. Initialize Sub-Services (Composition)
    const sourceTable = getSheetInstance(properties.SourceSheet || CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE);
    const namesTable = getSheetInstance(properties.NamesSheet || CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE);

    // --- CRITICAL OVERRIDE ---
    // The Fact Engine must scan the entire ledger history to build correct balances.
    // We ignore any registry settings and force a start at Row 2.
    sourceTable.firstDataRowIndex = 2;
    sourceTable.flushMemory();

    this.ledger = new AnnualLedger(sourceTable, namesTable);
    this.reporter = new AnnualReporter();
    this.renderer = new AnnualRenderer(this.STYLE_MAP);
  }

  /**
   * Orchestration: Clears caches and forces a full data reload.
   */
  refresh() {
    this.ledger.refresh();
  }

  /**
   * Orchestration: Generates a 2D matrix for a specific year.
   */
  importData(yearArg) {
    const targetYear = yearArg || this._config.year || this.sheetName.split("_")[0];
    myLog("info", "AnnualSheet: Orchestrating report for %s", targetYear);

    // 1. Get Facts from Ledger (Scan once, cache forever)
    const start = Date.now();
    const facts = this.ledger.getFacts();
    myLog("info", "Performance: Ingestion (10k+ rows) took %dms.", Date.now() - start);

    if (!facts) return [];

    // 2. Analyze the facts for the specific year
    const analysisStart = Date.now();
    const report = this.reporter.getYearlyReport(facts, targetYear);
    myLog("info", "Performance: Longitudinal Analysis (11 years) took %dms.", Date.now() - analysisStart);
    
    if (!report) {
      const available = Array.from(facts.yearlyData.keys()).sort().join(", ");
      throw new Error(`AnnualReporter: No data found for year "${targetYear}". Records found for: [${available}].`);
    }

    // 3. Render matrix from Renderer
    const matrix = this.renderer.render(report, this._config.layout || "standard");

    return matrix;
  }

  /**
   * Orchestration: Applies styles using Renderer's instructions.
   */
  afterSync(stats, newData) {
    this._applyStyles(newData);
  }

  // =========================================================================
  // PERSISTENCE LAYER (Sheet-Specific Styles)
  // =========================================================================

  _applyStyles(snapshot = []) {
    const startRow = Math.max(1, this.firstDataRowIndex || 2);
    const numRows = snapshot.length;
    if (numRows === 0) return;

    this.sheet.clear();
    this.sheet.clearFormats();
    this.sheet.setHiddenGridlines(true);
    this.sheet.getRange(startRow, 1, numRows, 4).setValues(snapshot);
    SpreadsheetApp.flush();

    const dataRange = this.sheet.getRange(startRow, 1, numRows, 4);
    dataRange.setFontFamily("Montserrat").setFontSize(10).setHorizontalAlignment("right").setVerticalAlignment("middle");

    const styleMap = this.STYLE_MAP;
    this.renderer.styleInstructions.forEach(instr => {
      const r = instr.range;
      const s = styleMap[instr.styleId];
      if (!s) return;
      const range = this.sheet.getRange(startRow + r.rowOffset, r.col, r.numRows, r.numCols);
      if (s.merge) range.merge();
      if (s.fontSize) range.setFontSize(s.fontSize);
      if (s.fontWeight) range.setFontWeight(s.fontWeight);
      if (s.fontStyle) range.setFontStyle(s.fontStyle);
      if (s.horizontalAlignment) range.setHorizontalAlignment(s.horizontalAlignment);
      if (s.fontColor) range.setFontColor(s.fontColor);
      if (s.numberFormat) range.setNumberFormat(s.numberFormat);
    });

    const currencyFormat = "£#,##0.00;[Red]-£#,##0.00;\"\"";
    this.sheet.getRange(startRow + 2, 2, numRows - 2, 3).setNumberFormat(currencyFormat);
    this.sheet.setColumnWidth(1, 280);
    this.sheet.setColumnWidths(2, 4, 120);
  }

  get STYLE_MAP() {
    return {
      "title": { fontSize: 14, fontWeight: "bold", horizontalAlignment: "center", merge: true },
      "sectionHeader": { fontSize: 12, fontWeight: "bold", horizontalAlignment: "right" },
      "columnHeader": { fontSize: 12, fontWeight: "bold", horizontalAlignment: "right" },
      "columnHeaderLabel": { fontSize: 10, fontWeight: "normal", horizontalAlignment: "right" },
      "categoryHeader": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right" },
      "categoryValue": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right" },
      "categoryValueRed": { fontSize: 10, fontWeight: "bold", fontStyle: "italic", horizontalAlignment: "right", fontColor: "red" },
      "grandTotalValue": { fontWeight: "bold" },
      "grandTotalValueRed": { fontWeight: "bold", fontColor: "red" },
      "expenditureValue": { fontColor: "red" },
      "alert": { fontColor: "red", fontWeight: "bold" },
      "alertNormal": { fontColor: "red" },
      "redFont": { fontColor: "red" },
      "blackFont": { fontColor: "black" },
      "currency": { numberFormat: "£#,##0.00;[Red]-£#,##0.00;\"\"" }
    };
  }
}

// Register with globals
globals.tableMap['AnnualSheet'] = AnnualSheet;
