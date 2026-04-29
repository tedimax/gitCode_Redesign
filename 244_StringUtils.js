"use strict";

/**
 * gitCode_Redesign - String Utilities
 * Specialized functions for naming and sanitation.
 */
const StringUtils = (() => {
  
  /**
   * Sanitizes a string for use as a Google Named Range.
   * Logic: Convert invalid characters to underscores.
   * Requirement: First char must be a letter or underscore.
   */
  const toRangeName = (str) => {
    if (!str) return "_";
    let name = str.trim().replace(CONFIG_CONSTANTS.RANGE_NAME_REGEX, "_");
    
    // Ensure first char is valid (Letter or underscore)
    if (!/^[a-zA-Z_]/.test(name)) {
      name = "_" + name;
    }
    return name;
  };

  /**
   * General purpose name cleaner.
   * Logic: Remove characters that might break CSV/Excel/Formulas.
   */
  const cleanName = (str) => {
    if (!str) return "";
    return String(str).trim().replace(CONFIG_CONSTANTS.CLEAN_NAME_REGEX, "");
  };

  return {
    toRangeName,
    cleanName
  };
})();
