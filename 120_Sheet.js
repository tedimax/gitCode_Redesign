"use strict";

/**
 * gitCode_Redesign - Sheet Class (Level 1)
 * Represents the Physical & Matrix Layer.
 * Manages the connection to Google Sheets and the windowed data matrix.
 */
class Sheet {
  constructor(ss, longName, config = null) {
    // Semi-private fields for data isolation
    this._window = [];
    
    // 1. Resolve Hybrid Config (Registry + Overrides)
    let registryConfig = {};
    if (typeof Registry !== 'undefined') {
      try {
        registryConfig = Registry.getSheetConfig(longName);
      } catch (e) {
        // Only throw if NO config was passed and it's not the bootstrap table
        if (!config && longName !== CONFIG_CONSTANTS.SHEETS_CONFIG_NAME) {
          throw e;
        }
      }
    }
    const rawConfig = Object.assign({}, registryConfig, config || {});
    
    // Standardize: Lowercase and Trim all property keys for O(1) lookup
    this._config = {};
    for (const key in rawConfig) {
      this._config[key.toLowerCase().trim()] = rawConfig[key];
    }

    this.ss = ss;
    this.longName = longName;
    const nameParts = longName.split("_");
    if (nameParts.length !== 2 && !this._config.SheetName) {
      throw new Error(`Naming Failure: The longName "${longName}" is invalid. It must follow the "Spreadsheet_Sheet" convention (e.g., "Ledgers_Bank") or have an explicit "SheetName" override in the Registry.`);
    }
    const [ssContext, sheetContext] = nameParts;
    this.sheetName = this._config.sheetname || sheetContext;
    this.sheet = ss.getSheetByName(this.sheetName);
    
    const isVirtual = this._config.sheettype === 'FileTable' 
                   || this._config.sheettype === 'InMemoryTable'
                   || this._config.sheettype === 'UnionTable';
    if (!this.sheet && !isVirtual) {
      if (this._config.createifmissing) {
        myLog("info", "Sheet: '%s' not found. Creating new sheet in spreadsheet %s.", this.sheetName, ss.getId());
        this.sheet = ss.insertSheet(this.sheetName);
      } else {
        const ssid = ss.getId();
        throw new Error(`Physical Sheet Missing: The physical Google Sheet named "${this.sheetName}" was not found inside the spreadsheet (ID: "${ssid}").\n\n` +
          `👉 Action Required: Please verify that a sheet tab named "${this.sheetName}" exists in the target spreadsheet, or set 'CreateIfMissing' to TRUE in your 'NewAccounts_Sheets' Registry configuration.`);
      }
    }

    // Windows state
    this.firstDataRowIndex = Number(this._config.firstrow) || 2;
    this.windowDataLength = 0;
    this.currentRowOffset = 0;
    this._isFetched = false;
    this._windowStartRow = null; // Physical row index of the first row in _window
    this._cachedLastRowIndex = null;
    this._maxWrittenRow = 0;
  }

  /**
   * Lazy accessor for the data matrix.
   * Ensures data is loaded exactly once on demand.
   */
  getWindow() {
    this.fetch();
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
    myLog("trace", "Sheet %s: Cache cleared.", this.longName);
  }

  /**
   * Safe access to the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  get(rowOffset, colOffset) {
    try {
      const window = this.getWindow();
      if (rowOffset < 0 || rowOffset >= window.length) {
        throw new Error(`Row offset ${rowOffset} out of bounds. Window length: ${window.length}`);
      }
      const row = window[rowOffset];
      if (!row || colOffset < 0 || colOffset >= row.length) {
        throw new Error(`Column offset ${colOffset} out of bounds at row ${rowOffset}. Row width: ${row?.length || 0}`);
      }
      return row[colOffset];
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
      const window = this.getWindow();
      if (rowOffset < 0 || rowOffset >= window.length) {
        throw new Error(`Cannot SET row offset ${rowOffset}. Out of bounds. Window length: ${window.length}`);
      }
      const row = window[rowOffset];
      if (!row || colOffset < 0 || colOffset >= row.length) {
        throw new Error(`Cannot SET column offset ${colOffset} at row ${rowOffset}. Out of bounds. Row width: ${row?.length || 0}`);
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
  setBatchedValuesInColumn(colOffset, value, rowOffsetsArray) {
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
      const isDefaultRequest = (startRow === undefined || startRow === null) && (numRows === undefined || numRows === null);

      // 1. Lazy Guard (Skip if we already have the default full fetch window)
      if (isDefaultRequest && this._isFetched) return;

      // 2. Virtual Sheet Guard
      if (!this.sheet) {
        this._isFetched = true;
        if (!this._windowStartRow) this._windowStartRow = this.firstDataRowIndex;
        return;
      }

      // 3. Resolve Requested Range
      const range = this._resolveRequestedRange(startRow, numRows);
      if (range.numRows <= 0) return;

      // 4. Orchestrate Load
      if (!this._isFetched) {
        // Build the initial window
        this._performInitialFetch(range);
      } else {
        // Expand the existing window perimeter
        this._expandWindow(range);
      }

      // 5. Cleanup
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
    const resolvedStart = (startRow === undefined || startRow === null) ? this.firstDataRowIndex : startRow;
    const physicalLastRow = this.sheet.getLastRow();
    const maxRows = this.sheet.getMaxRows();
    const registryLastRow = Number(this._config.lastrow) || 0;
    const lastCol = this.sheet.getLastColumn();
    const ssUrl = this.ss.getUrl();
    
    myLog("trace", "Sheet [%s] Dimension Audit: startRow=%d, physicalLastRow=%d, maxRows=%d, ssUrl=%s", 
      this.longName, resolvedStart, physicalLastRow, maxRows, ssUrl);
    
    const count = (numRows === undefined || numRows === null) ? Math.max(0, physicalLastRow - resolvedStart + 1) : numRows;
    return { start: resolvedStart, numRows: count, lastCol: lastCol };
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
      myLog("info", "Sheet %s: Extending window BACKWARDS by %d rows", this.sheetName, gapRows);
      const gapData = this.sheet.getRange(range.start, 1, gapRows, range.lastCol).getValues();
      this._window = gapData.concat(this._window);
      this._windowStartRow = range.start;
    }

    // 2. Forward Extension (Append)
    const currentEndRow = this._windowStartRow + this._window.length - 1;
    const reqEndRow = range.start + range.numRows - 1;
    if (reqEndRow > currentEndRow) {
      const gapStart = currentEndRow + 1;
      const gapRows = reqEndRow - currentEndRow;
      myLog("info", "Sheet %s: Extending window FORWARDS by %d rows", this.sheetName, gapRows);
      const gapData = this.sheet.getRange(gapStart, 1, gapRows, range.lastCol).getValues();
      this._window = this._window.concat(gapData);
    }
  }

  /**
   * Private Helper: Removes empty trailing rows from the window.
   */
  _trimTrailingRows() {
    const lastPopulatedIdx = this._findLastPopulatedIndex(this._window);
    if (lastPopulatedIdx === -1) {
      this._window = [];
    } else if (lastPopulatedIdx < this._window.length - 1) {
      const trimmedCount = this._window.length - (lastPopulatedIdx + 1);
      myLog("trace", "Sheet %s: Trimmed %d empty trailing rows", this.sheetName, trimmedCount);
      this._window = this._window.slice(0, lastPopulatedIdx + 1);
    }
    this.windowDataLength = this._window.length;
  }

  /**
   * Internal helper to find the last row containing any data in a 2D array.
   * @param {Array<Array>} matrix
   * @returns {number} The 0-based index of the last non-empty row, or -1 if empty.
   */
  _findLastPopulatedIndex(matrix) {
    if (!matrix || matrix.length === 0) return -1;
    
    for (let i = matrix.length - 1; i >= 0; i--) {
      // Check if row has any non-empty content
      const hasData = matrix[i].some(cell => cell !== "" && cell !== null && cell !== undefined);
      if (hasData) return i;
    }
    return -1;
  }

  /**
   * Physical Row Resolver (1-indexed)
   * Returns the physical row number of the last non-empty row.
   */
  getLastRowIndex() {
    // Return cached value if available, adjusting for any writes made since fetching
    if (this._cachedLastRowIndex !== null && this._cachedLastRowIndex !== undefined) {
      return Math.max(this._cachedLastRowIndex, this._maxWrittenRow || 0);
    }

    // Guard for virtual sheets
    if (!this.sheet) return this._maxWrittenRow || (this.firstDataRowIndex - 1);

    const lastCol = this.sheet.getLastColumn();
    const lastRow = this.sheet.getLastRow();
    
    if (lastCol === 0 || lastRow < this.firstDataRowIndex) {
      this._cachedLastRowIndex = this.firstDataRowIndex - 1;
      return this._cachedLastRowIndex;
    }
    
    // Fetch the values up to the API's idea of lastRow
    const numRows = (lastRow - this.firstDataRowIndex) + 1;
    const values = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, lastCol).getValues();
    
    const lastIdx = this._findLastPopulatedIndex(values);
    
    // Convert 0-indexed array offset back to 1-indexed physical row
    this._cachedLastRowIndex = (lastIdx === -1) ? this.firstDataRowIndex - 1 : (this.firstDataRowIndex + lastIdx);
    return Math.max(this._cachedLastRowIndex, this._maxWrittenRow || 0);
  }

  /**
   * Fetches the raw header row from the sheet.
   */
  _fetchHeaderRow(labelRow) {
    if (!this.sheet || !labelRow || labelRow < 1) return [];
    try {
      const lastCol = this.sheet.getLastColumn();
      if (lastCol === 0) return []; // Empty sheet
      const labels = this.sheet.getRange(labelRow, 1, 1, lastCol).getValues()[0];
      return labels;
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] Failed to fetch labels for sheet ${this.sheetName}. It may not exist. Details: ${e.message}`);
    }
  }

  clearDataArea() {
    const lastRow = this.getLastRowIndex();
    if (lastRow >= this.firstDataRowIndex) {
      this.sheet.getRange(this.firstDataRowIndex, 1, lastRow - this.firstDataRowIndex + 1, this.sheet.getLastColumn()).clearContent();
    }
    this._cachedLastRowIndex = this.firstDataRowIndex - 1;
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
      this.ss.setNamedRange(rangeName, this.sheet.getRange(startRow, startCol, numRows, numCols));
    } catch (e) {
      myLog("warn", "Failed to set named range %s: %s", rangeName, e.message);
    }
  }

  writeBlock(startRow, matrix) {
    if (!matrix || matrix.length === 0 || !matrix[0] || matrix[0].length === 0) return;
    myLog("info", "Writing " + matrix.length + " rows to " + this.sheetName + " starting at row " + startRow);
    const range = this.sheet.getRange(startRow, 1, matrix.length, matrix[0].length);
    range.setValues(matrix);

    // Update internal tracker if this exceeds it
    const endRow = startRow + matrix.length - 1;
    if (!this._maxWrittenRow || endRow > this._maxWrittenRow) {
      this._maxWrittenRow = endRow;
    }
  }

  /**
   * Helper to write data in chunks to prevent timeouts.
   * Can be used for partial updates or large matrices.
   */
  writeChunks(startRow, dataMatrix, chunkSize = 500) {
    for (let chunkOff = 0; chunkOff < dataMatrix.length; chunkOff += chunkSize) {
      const chunk = dataMatrix.slice(chunkOff, chunkOff + chunkSize);
      this.writeBlock(startRow + chunkOff, chunk);
    }
  }

  /**
   * Memory Management
   * Releases the cached 2D data matrix to prevent GAS memory limits.
   */
  flushMemory() {
    this._window = [];
    this._cachedLastRowIndex = null;
    this._maxWrittenRow = 0;
    this._isFetched = false;
    this._windowStartRow = null;
    this.windowDataLength = 0;
    myLog("trace", "Flushed _window memory for %s", this.longName);
  }

  /**
   * Named Range Generation

   * Uses StringUtils.toRangeName for strict sanitation.
   */
  writeNamedRanges() {
    const labels = this.sheet.getRange(this._config.labelrow || 1, 1, 1, this.sheet.getLastColumn()).getValues()[0];
    const sheetNameClean = StringUtils.toRangeName(this.sheetName);
    
    const physicalDataLength = Math.max(1, this.getLastRowIndex() - this.firstDataRowIndex + 1);

    // 1. Data Area Range (e.g. SS_NominalsData)
    const dataRange = this.sheet.getRange(this.firstDataRowIndex, 1, physicalDataLength, labels.length);
    this.ss.setNamedRange(sheetNameClean + "Data", dataRange);

    // 2. Full Sheet Range (e.g. SS_NominalsSheet) - Including headers
    const fullSheetRange = this.sheet.getRange(1, 1, this.getLastRowIndex(), labels.length);
    this.ss.setNamedRange(sheetNameClean + "Sheet", fullSheetRange);

    // 3. Individual Column-Data ranges (e.g. SS_Nominals_Date)
    labels.forEach((label, index) => {
      if (label) {
        const colName = sheetNameClean + StringUtils.toRangeName(label);
        const colRange = this.sheet.getRange(this.firstDataRowIndex, index + 1, physicalDataLength, 1);
        this.ss.setNamedRange(colName, colRange);
      }
    });
  }

}

// Register with globals
globals.tableMap['Sheet'] = Sheet;
