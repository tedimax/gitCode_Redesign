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
   * Uses functional .reduce() to traverse the label row.
   */
  initializeHeaderMap() {
    const labelRow = this.getProperty("LabelRow") || 1;
    const labels = this.getLabels(labelRow);
    
    this._columnMap = labels.reduce((map, label, offset) => {
      if (label) {
        map.set(label.trim(), offset);
      }
      return map;
    }, new Map());
    
    this._orderedLabels = null; // Clear cache
    myLog("trace", "Initialized columnMap for %s with %d labels", this.longName, this._columnMap.size);
  }

  /**
   * Returns an array of field labels in their physical column order.
   * Caches the result for performance.
   */
  getColLabels() {
    if (this._orderedLabels) return this._orderedLabels;

    this._orderedLabels = Array.from(this._columnMap.entries())
      .sort((a, b) => a[1] - b[1])
      .map(entry => entry[0]);

    return this._orderedLabels;
  }

  /**
   * Column Index Resolver
   */
  getColOffset(name) {
    if (!this._columnMap.has(name)) return -1;
    return this._columnMap.get(name);
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


}

// Register with globals
globals.tableMap['Table'] = Table;
