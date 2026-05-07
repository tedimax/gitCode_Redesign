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
   * Cleans and validates a string name (Account or Category).
   * Returns null if the value is empty or contains "garbage" strings like "undefined".
   */
  const sanitizeName = (val) => {
    const cleaned = String(val || "").trim();
    if (!cleaned || cleaned.toLowerCase() === "undefined" || cleaned.toLowerCase() === "null") return null;
    return cleaned;
  };

  /**
   * Replaces {{mustache}} tokens in a string using values from a context object.
   */
  const interpolate = (template, context) => {
    if (typeof template !== "string") return template;
    return template.replace(/{{(.*?)}}/g, (match, key) => {
      return resolveKey(context, key.trim()) || "";
    });
  };

  /**
   * Resolves a nested property value from an object using a dot-notation path (e.g., "totals.grandIn").
   */
  const resolveKey = (obj, path) => {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((prev, curr) => prev ? prev[curr] : undefined, obj);
  };

  /**
   * Converts a 0-based column index to its Google Sheets letter notation (A, B, C... AA, AB...).
   */
  const columnToLetter = (index) => {
    let col = index + 1;
    let letter = "";
    while (col > 0) {
      let modulo = (col - 1) % 26;
      letter = String.fromCharCode(modulo + 65) + letter;
      col = Math.floor((col - modulo - 1) / 26);
    }
    return letter;
  };

  return {
    toRangeName,
    sanitizeName,
    interpolate,
    resolveKey,
    columnToLetter
  };
})();
