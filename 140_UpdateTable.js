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
    
    // 1. Prepare Ingestion (Transformation/Fetch)
    const newData = this.prepare() || [];
    
    // 2. Persist results
    const stats = this.persist(newData);

    // 3. Post-Persistence Hooks (e.g. Styling)
    this.afterSync(stats, newData);
    
    // 4. Final Cleanup
    this.flushMemory();
    
    myLog("info", "Execution complete for %s. Stats: %s", this.longName, JSON.stringify(stats));
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
   * @param {string} mode - 'replace', 'update', or 'add'. Defaults to props.importmethod.
   */
  persist(newData, mode = this.getProperty("importmethod") || "replace") {
    myLog("info", "Persisting changes to %s using mode: %s", this.longName, mode);

    // Fail-fast: Ensure newData is explicitly provided
    if (!newData) {
       throw new Error(`fail-fast: persist() called without newData for ${this.longName}. Data must be explicitly prepared and passed.`);
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
          stats = this._persistReplace(newData);
          break;
        case "add":
          stats = this._persistAdd(newData);
          break;
        case "update":
          stats = this._persistUpdate(newData);
          break;
        default:
          throw new Error(`Persistence Error: Unknown persistence mode '${mode}' for ${this.longName}. Valid modes are 'replace', 'add', or 'update'.`);
      }

      const isReplace = mode.toLowerCase() === "replace";
      const hasChanges = isReplace || stats.added > 0 || stats.updated > 0;

      if (hasChanges) {
        // 4. Post-persistence: Sort the target sheet
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
