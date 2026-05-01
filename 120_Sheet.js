"use strict";

/**
 * gitCode_Redesign - Sheet Class (Level 1)
 * Represents the Physical & Matrix Layer.
 * Manages the connection to Google Sheets and the windowed data matrix.
 */
class Sheet {
  constructor(ss, longName, config = {}) {
    // Semi-private fields for data isolation
    this._window = [];
    this._config = config; // Contains sheetName, FirstRow, etc.
    this.ss = ss;
    this.longName = longName;
    const parts = longName.split("_");
    this.sheetName = config.SheetName || parts.slice(1).join("_");
    this.sheet = ss.getSheetByName(this.sheetName);
    
    if (!this.sheet && config.SheetType !== 'FileTable' && config.SheetType !== 'InMemoryTable') {
      throw new Error(`Sheet "${this.sheetName}" not found in spreadsheet "${ss.getName()}".`);
    }

    // Windows state
    this.firstDataRowIndex = Number(config.FirstRow) || 2;
    this.windowDataLength = 0;
    this.currentRowOffset = 0;
    this._isFetched = false;
    this._cachedLastRowIndex = null;
    this._maxWrittenRow = 0;
  }

  /**
   * Lazy accessor for the data matrix.
   * Ensures data is loaded exactly once on demand.
   */
  getWindow() {
    if (!this._isFetched) {
      this.fetchWindow();
    }
    return this._window;
  }

  /**
   * Safe access to the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  get(rowOffset, colOffset) {
    const window = this.getWindow();
    if (rowOffset < 0 || rowOffset >= window.length) return null;
    const row = window[rowOffset];
    if (!row || colOffset < 0 || colOffset >= row.length) return null;
    return row[colOffset];
  }

  /**
   * Safe modification of the internal window matrix.
   * Uses 0-based row and column offsets.
   */
  set(rowOffset, colOffset, value) {
    const window = this.getWindow();
    if (rowOffset >= 0 && rowOffset < window.length) {
      const row = window[rowOffset];
      if (row && colOffset >= 0 && colOffset < row.length) {
        row[colOffset] = value;
      }
    }
  }

  /**
   * Fetches the data window into the private matrix.
   */
  fetchWindow() {
    this._isFetched = true;
    const lastRow = this.sheet.getLastRow();
    const lastCol = this.sheet.getLastColumn();
    
    if (lastRow < this.firstDataRowIndex || lastCol === 0) {
      this._window = [];
      this.windowDataLength = 0;
      this._cachedLastRowIndex = this.firstDataRowIndex - 1;
      return;
    }
    
    const numRows = (lastRow - this.firstDataRowIndex) + 1;
    myLog("trace", "Fetching %d rows from %s (LastRow: %d, Start: %d)", numRows, this.sheetName, lastRow, this.firstDataRowIndex);
    const rawData = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, lastCol).getValues();
    
    // Use the consolidated helper to find the boundary
    const lastIdx = this._findLastPopulatedIndex(rawData);

    // Cache the physical last row calculation
    this._cachedLastRowIndex = (lastIdx === -1) ? this.firstDataRowIndex - 1 : (this.firstDataRowIndex + lastIdx);

    // Trim the matrix to only include rows with actual data
    this._window = (lastIdx === -1) ? [] : rawData.slice(0, lastIdx + 1);
    this.windowDataLength = this._window.length;
    this.currentRowOffset = 0;
    
    myLog("info", "Fetched and trimmed %d rows for sheet %s", this.windowDataLength, this.longName);
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

  getLabels(labelRow = 1) {
    const lastCol = this.sheet.getLastColumn();
    if (lastCol === 0) return [];
    return this.sheet.getRange(labelRow, 1, 1, lastCol).getValues()[0];
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
    this._window = null;
    this._cachedLastRowIndex = null;
    this._maxWrittenRow = 0;
    this._isFetched = false;
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
