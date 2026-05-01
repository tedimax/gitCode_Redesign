"use strict";

/**
 * gitCode_Redesign - AnnualSheet (Level 4)
 * Generates dynamic, formula-driven financial summaries.
 * Replaces the complex multi-pivot system with streamlined Sheets formulas.
 */
class AnnualSheet extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    // Ensure properties from CustomConfig (JSON string in registry) are parsed and available
    if (properties.CustomConfig) {
      try {
        const custom = JSON.parse(properties.CustomConfig);
        Object.assign(properties, custom);
      } catch (e) {
        myLog("error", "Failed to parse CustomConfig for %s: %s", longName, e.message);
      }
    }

    super(ss, longName, properties);
    this.year = properties.year || this.sheetName.split("_")[0]; // Prioritize explicit year
    this.yearLabel = "_" + this.year;

    // Metadata Configuration
    this.sourceLongName = properties.SourceSheet || CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_SOURCE_TABLE;
    this.namesLongName = properties.NamesSheet || CONFIG_CONSTANTS.DEFAULT_ANNUAL_SUMMARY_NAMES_TABLE;

    this.styleInstructions = []; // Collection of { range, styleId }
  }

  /**
   * Defines the visual structure of the Annual Sheet.
   */
  getReportDefinition() {
    return {
      sections: [
        {
          id: "TitleSection",
          rows: [
            { cells: [{ value: "Swarraton and Northington Village Hall", span: 4, style: "title" }] },
            { cells: [{ value: "{{year}} Financial Year", span: 4, style: "title" }] },
            { type: "spacer" }
          ]
        },
        {
          id: "AssetsSection",
          rows: [
            { 
              cells: [
                { value: "Accounts", style: "sectionHeader" },
                { key: "assets.status", style: "alertNormal" },
                { key: "assets.diff", style: "alertNormal" },
                { key: "assets.total", style: "sectionHeader" }
              ]
            },
            {
              type: "repeater",
              dataKey: "accounts",
              cells: [
                { key: "name" },
                { key: "status", style: "alertNormal" },
                { key: "diff", style: "diffStyle" },
                { key: "balance" }
              ]
            },
            { type: "spacer" }
          ]
        },
        {
          id: "TransactionsSection",
          rows: [
            { 
              cells: [
                { value: "{{year}}", style: "columnHeaderLabel" },
                { value: "Income", style: "columnHeader" },
                { value: "Expenditure", style: "columnHeader" },
                { value: "Net", style: "columnHeader" }
              ]
            },
            {
              cells: [
                { value: "Grand Total", style: "sectionHeader" },
                { key: "totals.grandIn", style: "grandTotalValue" },
                { key: "totals.grandOut", style: "grandTotalValueRed" },
                { key: "totals.grandNet", style: "grandTotalValue" }
              ]
            },
            {
              type: "groupRepeater",
              dataKey: "categoryTypes",
              rows: [
                {
                  cells: [
                    { key: "groupLabel", style: "categoryHeader" },
                    { key: "groupIn", style: "categoryValue" },
                    { key: "groupOut", style: "categoryValueRed" },
                    { key: "groupNet", style: "categoryValue" }
                  ]
                },
                {
                  type: "repeater",
                  dataKey: "categories",
                  cells: [
                    { key: "name" },
                    { key: "in" },
                    { key: "out", style: "expenditureValue" },
                    { key: "net" }
                  ]
                },
                { type: "spacer" }
              ]
            }
          ]
        },
        {
          id: "ChecksSection",
          rows: [
            { cells: [{ value: "Balance", style: "sectionHeader" }] }
          ]
        }
      ]
    };
  }

  /**
   * Maps style IDs to Google Sheets formatting properties.
   */
  static get REPORT_CONFIG() {
    return {
      DISPLAY_LABELS: { 
        "SOCIAL": "Social Events", 
        "GENERAL": "General", 
        "TRANSFERS": "Transfers" 
      },
      TRANSFER_KEYWORD: "TRANSFER",
      HIDDEN_TYPES: ["IDENTIFIERS"]
    };
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

  _renderReport(definition, context) {
    const newData = [];
    this.styleInstructions = [];
    const state = { rowIndex: 0 };

    definition.sections.forEach(section => {
      this._processRows(section.rows, context, newData, state);
    });

    return newData;
  }

  /**
   * Recursively processes row definitions.
   */
  _processRows(rowDefs, context, matrix, state) {
    rowDefs.forEach(rowDef => {
      switch (rowDef.type) {
        case "spacer":
          matrix.push(["", "", "", ""]);
          state.rowIndex++;
          break;

        case "repeater":
          const items = this._resolveKey(context, rowDef.dataKey) || [];
          items.forEach(item => {
            this._renderRow(rowDef, item, state.rowIndex, matrix);
            state.rowIndex++;
          });
          break;

        case "groupRepeater":
          const groups = this._resolveKey(context, rowDef.rowKey || rowDef.dataKey) || [];
          groups.forEach(group => {
            this._processRows(rowDef.rows, group, matrix, state);
          });
          break;

        default:
          this._renderRow(rowDef, context, state.rowIndex, matrix);
          state.rowIndex++;
      }
    });
  }

  _renderRow(rowDef, context, rowIdx, matrix) {
    const rowData = new Array(4).fill("");
    let currentCol = 1;

    rowDef.cells.forEach(cellDef => {
      let val = "";
      let styleId = cellDef.style;

      if (cellDef.value !== undefined) {
        val = this._interpolate(cellDef.value, context);
      } else if (cellDef.key !== undefined) {
        val = this._resolveKey(context, cellDef.key);
      }

      // Special handling for dynamic diff styles
      if (cellDef.key === "diff" && context.diffStyle) {
        styleId = context.diffStyle;
      }

      const span = cellDef.span || 1;
      rowData[currentCol - 1] = val;

      if (styleId) {
        this.styleInstructions.push({
          range: { rowOffset: rowIdx, col: currentCol, numRows: 1, numCols: span },
          styleId: styleId
        });
      }

      currentCol += span;
    });

    matrix.push(rowData);
    return rowData;
  }

  _interpolate(template, context) {
    if (typeof template !== "string") return template;
    return template.replace(/{{(.*?)}}/g, (match, key) => {
      return this._resolveKey(context, key.trim()) || "";
    });
  }

  _resolveKey(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((prev, curr) => prev ? prev[curr] : undefined, obj);
  }


  /**
   * Overrides UpdateTable.afterSync
   * Applies styles after the data is committed but before RAM is flushed.
   */
  afterSync(stats, newData) {
    myLog("info", "AnnualSheet: Post-sync styling triggered.");
    this._applyStyles(newData);
  }

  /**
   * Populates the internal _newData matrix for the report.
   */
  importData() {
    myLog("info", "Generating Dynamic Annual Summary for %s", this.year);

    const sourceTable = getSheetInstance(this.sourceLongName);
    const namesTable = getSheetInstance(this.namesLongName);

    // Respect the configuration for firstRow while ensuring a fresh fetch.
    // Prioritize the AnnualSheet's own property override over the ledger's registry default.
    if (sourceTable) {
      const registryConfig = Registry.getSheetConfig(this.sourceLongName);
      sourceTable.firstDataRowIndex = Number(this._config.firstRow) || Number(registryConfig.FirstRow) || 2;
      sourceTable.flushMemory(); 
    }

    this.sourceLongName = sourceTable ? sourceTable.longName : "AnnualSummaries_Merged";
    this.namesLongName = namesTable ? namesTable.longName : "AnnualSummaries_Names";

    // 1. Build Data Context
    const context = this._getContext(sourceTable, namesTable);

    // 2. Render using the definition
    const definition = this.getReportDefinition();
    const newData = this._renderReport(definition, context);

    return newData;
  }





  _applyStyles(snapshot = []) {
    myLog("info", "STYLING: Applying declarative instructions.");
    const startRow = Math.max(1, this.firstDataRowIndex || 2);
    const numRows = snapshot.length;
    if (numRows === 0) return;

    this.sheet.clear();
    this.sheet.clearFormats();
    this.sheet.setHiddenGridlines(true);

    // 1. Write Data
    this.sheet.getRange(startRow, 1, numRows, 4).setValues(snapshot);
    SpreadsheetApp.flush();

    // 2. Montserrat 10pt Base + Right Justification (Default)
    const dataRange = this.sheet.getRange(startRow, 1, numRows, 4);
    dataRange.setFontFamily("Montserrat").setFontSize(10).setHorizontalAlignment("right").setVerticalAlignment("middle");

    // 3. Apply Instructions
    const styleMap = this.STYLE_MAP;
    this.styleInstructions.forEach(instr => {
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

    // 4. Default Currency for numeric columns
    const currencyFormat = "£#,##0.00;[Red]-£#,##0.00;\"\"";
    this.sheet.getRange(startRow + 2, 2, numRows - 2, 3).setNumberFormat(currencyFormat);

    this.sheet.setColumnWidth(1, 280);
    this.sheet.setColumnWidths(2, 4, 120);
  }

  _getContext(sourceTable, namesTable) {
    const assetsData = this._getAssetsData(sourceTable);
    const transactionsData = this._getTransactionsData(sourceTable, namesTable);

    return {
      year: this.year,
      orgName: "Swarraton and Northington Village Hall",
      assets: assetsData.summary,
      accounts: assetsData.accounts,
      totals: transactionsData.totals,
      categoryTypes: transactionsData.types,
      ghosts: transactionsData.ghosts,
      debug: {
        source: sourceTable ? sourceTable.sheetName : "NULL",
        fyOff: sourceTable ? sourceTable.getColOffset("FY") : -1,
        amtOff: sourceTable ? sourceTable.getColOffset("Amount") : -1,
        accOff: sourceTable ? sourceTable.getColOffset("Account") : -1,
        pkOff: sourceTable ? sourceTable.getColOffset("PK") : -1,
        ssid: sourceTable ? sourceTable.ss.getId() : "N/A",
        physicalRows: sourceTable ? sourceTable.sheet.getLastRow() : 0
      }
    };
  }

  _getAssetsData(sourceTable) {
    const targetYear = String(this.year);
    const prevYear = String(this.year - 1);
    const data = sourceTable.getWindow();
    
    const amtOff = sourceTable.getColOffset("Amount");
    const accOff = sourceTable.getColOffset("Account");
    const clrOff = sourceTable.getColOffset("Cleared");
    const fyOff = sourceTable.getColOffset("FY");
    const balOff = sourceTable.getColOffset("Balance");
    const lastBalOff = sourceTable.getColOffset("LastBalance");
    const pkOff = sourceTable.getColOffset("PK");
    const catOff = sourceTable.getColOffset("Category");
    const entryTypeOff = sourceTable.getColOffset("EntryType");

    const categoryToType = new Map();
    const namesTable = getSheetInstance(this.namesLongName);
    const namesData = namesTable.getWindow();
    const nameOff = namesTable.getColOffset("Name");
    const typeOff = namesTable.getColOffset("Type");
    namesData.forEach(row => {
      if (row[nameOff]) categoryToType.set(String(row[nameOff]).trim(), String(row[typeOff] || "General").trim());
    });

    // Dynamic Prefix discovery (Fail-Fast)
    const configTable = getSheetInstance(CONFIG_CONSTANTS.SHEETS_CONFIG_NAME);
    const [bankPrefix, cashPrefix, assetPrefix] = ["Ledgers_Bank", "Ledgers_Cash", "Ledgers_Assets"].map(name => {
      const prefix = configTable.lookupValue("LongName", "KeyPrefix", name);
      if (!prefix) throw new Error(`AnnualSheet: Missing KeyPrefix for ${name} in ${CONFIG_CONSTANTS.SHEETS_CONFIG_NAME}`);
      return prefix;
    });

    const prefixes = { bank: bankPrefix, cash: cashPrefix, asset: assetPrefix };
    const accountTruth = new Map();
    let samples = [];

    // Single Pass: Collect data for all potential accounts
    data.forEach(row => {
      const acc = String(row[accOff] || "").trim();
      if (!acc || acc === "undefined" || acc === "null") return;

      // Ensure account exists in our tracking map
      if (!accountTruth.has(acc)) {
        accountTruth.set(acc, { 
          balCurrent: 0, balPrev: 0, ledgerNet: 0, 
          hasPrevEntries: false, hasPrevBalance: false,
          isValidAsset: false 
        });
      }
      const stats = accountTruth.get(acc);

      let rowFY = row[fyOff];
      if (rowFY instanceof Date) {
        rowFY = String(rowFY.getFullYear());
      } else {
        rowFY = String(rowFY || "").trim().split(".")[0].replace(/,/g, "");
      }

      const isMatchTarget = (rowFY === targetYear || rowFY.slice(-2) === targetYear.slice(-2));
      const isMatchPrev = (rowFY === prevYear || rowFY.slice(-2) === prevYear.slice(-2));
      const entryType = entryTypeOff !== -1 ? String(row[entryTypeOff] || "").trim().toUpperCase() : "";

      if (isMatchPrev) stats.hasPrevEntries = true;

      // Identify if this is a Bank, Cash, or Asset account via its ACCOUNT row
      if (entryType === "ACCOUNT") {
        const pk = String(row[pkOff] || "").toUpperCase();
        const isBankKey = pk.startsWith(bankPrefix.toUpperCase()) || pk.startsWith("BOOK");
        const accUpper = acc.toUpperCase();
        const isCash = accUpper.includes(cashPrefix.toUpperCase()) || accUpper.includes("CASH");
        const isAsset = accUpper.includes(assetPrefix.toUpperCase()) || accUpper.includes("ASSET");

        if (isBankKey || isCash || isAsset) stats.isValidAsset = true;
      }

      const amount = Number(row[amtOff]) || 0;
      const balance = Number(row[balOff]) || 0;
      const rawLastBal = String(row[lastBalOff] || "").toUpperCase();
      const isLastBalance = row[lastBalOff] === true || ["TRUE", "YES", "CHECKED", "1", "Y"].includes(rawLastBal);
      const rawClr = String(row[clrOff] || "").toUpperCase();
      const isCleared = row[clrOff] === true || ["TRUE", "YES", "CHECKED", "1", "Y"].includes(rawClr);

      if (entryType === "ACTIVITY" && isMatchTarget && isCleared) {
        stats.ledgerNet += amount;
      }
      
      if (entryType === "ACCOUNT" && isLastBalance) {
        if (isMatchTarget) stats.balCurrent = balance;
        if (isMatchPrev) {
          stats.balPrev = balance;
          stats.hasPrevBalance = true;
        }
      }
    });

    // Final Verification and Filtering
    const accounts = [];
    let totalAccountsBalance = 0;
    let totalLedgerNet = 0;
    let totalBankChange = 0;

    Array.from(accountTruth.keys()).sort().forEach(acc => {
      const stats = accountTruth.get(acc);
      if (!stats.isValidAsset) return; // Only include Bank, Cash, and Asset accounts
      const bankChange = stats.balCurrent - stats.balPrev;
      const discrepancy = stats.ledgerNet - bankChange;
      const isOK = Math.abs(discrepancy) < 0.01;

      totalAccountsBalance += stats.balCurrent;
      totalLedgerNet += stats.ledgerNet;
      totalBankChange += bankChange;

      if (Math.abs(stats.balCurrent) < 0.01 && Math.abs(stats.ledgerNet) < 0.01) return;

      accounts.push({
        name: acc,
        status: isOK ? "" : "Unbalanced",
        diff: isOK ? "" : Math.abs(discrepancy),
        diffStyle: isOK ? null : (discrepancy > 0 ? "blackFont" : "redFont"),
        balance: stats.balCurrent
      });
    });

    const diff = totalLedgerNet - totalBankChange;
    const isBalanced = Math.abs(diff) < 0.01;

    return {
      summary: {
        status: isBalanced ? "" : "Unbalanced",
        diff: isBalanced ? "" : Math.abs(diff),
        total: totalAccountsBalance
      },
      accounts: accounts
    };
  }

  _getTransactionsData(sourceTable, namesTable) {
    const targetYear = String(this.year);
    const amtOff = sourceTable.getColOffset("Amount");
    const catOff = sourceTable.getColOffset("Category");
    const clrOff = sourceTable.getColOffset("Cleared");
    const fyOff = sourceTable.getColOffset("FY");
    const entryTypeOff = sourceTable.getColOffset("EntryType");

    const categoryToType = new Map();
    const namesData = namesTable.getWindow();
    const nameOff = namesTable.getColOffset("Name");
    const typeOff = namesTable.getColOffset("Type");
    namesData.forEach(row => {
      if (row[nameOff]) categoryToType.set(String(row[nameOff]).trim(), String(row[typeOff] || "General").trim());
    });

    const typeStats = {};
    let grandIn = 0, grandOut = 0, grandNet = 0;
    let ghostNet = 0;
    const ghostCats = [];

    sourceTable.getWindow().forEach(row => {
      let rowFY = row[fyOff];
      if (rowFY instanceof Date) {
        rowFY = String(rowFY.getFullYear());
      } else {
        rowFY = String(rowFY || "").trim().split(".")[0].replace(/,/g, "");
      }
      
      const rawClr = String(row[clrOff] || "").toUpperCase();
      const isCleared = row[clrOff] === true || ["TRUE", "YES", "CHECKED", "1", "Y"].includes(rawClr);
      const entryType = String(row[entryTypeOff] || "").trim().toUpperCase();

      if (entryType !== "ACTIVITY" && entryType !== "ACCOUNT") return;
      
      const isMatchTarget = (rowFY === targetYear || rowFY.slice(-2) === targetYear.slice(-2));
      if (!isMatchTarget || !isCleared) return;
      const amount = Number(row[amtOff]) || 0;

      const cat = String(row[catOff] || "").trim();
      if (!cat) return;

      const config = AnnualSheet.REPORT_CONFIG;
      let type = cat.toUpperCase().includes(config.TRANSFER_KEYWORD) ? "Transfers" : categoryToType.get(cat);
      if (type && config.HIDDEN_TYPES.includes(type.toUpperCase())) type = "Transfers";

      if (!type) {
        ghostNet += amount;
        if (!ghostCats.includes(cat)) ghostCats.push(cat);
        return;
      }

      if (!typeStats[type]) typeStats[type] = { in: 0, out: 0, net: 0, categories: {} };
      const s = typeStats[type];
      if (!s.categories[cat]) s.categories[cat] = { name: cat, in: 0, out: 0, net: 0 };
      const c = s.categories[cat];

      if (amount > 0) { s.in += amount; c.in += amount; }
      else { s.out += Math.abs(amount); c.out += Math.abs(amount); }
      s.net += amount; c.net += amount;

      if (type.toUpperCase() !== "TRANSFERS") {
        if (amount > 0) grandIn += amount;
        else grandOut += Math.abs(amount);
        grandNet += amount;
      }
    });

    const orderedTypes = Object.keys(typeStats).sort((a, b) => {
      const A = a.toUpperCase(), B = b.toUpperCase();
      if (A === "SOCIAL") return -1;
      if (B === "SOCIAL") return 1;
      if (A === "TRANSFERS") return 1;
      if (B === "TRANSFERS") return -1;
      return a.localeCompare(b);
    });

    const config = AnnualSheet.REPORT_CONFIG;
    const types = orderedTypes.map(typeKey => {
      const s = typeStats[typeKey];
      return {
        groupLabel: config.DISPLAY_LABELS[typeKey.toUpperCase()] || typeKey,
        groupIn: s.in,
        groupOut: s.out,
        groupNet: s.net,
        categories: Object.values(s.categories).sort((a,b) => a.name.localeCompare(b.name))
      };
    });

    return {
      totals: { grandIn, grandOut, grandNet },
      types: types,
      ghosts: { net: ghostNet, list: ghostCats }
    };
  }
}

// Register with globals
globals.tableMap['AnnualSheet'] = AnnualSheet;
