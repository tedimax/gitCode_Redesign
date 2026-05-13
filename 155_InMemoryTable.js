"use strict";

/**
 * gitCode_Redesign - InMemoryTable (Level 5)
 * A Virtual Table that bypasses physical writes to Google Sheets.
 * Inherits all transformation logic from ImportTable, but commits changes directly to RAM.
 * Ideal for intermediate data pipelines (e.g. File -> Raw -> Clean) where physical persistence
 * of the intermediate steps is a bottleneck.
 */
class InMemoryTable extends ImportTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
  }

  /**
   * Overrides UpdateTable.commit
   * Instead of writing the transformed matrix (this._newData) to the Google Sheets API,
   * it flips it into the readable window matrix (this._window) making it instantly available
   * for downstream tables to use as a SourceSheet.
   */
  commit(newData, mode = "replace") {
    myLog("info", "Committing InMemoryTable %s to RAM (Mode: %s)...", this.longName, mode);

    // Fail-fast: Ensure newData is explicitly provided
    if (!newData) {
      throw new Error(`fail-fast: InMemoryTable.commit() called without newData for ${this.longName}. Data must be explicitly prepared and passed.`);
    }

    if (mode === "add" && this._window) {
      this._window = this._window.concat(newData);
    } else {
      this._window = newData;
    }

    this.windowDataLength = this._window.length;
    
    const stats = {
      added: newData.length,
      updated: 0,
      removed: 0
    };
    
    this._isFetched = true; // Mark as populated

    myLog("info", "InMemoryTable %s committed %d rows to RAM successfully.", this.longName, this.windowDataLength);
    return stats;
  }
}

// Register with globals
globals.tableMap['InMemoryTable'] = InMemoryTable;
