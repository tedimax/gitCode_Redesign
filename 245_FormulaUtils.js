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
  parse(formula, defaultSource = "", targetField = "", contextTable = "") {
    if (!formula) return "''";

    // Extract the "Sheet Suffix" from the current context (e.g. AnnualSummaries_2023 -> 2023)
    const targetSuffix = contextTable ? contextTable.split("_").pop() : "";

    // 1. Handle merge(...) shorthand (Vertical Union)
    // Translates merge(Cash: [Tendered], Square: [Net]) -> source-aware selection
    const mergeRegex = /merge\(([^)]*)\)/g;
    formula = String(formula).replace(mergeRegex, (match, args) => {
      const parts = args.split(",").map(p => p.trim());
      
      // Parse Overrides: "Cash: [Tendered]" -> { "Cash": "[Tendered]" }
      const overrides = {};
      parts.forEach(p => {
        const kv = p.split(":");
        if (kv.length === 2) {
          overrides[kv[0].trim()] = kv[1].trim();
        }
      });

      // CASE A: Overrides found (e.g. merge(Cash: [Tendered]))
      if (Object.keys(overrides).length > 0) {
        let nested = `[${targetField}]`; // Default
        Object.keys(overrides).forEach(matchKey => {
          const overrideField = overrides[matchKey];
          const parsedOverride = this.parse(overrideField, defaultSource, targetField, contextTable);
          
          // Smart Match: Check if the current source is exactly matchKey OR ends with _matchKey
          const condition = `(utils.getSourceName(rowOff) === "${matchKey}" || utils.getSourceName(rowOff).endsWith("_" + "${matchKey}"))`;
          nested = `(${condition} ? ${parsedOverride} : ${nested})`;
        });
        return nested;
      }

      // CASE B: Legacy/Standard merge logic
      const refs = args.split(",").map(arg => {
        const trimmed = arg.trim();
        // Check if it's a full reference: Table[Col] or [Col]
        const m = trimmed.match(/([a-zA-Z0-9_]+)?\[([a-zA-Z0-9_ ]+)\]/);
        if (m) {
          const target = m[1] || defaultSource;
          return `["${target}", "${m[2].trim()}"]`;
        }
        
        // --- Implicit Shorthands ---
        if (trimmed && !trimmed.includes("[") && targetField) {
          // Rule 1: Trailing Underscore (e.g. Ledgers_) -> Spreadsheet Group (Append Year + Field)
          if (trimmed.endsWith("_")) {
             const root = trimmed.slice(0, -1);
             return `["${root}_${targetSuffix}", "${targetField}"]`;
          }
          
          return `["${trimmed}", "${targetField}"]`;
        }
        
        return trimmed; 
      });
      return `utils.verticalMerge(rowOff, ${refs.join(", ")})`;
    });

    // 2. Handle truth(...) shorthand (Boolean casting)
    // Translates truth([Field]) -> !!(utils.getVal(..., "Field", rowOff))
    const truthRegex = /truth\(([^)]*)\)/g;
    formula = String(formula).replace(truthRegex, (match, arg) => {
      return `!!(${arg})`;
    });

    // 3. Handle lookup(...) shorthand (Cross-table lookups)
    // Translates lookup(Table, KeyCol, ValCol, SearchVal) -> utils.lookup("Table", "KeyCol", "ValCol", SearchVal)
    // Supports trailing underscore for context pivoting (e.g. lookup(Ledgers_, ...))
    const lookupRegex = /lookup\(([^,)]+),([^,)]+),([^,)]+),([^)]+)\)/g;
    formula = String(formula).replace(lookupRegex, (match, table, key, val, search) => {
      let t = table.trim();
      if (t.endsWith("_") && targetSuffix) {
        t = t.slice(0, -1) + "_" + targetSuffix;
      }
      return `utils.lookup("${t}", "${key.trim()}", "${val.trim()}", ${search.trim()})`;
    });

    // 4. Handle pk(...) shorthand (Primary Key generation)
    // Translates pk(prefix, date, hash) -> utils.pk(prefix, date, hash, rowOff)
    const pkRegex = /pk\(([^,)]+),([^,)]+),([^)]+)\)/g;
    formula = String(formula).replace(pkRegex, (match, prefix, date, hash) => {
      return `utils.pk(${prefix.trim()}, ${date.trim()}, ${hash.trim()}, rowOff)`;
    });

    // 5. Handle getKeyPrefix() shorthand
    // Maps to the 'KeyPrefix' property defined in the Sheets registry
    formula = formula.replace(/getKeyPrefix\(\)/g, "props.KeyPrefix");

    // 6. Handle hash(...) shorthand (Stable SHA-256)
    // Translates hash(a, b, c) -> utils.hash(a, b, c)
    const hashRegex = /hash\(([^)]*)\)/g;
    formula = String(formula).replace(hashRegex, (match, args) => {
      return `utils.hash(${args})`;
    });

    // 7. Handle hashRow(rowOff) shorthand
    formula = formula.replace(/hashRow\(rowOff\)/g, "utils.hashRow(rowOff)");

    // 8. Handle array(...) legacy shorthand
    // Translates array(a, b, c) -> a, b, c (Transparently unwraps for spread args)
    const arrayRegex = /array\(([^)]*)\)/g;
    formula = String(formula).replace(arrayRegex, (match, args) => {
      return args;
    });
    
    // 8. Handle Standard Bracketed Syntax: SheetName[ColumnName] or [ColumnName]
    // Supports trailing underscore for context pivoting (e.g. Ledgers_[Amount])
    const bracketRegex = /([a-zA-Z0-9_]+)?\[([a-zA-Z0-9_ ]+)\]/g;
    formula = String(formula).replace(bracketRegex, (match, longName, colName) => {
      let target = longName || defaultSource;
      if (target && target.endsWith("_") && targetSuffix) {
        target = target.slice(0, -1) + "_" + targetSuffix;
      }
      
      if (!target) {
        throw new Error(`Formula Parsing Error: Formula uses shorthand '[${colName.trim()}]', but no default SourceSheet is defined for context '${contextTable}'. Please use explicit table references (e.g. TableName[${colName.trim()}]).`);
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
   * @param {string[]} priorityFields - Optional fields to move to the front of the execution plan.
   * @returns {Map} - A new Map sorted by execution order.
   */
  resolveDependencies(compiledFormulaMap, rawFormulaMap, priorityFields = []) {
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

    // 1. Visit priority fields first (ensures they appear early if dependencies allow)
    priorityFields.forEach(field => {
      if (compiledFormulaMap.has(field)) {
        visit(field);
      }
    });

    // 2. Visit remaining fields
    compiledFormulaMap.forEach((_, field) => visit(field));
    return sortedMap;
  },

  /**
   * Creates the 'utils' object used as the execution context for formulas.
   */
  createContext(driver) {
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
      // Current row source name (for merge overrides)
      getSourceName: (rowOff) => {
        return (driver && typeof driver.getSourceName === 'function') ? driver.getSourceName(rowOff) : "";
      },
      // Cross-table data retrieval
      getVal: (longName, colName, rowOff) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.getValueByLabel(rowOff, colName);
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
      },
      // Hashes the entire raw source row for maximum idempotency
      hashRow: (rowOff) => {
        const row = driver.getWindow()[rowOff];
        if (!row || typeof CryptoUtils === 'undefined') return "";
        return CryptoUtils.generateHash(row.join("|"));
      },
      // Vertical Merge: Concatenates columns from multiple tables
      verticalMerge: (rowOff, ...sources) => {
        // sources: Array of [longName, colName]
        let currentBoundary = 0;
        for (const [longName, colName] of sources) {
          const instance = getCachedInstance(longName);
          if (!instance) continue;
          
          const len = instance.windowDataLength;
          if (rowOff < currentBoundary + len) {
            return instance.getValueByLabel(rowOff - currentBoundary, colName);
          }
          currentBoundary += len;
        }
        return "";
      },
      // Primary Key Generator: prefix#YYYYMMDD_hash
      // Smart Logic: First checks for an existing key in the source registry.
      pk: (prefix, date, hash, rowOff) => {
        // 1. Check for manual override in the source registry's Key column
        if (rowOff !== undefined && driver) {
          try {
            const existingKey = driver.getRowKey(driver.getWindow()[rowOff]);
            if (existingKey) return existingKey;
          } catch (e) {
            // Fallback if no key configured or other issue
          }
        }
        
        // 2. Fallback to generation
        if (!date || !hash) return "";
        const formattedDate = DateUtils.formatToYYYYMMDD(date);
        return `${prefix || ""}#${formattedDate}_${hash}`;
      },
      // Identifies if the current row is the last occurrence of a key (Lazy-Cached)
      isLast: (rowOff, keyFn, filterFn) => {
        const cacheKey = "_lastIdxMap";
        if (!this[cacheKey]) {
          this[cacheKey] = new Map();
          const window = driver.getWindow();
          const labels = driver.getLabels();
          
          window.forEach((rowArray, idx) => {
            const r = labels.reduce((obj, label, colOff) => {
              obj[label] = rowArray[colOff];
              return obj;
            }, {});

            if (!filterFn || filterFn(r)) {
              const k = String(keyFn(r));
              this[cacheKey].set(k, idx);
            }
          });
          myLog("info", "Formula Engine: Built isLast cache for %s (%d keys).", driver.longName, this[cacheKey].size);
        }

        const labels = driver.getLabels();
        const currentRow = driver.getWindow()[rowOff];
        const rCurrent = labels.reduce((obj, label, colOff) => {
          obj[label] = currentRow[colOff];
          return obj;
        }, {});
        
        return this[cacheKey].get(String(keyFn(rCurrent))) === rowOff;
      }
    };
  }
};
