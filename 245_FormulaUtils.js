"use strict";

/**
 * gitCode_Redesign - Formula Engine Utilities
 * Handles pre-parsing, dependency analysis, and topological sorting for the Virtual Column engine.
 */
const FormulaUtils = {

  /**
   * Translates formula shorthand into functional code.
   * Supports:
   * 1. [Column] -> utils.getVal(defaultSource, "Column", rowOff)
   * 2. SheetName[Column] -> utils.getVal("SheetName", "Column", rowOff)
   */
  parse(formula, defaultSource = "") {
    if (!formula) return "''";
    
    // 1. Handle Bracketed Syntax: SheetName[ColumnName] or [ColumnName]
    const bracketRegex = /([a-zA-Z0-9]+_[a-zA-Z0-9]+)?\[([a-zA-Z0-9_ ]+)\]/g;
    formula = String(formula).replace(bracketRegex, (match, longName, colName) => {
      const target = longName || defaultSource;
      if (!target) {
        myLog("warn", "Formula uses shorthand [ %s ] but no SourceSheet is defined for this table.", colName);
      }
      return `utils.getVal("${target}", "${colName.trim()}", rowOff)`;
    });

    // Short-circuit for numeric constants
    if (!isNaN(formula) && formula.trim() !== "") return formula;
    
    return formula;
  },

  /**
   * Scans a formula string for internal dependencies.
   * Recognizes both 'calc.Field' and the new '[Field]' shorthand.
   * @param {string} formula
   * @returns {string[]} Array of field names this formula depends on.
   */
  extractDependencies(formula) {
    const deps = new Set();
    
    // 1. Detect 'calc.ColumnName' (Internal target-row dependencies)
    const calcRegex = /calc\.([a-zA-Z0-9_ ]+)/g;
    let match;
    while ((match = calcRegex.exec(formula)) !== null) {
      deps.add(match[1].trim());
    }

    return Array.from(deps);
  },

  /**
   * Sorts a Map of formulas based on their internal dependencies (calc.Field).
   * Uses a Depth-First Search (DFS) for Topological Sorting.
   * @param {Map} compiledFormulaMap - Map of FieldName -> Function
   * @param {Map} rawFormulaMap - Map of FieldName -> Original Formula String
   * @returns {Map} - A new Map sorted by execution order.
   */
  resolveDependencies(compiledFormulaMap, rawFormulaMap) {
    const sortedMap = new Map();
    const visited = new Set();
    const temp = new Set();
    
    const visit = (field) => {
      if (temp.has(field)) throw new Error(`Circular dependency detected in formula for: ${field}`);
      if (!visited.has(field)) {
        temp.add(field);
        
        const formulaStr = rawFormulaMap.get(field) || "";
        const deps = this.extractDependencies(formulaStr);
        
        deps.forEach(dep => {
          if (compiledFormulaMap.has(dep)) {
            visit(dep);
          }
        });
        
        temp.delete(field);
        visited.add(field);
        sortedMap.set(field, compiledFormulaMap.get(field));
      }
    };

    compiledFormulaMap.forEach((_, field) => visit(field));
    return sortedMap;
  },

  /**
   * Creates the 'utils' object used as the execution context for formulas.
   */
  createContext() {
    const _sheetCache = new Map();

    const getCachedInstance = (longName) => {
      if (_sheetCache.has(longName)) return _sheetCache.get(longName);
      const instance = getSheetInstance(longName);
      if (instance) {
        _sheetCache.set(longName, instance);
        instance.getWindow(); // Lazy load once
      }
      return instance;
    };

    return {
      DateUtils,
      StringUtils,
      Temporal,
      // Cross-table data retrieval
      getVal: (longName, colName, rowOff) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.getCellValueByRowOffsetColumnLabel(rowOff, colName);
      },
      // Fast map lookup
      lookup: (longName, keyCol, valCol, searchVal) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.lookupValue(keyCol, valCol, searchVal);
      },
      // Stable SHA-256 hash
      hash: (...args) => {
        if (typeof CryptoUtils === 'undefined') return args.join("_");
        return CryptoUtils.generateHash(args.join("|"));
      }
    };
  }
};
