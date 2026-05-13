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
    if (properties.SourceFirstRow) {
      sourceTable.firstDataRowIndex = Number(properties.SourceFirstRow);
      myLog("info", "AnnualSheet: Forcing SourceFirstRow override -> %d", sourceTable.firstDataRowIndex);
    }
    const namesTable = getSheetInstance(properties.NamesSheet || CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE);


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
  prepare(yearArg) {
    const targetYear = yearArg || this._config.year || this.sheetName.split("_")[0];
    myLog("info", "AnnualSheet: Orchestrating report for %s", targetYear);

    // 1. Load Facts (Strategy: Configurable Load)
    const start = Date.now();
    const isFullLoad = this._config.FullLoad === true || this._config.FullLoad === "true";
    
    if (isFullLoad) {
      this.ledger.loadFull();
    } else {
      this.ledger.loadYear(targetYear);
    }
    
    const facts = this.ledger.getFacts();
    const loadMode = isFullLoad ? "Full Scan" : "Targeted Scan";
    myLog("info", "Performance: %s for %s took %dms.", loadMode, targetYear, Date.now() - start);

    if (!facts || facts.yearlyData.size === 0) return [];

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

  _applyStyles(snapshot = [], sheetNameOverride = null) {
    const startRow = Math.max(1, this.firstDataRowIndex || 2);
    const numRows = snapshot.length;
    if (numRows === 0) return;

    const targetSheet = sheetNameOverride ? this.ss.getSheetByName(sheetNameOverride) : this.sheet;
    if (!targetSheet) {
      throw new Error(`AnnualSheet Rendering Error: Target sheet '${sheetNameOverride || this.sheetName}' not found. Cannot apply styles.`);
    }

    targetSheet.clear();
    targetSheet.clearFormats();
    targetSheet.setHiddenGridlines(true);
    targetSheet.getRange(startRow, 1, numRows, 4).setValues(snapshot);
    SpreadsheetApp.flush();

    const dataRange = targetSheet.getRange(startRow, 1, numRows, 4);
    dataRange.setFontFamily("Montserrat").setFontSize(10).setHorizontalAlignment("right").setVerticalAlignment("middle");

    this.renderer.styleInstructions.forEach(instr => {
      const s = this.STYLE_MAP[instr.styleId];
      if (!s) return;

      const range = targetSheet.getRange(startRow + instr.range.rowOffset, instr.range.col, instr.range.numRows, instr.range.numCols);
      
      Object.entries(s).forEach(([key, val]) => {
        switch (key) {
          case "merge": if (val) range.merge(); break;
          case "fontSize": range.setFontSize(val); break;
          case "fontWeight": range.setFontWeight(val); break;
          case "fontStyle": range.setFontStyle(val); break;
          case "fontColor": range.setFontColor(val); break;
          case "background": range.setBackground(val); break;
          case "border": if (val) range.setBorder(true, null, true, null, null, null, "black", SpreadsheetApp.BorderStyle.SOLID); break;
          case "numberFormat": range.setNumberFormat(val); break;
          case "horizontalAlignment": range.setHorizontalAlignment(val); break;
        }
      });
    });

    // Apply Layout & Bulk Formatting from constants
    const dr = REPORT_LAYOUT.DATA_REGION;
    const dataStyle = REPORT_STYLE_MAP[dr.styleId];
    if (dataStyle && dataStyle.numberFormat) {
      this.sheet.getRange(startRow + dr.rowOffset, dr.col, numRows - dr.rowOffset, dr.numCols)
        .setNumberFormat(dataStyle.numberFormat);
    }

    REPORT_LAYOUT.COLUMN_WIDTHS.forEach(conf => {
      if (conf.count) this.sheet.setColumnWidths(conf.index, conf.count, conf.width);
      else this.sheet.setColumnWidth(conf.index, conf.width);
    });
  }

  get STYLE_MAP() {
    return REPORT_STYLE_MAP;
  }
}

// Register with globals
globals.tableMap['AnnualSheet'] = AnnualSheet;
