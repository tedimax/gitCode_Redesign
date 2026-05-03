"use strict";

/**
 * gitCode_Redesign - Table Class (Level 2)
 * Represents the Logical & Property Layer.
 * Extends Sheet to provide configuration-driven logic, hashing, and type casting.
 */
class Table extends Sheet {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    // Semi-private logic stores
    this._properties = properties;
    this._columnMap = new Map();
    this._hashKeyMap = new Map();
    this._isHashed = false;
    this._keyMetadata = null;
    this._orderedLabels = null;
    
    // Initialize headers automatically upon creation
    this.initializeHeaderMap();
  }

  /**
   * Safe access to table constants from the Sheets config.
   */
  getProperty(columnName) {
    return this._properties[columnName] || null;
  }

  /**
   * Builds a Map of Label -> Column Offset.
   * Stores both the ordered array and the lookup map for O(1) retrieval.
   */
  initializeHeaderMap() {
    const labelRow = this.getProperty("LabelRow") || 1;
    
    // 1. Capture and trim labels in their physical order
    this._orderedLabels = this.getLabels(labelRow).map(l => String(l || "").trim());
    
    // 2. Build the lookup map functionally (Label -> Offset)
    this._columnMap = new Map(
      this._orderedLabels
        .map((label, offset) => [label, offset])
        .filter(([label]) => label !== "")
    );
    
    myLog("trace", "Initialized columnMap for %s with %d labels", this.longName, this._columnMap.size);
  }

  /**
   * Returns an array of field labels in their physical column order.
   */
  getColLabels() {
    return this._orderedLabels || [];
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
  getCellValueByRowOffsetColumnLabel(rowOffset, label) {
    const colOffset = this.getColOffset(label);
    if (colOffset === -1) return null;
    return this.get(rowOffset, colOffset);
  }

  setCellValueByRowOffsetColumnLabel(rowOffset, label, val) {
    const colOffset = this.getColOffset(label);
    if (colOffset !== -1) {
      this.set(rowOffset, colOffset, val);
    }
  }

  /**
   * Converts a window row into a JavaScript object.
   * Functional Pattern: .reduce() over columnMap.
   */
  getRowObjectByOffset(rowOffset) {
    if (rowOffset < 0 || rowOffset >= this.windowDataLength) return null;
    
    // Debug logs removed. Logic continues.
    return Array.from(this._columnMap.entries()).reduce((obj, [label, colOff]) => {
      obj[label] = this.get(rowOffset, colOff);
      return obj;
    }, {});
  }

  /**
   * Internal helper to resolve key column metadata once.
   */
  _initializeKeyMetadata() {
    if (this._keyMetadata) return;

    const targetKeyField = this.getProperty("Key");
    const keyFieldsRaw = this.getProperty("KeyFields");

    if (targetKeyField) {
      // Single Key (Priority)
      const off = this.getColOffset(targetKeyField);
      if (off === -1) myLog("error", "CRITICAL: Key column '" + targetKeyField + "' not found in " + this.longName);
      this._keyMetadata = {
        type: "single",
        offset: off,
        fieldType: TypeUtils.getType(this.longName, targetKeyField)
      };
    } else if (keyFieldsRaw) {
      // Composite Key (Fallback)
      const fieldList = String(keyFieldsRaw).split(",").map(field => field.trim());
      this._keyMetadata = {
        type: "composite",
        fields: fieldList.map(field => {
          const off = this.getColOffset(field);
          if (off === -1) myLog("error", "CRITICAL: KeyField '" + field + "' not found in " + this.longName);
          return {
            offset: off,
            type: TypeUtils.getType(this.longName, field)
          };
        })
      };
    } else {
      // Emergency Fallback
      const fallback = "RowID";
      this._keyMetadata = {
        type: "single",
        offset: this.getColOffset(fallback),
        fieldType: "Integer"
      };
    }
  }

  /**
   * Calculates the primary key for a given row array.
   * Logic is shared between hashing and persistence matching.
   */
  getRowKey(row) {
    if (!this._keyMetadata) this._initializeKeyMetadata();
    const meta = this._keyMetadata;

    if (meta.type === "single") {
      if (meta.offset === -1) return null;
      const rawVal = row[meta.offset];
      if (rawVal === undefined || rawVal === "") return null;
      const val = TypeUtils.castType(rawVal, meta.fieldType);
      return val === null ? null : String(val).trim();
    } else {
      if (meta.fields.length === 0) return null;
      const compositeValue = meta.fields.map(fieldMeta => {
        const val = TypeUtils.castType(row[fieldMeta.offset], fieldMeta.type);
        return String(val || "");
      }).join("|");
      return CryptoUtils.generateHash(compositeValue);
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

  getRowOffsetByKey(key) {
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
      if (this.windowDataLength === 0) this.fetchWindow();
      
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
   * Overrides Sheet.fetchWindow to apply Strict Typing and Perimeter Validation.
   * Every cell is cast to its configured type and checked for mandatory requirements.
   */
  fetchWindow() {
    super.fetchWindow();
    
    const labels = this.getColLabels();
    const fieldTypes = labels.map(label => TypeUtils.getType(this.longName, label));
    const physicalRowStart = this.firstDataRowIndex;
    
    myLog("trace", "Applying Strict Typing & Validation to %d rows in %s", this.windowDataLength, this.longName);
    
    const pkOff = this.getColOffset("PK");
    const clearedOff = this.getColOffset("Cleared");

    this._window = this._window.map((row, rowOff) => {
      const physicalRow = physicalRowStart + rowOff;
      const pkValue = pkOff !== -1 ? row[pkOff] : "Unknown";
      
      // Resolve "Cleared" status for conditional validation
      const rawCleared = clearedOff !== -1 ? row[clearedOff] : true;
      const isCleared = (rawCleared === true || String(rawCleared).toUpperCase() === "TRUE");

      return row.map((cell, colOff) => {
        const type = fieldTypes[colOff];
        const label = labels[colOff];
        const val = TypeUtils.castType(cell, type);

        // --- PERIMETER VALIDATION ---
        // Mandatory fields are strictly enforced ONLY if the row is "Cleared"
        let isMandatory = type.startsWith("*") || ["Account", "EntryType", "FinancialYear", "Date", "PK", "Group", "Amount"].includes(label);
        
        // If not cleared, we relax the mandatory requirement for Group/Amount/etc.
        if (!isCleared) isMandatory = false;

        if (isMandatory && (val === "" || val === null || val === undefined)) {
          throw new Error(`Validation Error: Mandatory field "${label}" is empty at row ${physicalRow} [PK: ${pkValue}] of ${this.longName}.`);
        }
        
        if (isMandatory && label === "Group" && Number(val) === 0) {
          throw new Error(`Validation Error: Group ID cannot be zero at row ${physicalRow} [PK: ${pkValue}] of ${this.longName}.`);
        }

        return val;
      });
    });
  }

}

// Register with globals
globals.tableMap['Table'] = Table;
