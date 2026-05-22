"use strict";

/**
 * gitCode_Redesign - UpdateTable (Level 3)
 * Provides high-performance persistence logic (Replace, Add, Update).
 * Handles batching, dirty-checks, and chunked writes.
 */
class UpdateTable extends Table {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
  }

  /**
   * The Unified Orchestrator.
   * Executes the full ingestion and persistence lifecycle.
   */
  execute() {
    myLog("info", "Starting execution for %s...", this.longName);
    
    // UI Feedback: Toast on Start
    let sourceName = "N/A";
    if (typeof Utils !== 'undefined' && typeof Utils.getSourceSheet === 'function') {
      try {
        const src = Utils.getSourceSheet(this);
        if (src) sourceName = src.longName || src.sheetName || "N/A";
      } catch (e) {
        // Safe bypass
      }
    }
    if (sourceName === "N/A" && this.getProperty("sheettype") === "FileTable") {
      sourceName = this.getProperty("FolderId") || this.getProperty("FileId") || "Google Drive Folder";
    }

    const method = this._modeOverride || (this.getProperty("importmethod") || "replace");
    const startMsg = `Source: ${sourceName}\nMethod: ${method}`;
    const startTitle = `🔄 Importing ${this.longName}...`;
    
    myLog("info", `\n============================================================\n🔄 IMPORT START: ${this.longName}\n   Source: ${sourceName}\n   Method: ${method}\n============================================================`);
    
    try {
      SpreadsheetApp.getActive().toast(startMsg, startTitle, 10);
    } catch (e) {
      myLog("warn", "Failed to display start toast: %s", e.message);
    }

    // 1. Prepare Ingestion (Transformation/Fetch)
    const newData = this.prepare() || [];
    
    // 2. Persist results
    const stats = this.persist(newData);

    // 3. Post-Persistence Hooks (e.g. Styling)
    this.afterSync(stats, newData);
    
    // 4. Final Cleanup
    this.flushMemory();
    
    myLog("info", "Execution complete for %s. Stats: %s", this.longName, JSON.stringify(stats));

    // UI Feedback: Toast on Finish
    let finishMsg = "No changes (Up to date)";
    if (stats) {
      const modeStr = String(stats.mode || method).toLowerCase();
      if (modeStr === "replace" || modeStr === "replacerows" || (stats.added > 0 && stats.updated === 0 && stats.deleted === 0)) {
        finishMsg = `Replaced: ${stats.added || 0} rows`;
      } else {
        const parts = [];
        if (stats.added) parts.push(`Added: ${stats.added}`);
        if (stats.updated) parts.push(`Updated: ${stats.updated}`);
        if (stats.deleted) parts.push(`Deleted: ${stats.deleted}`);
        finishMsg = parts.length ? parts.join(", ") : "No changes (Up to date)";
      }
    }
    const finishTitle = `✅ Complete: ${this.longName}`;
    
    myLog("info", `\n============================================================\n✅ IMPORT COMPLETE: ${this.longName}\n   Status: ${finishMsg}\n============================================================`);
    
    try {
      SpreadsheetApp.getActive().toast(finishMsg, finishTitle, 5);
    } catch (e) {
      myLog("warn", "Failed to display finish toast: %s", e.message);
    }

    return stats;
  }

  /**
   * Post-Sync Hook.
   * Overridden by subclasses to perform styling or additional logic before RAM is flushed.
   */
  afterSync(stats, newData) {
    // No-op base
  }

  /**
   * Preparation phase.
   * Overridden by subclasses (e.g., AnnualSheet, ImportTable) to gather or transform data.
   */
  prepare() {
    myLog("trace", "Base UpdateTable: No preparation logic defined for %s. Returning empty matrix.", this.longName);
    return [];
  }

  /**
   * Main entry point for persistence.
   * @param {Array<Array<any>>} newData - The matrix of row data to write.
   * @param {string} mode - 'replace', 'update', or 'add'. Defaults to instance override or props.importmethod.
   */
  persist(newData, mode = this._modeOverride || (this.getProperty("importmethod") || "replace")) {
    myLog("info", "Persisting changes to %s using mode: %s", this.longName, mode);

    // Fail-fast: Ensure newData is explicitly provided
    if (!newData) {
       throw new Error(`fail-fast: persist() called without newData for ${this.longName}. Data must be explicitly prepared and passed.`);
    }

    // --- IN-MEMORY OVERRIDE ---
    if (this._isInMemory) {
      myLog("info", "In-Memory Mode: Skipping physical write for %s. Data stored in buffer (%d rows).", this.longName, newData.length);
      this._buffer = newData;
      return { mode: "in-memory", total: newData.length, added: 0, updated: 0, deleted: 0 };
    }


    // 1. Transactional Locking: Prevent concurrent syncs from corrupting data
    const lock = LockService.getScriptLock();
    try {
      // Wait for up to 30 seconds for the lock
      lock.waitLock(30000);
    } catch (e) {
      throw new Error(`Could not acquire script lock for ${this.longName}. Another sync may be in progress. Details: ${e.message}`);
    }

    try {
      // 3. Route to specific persistence logic
      let stats = { added: 0, updated: 0 };
      const normalizedMode = mode.toLowerCase();

      switch (normalizedMode) {
        case "replace":
        case "replacerows":
          stats = this._persistReplace(newData);
          break;
        case "add":
        case "addrows":
          stats = this._persistAdd(newData);
          break;
        case "update":
        case "updaterows":
          stats = this._persistUpdate(newData);
          break;
        default:
          throw new Error(`Persistence Error: Unknown persistence mode '${mode}' for ${this.longName}. Valid modes are 'replaceRows', 'addRows', or 'updateRows'.`);
      }

      const isReplace = normalizedMode === "replace" || normalizedMode === "replacerows";
      const hasChanges = isReplace || stats.added > 0 || stats.updated > 0;

      if (hasChanges) {
        // 4. Post-persistence: Flush buffered writes BEFORE sorting.
        // sheet.getRange().sort() reads the physical sheet state, so any pending setValues()
        // calls must be committed first — otherwise the sort operates on stale data and
        // silently undoes the updates we just wrote.
        SpreadsheetApp.flush();
        this.sortData();

        // 5. Post-persistence: Recalculate named ranges since the physical boundary and positions have changed.
        this.writeNamedRanges();
      }

      return stats;
    } finally {
      // Always release the lock
      lock.releaseLock();
    }
  }

  /**
   * Sorts the data physically on the sheet based on the SortField property.
   */
  sortData() {
    const sortField = this.getProperty("SortField");
    if (!sortField) return;

    const sortColOffset = this.getColOffset(sortField);
    if (sortColOffset === -1) {
      throw new Error(`Configuration Error: SortField '${sortField}' not found in table '${this.longName}'. Please check the registry.`);
    }

    // With the new caching optimization, pending writes are tracked via _maxWrittenRow,
    // completely eliminating the need to trigger a massive, slow SpreadsheetApp.flush() here.

    const lastRow = this.getLastRowIndex();
    if (lastRow <= this.firstDataRowIndex) return;

    // Physical column is 1-indexed (colOffset + 1)
    const physicalCol = sortColOffset + 1;
    const numRows = lastRow - this.firstDataRowIndex + 1;
    const numCols = this.sheet.getLastColumn();

    if (numRows > 0 && numCols > 0) {
      const range = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, numCols);
      range.sort({ column: physicalCol, ascending: true });
      myLog("info", "Sorted %s by %s (Col %d)", this.longName, sortField, physicalCol);
    }
  }



  /**
   * REPLACE Mode: Wipes all data and writes the fresh matrix.
   */
  _persistReplace(newData) {
    this.clearDataArea();

    if (newData.length > 0) {
      this.writeChunks(this.firstDataRowIndex, newData);
    }
    myLog("info", "Replace complete: %d rows written.", newData.length);
    return { added: newData.length, updated: 0 };
  }

  /**
   * ADD Mode: Appends only rows with unique keys not already in the sheet.
   */
  _persistAdd(newData) {
    // 2. Filter out existing rows based on Key
    const rowsToAdd = newData.filter(row => {
      const rowKey = this.getRowKey(row);
      if (!rowKey) return true; // Append blindly if table lacks a Primary Key
      return !this.getHashKeyMap().has(rowKey.toLowerCase());
    });

    if (rowsToAdd.length > 0) {
      const startRow = this.getLastRowIndex() + 1;
      this.writeChunks(startRow, rowsToAdd);
    }
    myLog("info", "Add complete: %d new rows appended.", rowsToAdd.length);
    return { added: rowsToAdd.length, updated: 0 };
  }

  /**
   * UPDATE Mode: Synchronizes existing rows and appends new ones.
   * Orchestrates the transformation and persistence of dirty records.
   */
  _persistUpdate(newData) {
    // 1. Snapshot the NEW data
    const { rowsToUpdate, rowsToAdd } = this._identifyChanges(newData);

    // 2. Apply updates in contiguous batches
    this._applyUpdates(rowsToUpdate);

    // 3. Append entirely new rows
    if (rowsToAdd.length > 0) {
      const startRow = this.getLastRowIndex() + 1;
      this.writeChunks(startRow, rowsToAdd);
    }

    myLog("info", "Update complete for %s: %d updated (dirty), %d added.", this.longName, rowsToUpdate.length, rowsToAdd.length);
    return { added: rowsToAdd.length, updated: rowsToUpdate.length };
  }

  /**
   * Compares staged data against the sheet to find changed or new records.
   * @returns {Object} {rowsToUpdate: Array<{offset, data}>, rowsToAdd: Array<Array>}
   */
  _identifyChanges(newData) {
    const newRowsSnapshot = newData;
    const rowsToUpdate = [];
    const rowsToAdd = [];
    const labels = this.getLabels();

    // PERFORMANCE: Pre-calculate field types for all columns once
    const fieldTypes = labels.map(label => Registry.getType(this.longName, label));

    newRowsSnapshot.forEach((newRow, idx) => {
      const rowKey = this.getRowKey(newRow);
      if (!rowKey) return;

      const existingRowOff = this.getHashKeyMap().get(rowKey.toLowerCase());

      if (existingRowOff !== undefined) {
        const existingRow = this.getWindow()[existingRowOff];
        
        const isDirty = newRow.some((newVal, colOff) => {
          const fieldType = fieldTypes[colOff];
          const normalizedNew = TypeUtils.castType(newVal, fieldType);
          const normalizedExisting = TypeUtils.castType(existingRow[colOff], fieldType);
          
          let dirty = String(normalizedNew) !== String(normalizedExisting);
          
          // Fuzzy numeric comparison for numeric fields
          if (dirty && typeof normalizedNew === 'number' && typeof normalizedExisting === 'number') {
            dirty = Math.abs(normalizedNew - normalizedExisting) > 1e-6;
          }
          
          if (labels[colOff] && labels[colOff].toUpperCase() === "PK" && dirty) {
            dirty = String(normalizedNew).toLowerCase() !== String(normalizedExisting).toLowerCase();
          }
          
          if (dirty) {
            myLog("trace", "  Column '%s' is dirty: New [%s] vs Existing [%s] (RAW: Source [%s] / Target [%s])", 
              labels[colOff], normalizedNew, normalizedExisting, newVal, existingRow[colOff]);
          }
          return dirty;
        });
        
        if (isDirty) {
          myLog("trace", "Row " + idx + " (Key: " + rowKey + ") -> UPDATE (Dirty)");
          rowsToUpdate.push({ offset: existingRowOff, data: newRow });
        }
      } else {
        myLog("info", "Row " + idx + " (Key: " + rowKey + ") -> ADD (Not found in target)");
        rowsToAdd.push(newRow);
      }
    });

    return { rowsToUpdate, rowsToAdd };
  }

  /**
   * Groups contiguous row updates together for high-performance batch writes.
   * @param {Array<Object>} rowsToUpdate
   */
  _applyUpdates(rowsToUpdate) {
    if (rowsToUpdate.length === 0) return;

    // Ensure sorted by offset to find contiguous blocks
    rowsToUpdate.sort((a, b) => a.offset - b.offset);

    let currentBlock = [rowsToUpdate[0]];
    
    for (let i = 1; i < rowsToUpdate.length; i++) {
      const currentRow = rowsToUpdate[i];
      const previousRow = rowsToUpdate[i - 1];

      if (currentRow.offset === previousRow.offset + 1) {
        currentBlock.push(currentRow);
      } else {
        this._writeRowBlock(currentBlock);
        currentBlock = [currentRow];
      }
    }
    this._writeRowBlock(currentBlock);
  }

  /**
   * Physically writes a block of contiguous rows to the spreadsheet.
   * @param {Array<Object>} rowBlock
   */
  _writeRowBlock(rowBlock) {
    if (rowBlock.length === 0) return;
    
    const startRow = this.firstDataRowIndex + rowBlock[0].offset;
    const matrix = rowBlock.map(item => item.data);
    this.writeBlock(startRow, matrix);
  }
  /**
   * Overrides Sheet.flushMemory to also clear transformation data.
   */
  flushMemory() {
    super.flushMemory();
    myLog("trace", "Flushed memory for %s", this.longName);
  }

  // Method removed - moved to base Table class

}

// Register with globals
globals.tableMap['UpdateTable'] = UpdateTable;
