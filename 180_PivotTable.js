"use strict";

/**
 * gitCode_Redesign - PivotTable (Level 3)
 * Manages Native Google Sheets Pivot Tables for Analysis and Drill-down.
 * This class preserves the native "Show Details" functionality you need for auditing.
 * 
 * Example "PivotConfig" JSON Property:
 * {
 *   "rows": ["Category"],
 *   "cols": ["FY"],
 *   "values": [
 *     { "field": "Amount", "summarize": "SUM" }
 *   ],
 *   "filters": {
 *     "Cleared": "TRUE"
 *   },
 *   "showRowTotals": true,
 *   "showColTotals": true
 * }
 */
class PivotTable extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    this.sourceLongName = properties.SourceTable;
    this.anchor = properties.Anchor || "A1";
    this.index = properties.Index || 0;
  }

  /**
   * Overrides importData to refresh/rebuild the physical Pivot Table.
   */
  importData() {
    myLog("info", "Rebuilding Native Pivot Table %s...", this.longName);
    
    // 1. Transactional Lock (Inherited from UpdateTable logic)
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    
    try {
      // 2. Clear existing pivot table at the specified index
      const existingPivots = this.sheet.getPivotTables();
      if (existingPivots.length > this.index) {
        existingPivots[this.index].remove();
      }
      
      // 3. Rebuild from Source
      this._buildPivot();
    } finally {
      lock.releaseLock();
    }
    
    return { added: 1, updated: 0 };
  }

  /**
   * Internal builder using the native SpreadsheetApp Pivot API.
   * Configured via a simple JSON-like property "PivotConfig".
   */
  _buildPivot() {
    const sourceTable = getSheetInstance(this.sourceLongName);
    if (!sourceTable) throw new Error(`Source table ${this.sourceLongName} not found for pivot ${this.longName}`);
    
    const lastRow = sourceTable.sheet.getLastRow();
    const lastCol = sourceTable.sheet.getLastColumn();
    const sourceRange = sourceTable.sheet.getRange(1, 1, lastRow, lastCol);
    
    const pivotTable = this.sheet.getRange(this.anchor).createPivotTable(sourceRange);
    
    // 4. Apply configuration from Registry properties
    const config = this.getProperty("PivotConfig") || {};
    
    // Rows
    (config.rows || []).forEach(row => {
      const colIdx = sourceTable.getColOffset(row) + 1;
      const group = pivotTable.addRowGroup(colIdx);
      group.showTotals(config.showRowTotals !== false);
    });
    
    // Columns
    (config.cols || []).forEach(col => {
      const colIdx = sourceTable.getColOffset(col) + 1;
      const group = pivotTable.addColumnGroup(colIdx);
      group.showTotals(config.showColTotals !== false);
    });
    
    // Values
    (config.values || []).forEach(val => {
      const colIdx = sourceTable.getColOffset(val.field) + 1;
      const summarizeFunction = val.summarize || SpreadsheetApp.PivotTableSummarizeFunction.SUM;
      pivotTable.addPivotValue(colIdx, summarizeFunction);
    });
    
    // Filters (Strictly handles the 'Cleared' requirement)
    const filters = config.filters || {};
    
    // Auto-add Cleared=TRUE filter if not specified otherwise
    if (filters.Cleared === undefined) filters.Cleared = "TRUE";
    
    Object.entries(filters).forEach(([field, value]) => {
      const colIdx = sourceTable.getColOffset(field) + 1;
      const criteria = SpreadsheetApp.newFilterCriteria()
        .setVisibleValues([String(value)])
        .build();
      pivotTable.addFilter(colIdx, criteria);
    });
    
    myLog("info", "Native Pivot Table %s updated with Cleared=%s constraint.", this.longName, filters.Cleared);
  }
}

// Register with globals
globals.tableMap['PivotTable'] = PivotTable;
