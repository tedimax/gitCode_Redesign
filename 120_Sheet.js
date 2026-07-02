"use strict";

/**
 * gitCode_Redesign - Sheet Class (Level 1)
 * Represents the Physical & Matrix Layer.
 * Manages the connection to Google Sheets and the windowed data matrix.
 */
class Sheet {
  constructor(ss, longName, properties = null) {
    // Semi-private fields for data isolation
    this._window = [];

    this.longName = longName

    // 1. Resolve Hybrid Config (Registry + Overrides)
    let registryProperties = {};
    if (typeof Registry !== 'undefined') {
      try {
        registryProperties = Registry.getSheetConfig(this.longName);
      } catch (e) {
        // Only throw if NO config was passed and it's not the bootstrap table
        if (!properties && this.longName !== CONFIG_CONSTANTS.SHEETS_CONFIG_NAME) {
          throw e;
        }
      }
    }

    this._properties = Object.fromEntries(
      Object.entries({ ...registryProperties, ...properties })
        .map(([key, value]) => [key.toLowerCase().trim(), value])
    );

    this.ss = ss;


    // Validate: Fail if the format is wrong AND no override exists
    const [ssContext, sheetContext] = this.longName.split("_");
    if (!sheetContext && !this._properties.sheetname) {
      throw new Error(`Naming Failure: The longName "${this.longName}" is invalid. It must follow the "Spreadsheet_Sheet" convention (e.g., "Ledgers_Bank") or have an explicit "SheetName" override in the Registry.`);
    }

    // Assign and fetch using fallback chain
    this.sheetName = String(this._properties.sheetname || sheetContext).trim();
    this.sheet = ss.getSheetByName(this.sheetName);

    if (!this.sheet) {
      const ssid = ss.getId();
      throw new Error(`Physical Sheet Missing: The physical Google Sheet named "${this.sheetName}" was not found inside the spreadsheet (ID: "${ssid}").\n\n` +
        `👉 Action Required: Please verify that a sheet tab named "${this.sheetName}" exists in the target spreadsheet.`);
    }

    // Windows state
    this.absoluteFirstRow = Number(this._properties.firstrow) || 2;
    const slackRows = Number(this._properties.windowslack) || 0;
    this.firstDataRowIndex = Math.max(2, this.absoluteFirstRow - slackRows);
    this.dataStartRow = this.absoluteFirstRow;
    this.windowDataLength = 0;
    this.currentRowOffset = 0;
    this._isFetched = false;
    this._windowStartRow = null; // Physical row index of the first row in _window
    this._cachedLastRowIndex = null;
    this._cachedLastCol = undefined;
    this._maxWrittenRow = 0;
  }

  getProperty(propName) {
    return this._properties[String(propName || "").toLowerCase().trim()];;
  }
  /**
   * Lazy accessor for the data matrix.
   * Ensures data is loaded exactly once on demand.
   */
  getWindow() {
    if (!this._isFetched) {
      this.fetch(this.firstDataRowIndex);
    }
    return this._window;
  }

  /**
   * Clears the internal data window cache, forcing a fresh fetch on next access.
   */
  clearCache() {
    this._window = [];
    this._windowStartRow = null;
    this.windowDataLength = 0;
    this._isFetched = false;
    this._cachedLastCol = undefined;
    myLog("trace", "Sheet %s: Cache cleared.", this.longName);
  }

  /**
   * Safe access to the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  get(rowOffset, colOffset) {
    try {
      const value = this.getWindow()[rowOffset]?.[colOffset];
      if (value === undefined) throw new Error("Index out of bounds");
      return value;
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] get(${rowOffset}, ${colOffset}) Failure: ${e.message}`);
    }
  }

  /**
   * Safe modification of the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  set(rowOffset, colOffset, value) {
    try {
      const row = this.getWindow()[rowOffset];
      if (!row || colOffset < 0 || colOffset >= row.length) {
        throw new Error("Index out of bounds");
      }
      row[colOffset] = value;
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] set(${rowOffset}, ${colOffset}) Failure: ${e.message}`);
    }
  }

  /**
   * Applies a single value to a disjoint batch of cells in a specific column.
   * Translates 0-indexed relative row offsets into physical A1 notations.
   */
  setValueByColumnOffsetAndRowOffsets(colOffset, value, rowOffsetsArray) {
    if (!this.sheet || !rowOffsetsArray || rowOffsetsArray.length === 0) return;
    const colLetter = StringUtils.columnToLetter(colOffset);
    const a1List = rowOffsetsArray.map(off => `${colLetter}${this.firstDataRowIndex + off}`);
    this.sheet.getRangeList(a1List).setValue(value);
  }

  /**
   * Fetches data into the private matrix. 
   * Supports incremental expansion (backward and forward).
   * @param {number} [startRow] Physical row to start from (default: firstDataRowIndex)
   * @param {number} [numRows] Number of rows to fetch (default: everything to bottom)
   */
  fetch(startRow, numRows) {
    try {
      const range = this._resolveRequestedRange(startRow, numRows);
      if (range.numRows <= 0) return;
      // Orchestrate Load: Build or expand the data window
      const isWindowEmpty = !this._isFetched || this._windowStartRow === null || this._window.length === 0;
      if (isWindowEmpty)
        this._performInitialFetch(range);
      else
        this._expandWindow(range);
      this._trimTrailingRows();
      this._isFetched = true;
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] fetch(${startRow}, ${numRows}) Failure: ${e.message}`);
    }
  }
  /**
   * Private Helper: Resolves the requested physical range into a range object.
   */
  _resolveRequestedRange(startRow, numRows) {
    const resolvedStart = startRow ?? this.firstDataRowIndex;
    const physicalLastRow = this.getLastRowIndex();
    const lastCol = this.getLastColumnIndex();
    // If numRows is nullish, calculate remaining rows down to physicalLastRow
    const count = numRows ?? Math.max(0, physicalLastRow - resolvedStart + 1);
    return { start: resolvedStart, numRows: count, lastCol };
  }

  /**
   * Private Helper: Performs the first-time data load for a sheet.
   */
  _performInitialFetch(range) {
    myLog("trace", "Sheet %s: Initial fetch of %d rows from row %d", this.sheetName, range.numRows, range.start);
    this._window = this.sheet.getRange(range.start, 1, range.numRows, range.lastCol).getValues();
    this._windowStartRow = range.start;
  }

  /**
   * Private Helper: Adds rows to the top or bottom of the existing window.
   */
  _expandWindow(range) {
    // 1. Backward Extension (Prepend)
    if (range.start < this._windowStartRow) {
      const gapRows = this._windowStartRow - range.start;
      myLog("trace", "Sheet %s: Extending window BACKWARDS by %d rows", this.sheetName, gapRows);
      const gapData = this.sheet.getRange(range.start, 1, gapRows, range.lastCol).getValues();
      this._window = [...gapData, ...this._window];
      this._windowStartRow = range.start;
    }

    // 2. Forward Extension (Append)
    const currentEndRow = this._windowStartRow + this._window.length - 1;
    const reqEndRow = range.start + range.numRows - 1;
    if (reqEndRow > currentEndRow) {
      const gapRows = reqEndRow - currentEndRow;
      myLog("trace", "Sheet %s: Extending window FORWARDS by %d rows", this.sheetName, gapRows);
      const gapData = this.sheet.getRange(currentEndRow + 1, 1, gapRows, range.lastCol).getValues();
      this._window = [...this._window, ...gapData];
    }
  }

  /**
   * Private Helper: Removes empty trailing rows from the window.
   */
  _trimTrailingRows() {
    const lastPopulatedIdx = this._findLastPopulatedIndex(this._window);
    const targetLength = lastPopulatedIdx + 1;
    if (targetLength < this._window.length) {
      const trimmedCount = this._window.length - targetLength;
      myLog("trace", "Sheet %s: Trimmed %d empty trailing rows", this.sheetName, trimmedCount);
      this._window = this._window.slice(0, targetLength);
    }
    this.windowDataLength = this._window.length;
  }

  /**
   * Internal helper to find the last row containing any data in a 2D array.
   * @param {Array<Array>} matrix
   * @returns {number} The 0-based index of the last non-empty row, or -1 if empty.
   */
  _findLastPopulatedIndex(matrix) {
    if (!matrix?.length) return -1;
    for (let i = matrix.length - 1; i >= 0; i--) {
      const hasData = matrix[i].some(cell => cell !== "" && cell != null);
      if (hasData) return i;
    }
    return -1;
  }
  /**
   * Physical Row Resolver (1-indexed)
   * Returns the physical row number of the last non-empty row.
   */

  getLastRowIndex() {
    // 1. Return cached value if available, accounting for fresh local writes
    if (this._cachedLastRowIndex != null) {
      return Math.max(this._cachedLastRowIndex, this._maxWrittenRow ?? 0);
    }
    // 2. Guard for virtual sheets
    if (!this.sheet) {
      return this._maxWrittenRow ?? (this.firstDataRowIndex - 1);
    }
    const lastCol = this.getLastColumnIndex();
    const lastRow = this.sheet.getLastRow();
    // 3. Fallback for completely empty sheets
    if (lastCol === 0 || lastRow < this.firstDataRowIndex) {
      this._cachedLastRowIndex = this.firstDataRowIndex - 1;
      return this._cachedLastRowIndex;
    }
    // 4. Inspect data to find the *true* last populated row index
    const numRows = (lastRow - this.firstDataRowIndex) + 1;
    const values = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, lastCol).getValues();
    const lastIdx = this._findLastPopulatedIndex(values);
    // Convert 0-indexed matrix offset back to 1-indexed physical row
    this._cachedLastRowIndex = (lastIdx === -1) ? this.firstDataRowIndex - 1 : (this.firstDataRowIndex + lastIdx);
    return Math.max(this._cachedLastRowIndex, this._maxWrittenRow ?? 0);
  }
  /**
   * Physical Column Resolver
   * Returns the cached physical column index of the last column.
   */
  getLastColumnIndex() {
    if (this._cachedLastCol !== undefined) return this._cachedLastCol;
    if (!this.sheet) return 1;
    return (this._cachedLastCol = this.sheet.getLastColumn());
  }
  /**
   * Fetches the raw header row from the sheet.
   */
  _fetchRowValues(rowIndex) {
    if (!this.sheet || !rowIndex || rowIndex < 1) return [];
    try {
      const lastCol = this.getLastColumnIndex();
      if (lastCol === 0) return [];
      return this.sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] Failed to fetch labels for sheet ${this.sheetName}. Details: ${e.message}`);
    }
  }

  clearDataArea() {
    const lastRow = this.getLastRowIndex();
    const wipeStartRow = this.dataStartRow;
    // Guard: If there is no data area to clear, reset cache and exit early
    if (lastRow < wipeStartRow) {
      this._cachedLastRowIndex = wipeStartRow - 1;
      this._maxWrittenRow = 0;
      return;
    }
    const numRows = lastRow - wipeStartRow + 1;
    this.sheet.getRange(wipeStartRow, 1, numRows, this.getLastColumnIndex()).clearContent();
    this._cachedLastRowIndex = wipeStartRow - 1;
    this._maxWrittenRow = 0;
  }

  /**
  * Safely writes a physical Named Range to the spreadsheet.
  * Keeps API calls isolated to the Physical Layer.
  * @param {string} rangeName Cleaned, Google-compliant range name.
  * @param {number} startRow 1-indexed row start.
  * @param {number} startCol 1-indexed column start.
  * @param {number} numRows Number of rows to include.
  * @param {number} numCols Number of columns to include.
  */
  writeNamedRange(rangeName, startRow, startCol, numRows, numCols) {
    if (!this.sheet) return;

    try {
      const range = this.sheet.getRange(startRow, startCol, numRows, numCols);
      this.ss.setNamedRange(rangeName, range);
    } catch (e) {
      myLog("warn", "Failed to set named range %s: %s", rangeName, e.message);
    }
  }

  writeBlock(startRow, matrix) {
    if (!matrix?.length || !matrix[0]?.length) return;
    const numRows = matrix.length;
    const numCols = matrix[0].length;
    myLog("trace", `Writing ${numRows} rows to ${this.sheetName} starting at row ${startRow}`);
    // 1. Auto-expand rows if needed to prevent out-of-bounds errors
    const maxRows = this.sheet.getMaxRows();
    const neededRows = startRow + numRows - 1;
    if (neededRows > maxRows) {
      const rowsToAdd = neededRows - maxRows;
      this.sheet.insertRowsAfter(maxRows, rowsToAdd);
      myLog("trace", "Sheet %s: Expanded physical rows by %d (maxRows is now %d)", this.sheetName, rowsToAdd, neededRows);
    }
    // 2. Auto-expand columns if needed
    const maxCols = this.sheet.getMaxColumns();
    if (numCols > maxCols) {
      const colsToAdd = numCols - maxCols;
      this.sheet.insertColumnsAfter(maxCols, colsToAdd);
      myLog("trace", "Sheet %s: Expanded physical columns by %d (maxColumns is now %d)", this.sheetName, colsToAdd, numCols);
    }
    // 3. Commit data to the sheet
    this.sheet.getRange(startRow, 1, numRows, numCols).setValues(matrix);
    // 4. Update the internal tracker
    this._maxWrittenRow = Math.max(this._maxWrittenRow ?? 0, neededRows);
  }

  /**
   * Helper to write data in chunks to prevent timeouts.
   * Can be used for partial updates or large matrices.
   */
  writeChunks(startRow, dataMatrix, chunkSize = CONFIG_CONSTANTS.SHEET_CHUNK_SIZE) {
    for (let offset = 0; offset < dataMatrix.length; offset += chunkSize) {
      const chunk = dataMatrix.slice(offset, offset + chunkSize);
      const targetRow = startRow + offset
      this.writeBlock(targetRow, chunk);
    }
  }

  /**
 * Physically deletes a row and decrements last row trackers to prevent coordinates errors
 * and avoid a full sheet cache reload.
 * @param {number} physicalRow 1-indexed physical row number.
 */
  deleteRow(physicalRow) {
    if (!this.sheet) return;
    this.sheet.deleteRow(physicalRow);
    // 1. Decrement the cached index if it exists
    if (this._cachedLastRowIndex != null) {
      this._cachedLastRowIndex--;
    }
    // 2. Safely decrement the max written row tracker
    if (this._maxWrittenRow) {
      this._maxWrittenRow = Math.max(0, this._maxWrittenRow - 1);
    }
  }

  /**
   * Memory Management
   * Releases the cached 2D data matrix to prevent GAS memory limits.
   */
  flushMemory() {
    this._window = [];
    this._cachedLastRowIndex = null;
    this._cachedLastCol = undefined;
    this._maxWrittenRow = 0;
    this._isFetched = false;
    this._windowStartRow = null;
    this.windowDataLength = 0;
    myLog("trace", "Flushed _window memory for %s", this.longName);
  }

}

// Register with globals
globals.tableMap['Sheet'] = Sheet;
