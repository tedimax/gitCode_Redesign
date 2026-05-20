"use strict";

/**
 * gitCode_Redesign - Formula Engine Utilities
 * Handles pre-parsing, dependency analysis, and topological sorting for the Virtual Column engine.
 */
var FormulaUtils = {

  /**
   * Private Helper: Finds the matching closing parenthesis for an opening one.
   * @param {string} text 
   * @param {number} openIdx - Index of the opening parenthesis.
   * @returns {number} Index of the closing parenthesis, or -1 if not found.
   */
  _findClosingParen(text, openIdx) {
    let count = 1;
    for (let i = openIdx + 1; i < text.length; i++) {
      if (text[i] === "(") count++;
      else if (text[i] === ")") count--;
      if (count === 0) return i;
    }
    return -1;
  },

  /**
   * Translates formula shorthand into functional code.
   * Supports:
   * 1. [Column] -> utils.getVal(defaultSource, "Column", rowOff)
   * 2. SheetName[Column] -> utils.getVal("SheetName", "Column", rowOff)
   */
  /**
   * Robust Single-Pass Scanner: Translates shorthand into functional code.
   */
  parse(formula, defaultSource = "", targetField = "", contextTable = "") {
    if (!formula) return "''";
    const text = String(formula).trim();
    const targetSuffix = contextTable ? contextTable.split("_").pop() : "";
    
    let result = "";
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      // 1. Strings
      if (char === '"' || char === "'") {
        const quote = char;
        result += quote;
        i++;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === '\\') {
            result += text[i] + (text[i+1] || "");
            i += 2;
          } else {
            result += text[i];
            i++;
          }
        }
        if (i < text.length) { result += quote; i++; }
        continue;
      }

      // 2. Bracketed Shorthand [Column]
      if (char === '[') {
        const prev = result.length > 0 ? result[result.length - 1] : "";
        if (prev === ")" || prev === "]" || prev === "'" || prev === '"') {
          result += "["; i++; continue;
        }

        let longName = "";
        let j = result.length - 1;
        while (j >= 0 && /[a-zA-Z0-9_]/.test(result[j])) {
          longName = result[j] + longName;
          j--;
        }

        const end = text.indexOf(']', i + 1);
        if (end !== -1) {
          const colName = text.substring(i + 1, end).trim();
          
          // Guard: If it contains quotes, it's a JS array/object, not a column
          if (colName.includes('"') || colName.includes("'")) {
             result += "["; i++; continue;
          }

          if (/^\d+$/.test(colName)) { result += "["; i++; continue; }

          if (longName) result = result.substring(0, result.length - longName.length);
          
          // Circular Dependency / Target Pivot logic
          let replacement;
          let isVirtual = false;
          let cleanCol = colName;
          if (cleanCol.startsWith("calc.")) {
            cleanCol = cleanCol.substring(5);
          } else if (cleanCol.startsWith("calc[\"") && cleanCol.endsWith("\"]")) {
            cleanCol = cleanCol.substring(6, cleanCol.length - 2);
          } else if (cleanCol.startsWith("calc['") && cleanCol.endsWith("']")) {
            cleanCol = cleanCol.substring(6, cleanCol.length - 2);
          }

          if (!longName && cleanCol === targetField && contextTable !== "__FILTER__") {
            replacement = `(sourceRow[sourceLabels.indexOf("${cleanCol}")])`;
          } else {
            // Check if this is a virtual column in the current table
            if (!longName && contextTable && typeof Registry !== 'undefined') {
              const targetFormulas = Registry.getFormulasFor(contextTable);
              isVirtual = targetFormulas.some(f => {
                 const fName = (f.targetField || "").trim();
                 return fName === cleanCol || fName.endsWith("[" + cleanCol + "]");
              });
            }

            if (isVirtual) {
              replacement = `calc['${cleanCol}']`;
            } else {
              let target = longName || defaultSource;
              if (target.endsWith("_") && targetSuffix) target = target.slice(0, -1) + "_" + targetSuffix;
              const t = target.trim().replace(/^["']|["']$/g, '');
              const c = cleanCol.replace(/^["']|["']$/g, '');
              replacement = `utils.getVal("${t}", "${c}", rowOff)`;
            }
          }

          // Temporal API Wrapping for Date, DateTime, and Time types
          let typeTable = longName || defaultSource;
          if (!longName && (isVirtual || contextTable === "__FILTER__")) {
            typeTable = contextTable;
          }
          if (typeTable && typeTable.endsWith("_") && targetSuffix) {
            typeTable = typeTable.slice(0, -1) + "_" + targetSuffix;
          }
          if (typeTable && typeof Registry !== 'undefined') {
            const fieldType = Registry.getType(typeTable, cleanCol);
            if (fieldType === "Date") {
              replacement = `(DateUtils._toTemporalPlainDate(${replacement}))`;
            } else if (fieldType === "DateTime") {
              replacement = `(DateUtils._toTemporalPlainDateTime(${replacement}))`;
            } else if (fieldType === "Time") {
              replacement = `(DateUtils._toTemporalPlainTime(${replacement}))`;
            }
          }
          result += replacement;
          i = end + 1;
          continue;
        }
      }

      // 3. Words and Function Calls
      if (/[a-zA-Z]/.test(char)) {
        let word = "";
        let k = i;
        while (k < text.length && /[a-zA-Z0-9_]/.test(text[k])) {
          word += text[k];
          k++;
        }

        if (text[k] === '(') {
          // Special Shorthands
          if (word === "pk" || word === "pk2" || word === "hash" || word === "lookup" || word === "ifBlank" || word === "isBlank" || word === "merge" || word === "truth") {
            const prev6 = result.substring(result.length - 6);
            if (prev6 !== "utils.") {
              const endIdx = this._findClosingParen(text, k);
              if (endIdx !== -1) {
                const args = text.substring(k + 1, endIdx);
                let rep = "";
                if (word === "merge") {
                  rep = this._compileMergeMacro(args, defaultSource, targetField, contextTable);
                } else {
                  const parsedArgs = this.parse(args, defaultSource, targetField, contextTable);
                  if (word === "pk") {
                    const parts = parsedArgs.split(/,(?![^(]*\))/);
                    if (parts.length >= 3) rep = `utils.pk(${parts[0].trim()}, ${parts[1].trim()}, ${parts.slice(2).join(",").trim()}, rowOff)`;
                    else rep = `pk(${parsedArgs})`;
                  } else if (word === "pk2") {
                    const parts = parsedArgs.split(/,(?![^(]*\))/);
                    rep = `utils.pk2(${parts[0].trim()}, ${parts[1].trim()}, rowOff)`;
                  } else if (word === "hash") {
                    rep = `utils.hash(${parsedArgs})`;
                  } else if (word === "lookup") {
                    const p = parsedArgs.split(/,(?![^(]*\))/).map(s => s.trim().replace(/^["']|["']$/g, ''));
                    if (p.length >= 4) rep = `utils.lookup("${p[0]}", "${p[1]}", "${p[2]}", ${p.slice(3).join(",")})`;
                    else rep = `lookup(${parsedArgs})`;
                  } else if (word === "ifBlank" || word === "isBlank") {
                    const parts = parsedArgs.split(/,(?![^(]*\))/);
                    if (parts.length >= 3) {
                      const modeSelector = parts[0].trim();
                      const fieldNameArg = parts[1].trim();
                      const fallbackExpr = parts.slice(2).join(",").trim();
                      rep = `utils.isBlank(${modeSelector}, ${fieldNameArg}, "${targetField}", calc, props.ImportMethod, () => (${fallbackExpr}))`;
                    } else if (parts.length === 2) {
                      const fieldNameArg = parts[0].trim();
                      const fallbackExpr = parts[1].trim();
                      rep = `utils.isBlank("all", ${fieldNameArg}, "${targetField}", calc, props.ImportMethod, () => (${fallbackExpr}))`;
                    } else {
                      rep = `isBlank(${parsedArgs})`;
                    }
                  } else if (word === "truth") {
                    rep = `utils.truth(${parsedArgs})`;
                  }
                }
                result += rep;
                i = endIdx + 1;
                continue;
              }
            }
          } else if (word === "eventDate" && text[k+1] === ')') {
            result += "calc.EventDate";
            i = k + 2;
            continue;
          } else if (word === "getKeyPrefix" && text[k+1] === ')') {
            result += "props.KeyPrefix";
            i = k + 2;
            continue;
          } else if (word === "getProperty") {
            const endIdx = this._findClosingParen(text, k);
            if (endIdx !== -1) {
              const prop = text.substring(k + 1, endIdx).trim().replace(/^["']|["']$/g, '');
              result += `props.${prop}`;
              i = endIdx + 1;
              continue;
            }
          }
        }
      }
 
      result += char;
      i++;
    }
 
    return result;
  },

  /**
   * Helper to compile sheet-level merge macros: merge(Sheet[Col], Sheet[Col]) or merge([Col], [Col])
   */
  _compileMergeMacro(innerText, defaultSource, targetField, contextTable) {
    if (!innerText.trim()) return "''";
    const parts = innerText.split(/,(?![^(]*\))/).map(s => s.trim());
    
    // 1. Detect if Named (Sheet[Column]) or Positional ([Column])
    const hasSheetNames = parts.some(p => {
      const openBracket = p.indexOf("[");
      return openBracket > 0; // Bracket is preceded by a sheet name
    });

    // 2. Resolve all source sheets of the virtual union from the registry
    let sourceNames = [];
    if (typeof Registry !== 'undefined' && contextTable) {
      const config = Registry.getSheetConfig(contextTable);
      const sourcesRaw = config ? (config.SourceSheets || config.SourceSheet) : null;
      if (sourcesRaw) {
        sourceNames = String(sourcesRaw).split(",").map(s => s.trim());
      }
    }
    if (sourceNames.length === 0 && defaultSource) {
      sourceNames = [defaultSource];
    }

    // 3. Build the exact [sourceName, colName] pairs
    const overrideMap = new Map();
    if (hasSheetNames) {
      parts.forEach(part => {
        const openBracket = part.indexOf("[");
        const closeBracket = part.lastIndexOf("]");
        if (openBracket > 0 && closeBracket !== -1) {
          const sheetName = part.substring(0, openBracket).trim();
          const colName = part.substring(openBracket + 1, closeBracket).trim();
          overrideMap.set(sheetName, colName);
        }
      });
    }

    const resolvedSources = sourceNames.map((name, index) => {
      let colOverride = "";
      if (hasSheetNames) {
        const cleanName = name.replace(/^ImportsArchive_|^Ledgers_/, "");
        const popName = name.split("_").pop();
        
        if (overrideMap.has(name)) {
          colOverride = overrideMap.get(name);
        } else if (overrideMap.has(cleanName)) {
          colOverride = overrideMap.get(cleanName);
        } else if (overrideMap.has(popName)) {
          colOverride = overrideMap.get(popName);
        } else {
          colOverride = targetField;
        }
      } else {
        colOverride = parts[index] !== undefined ? parts[index] : targetField;
      }
      
      colOverride = colOverride.trim().replace(/^\[|\]$/g, "");
      return `["${name}", "${colOverride}"]`;
    });

    return `utils.verticalMerge(rowOff, ${resolvedSources.join(", ")})`;
  },

  /**
   * Scans a formula string for internal dependencies.
   */
  extractDependencies(formula, targetField = null) {
    const deps = new Set();
    const text = String(formula).trim();
    
    let i = 0;
    while (i < text.length) {
      const char = text[i];

      // 1. Strings: Ignore everything inside
      if (char === '"' || char === "'") {
        const quote = char;
        i++;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === '\\') i += 2;
          else i++;
        }
        if (i < text.length) i++;
        continue;
      }

      // 2. detect calc['Field'] or calc.Field
      if (text.substring(i, i + 5) === "calc.") {
        let word = "";
        let k = i + 5;
        while (k < text.length && /[a-zA-Z0-9_]/.test(text[k])) {
          word += text[k];
          k++;
        }
        if (word && word !== targetField) deps.add(word);
        i = k;
        continue;
      }

      if (text.substring(i, i + 5) === "calc[") {
        const end = text.indexOf(']', i + 5);
        if (end !== -1) {
          const col = text.substring(i + 5, end).trim().replace(/^["']|["']$/g, '');
          if (col && col !== targetField) deps.add(col);
          i = end + 1;
          continue;
        }
      }

      // 3. detect [Field] or Sheet[Field]
      if (char === '[') {
        // Guard against JS lookups: check prev char in 'text' (not the result)
        // Since we are scanning 'text', j = i-1
        let isJSLookup = false;
        let j = i - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        if (j >= 0) {
          const prevChar = text[j];
          if (prevChar === ")" || prevChar === "]" || prevChar === "'" || prevChar === '"') isJSLookup = true;
        }

        if (!isJSLookup) {
          const end = text.indexOf(']', i + 1);
          if (end !== -1) {
            const col = text.substring(i + 1, end).trim();
            
            // Guard: Ignore if contains quotes (JS array/object)
            if (col.includes('"') || col.includes("'")) {
               i = end + 1; continue;
            }

            // Guard: If it's a virtual column in the current table, it's NOT a source dependency
            let isVirtual = false;
            if (!/^\d+$/.test(col) && col !== targetField && typeof Registry !== 'undefined') {
              // We can't easily check contextTable here without passing it in, 
              // but we can check if it exists in ANY formulas for this import.
              // Actually, resolveDependencies handles this better.
            }
            
            if (!/^\d+$/.test(col) && col !== targetField) {
              deps.add(col);
            }
            i = end + 1;
            continue;
          }
        }
      }

      i++;
    }

    const resultDeps = Array.from(deps);
    myLog("trace", "Dependency Scanner [%s]: Found %s in formula '%s'", targetField, JSON.stringify(resultDeps), text.substring(0, 50) + "...");
    return resultDeps;
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
        const deps = this.extractDependencies(formulaStr, field);
        
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
  createContext(driver, target = null) {
    const _sheetCache = new Map();
    const _lastIdxCache = new Map(); // Local cache for isLast
    let _lastIdxCacheBuilt = false;
    let _rowObjectsCache = null;
    const props = {
      KeyPrefix: (target ? target.getProperty("KeyPrefix") : driver.getProperty("KeyPrefix")) || "",
      ImportMethod: (target ? target.getProperty("ImportMethod") : (driver ? driver.getProperty("ImportMethod") : "")) || "",
      IsBlank: (() => {
        const raw = target ? target.getProperty("IsBlank") : (driver ? driver.getProperty("IsBlank") : false);
        return (raw === true || String(raw).toLowerCase().trim() === "true");
      })()
    };
    const getCachedInstance = (longName) => {
      if (driver && driver.longName === longName) return driver;
      if (_sheetCache.has(longName)) return _sheetCache.get(longName);
      const instance = getSheetInstance(longName);
      if (instance) {
        instance.withoutValidation();
        _sheetCache.set(longName, instance);
        instance.getWindow(); // Lazy load once
      }
      return instance;
    };

    return {
      props,
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
      // Target sheet data retrieval (O(1) lazy-hashed lookup by current calc.PK)
      targetVal: (colName, calc) => {
        if (!target || !calc || !calc.PK) return "";
        const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
        if (existingRowOff === undefined) return "";
        return target.getValueByLabel(existingRowOff, colName);
      },
      // Configurable, lazy-short-circuiting test-for-blank wrapper (Generalized for source or target fields)
      isBlank: (modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn) => {
        // Global Registry/Config check: if IsBlank is false/not defined, ignore the wrapper and always compute formula
        if (!props.IsBlank) {
          return fallbackFn();
        }
        
        const mode = String(modeSelector || "all").toLowerCase().trim().replace("rows", "");
        const currentMethod = String(currentImportMethod || "").toLowerCase().trim().replace("rows", "");
        
        let shouldTest = false;
        if (mode === "all") {
          shouldTest = true;
        } else if (mode === "ignore" || mode === "") {
          shouldTest = false;
        } else {
          const modes = mode.split("+").map(m => m.trim().replace("rows", ""));
          shouldTest = modes.includes(currentMethod);
        }
        
        if (shouldTest) {
          const cleanColName = (name) => {
            if (!name) return "";
            let cleaned = String(name).trim();
            if (cleaned.startsWith("calc.")) {
              cleaned = cleaned.substring(5);
            } else if (cleaned.startsWith("calc[\"") && cleaned.endsWith("\"]")) {
              cleaned = cleaned.substring(6, cleaned.length - 2);
            } else if (cleaned.startsWith("calc['") && cleaned.endsWith("']")) {
              cleaned = cleaned.substring(6, cleaned.length - 2);
            }
            return cleaned.trim();
          };

          const resolvedTestCol = cleanColName(testColName);
          const resolvedTargetCol = cleanColName(targetColName);

          // 1. Resolve resolvedTestCol's value from source/calc OR existing target sheet row
          let valToTest = undefined;
          if (calc) {
            const key = Object.keys(calc).find(k => k.toLowerCase() === resolvedTestCol.toLowerCase());
            if (key !== undefined) {
              valToTest = calc[key];
            }
          }
          if ((valToTest === undefined || valToTest === "" || valToTest === null) && target && calc && calc.PK) {
            const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
            if (existingRowOff !== undefined && target.getColOffset(resolvedTestCol) !== -1) {
              valToTest = target.getValueByLabel(existingRowOff, resolvedTestCol);
            }
          }
          
          // 2. If testColName is not blank, bypass formula and return existing target field value
          if (valToTest !== undefined && valToTest !== "" && valToTest !== null) {
            if (calc) {
              const key = Object.keys(calc).find(k => k.toLowerCase() === resolvedTargetCol.toLowerCase());
              if (key !== undefined && calc[key] !== "" && calc[key] !== null && calc[key] !== undefined) {
                return calc[key];
              }
            }
            if (target && calc && calc.PK) {
              const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
              if (existingRowOff !== undefined && target.getColOffset(resolvedTargetCol) !== -1) {
                const ext = target.getValueByLabel(existingRowOff, resolvedTargetCol);
                if (ext !== "" && ext !== null && ext !== undefined) {
                  return ext;
                }
              }
            }
          }
        }
        
        return fallbackFn();
      },
      ifBlank: function(modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn) {
        // Standard delegation to isBlank for legacy spreadsheet formula backwards compatibility
        return this.isBlank(modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn);
      },
      // Fast map lookup
      lookup: (longName, keyCol, valCol, searchVal) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.lookupValue(keyCol, valCol, searchVal);
      },
      // Legacy DJB2/hashCode compatibility workaround
      hash: (...args) => {
        const to2String = (input) => {
          if (input === null || input === undefined) return "";
          if (typeof input === 'number') {
            return input.toFixed(2);
          } else if (typeof input === 'string') {
            return input.trim();
          } else {
            return String(input);
          }
        };

        const hashStr = args.reduce((str, arg) => str + to2String(arg), "");
        const finalStr = hashStr + "0"; // initial count was 0

        let hashKey = 0;
        for (let i = 0; i < finalStr.length; i++) {
          const chr = finalStr.charCodeAt(i);
          hashKey = ((hashKey << 5) - hashKey) + chr;
          hashKey |= 0; // Convert to signed 32-bit integer
        }
        return hashKey.toString();
      },
      // truth: Evaluates a value as a Boolean based on non-zero, not null, not blank criteria
      truth: (val) => {
        if (val === null || val === undefined) return false;
        const str = String(val).trim();
        if (str === "" || str === "0") return false;
        
        const num = Number(val);
        if (!isNaN(num)) {
          return num !== 0;
        }
        
        const lower = str.toLowerCase();
        if (lower === "true" || lower === "yes" || lower === "y" || lower === "1") return true;
        if (lower === "false" || lower === "no" || lower === "n" || lower === "0") return false;
        
        return true;
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
            if (colName === "" || colName === "''" || colName === '""') {
              return "";
            }
            return instance.getValueByLabel(rowOff - currentBoundary, colName);
          }
          currentBoundary += len;
        }
        return "";
      },
      // Primary Key Generator: prefix#YYYYMMDD_hash
      // Fluid Interface: Handles both (date, hash, rowOff) and (prefix, date, hash, rowOff)
      pk: (...args) => {
        let prefix, date, hash, rowOff;
        
        if (args.length >= 4) {
          [prefix, date, hash, rowOff] = args;
        } else {
          [date, hash, rowOff] = args;
          prefix = props.KeyPrefix;
        }

        // Generate target-prefixed key
        if (!date || !hash) return "";
        const formattedDate = DateUtils.toCompactDate(date);
        return `${prefix || ""}#${formattedDate}_${hash}`;
      },
      // Specialty PK generator for dynamic transaction expansion
      pk2: (pk, date, rowOff) => {
        if (!pk) return "";
        const compactDate = DateUtils.toCompactDate(date);
        const pkStr = String(pk).trim();
        
        // Backward compatibility rule: If the key starts with "Transaction", preserve legacy double-prefix format
        if (pkStr.startsWith("Transaction")) {
          return "Transaction#" + compactDate + "_" + pkStr;
        }
        
        const hashIdx = pkStr.indexOf("#");
        if (hashIdx !== -1) {
          const lhs = pkStr.substring(0, hashIdx);
          const rhs = pkStr.substring(hashIdx + 1);
          return `${lhs}#${compactDate}_${rhs}`;
        } else {
          return `Transaction#${compactDate}_${pkStr}`;
        }
      },
      isLast: (rowOff, keyFn, filterFn) => {
        if (!_lastIdxCacheBuilt) {
          const window = driver.getWindow();
          const labels = driver.getLabels();
          
          _rowObjectsCache = window.map(rowArray => {
            return labels.reduce((obj, label, colOff) => {
              obj[label] = rowArray[colOff];
              return obj;
            }, {});
          });

          _rowObjectsCache.forEach((r, idx) => {
            if (!filterFn || filterFn(r)) {
              const k = String(keyFn(r));
              _lastIdxCache.set(k, idx);
            }
          });
          _lastIdxCacheBuilt = true;
          myLog("info", "Formula Engine: Built isLast cache for %s (%d keys).", driver.longName, _lastIdxCache.size);
        }

        const rCurrent = _rowObjectsCache[rowOff];
        return _lastIdxCache.get(String(keyFn(rCurrent))) === rowOff;
      }
    };
  }
};
