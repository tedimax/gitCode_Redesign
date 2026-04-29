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
  commit(mode = "replace") {
    myLog("info", "Committing InMemoryTable %s to RAM (Mode: %s)...", this.longName, mode);

    if (mode === "add" && this._window) {
      this._window = this._window.concat(this._newData || []);
    } else {
      // replace, update, etc.
      // Note: for pure 'update' logic without a physical sheet, replacing is typically safer
      // since there is no physical state to 'update' against unless it was already fetched.
      this._window = this._newData || [];
    }

    this.windowDataLength = this._window.length;
    
    // Clear out the temporary buffer to free up memory
    const stats = {
      added: this._newData ? this._newData.length : 0,
      updated: 0,
      removed: 0
    };
    
    this._newData = [];
    this._isFetched = true; // Mark as populated

    myLog("info", "InMemoryTable %s committed %d rows to RAM successfully.", this.longName, this.windowDataLength);
    return stats;
  }
}

// Register with globals
globals.tableMap['InMemoryTable'] = InMemoryTable;
