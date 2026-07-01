"use strict";

/**
 * gitCode_Redesign - Formula Engine Utilities
 * Handles pre-parsing, dependency analysis, and topological sorting for the Virtual Column engine.
 * 
 * ============================================================================
 * INVARIANTS:
 * 1. Static Analysis Invariant: `extractDependencies` strictly performs static string 
 *    analysis. It NEVER evaluates code. This prevents side-effects and ensures safe 
 *    cyclic dependency detection before compilation.
 * 2. Topological Evaluation Invariant: `resolveDependencies` guarantees that no formula 
 *    is compiled or executed until all of its requested `calc.Field` dependencies 
 *    have been successfully built and evaluated.
 * 3. Context Isolation Invariant: The transpiler maps user shorthand explicitly and 
 *    exclusively to safe context variables (`utils`, `calc`, `props`, `rowOff`, `sourceRow`, `sourceLabels`). 
 *    It does NOT use `eval()`; it creates closures via `new Function()`.
 * 4. Cache Idempotency Invariant: Expensive caching objects (`_sheetCache` for 
 *    cross-table references, `_lastIdxCache` for sorting constraints) are built 
 *    exactly once per execution scope to prevent exponential runtime degradation.
 * ============================================================================
 */
var FormulaUtils = {
  /**
   * Robust Single-Pass Scanner: Translates shorthand into functional code.
   * Leverages the helper _parse functions above.
   */
  parse(formula, defaultSource = "", targetField = "", contextTable = "") {
    if (!formula) return "''";
    const text = String(formula).trim();
    
    let result = "";
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      // 1. Strings
      if (char === '"' || char === "'") {
        const parsedStr = this._parseStringLiteral(text, i);
        result += parsedStr.result;
        i = parsedStr.nextIdx;
        continue;
      }

      // 2. Bracketed Shorthand [Column]
      if (char === '[') {
        const bracket = this._parseBracketNotation(text, i, result, defaultSource, targetField, contextTable);
        if (bracket.replaceLongNameLen > 0) {
          result = result.substring(0, result.length - bracket.replaceLongNameLen);
        }
        result += bracket.result;
        i = bracket.nextIdx;
        continue;
      }

      // 3. Words and Function Calls
      if (/[a-zA-Z]/.test(char)) {
        let word = "";
        let k = i;
        while (k < text.length && /[a-zA-Z0-9_]/.test(text[k])) {
          word += text[k];
          k++;
        }

        const fnCall = this._parseFunctionCall(text, k, word, result, defaultSource, targetField, contextTable);
        if (fnCall.handled) {
          result += fnCall.result;
          i = fnCall.nextIdx;
          continue;
        }
      }
 
      result += char;
      i++;
    }
 
    return result;
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
   * @returns {Map} A new Map sorted by execution order.
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
    const _lastIdxCache = new Map();
    let _lastIdxCacheBuilt = false;
    let _lastIdxCacheBuilding = false;
    let _rowObjectsCache = null;
    const _dateSerialCounters = new Map();
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
        instance.getWindow();
      }
      return instance;
    };

    const context = {
      props,
      DateUtils,
      StringUtils,
      Temporal,
      getSourceName: (rowOff) => (driver && typeof driver.getSourceName === 'function') ? driver.getSourceName(rowOff) : "",
      getVal: (longName, colName, rowOff) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.getValueByLabel(rowOff, colName);
      },
      targetVal: (colName, calc) => {
        if (!target || !calc || !calc.PK) return "";
        const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
        if (existingRowOff === undefined) return "";
        return target.getValueByLabel(existingRowOff, colName);
      },
      isBlank: (modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn) => {
        return FormulaUtils._contextIsBlank(props, target, modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn);
      },
      ifBlank: function(modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn) {
        return this.isBlank(modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn);
      },
      lookup: (longName, keyCol, valCol, searchVal) => {
        const instance = getCachedInstance(longName);
        if (!instance) return "";
        return instance.lookupValue(keyCol, valCol, searchVal);
      },
      hash: (...args) => FormulaUtils._contextHash(...args),
      truth: (val) => FormulaUtils._contextTruth(val),
      hashRow: (rowOff) => {
        const row = driver.getWindow()[rowOff];
        if (!row || typeof CryptoUtils === 'undefined') return "";
        return CryptoUtils.generateHash(row.join("|"));
      },
      verticalMerge: (rowOff, ...sources) => {
        const actualSourceName = context.getSourceName(rowOff);
        if (actualSourceName) {
          const match = sources.find(([longName]) => {
            return longName === actualSourceName || 
                   longName.replace(/^ImportsArchive_|^Ledgers_/, "") === actualSourceName.replace(/^ImportsArchive_|^Ledgers_/, "") ||
                   longName.split("_").pop() === actualSourceName.split("_").pop();
          });
          if (match) {
            const colName = match[1];
            if (colName === "" || colName === "''" || colName === '""') return "";
            return driver.getValueByLabel(rowOff, colName);
          }
        }
        let currentBoundary = 0;
        for (const [longName, colName] of sources) {
          const instance = getCachedInstance(longName);
          if (!instance) continue;
          const len = instance.windowDataLength;
          if (rowOff < currentBoundary + len) {
            if (colName === "" || colName === "''" || colName === '""') return "";
            return instance.getValueByLabel(rowOff - currentBoundary, colName);
          }
          currentBoundary += len;
        }
        return "";
      },
      pk: (...args) => FormulaUtils._contextPk(props, DateUtils, _dateSerialCounters, ...args),
      pk2: (pk, date, rowOff) => FormulaUtils._contextPk2(DateUtils, pk, date, rowOff)
    };

    context.isLast = (rowOff, keyFn, filterFn) => {
      if (!_lastIdxCacheBuilt && !_lastIdxCacheBuilding) {
        _lastIdxCacheBuilding = true;
        const window = driver.getWindow();
        const labels = driver.getLabels();
        
        if (target && typeof target._buildExecutionPlan === 'function') {
          const plan = target._buildExecutionPlan(driver);
          const sourceLabels = driver.getLabels();
          _rowObjectsCache = window.map(() => ({}));
          window.forEach((sourceRow, rOff) => {
            const calc = _rowObjectsCache[rOff];
            plan.forEach(step => {
              const rawResult = step.isSimple 
                ? sourceRow[step.sourceIdx] 
                : step.compiledFormula(rOff, calc, context, props, sourceRow, sourceLabels);
              calc[step.targetField] = rawResult;
            });
          });
        } else {
          _rowObjectsCache = window.map(rowArray => {
            return labels.reduce((obj, label, colOff) => {
              obj[label] = rowArray[colOff];
              return obj;
            }, {});
          });
        }

        const sortField = (target && typeof target.getProperty === 'function') ? target.getProperty("SortField") : null;
        const sortedIndices = Array.from({ length: _rowObjectsCache.length }, (_, idx) => idx);
        
        if (sortField) {
          const sortColType = (target && typeof Registry !== 'undefined') ? Registry.getType(target.longName, sortField) : null;
          sortedIndices.sort((a, b) => {
            const valA = _rowObjectsCache[a][sortField];
            const valB = _rowObjectsCache[b][sortField];
            let diff = 0;
            if (valA instanceof Date || valB instanceof Date || sortColType === "Date" || sortColType === "DateTime") {
              const dA = valA ? new Date(valA) : new Date(0);
              const dB = valB ? new Date(valB) : new Date(0);
              diff = dA.getTime() - dB.getTime();
            } else if (typeof valA === 'number' && typeof valB === 'number') {
              diff = valA - valB;
            } else {
              diff = String(valA || "").localeCompare(String(valB || ""));
            }
            if (diff !== 0) return diff;
            const pkA = String(_rowObjectsCache[a].PK || _rowObjectsCache[a].pk || "");
            const pkB = String(_rowObjectsCache[b].PK || _rowObjectsCache[b].pk || "");
            return pkA.localeCompare(pkB);
          });
        }

        sortedIndices.forEach(idx => {
          const r = _rowObjectsCache[idx];
          const passFilter = !filterFn || filterFn(r);
          if (passFilter) {
            const k = String(keyFn(r));
            _lastIdxCache.set(k, idx);
          }
        });
        _lastIdxCacheBuilt = true;
        _lastIdxCacheBuilding = false;
      }
      const rCurrent = _rowObjectsCache ? _rowObjectsCache[rowOff] : null;
      const key = rCurrent ? String(keyFn(rCurrent)) : "UNKNOWN_KEY";
      const lastIdx = _lastIdxCache.get(key);
      return lastIdx === rowOff;
    };
    return context;
  },

  /**
   * Translates formula shorthand into functional code.
   * Supports:
   * 1. [Column] -> utils.getVal(defaultSource, "Column", rowOff)
   * 2. SheetName[Column] -> utils.getVal("SheetName", "Column", rowOff)
   */

  /**
   * Helper: Parses string literals safely skipping escaped quotes.
   */
  _parseStringLiteral(text, i) {
    const quote = text[i];
    let result = quote;
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
    return { result, nextIdx: i };
  },

  /**
   * Helper: Parses bracket notation for columns, tracking long names and resolving contexts.
   */
  _parseBracketNotation(text, i, resultSoFar, defaultSource, targetField, contextTable) {
    const targetSuffix = contextTable ? contextTable.split("_").pop() : "";
    let result = "";
    
    const prev = resultSoFar.length > 0 ? resultSoFar[resultSoFar.length - 1] : "";
    if (prev === ")" || prev === "]" || prev === "'" || prev === '"') {
      return { result: "[", replaceLongNameLen: 0, nextIdx: i + 1, handled: false };
    }

    let longName = "";
    let j = resultSoFar.length - 1;
    while (j >= 0 && /[a-zA-Z0-9_]/.test(resultSoFar[j])) {
      longName = resultSoFar[j] + longName;
      j--;
    }

    const end = text.indexOf(']', i + 1);
    if (end !== -1) {
      const colName = text.substring(i + 1, end).trim();
      
      // Guard: If it contains quotes, it's a JS array/object, not a column
      if (colName.includes('"') || colName.includes("'")) {
         return { result: "[", replaceLongNameLen: 0, nextIdx: i + 1, handled: false };
      }
      if (/^\d+$/.test(colName)) {
         return { result: "[", replaceLongNameLen: 0, nextIdx: i + 1, handled: false };
      }
      
      let replacement;
      let cleanCol = colName;
      if (cleanCol.startsWith("calc.")) {
        cleanCol = cleanCol.substring(5);
      } else if (cleanCol.startsWith('calc["') && cleanCol.endsWith('"]')) {
        cleanCol = cleanCol.substring(6, cleanCol.length - 2);
      } else if (cleanCol.startsWith("calc['") && cleanCol.endsWith("']")) {
        cleanCol = cleanCol.substring(6, cleanCol.length - 2);
      }

      let isVirtual = false;
      if (!longName && cleanCol !== targetField && contextTable && typeof Registry !== 'undefined') {
        let existsInSource = false;
        if (defaultSource) {
          try {
            const sourceInstance = getSheetInstance(defaultSource);
            if (sourceInstance) {
              const sourceLabels = sourceInstance.getLabels();
              const cleanColLower = cleanCol.toLowerCase();
              existsInSource = sourceLabels.some(l => String(l).toLowerCase().trim() === cleanColLower);
            }
          } catch (e) {}
        }
        if (!existsInSource) {
          const targetFormulas = Registry.getFormulasFor(contextTable);
          const hasExplicitFormula = targetFormulas.some(f => {
             const fName = (f.targetField || "").trim();
             return fName === cleanCol || fName.endsWith("[" + cleanCol + "]");
          });
          if (hasExplicitFormula) {
            isVirtual = true;
          } else {
            try {
              const targetInstance = getSheetInstance(contextTable);
              if (targetInstance) {
                const labels = targetInstance.getLabels();
                const cleanColLower = cleanCol.toLowerCase();
                isVirtual = labels.some(l => String(l).toLowerCase().trim() === cleanColLower);
              }
            } catch (e) {}
          }
        }
      }

      if (!longName && cleanCol === targetField && contextTable !== "__FILTER__") {
        replacement = `(sourceRow[sourceLabels.indexOf("${cleanCol}")])`;
      } else if (isVirtual) {
        replacement = `calc['${cleanCol}']`;
      } else {
        let target = longName || defaultSource;
        if (target.endsWith("_") && targetSuffix) target = target.slice(0, -1) + "_" + targetSuffix;
        const t = target.trim().replace(/^["']|["']$/g, '');
        const c = cleanCol.replace(/^["']|["']$/g, '');
        replacement = `utils.getVal("${t}", "${c}", rowOff)`;
      }

      // Temporal API Wrapping
      let typeTable = longName || defaultSource;
      if (isVirtual) {
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
      return { result, replaceLongNameLen: longName.length, nextIdx: end + 1, handled: true };
    }
    return { result: "[", replaceLongNameLen: 0, nextIdx: i + 1, handled: false };
  },

  /**
   * Helper: Parses specific function calls explicitly mapping to utils or other properties.
   */
  _parseFunctionCall(text, k, word, resultSoFar, defaultSource, targetField, contextTable) {
    if (text[k] !== '(') return { result: "", nextIdx: k, handled: false };

    // Special Shorthands
    if (["pk", "pk2", "hash", "lookup", "ifBlank", "isBlank", "merge", "truth"].includes(word)) {
      const prev6 = resultSoFar.substring(resultSoFar.length - 6);
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
              const parts = this._splitTopLevelCommas(parsedArgs);
              if (parts.length >= 3) rep = `utils.pk(${parts[0].trim()}, ${parts[1].trim()}, ${parts.slice(2).join(",").trim()}, rowOff)`;
              else rep = `pk(${parsedArgs})`;
            } else if (word === "pk2") {
              const parts = this._splitTopLevelCommas(parsedArgs);
              if (parts.length === 3) {
                rep = `utils.pk2(${parts[0].trim()} + "#" + ${parts[2].trim()}, ${parts[1].trim()}, rowOff)`;
              } else {
                rep = `utils.pk2(${parts[0].trim()}, ${parts[1].trim()}, rowOff)`;
              }
            } else if (word === "hash") {
              rep = `utils.hash(${parsedArgs})`;
            } else if (word === "lookup") {
              const p = this._splitTopLevelCommas(parsedArgs).map(s => s.trim().replace(/^["']|["']$/g, ''));
              if (p.length >= 4) rep = `utils.lookup("${p[0]}", "${p[1]}", "${p[2]}", ${p.slice(3).join(",")})`;
              else rep = `lookup(${parsedArgs})`;
            } else if (word === "ifBlank" || word === "isBlank") {
              const parts = this._splitTopLevelCommas(parsedArgs);
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
          return { result: rep, nextIdx: endIdx + 1, handled: true };
        }
      }
    } else if (word === "eventDate" && text[k+1] === ')') {
      return { result: "calc.EventDate", nextIdx: k + 2, handled: true };
    } else if (word === "getKeyPrefix" && text[k+1] === ')') {
      return { result: "props.KeyPrefix", nextIdx: k + 2, handled: true };
    } else if (word === "getProperty") {
      const endIdx = this._findClosingParen(text, k);
      if (endIdx !== -1) {
        const prop = text.substring(k + 1, endIdx).trim().replace(/^["']|["']$/g, '');
        return { result: `props.${prop}`, nextIdx: endIdx + 1, handled: true };
      }
    }
    return { result: "", nextIdx: k, handled: false };
  },

  /**
   * Helper to compile sheet-level merge macros: merge(Sheet[Col], Sheet[Col]) or merge([Col], [Col])
   */
  _compileMergeMacro(innerText, defaultSource, targetField, contextTable) {
    if (!innerText.trim()) return "''";
    const parts = this._splitTopLevelCommas(innerText).map(s => s.trim());
    
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

    // 3. Resolve the column name for the current source sheet
    const currentSourceIdx = sourceNames.findIndex(name => {
      return name === defaultSource || 
             name.replace(/^ImportsArchive_|^Ledgers_/, "") === defaultSource.replace(/^ImportsArchive_|^Ledgers_/, "") ||
             name.split("_").pop() === defaultSource.split("_").pop();
    });

    if (currentSourceIdx === -1) {
      // If defaultSource is not part of this union, compile this macro to an empty string
      return "''";
    }

    // 3. Resolve the column name for the current source sheet
    let colOverride = "";
    if (hasSheetNames) {
      const overrideMap = new Map();
      parts.forEach(part => {
        const openBracket = part.indexOf("[");
        const closeBracket = part.lastIndexOf("]");
        if (openBracket > 0 && closeBracket !== -1) {
          const sheetName = part.substring(0, openBracket).trim();
          const colName = part.substring(openBracket + 1, closeBracket).trim();
          overrideMap.set(sheetName, colName);
        }
      });

      const cleanName = defaultSource.replace(/^ImportsArchive_|^Ledgers_/, "");
      const popName = defaultSource.split("_").pop();
      
      if (overrideMap.has(defaultSource)) {
        colOverride = overrideMap.get(defaultSource);
      } else if (overrideMap.has(cleanName)) {
        colOverride = overrideMap.get(cleanName);
      } else if (overrideMap.has(popName)) {
        colOverride = overrideMap.get(popName);
      } else {
        colOverride = targetField;
      }
    } else {
      colOverride = parts[currentSourceIdx] !== undefined ? parts[currentSourceIdx] : targetField;
    }

    colOverride = colOverride.trim().replace(/^\[|\]$/g, "");

    // 4. Verify if the column exists in the current source sheet's label row
    if (colOverride && typeof getSheetInstance !== 'undefined') {
      try {
        const instance = getSheetInstance(defaultSource);
        if (instance && instance.column[colOverride] === undefined) {
          // Column is missing from this sheet. Treat it as empty.
          return "''";
        }
      } catch (e) {
        // Fallback
      }
    }

    if (!colOverride || colOverride === "" || colOverride === "''" || colOverride === '""') {
      return "''";
    }

    // 5. Compile to a direct lookup
    if (colOverride === targetField) {
      return `(sourceRow[sourceLabels.indexOf("${colOverride}")])`;
    } else {
      return `utils.getVal("${defaultSource}", "${colOverride}", rowOff)`;
    }
  },

  /**
   * Private Helper: Splits a string by commas, but only at the top level
   * (ignoring commas inside nested parentheses/brackets).
   */
  _splitTopLevelCommas(str) {
    const parts = [];
    let current = "";
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === "(" || char === "[" || char === "{") {
        depth++;
        current += char;
      } else if (char === ")" || char === "]" || char === "}") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current);
    return parts;
  },

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
   * Context Helper: Legacy DJB2 string hashing
   */
  _contextHash(...args) {
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
    return Math.abs(hashKey).toString();
  },

  /**
   * Context Helper: Boolean truth evaluation
   */
  _contextTruth(val) {
    if (val === null || val === undefined) return false;
    const str = String(val).trim();
    if (str === "" || str === "0") return false;
    const num = Number(val);
    if (!isNaN(num)) return num !== 0;
    const lower = str.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "y" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "n" || lower === "0") return false;
    return true;
  },

  /**
   * Context Helper: Primary Key generation
   */
  _contextPk(props, DateUtils, countersMap, ...args) {
    let prefix, date, hash, rowOff;
    if (args.length >= 4) {
      [prefix, date, hash, rowOff] = args;
    } else {
      [date, hash, rowOff] = args;
      prefix = props.KeyPrefix;
    }
    if (!date || !hash) return "";
    const formattedDate = DateUtils.toCompactDate(date);
    
    // Determine the serial/sequence number, resetting every new date
    let serial = 0;
    if (countersMap) {
      if (countersMap.has(formattedDate)) {
        serial = countersMap.get(formattedDate) + 1;
      }
      countersMap.set(formattedDate, serial);
    } else {
      serial = rowOff !== undefined && rowOff !== null ? rowOff : 0;
    }
    
    const pad = String(serial).padStart(3, '0');
    return `${prefix || ""}#${formattedDate}.${pad}_${hash}`;
  },

  /**
   * Context Helper: Specialty PK generator for dynamic expansion
   */
  _contextPk2(DateUtils, pk, date, rowOff) {
    if (!pk) return "";
    const compactDate = DateUtils.toCompactDate(date);
    const pkStr = String(pk).trim();
    if (pkStr.startsWith("Transaction")) {
      return "Transaction#" + compactDate + "_" + pkStr;
    }
    const hashIdx = pkStr.indexOf("#");
    if (hashIdx !== -1) {
      const lhs = pkStr.substring(0, hashIdx);
      const rhs = pkStr.substring(hashIdx + 1);
      return `${lhs}#${compactDate}_${rhs}`;
    } else {
      return "Transaction#" + compactDate + "_" + pkStr;
    }
  },

  /**
   * Context Helper: Configurable, lazy-short-circuiting test-for-blank wrapper
   */
  _contextIsBlank(props, target, modeSelector, testColName, targetColName, calc, currentImportMethod, fallbackFn) {
    if (!props.IsBlank) {
      return fallbackFn();
    }
    const mode = String(modeSelector || "all").toLowerCase().trim().replace("rows", "");
    const currentMethod = String(currentImportMethod || "").toLowerCase().trim().replace("rows", "");
    
    let shouldTest = false;
    if (mode === "all") shouldTest = true;
    else if (mode === "ignore" || mode === "") shouldTest = false;
    else {
      const modes = mode.split("+").map(m => m.trim().replace("rows", ""));
      shouldTest = modes.includes(currentMethod);
    }
    
    if (shouldTest) {
      const cleanColName = (name) => {
        if (!name) return "";
        let cleaned = String(name).trim();
        if (cleaned.startsWith("calc.")) cleaned = cleaned.substring(5);
        else if (cleaned.startsWith('calc["') && cleaned.endsWith('"]')) cleaned = cleaned.substring(6, cleaned.length - 2);
        else if (cleaned.startsWith("calc['") && cleaned.endsWith("']")) cleaned = cleaned.substring(6, cleaned.length - 2);
        return cleaned.trim();
      };
      const resolvedTestCol = cleanColName(testColName);
      const resolvedTargetCol = cleanColName(targetColName);
      let valToTest = undefined;
      if (calc) {
        const key = Object.keys(calc).find(k => k.toLowerCase() === resolvedTestCol.toLowerCase());
        if (key !== undefined) valToTest = calc[key];
      }
      if ((valToTest === undefined || valToTest === "" || valToTest === null) && target && calc && calc.PK) {
        const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
        if (existingRowOff !== undefined && target.column[resolvedTestCol] !== undefined) {
          valToTest = target.getValueByLabel(existingRowOff, resolvedTestCol);
        }
      }
      if (valToTest !== undefined && valToTest !== "" && valToTest !== null) {
        if (calc) {
          const key = Object.keys(calc).find(k => k.toLowerCase() === resolvedTargetCol.toLowerCase());
          if (key !== undefined && calc[key] !== "" && calc[key] !== null && calc[key] !== undefined) return calc[key];
        }
        if (target && calc && calc.PK) {
          const existingRowOff = target.getHashKeyMap().get(String(calc.PK).trim().toLowerCase());
          if (existingRowOff !== undefined && target.column[resolvedTargetCol] !== undefined) {
            const ext = target.getValueByLabel(existingRowOff, resolvedTargetCol);
            if (ext !== "" && ext !== null && ext !== undefined) return ext;
          }
        }
      }
    }
    return fallbackFn();
  },


};
