"use strict";

/**
 * gitCode_Redesign - UnionTable (Level 3 Virtual)
 * A virtual source sheet that concatenates multiple tables vertically.
 * Used as a "Driver" for merged reports.
 */
class UnionTable extends Table {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    this._sourceInstances = [];
    this._boundaries = []; // { name, start, end }
    this._isInitialized = false;
  }

  /**
   * Orchestration: Resolves all source table instances from the physical sheet.
   */
  _ensureSources() {
    if (this._isInitialized) return;

    // 1. Fetch physical config data (bypassing overridden getWindow)
    Sheet.prototype.fetch.call(this, this.firstDataRowIndex);
    const configData = [...this._window]; 
    this.clearCache(); // Reset so Union logic can take over this._window later

    // 2. Fetch headers from physical sheet (Row 1)
    const lastCol = this.sheet.getLastColumn();
    if (lastCol === 0) {
      throw new Error(`UnionTable Failure: The physical configuration sheet for ${this.longName} is completely empty.`);
    }
    const headers = this.sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const sourceColOffset = headers.findIndex(h => String(h).trim().toLowerCase() === "source");

    if (sourceColOffset === -1) {
      throw new Error(`UnionTable Failure: The physical configuration sheet for ${this.longName} is missing the required 'Source' column.`);
    }

    // 3. Extract source names
    const sourceNames = [];
    configData.forEach(row => {
      const sourceName = row[sourceColOffset];
      if (sourceName && String(sourceName).trim() !== "") {
        sourceNames.push(String(sourceName).trim());
      }
    });

    if (sourceNames.length === 0) {
      throw new Error(`UnionTable Failure: No sources defined in the 'Source' column of ${this.longName}.`);
    }

    let currentOffset = 0;
    this._sourceInstances = sourceNames.map(name => {
      const instance = getSheetInstance(name);
      if (!instance) throw new Error(`UnionTable Failure: Source table '${name}' not found.`);
      
      const start = currentOffset;
      const length = instance.windowDataLength;
      currentOffset += length;
      
      this._boundaries.push({ 
        name: instance.longName, 
        start: start, 
        end: currentOffset - 1 
      });

      return instance;
    });

    this._isInitialized = true;
    this._labels = null; // Clear the physical ["Source"] label so getLabels() rebuilds the virtual schema
    
    // Calculate initial combined length for logging
    const totalRows = this._sourceInstances.reduce((sum, s) => sum + s.windowDataLength, 0);
    myLog("info", "UnionTable %s: Initialized with %d sources (%d total rows detected). Sources: %s", 
      this.longName, this._sourceInstances.length, totalRows, sourceNames.join(", "));
  }

  /**
   * Returns the name of the source sheet for a given absolute row offset.
   * @param {number} rowOff Absolute row index in the union.
   * @returns {string} The sheet name (e.g. "Cash").
   */
  getSourceName(rowOff) {
    this._ensureSources();
    const boundary = this._boundaries.find(b => rowOff >= b.start && rowOff <= b.end);
    return boundary ? boundary.name : "";
  }

  getWindow() {
    this._ensureSources();
    
    const unionLabels = this.getLabels();
    
    // Concatenate all windows, but align their columns to the unionLabels!
    this._window = this._sourceInstances.reduce((acc, source) => {
      const sourceLabels = source.getLabels();
      const sourceWindow = source.getWindow();
      
      // If the source has the exact same labels in the exact same order, we don't need alignment
      const isAlreadyAligned = sourceLabels.length === unionLabels.length && 
        sourceLabels.every((l, idx) => l === unionLabels[idx]);
        
      if (isAlreadyAligned) {
        return acc.concat(sourceWindow);
      }
      
      // Map columns from source to union indices
      const colMap = unionLabels.map(label => {
        if (label === "Source") return -2;
        if (label === "PK") return -3;
        return source.getColOffset(label);
      });
      
      const alignedWindow = sourceWindow.map(row => {
        return colMap.map(offset => {
          if (offset === -2) return source.longName;
          if (offset === -3) return source.getRowKey(row) || "";
          return offset !== -1 ? row[offset] : "";
        });
      });
      
      return acc.concat(alignedWindow);
    }, []);

    this.windowDataLength = this._window.length;
    this._isFetched = true;
    return this._window;
  }

  /**
   * Physical Row count helper.
   */
  getLastRowIndex() {
    this._ensureSources();
    const totalDataRows = this._sourceInstances.reduce((sum, source) => {
      return sum + source.windowDataLength;
    }, 0);
    
    return (this.firstDataRowIndex - 1) + totalDataRows;
  }

  /**
   * Overrides getLabels to reflect the union of schemas from all sources.
   */
  getLabels() {
    this._ensureSources();
    if (!this._labels || this._labels.length === 0) {
      const allLabels = new Set();
      allLabels.add("Source");
      allLabels.add("PK");
      this._sourceInstances.forEach(source => {
        const sourceLabels = source.getLabels();
        myLog("info", "UnionTable Source [%s] labels: %s", source.longName, JSON.stringify(sourceLabels));
        sourceLabels.forEach(label => {
          if (label) {
            allLabels.add(String(label).trim());
          }
        });
      });
      this._labels = Array.from(allLabels);
      this._columnMap = new Map(
        this._labels.map((label, offset) => [label, offset])
      );
      myLog("info", "UnionTable Combined labels: %s", JSON.stringify(this._labels));
    }
    return this._labels;
  }

  /**
   * Memory management.
   */
  flushMemory() {
    super.flushMemory();
    this._sourceInstances.forEach(s => s.flushMemory());
    this._isInitialized = false;
  }
}

// Register with globals
globals.tableMap['UnionTable'] = UnionTable;
