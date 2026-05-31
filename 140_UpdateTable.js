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
    const numCols = this.getLastColumnIndex();

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

    let processedData = newData;

    if (newData.length > 0) {
      let sourceSheet = null;
      try {
        if (typeof Utils !== 'undefined' && typeof Utils.getSourceSheet === 'function') {
          sourceSheet = Utils.getSourceSheet(this);
        }
      } catch (e) {
        // Safe bypass
      }

      if (sourceSheet) {
        const isUnion = sourceSheet.constructor.name === "UnionTable" || typeof sourceSheet._ensureSources === 'function';

        if (isUnion) {
          processedData = this._applyUnionDateFilter(newData);
        } else {
          // Slice by source slack offset for standard 1:1 ledger sync
          const sourceFirstRow = sourceSheet.absoluteFirstRow || 2;
          const sourceFirstDataRow = sourceSheet.firstDataRowIndex || 2;
          const sourceSlackOffset = Math.max(0, sourceFirstRow - sourceFirstDataRow);
          if (sourceSlackOffset > 0 && newData.length > sourceSlackOffset) {
            processedData = newData.slice(sourceSlackOffset);
            myLog("info", "Standard ledger sync: sliced %d slack rows from source payload.", sourceSlackOffset);
          }
        }
      }

      const writeStartRow = this.absoluteFirstRow || this.firstDataRowIndex;
      if (processedData.length > 0) {
        this.writeChunks(writeStartRow, processedData);
      }
    }
    
    myLog("info", "Replace complete: %d rows written to %s.", processedData.length, this.longName);
    return { added: processedData.length, updated: 0 };
  }

  /**
   * Filters input data for a UnionTable sync by removing records older than the target boundary date.
   * The boundary date is resolved in order of priority:
   * 1. The date value present in the row immediately preceding absoluteFirstRow.
   * 2. A fallback April 1st date parsed from the sheet's name if a year (20XX) is present.
   * 
   * @param {Array<Array<any>>} newData - The raw input dataset.
   * @returns {Array<Array<any>>} The filtered dataset.
   * @private
   */
  _applyUnionDateFilter(newData) {
    const dateFieldName = this.getProperty("DateField") || "Date";
    const dateColOffset = this.getColOffset(dateFieldName);
    if (dateColOffset === -1) {
      return newData;
    }

    let targetBoundaryDate = null;
    const labelRowIdx = Number(this.getProperty("LabelRow")) || 1;
    const prevRowIndex = this.absoluteFirstRow - 1;

    // 1. Attempt to get boundary date from the row directly above absoluteFirstRow
    if (this.sheet && prevRowIndex > labelRowIdx) {
      const rawDate = this.sheet.getRange(prevRowIndex, dateColOffset + 1).getValue();
      if (rawDate) {
        const parsed = rawDate instanceof Date ? rawDate : new Date(rawDate);
        if (!isNaN(parsed.getTime())) {
          targetBoundaryDate = parsed;
        }
      }
    }

    // 2. Fallback: Parse year from sheet name (e.g., "Ledger 2026") and default to April 1st
    if (!targetBoundaryDate) {
      const yearMatch = this.sheetName.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        targetBoundaryDate = new Date(Number(yearMatch[1]), 3, 1);
      }
    }

    if (!targetBoundaryDate) {
      return newData;
    }

    // 3. Filter out rows that are strictly before the boundary date
    const boundaryTime = targetBoundaryDate.getTime();
    const filtered = newData.filter(row => {
      const rawVal = row[dateColOffset];
      if (!rawVal) return true; // Keep row if no date is provided
      const valDate = rawVal instanceof Date ? rawVal : new Date(rawVal);
      if (isNaN(valDate.getTime())) return true; // Keep row if date is invalid
      return valDate.getTime() >= boundaryTime;
    });

    myLog("info", "UnionTable filter: Kept %d of %d rows matching date boundary >= %s", 
      filtered.length, newData.length, targetBoundaryDate.toISOString().split('T')[0]);

    return filtered;
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

      // Scenario A: The row key already exists in the destination sheet (potential update)
      if (existingRowOff !== undefined) {
        // Enforce Read-Only Slack Window: Do not update historical rows that lie before the absolute start row boundary
        const physicalRowIndex = this.firstDataRowIndex + existingRowOff;
        if (this.absoluteFirstRow && physicalRowIndex < this.absoluteFirstRow) {
          return; // Skip updates to locked/historical entries
        }

        // Retrieve the matching existing row from the sheet cache window
        const existingRow = this.getWindow()[existingRowOff];
        
        // Scan each column to determine if any field values have changed (is dirty)
        const isDirty = newRow.some((newVal, colOff) => {
          const fieldType = fieldTypes[colOff];
          
          // Normalize both values using the defined schema type for the column
          const normalizedNew = TypeUtils.castType(newVal, fieldType);
          const normalizedExisting = TypeUtils.castType(existingRow[colOff], fieldType);
          
          // Default check: simple stringified comparison
          let dirty = String(normalizedNew) !== String(normalizedExisting);
          
          // Performance/Precision Guard: Fuzzy numeric comparison for floating point numbers
          // This avoids false-positive dirty flags caused by minor JavaScript float representation issues
          if (dirty && typeof normalizedNew === 'number' && typeof normalizedExisting === 'number') {
            const columnName = labels[colOff];
            // 'balance' gets a dedicated fuzzy threshold, other numeric columns get the standard threshold
            const threshold = (columnName && columnName.toLowerCase() === "balance") 
              ? CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD 
              : CONFIG_CONSTANTS.FUZZY_NUMERIC_THRESHOLD;
            
            // Re-evaluate dirty status using the tolerance threshold
            dirty = Math.abs(normalizedNew - normalizedExisting) > threshold;
          }
          
          // Primary Key Guard: Perform case-insensitive string comparison for Primary Key fields (PK)
          if (labels[colOff] && labels[colOff].toUpperCase() === "PK" && dirty) {
            dirty = String(normalizedNew).toLowerCase() !== String(normalizedExisting).toLowerCase();
          }
          
          // Log detailed traces for the specific column mismatch if it remains dirty
          if (dirty) {
            myLog("trace", "  Column '%s' is dirty: New [%s] vs Existing [%s] (RAW: Source [%s] / Target [%s])", 
              labels[colOff], normalizedNew, normalizedExisting, newVal, existingRow[colOff]);
          }
          return dirty;
        });
        
        // If one or more columns are dirty, mark this row as requiring an update
        if (isDirty) {
          myLog("trace", "Row " + idx + " (Key: " + rowKey + ") -> UPDATE (Dirty)");
          rowsToUpdate.push({ offset: existingRowOff, data: newRow });
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
