"use strict";

/**
 * gitCode_Redesign - Type Management Utility
 * Strictly enforces data types based on the NewAccounts_DataTypes configuration.
 */
const TypeUtils = {
  
  /**
   * Casts a raw value to the specified type.
   * Functional Pattern: Pure transformation. No side effects/logging.
   * @param {any} val The value to cast.
   * @param {string} type The target type name.
   * @param {Object} [context] Optional context for error reporting {sheet, row, col}.
   */
  castType(val, type, context = null) {
    try {
      if (val === null || val === undefined || val === "") return "";
      
      const cleanType = (type || "String").trim();
      
      switch (cleanType) {
        case 'String':
          if (val instanceof Date) return DateUtils.toISODate(val);
          if (typeof val === 'number') return String(val);
          return String(val).trim().replace(/[\x00-\x1F\x7F-\x9F]/g, "");
          
        case 'Integer':
          return parseInt(val, 10) || 0;
          
        case 'Currency':
          const cleanCurr = String(val).replace(/[£$,\s]/g, '');
          return parseFloat(cleanCurr) || 0;

        case 'Percentage':
          const strVal = String(val).trim();
          const isPercentString = strVal.endsWith('%');
          const cleanPerc = strVal.replace(/[£$,%\s]/g, '');
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
          return String(val).trim();
          
        case 'rangeNames':
          return String(val).trim().replace(CONFIG_CONSTANTS.RANGE_NAME_REGEX, '_');

        case 'DateRange':
          return this._castDateRange(val);
          
        default:
          return String(val).trim();
      }
    } catch (e) {
      const ctxStr = context ? ` [${context.sheet} Row ${context.row}, Col "${context.col}"]` : "";
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
    const ctxStr = context ? ` [${context.sheet} Row ${context.row}, Col "${context.col}"]` : "";

    switch (cleanType) {
      case 'Key1':
        // Permissive suffix: Allows -, #, ., _ for negative hashes and complex generated keys
        if (!/^[A-Za-z0-9]+#20\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])_[A-Za-z0-9#._-]+$/.test(val)) {
          throw new Error(`Schema Validation Failure: Invalid Key1 format "${val}". Expected "prefix#yyyymmdd_suffix".${ctxStr}`);
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
        
      case 'Key1_Strict':
         if (!/^[A-Za-z]+#20\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])_[A-Za-z0-9]+$/.test(val)) {
          throw new Error(`Schema Validation Failure: Value "${val}" does not meet strict Key1 requirements.${ctxStr}`);
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
        // Use the Thunking Layer to resolve between Native Date and ISO String
        return DateUtils.toEgressDate(val);
        
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
    return Registry.getType(longName, columnName);
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
