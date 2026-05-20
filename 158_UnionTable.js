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
   * Orchestration: Resolves all source table instances.
   */
  _ensureSources() {
    if (this._isInitialized) return;

    const sourcesRaw = this.getProperty("Sources");
    if (!sourcesRaw) {
      throw new Error(`UnionTable Failure: No 'Sources' defined in properties for ${this.longName}. Expected a comma-separated list of LongNames.`);
    }

    const sourceNames = String(sourcesRaw).split(",").map(s => s.trim());
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
      const colMap = unionLabels.map(label => source.getColOffset(label));
      
      const alignedWindow = sourceWindow.map(row => {
        return colMap.map(offset => (offset !== -1 ? row[offset] : ""));
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
   * Overrides getLabels to reflect the schema of the FIRST source.
   */
  getLabels() {
    this._ensureSources();
    const firstLabels = this._sourceInstances[0].getLabels();
    if (firstLabels && firstLabels.length > 0 && (!this._labels || this._labels.length === 0)) {
      this._labels = firstLabels;
      this._columnMap = new Map(
        firstLabels.map((label, offset) => [label, offset]).filter(([label]) => label !== "")
      );
    }
    return firstLabels;
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
