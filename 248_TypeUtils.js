"use strict";

/**
 * gitCode_Redesign - Type Management Utility
 * Strictly enforces data types based on the NewAccounts_DataTypes configuration.
 */
const TypeUtils = {
  
  /**
   * Casts a raw value to the specified type.
   * Functional Pattern: Pure transformation.
   */
  castType(val, type) {
    if (val === null || val === undefined || val === "") return "";
    
    const cleanType = (type || "String").trim();
    
    switch (cleanType) {
      case 'String':
        if (val instanceof Date) return DateUtils.toISODate(val);
        return String(val).trim().replace(CONFIG_CONSTANTS.CLEAN_NAME_REGEX, '');
        
      case 'Integer':
        const intVal = parseInt(val, 10);
        return isNaN(intVal) ? 0 : intVal;
        
      case 'Currency':
      case 'Percentage':
        const numVal = parseFloat(val);
        return isNaN(numVal) ? (0).toFixed(CONFIG_CONSTANTS.DECIMAL_PRECISION) : numVal.toFixed(CONFIG_CONSTANTS.DECIMAL_PRECISION);
        
      case 'Boolean':
        if (typeof val === 'boolean') return val;
        const strVal = String(val).toLowerCase();
        return strVal === 'true' || strVal === 'yes' || strVal === '1';
        
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
        return String(val).trim(); // Specialized logic in Table classes
        
      case 'rangeNames':
        return String(val).trim().replace(CONFIG_CONSTANTS.RANGE_NAME_REGEX, '_');

      case 'DateRange':
        // Expects "datetime - datetime" or similar
        return this._castDateRange(val);
        
      default:
        // Untyped fields default to clean String
        return String(val).trim().replace(CONFIG_CONSTANTS.CLEAN_NAME_REGEX, '');
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
    if (!globals.dataTypesMap) return "String";
    return globals.dataTypesMap.get(`${longName}:${columnName}`) || "String";
  }
};
