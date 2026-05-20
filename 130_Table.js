"use strict";

/**
 * gitCode_Redesign - Table Class (Level 2)
 * Represents the Logical & Property Layer.
 * Extends Sheet to provide configuration-driven logic, hashing, and type casting.
 */
class Table extends Sheet {
  constructor(ss, longName, properties = null) {
    super(ss, longName, properties);
    // Semi-private logic stores
    let registryProps = {};
    if (typeof Registry !== 'undefined') {
      try {
        registryProps = Registry.getSheetConfig(longName);
      } catch (e) {
        // Hard fail at Level 2 if no properties provided and not bootstrapping
        if (!properties && longName !== CONFIG_CONSTANTS.SHEETS_CONFIG_NAME) {
          throw e;
        }
      }
    }
    const rawProps = Object.assign({}, registryProps, properties || {});
    
    this._properties = {};
    if (rawProps) {
      for (const key in rawProps) {
        this._properties[key.toLowerCase().trim()] = rawProps[key];
      }
    }
    
    this._columnMap = new Map();
    this._hashKeyMap = new Map();
    this._isHashed = false;
    this._keyMetadata = null;
    this._labels = null;
    this._modeOverride = null; // Internal override for Fluent API
    this._isInMemory = false;  // If true, persist() will not write to the sheet
    this._buffer = [];         // Stores results for in-memory runs
    this._validStartRow = null; // Physical row index of the first validated row
    this._validEndRow = null;   // Physical row index of the last validated row
    this._skipValidation = false; // Internal flag for fast lookups
    
    // Initialize headers automatically upon creation
    this.initializeHeaderMap();
  }

  /**
   * Fluent API: Forces 'update' mode for this specific instance.
   * @returns {Table}
   */
  withUpdateMode() {
    this._modeOverride = "update";
    return this;
  }

  /**
   * Fluent API: Prevents physical writes to the sheet.
   * @returns {Table}
   */
  asInMemory() {
    this._isInMemory = true;
    return this;
  }

  /**
   * Returns the data generated during an in-memory execution.
   */
  getBuffer() {
    return this._buffer;
  }


  // =========================================================================
  // FOUNDATIONAL METHODS (CONSTRUCTOR HELPERS)
  // =========================================================================

  /**
   * Builds a Map of Label -> Column Offset.
   * Stores both the ordered array and the lookup map for O(1) retrieval.
   */
  initializeHeaderMap() {
    const labelRow = this.getProperty("LabelRow");
    
    // 1. Capture and trim labels in their physical order (Skip if LabelRow is 0)
    const rawLabels = (labelRow === 0) ? [] : this._fetchHeaderRow(labelRow || 1);
    this._labels = rawLabels.map(label => String(label || "").trim());
    
    // 2. Build the lookup map functionally (Label -> Offset)
    this._columnMap = new Map(
      this._labels
        .map((label, offset) => [label, offset])
        .filter(([label]) => label !== "")
    );
    
    // 3. Fallback: If no labels found, try symbolic map from constants
    if (this._columnMap.size === 0) {
      const symbolicMap = TABLE_COLUMN_MAP[this.longName];
      if (symbolicMap) {
        myLog("trace", "Table %s: Using symbolic mapping from constants.", this.longName);
        for (const symbol in symbolicMap) {
          const literalHeader = symbolicMap[symbol];
          if (!this._columnMap.has(literalHeader)) {
             this._columnMap.set(literalHeader, Object.keys(symbolicMap).indexOf(symbol));
          }
        }
      } else if (labelRow !== 0) {
        myLog("warn", "Table %s: No physical or symbolic headers found.", this.longName);
      } else {
        myLog("trace", "Table %s: Confirmed as Raw/Output sheet (LabelRow=0).", this.longName);
      }
    }
    
    myLog("trace", "Initialized columnMap for %s with %d labels", this.longName, this._columnMap.size);
  }

  // =========================================================================
  // PROPERTY, COLUMN & CELL ACCESSORS (GETTERS/SETTERS)
  // =========================================================================

  /**
   * Safe access to table constants from the Sheets config.
   * Uses standardized O(1) lookup.
   */
  getProperty(propName) {
    const key = String(propName || "").toLowerCase().trim();
    const val = this._properties[key];
    
    if (key === "keyprefix") {
       myLog("trace", "Table [%s]: getProperty('%s') -> '%s' (Available: [%s])", 
         this.longName, key, val, Object.keys(this._properties).join(", "));
    }

    if (val !== undefined && val !== null && val !== "") return val;

    // Fallback to Registry global lookup (RECURSION GUARD)
    // The Registry's own configuration table cannot look itself up via the Registry.
    if (this.longName !== CONFIG_CONSTANTS.SHEETS_CONFIG_NAME && typeof Registry !== 'undefined') {
      return Registry.lookupValue(this.longName, propName);
    }
    return null;
  }

  /**
   * Returns an array of field labels in their physical column order.
   */
  getLabels() {
    return this._labels || [];
  }

  /**
   * Fluent setter to disable row validation for high-volume lookup tables.
   */
  withoutValidation() {
    this._skipValidation = true;
    return this;
  }

  /**
   * O(1) Column Index Resolver
   */
  getColOffset(name) {
    if (!name) return -1;
    const searchName = String(name).toLowerCase().trim();
    
    // 1. Try exact match (Fast)
    let off = this._columnMap.get(name);
    if (off !== undefined) return off;
    
    // 2. Try case-insensitive match (Fallback)
    for (const [label, offset] of this._columnMap.entries()) {
      if (label.toLowerCase() === searchName) return offset;
    }
    
    return -1;
  }

  /**
   * Helper to resolve a symbolic map of fields to their column offsets.
   */
  getOffsets(fieldMap) {
    const offsets = {};
    for (const [key, colName] of Object.entries(fieldMap)) {
      offsets[key] = this.getColOffset(colName);
    }
    return offsets;
  }

  /**
   * Automatically resolves symbolic offsets for this table based on the global TABLE_COLUMN_MAP.
   * If an override map is provided, it uses that instead.
   */
  getSymbolicOffsets(overrideMap = null) {
    const map = overrideMap || TABLE_COLUMN_MAP[this.longName];
    if (!map) {
      myLog("trace", "No standard column map found for %s", this.longName);
      return {};
    }
    return this.getOffsets(map);
  }

  /**
   * Data Access by Label
   */
  getValueByLabel(rowOffset, label) {
    try {
      const colOffset = this.getColOffset(label);
      if (colOffset === -1) {
        throw new Error(`Column label "${label}" not found.`);
      }
      return this.get(rowOffset, colOffset);
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getValueByLabel(${rowOffset}, "${label}") Failure: ${e.message}`);
    }
  }

  setValueByLabel(rowOffset, label, val) {
    try {
      const colOffset = this.getColOffset(label);
      if (colOffset === -1) {
        throw new Error(`Cannot SET value. Column label "${label}" not found.`);
      }
      this.set(rowOffset, colOffset, val);
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] setValueByLabel(${rowOffset}, "${label}") Failure: ${e.message}`);
    }
  }

  /**
   * Converts a window row into a JavaScript object.
   * Functional Pattern: .reduce() over columnMap.
   */
  getRowObjectByOffset(rowOffset) {
    try {
      if (rowOffset < 0 || rowOffset >= this.windowDataLength) {
        throw new Error(`Invalid row offset ${rowOffset} for object conversion. Window length: ${this.windowDataLength}`);
      }
      
      return Array.from(this._columnMap.entries()).reduce((obj, [label, colOff]) => {
        obj[label] = this.get(rowOffset, colOff);
        return obj;
      }, {});
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getRowObjectByOffset(${rowOffset}) Failure: ${e.message}`);
    }
  }

  // =========================================================================
  // FETCH & VALIDATION ENGINE
  // =========================================================================

  /**
   * Overrides Sheet.fetch to apply Incremental Strict Typing and Perimeter Validation.
   */
  fetch(startRow = null, numRows = null) {
    try {
      super.fetch(startRow, numRows);
      if (this.windowDataLength === 0) return;

      const labels = this.getLabels();
      const fieldTypes = labels.map(label => TypeUtils.getType(this.longName, label));
      const clearedOff = this.getColOffset("Cleared");
      const groupOff = this.getColOffset("Group");
      const entryTypeOff = this.getColOffset("EntryType");

      // Resolve which physical range needs validation
      const winEndRow = this._windowStartRow + this.windowDataLength - 1;
      
      // We only validate rows that haven't been validated in this session
      const validateStart = this._validStartRow ? Math.min(this._windowStartRow, this._validStartRow) : this._windowStartRow;
      const validateEnd = this._validEndRow ? Math.max(winEndRow, this._validEndRow) : winEndRow;

      for (let pRow = validateStart; pRow <= validateEnd; pRow++) {
        // Skip if already validated OR if global bypass is active
        if (this._skipValidation) continue;
        if (this._validStartRow && this._validEndRow && pRow >= this._validStartRow && pRow <= this._validEndRow) continue;

        const rowOff = pRow - this._windowStartRow;
        const row = this._window[rowOff];
        const keyValue = this.getRowKey(row);
        
        // If the row has no key, it is a comment or spacer row. Bypass validation entirely.
        if (keyValue === null || keyValue === "") continue;
        
        let isCleared = true;
        let rawCleared = "true";
        if (clearedOff !== -1) {
          rawCleared = row[clearedOff];
          isCleared = (rawCleared === true || String(rawCleared).toUpperCase() === "TRUE");
        } else if (groupOff !== -1) {
          const rawGroup = row[groupOff];
          isCleared = (rawGroup !== undefined && rawGroup !== null && String(rawGroup).trim() !== "" && String(rawGroup).trim() !== "0");
          rawCleared = isCleared ? "true" : "false";
        }

        this._window[rowOff] = row.map((cell, colOff) => {
          const type = fieldTypes[colOff];
          const label = labels[colOff];
          const context = { row: pRow, col: label, sheet: this.longName };
          const val = TypeUtils.castType(cell, type);
          TypeUtils.validate(val, type, context);
          
           // Only enforce mandatory fields for data tables, skip for system configuration sheets
          const isConfigSheet = [
            CONFIG_CONSTANTS.SHEETS_CONFIG_NAME,
            CONFIG_CONSTANTS.DATATYPES_SHEET_NAME,
            CONFIG_CONSTANTS.FORMULAS_SHEET_NAME,
            CONFIG_CONSTANTS.CORRECTIONS_SHEET_NAME,
            "NewAccounts_TestSheetDest"
          ].includes(this.longName);

          let isMandatory = !isConfigSheet && (CONFIG_CONSTANTS.MANDATORY_TABLE_FIELDS || []).includes(label);
          const entryType = entryTypeOff !== -1 ? String(row[entryTypeOff] || "").trim().toUpperCase() : "ACTIVITY";

          // Rule 1: Group is only mandatory once the row is Cleared
          if (label === "Group" && !isCleared) isMandatory = false;

          // Rule 2: Category is only mandatory for Activity rows (regardless of cleared status)
          if (label === "Category" && entryType !== "ACTIVITY") isMandatory = false;

          // Rule 3: FY is mandatory for all Account balance snapshots, but for anything else (Activity, etc), it's only mandatory if Cleared
          if (label === "FY") {
             if (entryType !== "ACCOUNT" && !isCleared) isMandatory = false;
          }

          // Note: Core fields (PK, Amount, Account) remain mandatory regardless of state.

          if (isMandatory && (val === "" || val === null || val === undefined)) {
            const stateInfo = `[Type: ${entryType}, Cleared: ${isCleared} (raw: "${rawCleared}")]`;
            throw new Error(`Validation Error ${stateInfo}: Mandatory field "${label}" is empty at row ${pRow} [Key: ${keyValue}].`);
          }
          
          if (isMandatory && label === "Group" && Number(val) === 0) {
            throw new Error(`Validation Error: Group ID cannot be zero at row ${pRow} [Key: ${keyValue}].`);
          }

          return val;
        });
      }

      // Update the validation bounds
      this._validStartRow = this._windowStartRow;
      this._validEndRow = winEndRow;
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] fetch(${startRow}, ${numRows}) Failure: ${e.message}`);
    }
  }

  fetchWindow() {
    this.fetch();
  }

  /**
   * Ensures that at least 'count' rows from the bottom are loaded and validated.
   */
  ensureRows(count) {
    const totalLast = this.getLastRowIndex();
    const targetStart = Math.max(this.firstDataRowIndex, totalLast - count + 1);
    
    if (!this._windowStartRow || targetStart < this._windowStartRow) {
      this.fetch(targetStart);
    }
  }

  // =========================================================================
  // KEY MANAGEMENT & HASH UTILITIES
  // =========================================================================

  /**
   * Internal helper to resolve key column metadata once.
   */
  _initializeKeyMetadata() {
    if (this._keyMetadata) return this._keyMetadata;

    const targetKeyField = this.getProperty("Key");
    const keyFieldsRaw = this.getProperty("KeyFields");

    switch (true) {
      case !!targetKeyField: {
        // Single Key (Priority)
        const keyOffset = this.getColOffset(targetKeyField);
        if (keyOffset === -1) {
          const labels = this.getLabels();
          throw new Error(`CRITICAL: Key column '${targetKeyField}' not found in ${this.longName}. Available Columns: [${labels.join(", ")}]`);
        }
        
        this._keyMetadata = {
          type: "single",
          offset: keyOffset,
          fieldType: TypeUtils.getType(this.longName, targetKeyField)
        };
        break;
      }
      
      case !!keyFieldsRaw: {
        // Composite Key (Fallback)
        const fieldList = String(keyFieldsRaw).split(",").map(field => field.trim());
        this._keyMetadata = {
          type: "composite",
          fields: fieldList.map(field => {
            const fieldOffset = this.getColOffset(field);
            if (fieldOffset === -1) throw new Error("CRITICAL: KeyField '" + field + "' not found in " + this.longName);
            
            return {
              offset: fieldOffset,
              type: TypeUtils.getType(this.longName, field)
            };
          })
        };
        break;
      }
      
      default:
        const available = Object.keys(this._properties).join(", ");
        throw new Error(`CRITICAL: Table ${this.longName} has no 'Key' or 'KeyFields' configured in the registry. Available properties: [${available}]. Check your spreadsheet column headers.`);
    }
    return this._keyMetadata;
  }

  /**
   * Calculates the primary key for a given row array.
   * @param {Array} row The row data array.
   * @param {number} pRow Optional physical row number for logging context.
   */
  getRowKey(row, pRow = null) {
    try {
      if (!this._keyMetadata) this._initializeKeyMetadata();
      
      if (this._keyMetadata.type === "single") {
        const rawVal = row[this._keyMetadata.offset];
        if (rawVal === undefined || rawVal === "") return null;
        
        const val = TypeUtils.castType(rawVal, this._keyMetadata.fieldType);
        return val === null ? null : String(val).trim();
      } else {
        if (this._keyMetadata.fields.length === 0) return null;
        let allEmpty = true;
        const compositeValue = this._keyMetadata.fields.map(fieldMeta => {
          const rawCell = row[fieldMeta.offset];
          if (rawCell !== undefined && rawCell !== null && String(rawCell).trim() !== "") {
            allEmpty = false;
          }
          const val = TypeUtils.castType(rawCell, fieldMeta.type);
          return String(val || "").trim().toLowerCase();
        }).join("|");
        
        if (allEmpty) return null;
        return CryptoUtils.generateHash(compositeValue);
      }
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getRowKey() Failure: ${e.message}`);
    }
  }

  buildHashKeyMap() {
    this._hashKeyMap.clear();
    this._isHashed = true;

    // --- FULL SCAN FOR KEYS ---
    // If this is an UpdateTable, we MUST know all existing keys to prevent duplicates,
    // even if they fall outside the current 'FirstRow' window.
    if (this.sheet && (this instanceof UpdateTable || this.getProperty("importmethod"))) {
      const lastRow = this.sheet.getLastRow();
      if (lastRow >= this.firstDataRowIndex) {
        this._initializeKeyMetadata();
        const keyMetadata = this._keyMetadata;
        
        // Optimize: If it's a single column key, fetch only that column
        if (keyMetadata.type === "single") {
          const keyCol = keyMetadata.offset + 1;
          const values = this.sheet.getRange(this.firstDataRowIndex, keyCol, lastRow - this.firstDataRowIndex + 1, 1).getValues();
          values.forEach((valArr, index) => {
            const rawVal = valArr[0];
            if (rawVal !== undefined && rawVal !== "") {
              const key = String(TypeUtils.castType(rawVal, keyMetadata.fieldType) || "").trim().toLowerCase();
              if (key) this._hashKeyMap.set(key, index);
            }
          });
          myLog("trace", "Table %s: Hashed %d keys from full-sheet scan (Col %d).", this.longName, this._hashKeyMap.size, keyCol);
          return;
        } else {
          // Composite Keys: Fetch only the necessary columns for the full sheet
          const lastCol = this.sheet.getLastColumn();
          const numRows = lastRow - this.firstDataRowIndex + 1;
          const fullData = this.sheet.getRange(this.firstDataRowIndex, 1, numRows, lastCol).getValues();
          
          fullData.forEach((row, index) => {
            const key = this.getRowKey(row);
            if (key) this._hashKeyMap.set(key, index);
          });
          myLog("trace", "Table %s: Hashed %d keys from full-sheet scan (Composite).", this.longName, this._hashKeyMap.size);
          return;
        }
      }
    }

    // Fallback: Hash only the current window
    this.getWindow().forEach((row, index) => {
      const key = this.getRowKey(row);
      if (key) {
        this._hashKeyMap.set(String(key).trim().toLowerCase(), index);
      }
    });
  }

  /**
   * Lazy accessor for the Hash Key Map.
   * Ensures the map is built exactly once on demand.
   */
  getHashKeyMap() {
    if (!this._isHashed) {
      this.buildHashKeyMap();
    }
    return this._hashKeyMap;
  }

  getRowOffset(key) {
    return this.getHashKeyMap().get(String(key).trim().toLowerCase());
  }

  /**
   * High-Performance Lookup
   * Builds a lazy cache of KeyCol -> ValCol for O(1) retrieval.
   */
  lookupValue(keyCol, valCol, searchVal) {
    if (!this._lookupCacheMap) this._lookupCacheMap = new Map();
    const cacheKey = `${keyCol}_${valCol}`;
    
    if (!this._lookupCacheMap.has(cacheKey)) {
      this.fetch();
      
      const keyOffset = this.getColOffset(keyCol);
      const valOffset = this.getColOffset(valCol);
      
      if (keyOffset === -1 || valOffset === -1) return "";
 
      const lookupMap = new Map();
      this._window.forEach(row => {
        const k = row[keyOffset];
        if (k !== undefined && k !== "") lookupMap.set(String(k).toLowerCase(), row[valOffset]);
      });
      this._lookupCacheMap.set(cacheKey, lookupMap);
      myLog("trace", "Built lookup cache for %s (%s->%s)", this.longName, keyCol, valCol);
    }
    
    return this._lookupCacheMap.get(cacheKey).get(String(searchVal).toLowerCase()) || "";
  }
  
  /**
   * Calculates required Named Ranges and delegates creation to the Physical layer.
   */
  writeNamedRanges() {
    if (!this.sheet) {
      myLog("warn", "Cannot write named ranges for Virtual Sheet: %s", this.longName);
      return;
    }
    
    const startRow = (Number(this.getProperty("LabelRow")) || 1) + 1;
    const endRow = this.sheet.getMaxRows();
    const lastCol = this.sheet.getLastColumn();
    
    if (endRow < startRow || lastCol === 0) return;
    
    const numRows = endRow - startRow + 1;
    const safeSheetName = Utils.cleanNameForRange(this.sheetName);
    
    // 1. SheetNameSheet (Row 1 to end)
    this.writeNamedRange(safeSheetName + "Sheet", 1, 1, endRow, lastCol);
    
    // 2. SheetNameData (Row LabelRow+1 to end)
    this.writeNamedRange(safeSheetName + "Data", startRow, 1, numRows, lastCol);
    
    // 3. SheetNameColumnName (Per column)
    this.getLabels().forEach(label => {
      if (!label) return;
      const colOff = this.getColOffset(label);
      if (colOff !== -1) {
        const rangeName = safeSheetName + Utils.cleanNameForRange(label);
        this.writeNamedRange(rangeName, startRow, colOff + 1, numRows, 1);
      }
    });
    
    myLog("info", "Successfully wrote Named Ranges for %s", this.longName);
  }


  /**
   * Scans the physical sheet to find the first row that matches or follows the target date.
   * Useful for setting the ingestion window for a specific Financial Year.
   * @param {Date} targetDate
   * @param {string} dateLabel - The name of the column to scan (defaults to 'Date')
   * @returns {number} The physical row index.
   */
  calculateFirstRowByDate(targetDate, dateLabel = "Date") {
    if (!this.sheet) return this.firstDataRowIndex;
    
    const dateCol = this.getColOffset(dateLabel);

    if (dateCol === -1) {
      myLog("warn", "Table %s: Cannot calculate FirstRow by date. Column '%s' not found.", this.longName, dateLabel);
      return this.firstDataRowIndex;
    }

    // Fetch only the date column for efficiency
    const lastRow = this.sheet.getLastRow();
    
    let labelRow = Number(this.getProperty("LabelRow"));
    if (isNaN(labelRow) || labelRow === undefined || labelRow === null) {
      labelRow = 1;
    }
    const searchStartRow = labelRow + 1; // Always scan from the top of the data
    
    if (lastRow < searchStartRow) return searchStartRow;

    const dateValues = this.sheet.getRange(searchStartRow, dateCol + 1, lastRow - searchStartRow + 1, 1).getValues();
    const targetTime = targetDate.getTime();
    
    for (let i = 0; i < dateValues.length; i++) {
      const cellValue = dateValues[i][0];
      const cellDate = cellValue instanceof Date ? cellValue : new Date(cellValue);
      
      if (!isNaN(cellDate.getTime())) {
        if (cellDate.getTime() >= targetTime) {
          return i + searchStartRow;
        }
      }
    }
    return lastRow; // Default to end if no future dates found
  }
}

// Register with globals
globals.tableMap['Table'] = Table;
