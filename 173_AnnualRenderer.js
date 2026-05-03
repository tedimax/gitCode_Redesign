"use strict";

/**
 * gitCode_Redesign - AnnualRenderer
 * The "Layout Engine" for annual reporting.
 * Responsible for turning report objects into 2D matrices and style instructions.
 */
class AnnualRenderer {
  constructor(styleMap) {
    this.styleMap = styleMap;
    this.styleInstructions = [];
  }

  /**
   * Main entry point: Renders a report object into a matrix.
   */
  render(report, layout = "standard") {
    const newData = [];
    this.styleInstructions = [];
    const state = { rowIndex: 0 };
    const definition = this._getDefinition(report.year, layout);

    definition.sections.forEach(section => {
      this._processRows(section.rows, report, newData, state);
    });

    return newData;
  }

  _processRows(rowDefs, context, matrix, state) {
    rowDefs.forEach(rowDef => {
      switch (rowDef.type) {
        case "spacer":
          matrix.push(["", "", "", ""]);
          state.rowIndex++;
          break;
        case "repeater":
          const items = StringUtils.resolveKey(context, rowDef.dataKey) || [];
          items.forEach(item => {
            this._renderRow(rowDef, item, state.rowIndex, matrix);
            state.rowIndex++;
          });
          break;
        case "groupRepeater":
          const groups = StringUtils.resolveKey(context, rowDef.rowKey || rowDef.dataKey) || [];
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
      if (cellDef.value !== undefined) val = StringUtils.interpolate(cellDef.value, context);
      else if (cellDef.key !== undefined) val = StringUtils.resolveKey(context, cellDef.key);
      if (cellDef.key === "diff" && context.diffStyle) styleId = context.diffStyle;
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

  _getDefinition(year, layout) {
    const structures = this._buildStructures(year);
    const layouts = {
      "standard": [structures.TitleSection, structures.AssetsSection, structures.TransactionsSection, structures.ChecksSection],
      "transactions_only": [structures.TitleSection, structures.TransactionsSection],
      "assets_only": [structures.TitleSection, structures.AssetsSection, structures.ChecksSection]
    };
    return { sections: layouts[layout] || layouts["standard"] };
  }

  _buildStructures(year) {
    return {
      TitleSection: {
        rows: [
          { cells: [{ value: "Swarraton and Northington Village Hall", span: 4, style: "title" }] },
          { cells: [{ value: `${year} Financial Year`, span: 4, style: "title" }] },
          { type: "spacer" }
        ]
      },
      AssetsSection: {
        rows: [
          { cells: [{ value: "Accounts", style: "sectionHeader" }, { key: "assets.status", style: "alertNormal" }, { key: "assets.diff", style: "alertNormal" }, { key: "assets.total", style: "sectionHeader" }] },
          { type: "repeater", dataKey: "accounts", cells: [{ key: "name" }, { key: "status", style: "alertNormal" }, { key: "diff", style: "diffStyle" }, { key: "balance" }] },
          { type: "spacer" }
        ]
      },
      TransactionsSection: {
        rows: [
          { cells: [{ value: year, style: "columnHeaderLabel" }, { value: "Income", style: "columnHeader" }, { value: "Expenditure", style: "columnHeader" }, { value: "Net", style: "columnHeader" }] },
          { cells: [{ value: "Grand Total", style: "sectionHeader" }, { key: "totals.in", style: "grandTotalValue" }, { key: "totals.out", style: "grandTotalValueRed" }, { key: "totals.net", style: "grandTotalValue" }] },
          {
            type: "groupRepeater", dataKey: "categoryGroups", rows: [
              { cells: [{ key: "groupLabel", style: "categoryHeader" }, { key: "groupIn", style: "categoryValue" }, { key: "groupOut", style: "categoryValueRed" }, { key: "groupNet", style: "categoryValue" }] },
              { type: "repeater", dataKey: "categories", cells: [{ key: "name" }, { key: "in" }, { key: "out", style: "expenditureValue" }, { key: "net" }] },
              { type: "spacer" }
            ]
          }
        ]
      },
      ChecksSection: {
        rows: []
      }
    };
  }
}
