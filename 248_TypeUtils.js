"use strict";
myLog("info", "TypeUtils Bootstrap: v4 (Sync Kick Active)");
// Sync Kick: 22:23

/**
 * gitCode_Redesign - Type Management Utility
 * Strictly enforces data types based on the NewAccounts_DataTypes configuration.
 */
const TypeUtils = {
  
  /**
   * Helper to retrieve column letter and index for error messages.
   */
  _getColDetails(sheet, col) {
    if (!sheet || !col) return "";
    try {
      const instance = globals.sheetInstances[sheet];
      if (instance) {
        const colIdx = instance.column[col];
        if (colIdx !== undefined) {
          return ` (Column ${StringUtils.columnToLetter(colIdx)}/${colIdx + 1})`;
        }
      }
    } catch (e) {}
    return "";
  },

  /**
   * Casts a raw value to the specified type.
   * Functional Pattern: Pure transformation. No side effects/logging.
   * @param {any} val The value to cast.
   * @param {string} type The target type name.
   * @param {Object} [context] Optional context for error reporting {sheet, row, col}.
   */
  castType(val, type, context = null) {
    try {
      const cleanType = (type || "String").trim();
      const isEmpty = (val === null || val === undefined || val === "");
      
      // Guard: Google Sheets formula errors (#N/A, #REF!, #VALUE!, #DIV/0!, etc.)
      // arrive as strings or as SpreadsheetApp error objects. Treat them as empty.
      if (!isEmpty) {
        const strCheck = String(val);
        if (strCheck.charAt(0) === "#") return "";
      }

      if (isEmpty && ["String", "Key1", "Key2", "rangeNames"].includes(cleanType)) return "";
      
      switch (cleanType) {
        case 'String':
          const isDateObj = val instanceof Date || (val && typeof val.getTime === 'function' && !isNaN(val.getTime()));
          if (isDateObj) {
            // If the Date object falls on the Google Sheets Time epoch (Dec 30, 1899),
            // it is a pure time cell that is being read as a Date object. Return the Time string.
            if (val.getFullYear() === 1899 && val.getMonth() === 11 && val.getDate() === 30) {
              return DateUtils.toISOTime(val);
            }
            return DateUtils.toISODate(val);
          }
          if (typeof val === 'number') return String(val);
          const strVal = String(val).trim().replace(/[\x00-\x1F\x7F-\x9F]/g, "");
          const lowerStr = strVal.toLowerCase();
          if (lowerStr === "null" || lowerStr === "undefined") return "";
          return strVal;
          
        case 'Integer':
          return parseInt(val, 10) || 0;
          
        case 'Currency':
          const cleanCurr = String(val).replace(/[£$,\s]/g, '');
          return parseFloat(cleanCurr) || 0;

        case 'Percentage':
          const percentStr = String(val).trim();
          const isPercentString = percentStr.endsWith('%');
          const cleanPerc = percentStr.replace(/[£$,%\s]/g, '');
          let numPerc = parseFloat(cleanPerc) || 0;
          if (isPercentString) numPerc = numPerc / 100;
          return numPerc;
          
        case 'Boolean':
          return this.isTrue(val);
          
        case 'Date':
          return DateUtils.toISODate(val);
          
        case 'DateTime':
          return DateUtils.toISODateTime(val);
          
        case 'Time':
          return DateUtils.toISOTime(val);
          
        case 'YYYY':
          const year = parseInt(val, 10);
          return isNaN(year) ? "" : String(year).padStart(4, '0');
          
        case 'Key1':
        case 'Key2':
          const keyStr = String(val).trim();
          const keyLower = keyStr.toLowerCase();
          if (keyLower === "null" || keyLower === "undefined") return "";
          return keyStr;
          
        case 'rangeNames':
          return String(val).trim().replace(CONFIG_CONSTANTS.RANGE_NAME_REGEX, '_');

        case 'DateRange':
          return this._castDateRange(val);

        case 'TimeRange':
          return DateUtils.toISOTimeRange(val);
          
        default:
          const defStr = String(val).trim();
          const defLower = defStr.toLowerCase();
          if (defLower === "null" || defLower === "undefined") return "";
          return defStr;
      }
    } catch (e) {
      const colDetails = this._getColDetails(context ? context.sheet : null, context ? context.col : null);
      const ctxStr = context ? ` [${context.sheet} Row ${context.row}, Col "${context.col}"${colDetails}]` : "";
      throw new Error(`[Schema Layer] castType failure for type "${type}"${ctxStr}: ${e.message}`);
    }
  },

  /**
   * The Border Guard.
   * Performs high-fidelity validation and logs warnings with context.
   * Called ONLY during ingestion/transformation (the system boundary).
   */
  validate(val, type, context = null) {
    if (val === null || val === undefined || val === "") return;
    
    const cleanType = (type || "String").trim();
    const colDetails = this._getColDetails(context ? context.sheet : null, context ? context.col : null);
    const ctxStr = context ? ` [${context.sheet} Row ${context.row}, Col "${context.col}"${colDetails}]` : "";

    switch (cleanType) {
      case 'Key1':
      case 'Key1_Strict':
         const sVal = String(val || "").trim();
         // Unified Legacy-Safe Regex: supports YYYY and YYYYMMDD with symbols, allowing optional .SS to .SSSSS sequence
         const pkRegex = /^[A-Za-z0-9.-]+#(20\d{2}|20\d{6})(\.\d{2,5})?_[A-Za-z0-9.#-]+$/;
         
         if (!pkRegex.test(sVal)) {
           const charCodes = sVal.split('').map(c => c.charCodeAt(0)).join(',');
           myLog("error", "PK VALIDATION DIAGNOSTIC: Value='%s' | Codes=[%s] | Len=%d", sVal, charCodes, sVal.length);
           throw new Error(`Schema Validation Failure (v5-Unified): Invalid Key1 format "${val}". Expected "prefix#yyyymmdd_suffix".${ctxStr}`);
         }
         break;

      case 'Integer':
        if (isNaN(parseInt(val, 10))) {
          throw new Error(`Schema Validation Failure: Expected Integer but received unparseable text "${val}".${ctxStr}`);
        }
        break;

      case 'Currency':
        const cleanCurr = String(val).replace(/[£$,\s]/g, '');
        if (isNaN(parseFloat(cleanCurr))) {
          throw new Error(`Schema Validation Failure: Expected Currency but received unparseable text "${val}".${ctxStr}`);
        }
        break;
    }
  },
  
  /**
   * Converts an internal typed value back into a format Google Sheets understands.
   * e.g. Converts ISO Date strings back into native JS Date objects for correct formatting.
   */
  toSheetValue(val, type) {
    if (val === null || val === undefined || val === "") return "";
    
    const cleanType = (type || "String").trim();
    
    switch (cleanType) {
      case 'Date':
      case 'DateTime':
      case 'Time':
        // Use the Thunking Layer to resolve between Native Date and ISO String
        return DateUtils.toEgressDate(val, cleanType);
        
      case 'Integer':
      case 'Currency':
      case 'Percentage':
        // Ensure strictly numeric for calculations in sheets
        return Number(val);
        
      case 'Boolean':
        return !!val;
        
      default:
        return val;
    }
  },

  /**
   * Internal helper for DateRange casting
   */
  _castDateRange(val) {
    const parts = String(val).split("-").map(p => p.trim());
    if (parts.length === 2) {
      return `${DateUtils.toISODateTime(parts[0])} - ${DateUtils.toISODateTime(parts[1])}`;
    }
    return String(val);
  },

  /**
   * Retrieves the type for a specific spreadsheet column from the registry.
   */
  getType(longName, columnName) {
    const regType = Registry.getType(longName, columnName);
    if (regType && regType !== "String") return regType;
    
    // Auto-Type Fallback for implicit columns that copy 1:1 by exact name matches
    const name = String(columnName || "").trim().toLowerCase();
    if (name === "time") return "Time";
    if (name === "date") return "Date";
    if (name === "datetime") return "DateTime";
    
    return regType || "String";
  },

  /**
   * Helper to normalize Google Sheets boolean-ish values.
   * Strictly returns true ONLY for literal booleans or the string "TRUE".
   */
  isTrue(val) {
    if (typeof val === 'boolean') return val;
    return String(val || "").toUpperCase() === "TRUE";
  }
};
