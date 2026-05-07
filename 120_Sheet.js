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
    const hasConfig = config && Object.keys(config).length > 0;
    this._config = hasConfig ? config : (typeof Registry !== 'undefined' ? Registry.getSheetConfig(longName) : {});
    this.ss = ss;
    this.longName = longName;
    const parts = longName.split("_");
    this.sheetName = this._config.SheetName || parts.slice(1).join("_");
    this.sheet = ss.getSheetByName(this.sheetName);
    
    const isVirtual = this._config.SheetType === 'FileTable' || this._config.SheetType === 'InMemoryTable';
    if (!this.sheet && !isVirtual) {
      if (this._config.CreateIfMissing) {
        myLog("info", "Sheet: '%s' not found. Creating new sheet in spreadsheet %s.", this.sheetName, ss.getId());
        this.sheet = ss.insertSheet(this.sheetName);
      } else {
        const ssid = ss.getId();
        throw new Error(`Registry Failure: Sheet "${this.sheetName}" not found. Expected in Spreadsheet ID: "${ssid}". Please check your Sheets configuration.`);
      }
    }

    // Windows state
    this.firstDataRowIndex = Number(this._config.FirstRow) || 2;
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
   * Safe access to the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  get(rowOffset, colOffset) {
    try {
      this.fetch();
      if (rowOffset < 0 || rowOffset >= this._window.length) {
        throw new Error(`Row offset ${rowOffset} out of bounds. Window length: ${this._window.length}`);
      }
      const row = this._window[rowOffset];
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
      this.fetch();
      if (rowOffset < 0 || rowOffset >= this._window.length) {
        throw new Error(`Cannot SET row offset ${rowOffset}. Out of bounds. Window length: ${this._window.length}`);
      }
      const row = this._window[rowOffset];
      if (!row || colOffset < 0 || colOffset >= row.length) {
        throw new Error(`Cannot SET column offset ${colOffset} at row ${rowOffset}. Out of bounds. Row width: ${row?.length || 0}`);
      }
      row[colOffset] = value;
    } catch (e) {
      throw new Error(`[Physical Layer: ${this.longName}] set(${rowOffset}, ${colOffset}) Failure: ${e.message}`);
    }
  }

  /**
   * Fetches data into the private matrix. 
   * Supports incremental expansion (backward and forward).
   * @param {number} [startRow] Physical row to start from (default: firstDataRowIndex)
   * @param {number} [numRows] Number of rows to fetch (default: everything to bottom)
   */
  fetch(startRow = null, numRows = null) {
    try {
      const isDefaultRequest = (startRow === null && numRows === null);

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
    const lastRow = this.sheet.getLastRow();
    const lastCol = this.sheet.getLastColumn();
    const reqStart = startRow || this.firstDataRowIndex;
    const reqNum = numRows || (lastRow >= reqStart ? (lastRow - reqStart + 1) : 0);
    return { start: reqStart, numRows: reqNum, lastCol: lastCol };
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
  _fetchHeaderRow(labelRow = 1) {
    if (!this.sheet) return [];
    try {
      const labels = this.sheet.getRange(labelRow, 1, 1, this.sheet.getLastColumn()).getValues()[0];
      return labels;
    } catch (e) {
      myLog("warn", "Failed to fetch labels for sheet %s", this.sheetName);
      return [];
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

  writeBlock(startRow, matrix) {
    if (!matrix || matrix.length === 0 || !matrix[0] || matrix[0].length === 0) return;
    myLog("info", "Writing " + matrix.length + " rows to " + this.sheetName + " starting at row " + startRow);
    const range = this.sheet.getRange(startRow, 1, matrix.length, matrix[0].length);
    range.clearFormat(); // Reset any 'Plain Text' formatting to ensure formulas evaluate
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
    const labels = this.sheet.getRange(this._config.LabelRow || 1, 1, 1, this.sheet.getLastColumn()).getValues()[0];
    const sheetNameClean = StringUtils.toRangeName(this.longName);
    
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
