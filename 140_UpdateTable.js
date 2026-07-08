"use strict";

/**
 * gitCode_Redesign - UpdateTable (Level 3)
 * Provides high-performance persistence logic (Replace, Add, Update).
 * Handles batching, dirty-checks, and chunked writes.
 */
class UpdateTable extends Table {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    /** @type {Set<any>} */
    this._pksToDelete = new Set();
  }

  /**
   * The Unified Orchestrator.
   * Executes the full ingestion and persistence lifecycle.
   */
  execute() {
    myLog("info", "Starting execution for %s...", this.longName);

    // UI Feedback: Toast on Start (Uses external utility to keep Orchestrator clean)
    if (typeof Utils !== 'undefined' && typeof Utils.displayStartToast === 'function') {
      Utils.displayStartToast(this, this._modeOverride);
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

    // UI Feedback: Toast on Finish (Uses external utility)
    if (typeof Utils !== 'undefined' && typeof Utils.displayFinishToast === 'function') {
      Utils.displayFinishToast(this, stats, this._modeOverride);
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
  persist(newData, mode = this._modeOverride || this.getProperty("importmethod")) {
    myLog("info", "Table %s persistence routing Mode: '%s'", this.longName, mode);

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
      // Wait for lock acquisition
      lock.waitLock(CONFIG_CONSTANTS.LOCK_TIMEOUT_MS);
    } catch (e) {
      throw new Error(`Could not acquire script lock for ${this.longName}. Another sync may be in progress. Details: ${e.message}`);
    }

    try {
      // 3. Route to specific persistence logic
      let stats = { added: 0, updated: 0 };
      let normalizedMode = String(mode).toLowerCase();

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
      const hasChanges = isReplace || stats.added > 0 || stats.updated > 0 || (stats.deleted && stats.deleted > 0);

      if (hasChanges) {
        // 4. Post-persistence: Flush buffered writes BEFORE sorting.
        // sheet.getRange().sort() reads the physical sheet state, so any pending setValues()
        // calls must be committed first — otherwise the sort operates on stale data and
        // silently undoes the updates we just wrote.
        SpreadsheetApp.flush();
        this.sortData();

        // 5. Post-persistence: Recalculate named ranges since the physical boundary and positions have changed
        resetFYWindow(this.longName);
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
   *
  sortData() {
    const sortField = this.getProperty("SortField");
    if (!sortField) return;

    const lastRow = this.getLastRowIndex();
    if (lastRow <= this.firstDataRowIndex) return;

    // Physical column is 1-indexed (colOffset + 1)
    const colOffset = this.column[sortField];
    if (colOffset === undefined) {
      myLog("warning", "SortField '%s' not found in %s column list. Bypassing sort.", sortField, this.longName);
      return;
    }
    const physicalCol = colOffset + 1;
    const numRows = lastRow - this.firstDataRowIndex + 1;
    const numCols = this.getLastColumnIndex();

    if (numRows > 0 && numCols > 0) {
      const range = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, numCols);

      // Build a stable sort spec: primary = SortField, secondary = PK
      const sortSpec = [{ column: physicalCol, ascending: true }];
      const keyProp = this.getProperty("Key");
      const keyOffset = keyProp ? this.column[keyProp] : undefined;
      if (keyOffset !== undefined && keyOffset !== -1 && keyOffset + 1 !== physicalCol) {
        sortSpec.push({ column: keyOffset + 1, ascending: true });
      }
      range.sort(sortSpec);
      myLog("info", "Sorted %s by %s (Col %d) + PK tiebreak", this.longName, sortField, physicalCol);
    }
  }*/
  sortData() {
   const sortFieldsStr = this.getProperty("SortField") || this.getProperty("SortFields");
   if (!sortFieldsStr) return;

  const lastRow = this.getLastRowIndex();
  if (lastRow <= this.firstDataRowIndex) return;

  // Split the CSV string, trim whitespace, and filter out empty values
  const sortFields = sortFieldsStr.split(',').map(f => f.trim()).filter(Boolean);
  if (sortFields.length === 0) return;

  const sortSpec = [];
  const loggedFields = [];

  // Loop through and build the sort specification (major fields first)
  for (const field of sortFields) {
    const colOffset = this.column[field];
    if (colOffset === undefined) {
      myLog("warning", "SortField '%s' not found in %s column list. Skipping field.", field, this.longName);
      continue;
    }
    const physicalCol = colOffset + 1;
    sortSpec.push({ column: physicalCol, ascending: true });
    loggedFields.push(`${field} (Col ${physicalCol})`);
  }

  // If none of the provided fields were valid, bypass the sort completely
  if (sortSpec.length === 0) {
    myLog("warning", "No valid sort fields found in '%s' for %s. Bypassing sort.", sortFieldsStr, this.longName);
    return;
  }

  const numRows = lastRow - this.firstDataRowIndex + 1;
  const numCols = this.getLastColumnIndex();

  if (numRows > 0 && numCols > 0) {
    const range = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, numCols);

    // Sort strictly by the built sortSpec array
    range.sort(sortSpec);
    myLog("info", "Sorted %s by %s", this.longName, loggedFields.join(" + "));
  }
}



  _persistReplace(newData) {
    this.clearDataArea();

    if (newData.length > 0) {
      this._assignSeqValues(newData);
      this.writeChunks(this.dataStartRow, newData);
    }

    myLog("info", "Replace complete: %d rows written to %s.", newData.length, this.longName);
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
      this._assignSeqValues(rowsToAdd);
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
      this._assignSeqValues(rowsToAdd);
      const startRow = this.getLastRowIndex() + 1;
      this.writeChunks(startRow, rowsToAdd);
    }

    // 4. Process any pending deletions last
    let deletedCount = 0;
    if (this._pksToDelete && this._pksToDelete.size > 0) {
      myLog("info", "UpdateTable: Processing %d pending deletions for %s...", this._pksToDelete.size, this.longName);

      const offsetsToDelete = [];
      this._pksToDelete.forEach(pk => {
        const pkLower = String(pk).toLowerCase().trim();
        const offset = this.getHashKeyMap().get(pkLower);
        if (offset !== undefined) {
          offsetsToDelete.push(offset);
        }
      });

      // Sort descending to prevent shifting issues during deletion
      offsetsToDelete.sort((a, b) => b - a);

      offsetsToDelete.forEach(offset => {
        const physicalRow = (this._windowStartRow !== null ? this._windowStartRow : this.firstDataRowIndex) + offset;
        myLog("info", "UpdateTable: Deleting physical row %d from %s", physicalRow, this.longName);
        this.deleteRow(physicalRow);
      });

      deletedCount = offsetsToDelete.length;
      this._pksToDelete.clear();

      // Invalidate cache since row positions shifted
      this.clearCache();
    }

    myLog("info", "Update complete for %s: %d updated (dirty), %d added, %d deleted.", this.longName, rowsToUpdate.length, rowsToAdd.length, deletedCount);
    return { added: rowsToAdd.length, updated: rowsToUpdate.length, deleted: deletedCount };
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
      if (!rowKey) {
        myLog("trace", "UpdateTable [%s]: Row %d skipped - no rowKey generated.", this.longName, idx);
        return;
      }

      const existingRowOff = this.getHashKeyMap().get(rowKey.toLowerCase());

      // Scenario A: The row key already exists in the destination sheet (potential update)
      if (existingRowOff !== undefined) {
        const physicalRowIndex = (this._windowStartRow !== null ? this._windowStartRow : this.firstDataRowIndex) + existingRowOff;
        myLog("trace", "UpdateTable [%s] COMPARISON: Key '%s' found at offset %d (physical row %d). dataStartRow limit is %d.",
          this.longName, rowKey, existingRowOff, physicalRowIndex, this.dataStartRow);

        if (this.dataStartRow && physicalRowIndex < this.dataStartRow) {
          myLog("trace", "UpdateTable [%s]: Bypassed update check for Key '%s' (physical row %d < dataStartRow %d)",
            this.longName, rowKey, physicalRowIndex, this.dataStartRow);
          return; // Skip updates to locked/historical entries
        }

        const existingRow = this.getWindow()[existingRowOff];

        // Scan each column to determine if any field values have changed (is dirty)
        const isDirty = newRow.some((newVal, colOff) => {
          const fieldType = fieldTypes[colOff];
          const normalizedNew = TypeUtils.castType(newVal, fieldType);
          const normalizedExisting = TypeUtils.castType(existingRow[colOff], fieldType);

          let dirty = String(normalizedNew) !== String(normalizedExisting);

          if (dirty && typeof normalizedNew === 'number' && typeof normalizedExisting === 'number') {
            const columnName = labels[colOff];
            const threshold = (columnName && columnName.toLowerCase() === "balance")
              ? CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD
              : CONFIG_CONSTANTS.FUZZY_NUMERIC_THRESHOLD;
            dirty = Math.abs(normalizedNew - normalizedExisting) > threshold;
          }

          if (labels[colOff] && labels[colOff].toUpperCase() === "PK" && dirty) {
            dirty = String(normalizedNew).toLowerCase() !== String(normalizedExisting).toLowerCase();
          }

          myLog("trace", "  Col %d (%s) Type [%s]: New [%s] (raw: [%s]) vs Existing [%s] (raw: [%s]) -> dirty=%s",
            colOff, labels[colOff], fieldType, normalizedNew, newVal, normalizedExisting, existingRow[colOff], dirty);

          return dirty;
        });

        if (isDirty) {
          myLog("info", "Row " + idx + " (Key: " + rowKey + ") -> UPDATE (Dirty)");
          rowsToUpdate.push({ offset: existingRowOff, data: newRow });
        } else {
          myLog("trace", "Row " + idx + " (Key: " + rowKey + ") -> NO CHANGE");
        }
      } else {
        // Scenario B: The row key does not exist in the destination sheet (new insertion)
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

    const startRow = (this._windowStartRow !== null ? this._windowStartRow : this.firstDataRowIndex) + rowBlock[0].offset;
    const matrix = rowBlock.map(item => item.data);
    this.writeBlock(startRow, matrix);
  }
  /**
   * Stamps the Seq column in-place on a matrix of row arrays, for tables that require it.
   *
   * Rules:
   *  - Only runs for tables listed in CONFIG_CONSTANTS.SEQ_MANDATORY_TABLES.
   *  - Only runs when the target sheet has a Seq column and a DateField property.
   *  - Seq is set to 0 for the first row on a given date, incremented by 1 for each
   *    subsequent row on the same date, and reset to 0 when the date changes.
   *  - Always stamps unconditionally — the formula engine writes the Integer default (0)
   *    into the Seq slot when the source has no Seq column, so there is no reliable way
   *    to distinguish a source-supplied value from a default. Since this method is only
   *    ever called for rows being physically added to the sheet, always stamping is correct.
   *
   * Called BEFORE writeChunks so that the physical write order matches the Seq values.
   * Update mode (existing rows) never calls this, preserving their existing Seq values.
   *
   * @param {Array<Array<any>>} rows - The row matrix to stamp in-place.
   */
  _assignSeqValues(rows) {
    if (!rows || rows.length === 0) return;

    // 1. Guard: only applicable to mandatory tables
    const mandatoryTables = CONFIG_CONSTANTS.SEQ_MANDATORY_TABLES || [];
    if (!mandatoryTables.includes(this.longName)) return;

    // 2. Guard: target sheet must have both a Seq column and a DateField
    const seqField = CONFIG_CONSTANTS.SEQ_FIELD || "Seq";
    const seqColIdx = this.column[seqField];
    if (seqColIdx === undefined) return;

    const dateFieldName = this.getProperty("DateField");
    if (!dateFieldName) return;
    const dateColIdx = this.column[dateFieldName];
    if (dateColIdx === undefined) return;

    // 3. Stamp Seq values sequentially per date.
    //    These rows are always being physically added to the sheet (never updated),
    //    so we always stamp — even if the formula engine has already placed a default
    //    Integer value of 0 in the Seq slot (which would be indistinguishable from a
    //    real source-supplied 0).
    let lastDateKey = null;
    let currentSeq = 0;

    rows.forEach(row => {
      const dateVal = row[dateColIdx];
      if (dateVal === null || dateVal === undefined || dateVal === "") return;

      // Produce a stable string key for the date (works for Date objects and strings)
      const dateKey = (dateVal instanceof Date)
        ? `${dateVal.getFullYear()}-${dateVal.getMonth()}-${dateVal.getDate()}`
        : String(dateVal);

      if (dateKey !== lastDateKey) {
        currentSeq = 0;
        lastDateKey = dateKey;
      } else {
        currentSeq++;
      }

      row[seqColIdx] = currentSeq;
    });

    myLog("info", "_assignSeqValues [%s]: Seq column stamped for %d rows.", this.longName, rows.length);
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
