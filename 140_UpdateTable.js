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
  runSync() {
    myLog("info", "Starting runSync for %s...", this.longName);
    
    // 1. Perform Ingestion (Transformation/Fetch)
    const newData = this.importData() || [];
    
    // 2. Persist results
    const stats = this.commit(newData);

    // 3. Post-Persistence Hooks (e.g. Styling)
    this.afterSync(stats, newData);
    
    // 4. Final Cleanup
    this.flushMemory();
    
    myLog("info", "runSync complete for %s. Stats: %s", this.longName, JSON.stringify(stats));
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
   * Ingestion phase.
   * Overridden by subclasses (e.g., AnnualSheet) or defers to transform().
   */
  importData() {
    return this.transform();
  }

  /**
   * Placeholder for transformation logic.
   * Overridden by subclasses (e.g., ImportTable) to provide automated mapping.
   */
  transform() {
    myLog("trace", "Base UpdateTable: No transformation logic defined for %s", this.longName);
    return [];
  }

  /**
   * Main entry point for persistence.
   * @param {string} mode - 'replace', 'update', or 'add'. Defaults to props.ImportMethod.
   */
  commit(newData, mode = this.getProperty("ImportMethod") || "replace") {
    myLog("info", "Committing changes to %s using mode: %s", this.longName, mode);

    // Ensure newData is provided
    if (!newData) {
       myLog("warn", "commit() called without newData for %s. Attempting transform...", this.longName);
       newData = this.transform() || [];
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
      switch (mode.toLowerCase()) {
        case "replace":
        case "replacerows":
          stats = this._commitReplace(newData);
          break;
        case "add":
        case "addrows":
        case "append":
          stats = this._commitAdd(newData);
          break;
        case "update":
        case "updaterows":
          stats = this._commitUpdate(newData);
          break;
        default:
          myLog("error", "Unknown import mode: %s. Defaulting to no-op.", mode);
      }

      const isReplace = mode.toLowerCase() === "replace" || mode.toLowerCase() === "replacerows";
      const hasChanges = isReplace || stats.added > 0 || stats.updated > 0;

      if (hasChanges) {
        // 4. Post-commit: Sort the target sheet
        this.sortData();
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
      myLog("warn", "SortField '%s' not found in %s.", sortField, this.longName);
      return;
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
  _commitReplace(newData) {
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
  _commitAdd(newData) {
    // 2. Filter out existing rows based on Key
    const rowsToAdd = newData.filter(row => {
      const rowKey = this.getRowKey(row);
      if (!rowKey) return true; // Append blindly if table lacks a Primary Key
      return !this.getHashKeyMap().has(rowKey);
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
  _commitUpdate(newData) {
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

      const existingRowOff = this.getHashKeyMap().get(rowKey);

      if (existingRowOff !== undefined) {
        const existingRow = this.getWindow()[existingRowOff];
        
        const isDirty = newRow.some((newVal, colOff) => {
          const fieldType = fieldTypes[colOff];
          const normalizedNew = TypeUtils.castType(newVal, fieldType);
          const normalizedExisting = TypeUtils.castType(existingRow[colOff], fieldType);
          return String(normalizedNew) !== String(normalizedExisting);
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

}

// Register with globals
globals.tableMap['UpdateTable'] = UpdateTable;
