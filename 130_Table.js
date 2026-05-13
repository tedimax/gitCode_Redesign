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
    this._properties = this._config;
    this._columnMap = new Map();
    this._hashKeyMap = new Map();
    this._isHashed = false;
    this._keyMetadata = null;
    this._labels = null;
    this._validStartRow = null; // Physical row index of the first validated row
    this._validEndRow = null;   // Physical row index of the last validated row
    
    // Initialize headers automatically upon creation
    this.initializeHeaderMap();
  }

  // =========================================================================
  // FOUNDATIONAL METHODS (CONSTRUCTOR HELPERS)
  // =========================================================================

  /**
   * Builds a Map of Label -> Column Offset.
   * Stores both the ordered array and the lookup map for O(1) retrieval.
   */
  initializeHeaderMap() {
    const labelRow = this.getProperty("LabelRow") || 1;
    
    // 1. Capture and trim labels in their physical order
    this._labels = this._fetchHeaderRow(labelRow).map(label => String(label || "").trim());
    
    // 2. Build the lookup map functionally (Label -> Offset)
    this._columnMap = new Map(
      this._labels
        .map((label, offset) => [label, offset])
        .filter(([label]) => label !== "")
    );
    
    myLog("trace", "Initialized columnMap for %s with %d labels", this.longName, this._columnMap.size);
  }

  // =========================================================================
  // PROPERTY, COLUMN & CELL ACCESSORS (GETTERS/SETTERS)
  // =========================================================================

  /**
   * Safe access to table constants from the Sheets config.
   * Uses standardized O(1) lookup.
   */
  getProperty(columnName) {
    const val = this._properties[columnName.toLowerCase().trim()];
    return val !== undefined ? val : null;
  }

  /**
   * Returns an array of field labels in their physical column order.
   */
  getLabels() {
    return this._labels || [];
  }

  /**
   * O(1) Column Index Resolver
   */
  getColOffset(name) {
    const off = this._columnMap.get(name);
    return off !== undefined ? off : -1;
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

      // Resolve which physical range needs validation
      const winEndRow = this._windowStartRow + this.windowDataLength - 1;
      
      // We only validate rows that haven't been validated in this session
      const validateStart = this._validStartRow ? Math.min(this._windowStartRow, this._validStartRow) : this._windowStartRow;
      const validateEnd = this._validEndRow ? Math.max(winEndRow, this._validEndRow) : winEndRow;

      for (let pRow = validateStart; pRow <= validateEnd; pRow++) {
        // Skip if already validated
        if (this._validStartRow && this._validEndRow && pRow >= this._validStartRow && pRow <= this._validEndRow) continue;

        const rowOff = pRow - this._windowStartRow;
        const row = this._window[rowOff];
        const keyValue = this.getRowKey(row) || "Unknown";
        
        const rawCleared = clearedOff !== -1 ? row[clearedOff] : true;
        const isCleared = (rawCleared === true || String(rawCleared).toUpperCase() === "TRUE");

        this._window[rowOff] = row.map((cell, colOff) => {
          const type = fieldTypes[colOff];
          const label = labels[colOff];
          const context = { row: pRow, col: label, sheet: this.longName };
          const val = TypeUtils.castType(cell, type);
          TypeUtils.validate(val, type, context);
          let isMandatory = CONFIG_CONSTANTS.MANDATORY_TABLE_FIELDS.includes(label);
          if (!isCleared) isMandatory = false;

          if (isMandatory && (val === "" || val === null || val === undefined)) {
            throw new Error(`Validation Error: Mandatory field "${label}" is empty at row ${pRow} [Key: ${keyValue}].`);
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
    if (this._keyMetadata) return;

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
        const compositeValue = this._keyMetadata.fields.map(fieldMeta => {
          const val = TypeUtils.castType(row[fieldMeta.offset], fieldMeta.type);
          return String(val || "");
        }).join("|");
        return CryptoUtils.generateHash(compositeValue);
      }
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getRowKey() Failure: ${e.message}`);
    }
  }

  buildHashKeyMap() {
    this._hashKeyMap.clear();
    this._isHashed = true;

    this.getWindow().forEach((row, index) => {
      const key = this.getRowKey(row);
      if (key) {
        this._hashKeyMap.set(String(key).trim(), index);
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
    return this.getHashKeyMap().get(String(key).trim());
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
        if (k !== undefined && k !== "") lookupMap.set(String(k), row[valOffset]);
      });
      this._lookupCacheMap.set(cacheKey, lookupMap);
      myLog("trace", "Built lookup cache for %s (%s->%s)", this.longName, keyCol, valCol);
    }
    
    return this._lookupCacheMap.get(cacheKey).get(String(searchVal)) || "";
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

}

// Register with globals
globals.tableMap['Table'] = Table;
