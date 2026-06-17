"use strict";

/**
 * gitCode_Redesign - ImportTable (Level 4)
 * The Virtual Column Mapping Engine.
 * Extends UpdateTable to allow transformed data to be persisted.
 */
class ImportTable extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    this._compiledFormulaMap = new Map(); // TargetField -> Function
    this._rawFormulaMap = new Map();      // TargetField -> Original String (for dep analysis)
    this._isEngineInitialized = false;
    this._sourceOverride = null;          // Fluent API override
  }

  /**
   * Fluent API: Overrides the source sheet for this import run.
   */
  withSource(longName) {
    this._sourceOverride = longName;
    return this;
  }
  /**
   * Overrides UpdateTable.prepare
   * Explicitly triggers the transformation engine.
   */
  prepare() {
    return this.transform();
  }

  // =========================================================================
  // MAIN TRANSFORMATION PIPELINE
  // =========================================================================

  /**
   * Orchestrates the high-level transformation lifecycle.
   */
  transform() {
    const sourceSheets = Utils.getSourceSheets(this);
    if (sourceSheets.length === 0) {
      throw new Error(`ImportTable transform error: No source sheets resolved for ${this.longName}`);
    }
    
    myLog("info", "Driving Sources for %s: %s", this.longName, sourceSheets.map(s => s.longName).join(", "));

    // --- FAST PATH: Aligned Clone (Only for single-source sheets to preserve speed) ---
    if (sourceSheets.length === 1) {
      const fastClone = this._tryFastClone(sourceSheets[0]);
      if (fastClone.success) {
        return fastClone.data;
      }
    }

    // --- STANDARD PATH: Sequential Ingestion Pipeline ---
    const targetObjects = [];
    const seenPKs = new Map();
    const fyFieldName = "FY";
    
    // Ledgers_GeneratedTransactions is excluded from 1:1 boundary checks here because its source sheet
    // (manualEntry_scheduled transactions) contains schedules. It is expanded to occurrences first
    // and filtered individually in GenerateTable.
    const targetBoundaryFY = (this.longName !== "Ledgers_GeneratedTransactions")
      ? this._getTargetBoundaryFY(fyFieldName)
      : null;

    const configMethod = this.getProperty("importmethod") || "replace";
    const finalMode = String(this._modeOverride || configMethod).toLowerCase();
    const isReplace = finalMode === "replace" || finalMode === "replacerows";

    const seqCol = this.getColOffset("Sequence");
    let nextSequence = 1;
    if (seqCol !== -1 && !isReplace) {
      let maxSeq = 0;
      this.getWindow().forEach(row => {
        const val = Number(row[seqCol]);
        if (!isNaN(val) && val > maxSeq) {
          maxSeq = val;
        }
      });
      nextSequence = maxSeq + 1;
      myLog("info", "ImportTable: Found max Sequence %d in window of %s. Next sequence: %d", maxSeq, this.longName, nextSequence);
    }
    const nextSeqObj = { val: nextSequence };

    const excludedCount = sourceSheets.reduce((acc, sourceSheet) => {
      return acc + this._transformSourceSheet(sourceSheet, targetObjects, seenPKs, targetBoundaryFY, fyFieldName, nextSeqObj);
    }, 0);

    // Print duplicate traps report
    seenPKs.forEach((entries, pk) => {
      if (entries.length > 1) {
        myLog("error", "TRAP DETECTED: PK '%s' is processed %d times in %s!", pk, entries.length, this.longName);
        entries.forEach((e, idx) => {
          myLog("error", "  - Occurrence %d: Source sheet: %s | Source row offset: %d | Source PK: %s | Calc PK: %s", 
            idx + 1, e.sourceName, e.rowOff, e.sourcePK, e.calcPK);
        });
      }
    });

    if (excludedCount > 0 && targetBoundaryFY) {
      myLog("info", "ImportTable [Boundary Guard]: Excluded %d source rows preceding boundary FY %d", 
        excludedCount, targetBoundaryFY);
    }

    // 3. Injection (Ghost Rows)
    this._injectGhostRows(targetObjects, targetBoundaryFY, fyFieldName, nextSeqObj);

    // 4. Serialize results
    const newData = this._serializeObjectsToMatrix(targetObjects);

    myLog("info", "Transformation complete for %s. (Total: %d rows consolidated)", this.longName, targetObjects.length);
    return newData;
  }

  /**
   * Processes a single source sheet: builds execution plan, evaluates formulas per-row,
   * handles duplicate PK checks, filters records, and collects output rows.
   *
   * @private
   */
   _transformSourceSheet(sourceSheet, targetObjects, seenPKs, targetBoundaryFY, fyFieldName, nextSeqObj) {
    let excludedCount = 0;
    const context = FormulaUtils.createContext(sourceSheet, this);
    myLog("info", "Starting transformation engine for %s source: %s...", this.longName, sourceSheet.longName);
    try {
      SpreadsheetApp.getActive().toast(`Processing source: ${sourceSheet.longName}`, `🔄 Importing ${this.longName}...`, 10);
    } catch (e) {
      // Safe bypass
    }

    // 1. Build Hybrid Execution Plan specific to this source sheet
    const executionPlan = this._buildExecutionPlan(sourceSheet);

    // 2. Execute Phased Pipeline (Calculate -> Patch -> Filter)
    const sourceWindow = sourceSheet.getWindow();
    const sourceLen = sourceWindow.length;
    
    for (let rowOff = 0; rowOff < sourceLen; rowOff++) {
      if (rowOff > 0 && rowOff % 500 === 0) {
        myLog("info", "Transform progress for %s -> %s: %d / %d rows processed...", this.longName, sourceSheet.longName, rowOff, sourceLen);
      }
      
      const sourceRow = sourceWindow[rowOff];
      const calc = this._calculateRow(sourceRow, rowOff, context, executionPlan, sourceSheet);
      const patched = this._applyGlobalPatches(calc);

      if (calc.PK) {
        const pkLower = String(calc.PK).toLowerCase().trim();
        const info = {
          rowOff,
          sourceName: sourceSheet.longName,
          calcPK: calc.PK,
          sourcePK: sourceRow[sourceSheet.getColOffset("PK")] || sourceRow[sourceSheet.getColOffset("pk")] || "N/A"
        };
        if (seenPKs.has(pkLower)) {
          seenPKs.get(pkLower).push(info);
        } else {
          seenPKs.set(pkLower, [info]);
        }
      }

      // A. Standard Registry filter (e.g. Cleared status, etc)
      if (!this._shouldKeepRow(patched, rowOff, context, sourceSheet)) {
        if (calc.PK) {
          const pkLower = String(calc.PK).toLowerCase().trim();
          if (this.getHashKeyMap().has(pkLower)) {
            if (!this._pksToDelete) this._pksToDelete = new Set();
            this._pksToDelete.add(calc.PK);
            myLog("info", "ImportTable: Row with PK '%s' is filtered out but exists in target. Marking for deletion.", calc.PK);
          }
        }
        continue;
      }

      // B. Target Boundary FY Exclusion Rule
      if (targetBoundaryFY) {
        const calcFYRaw = patched[fyFieldName] || patched.FY || patched.fy;
        if (calcFYRaw !== undefined && calcFYRaw !== null && calcFYRaw !== "") {
          const calcFY = Number(calcFYRaw);
          if (!isNaN(calcFY) && calcFY <= targetBoundaryFY) {
            excludedCount++;
            continue;
          }
        }
      }

      const targetSeqCol = this.getColOffset("Sequence");
      if (targetSeqCol !== -1) {
        if (patched.Sequence === undefined || patched.Sequence === null || patched.Sequence === "") {
          const sourceSeqCol = sourceSheet.getColOffset("Sequence");
          if (sourceSeqCol !== -1 && sourceRow[sourceSeqCol] !== undefined && sourceRow[sourceSeqCol] !== null && sourceRow[sourceSeqCol] !== "") {
            patched.Sequence = Number(sourceRow[sourceSeqCol]);
          } else if (nextSeqObj) {
            patched.Sequence = nextSeqObj.val++;
          }
        } else {
          patched.Sequence = Number(patched.Sequence);
        }
      }

      targetObjects.push(patched);
    }
    
    // Keep memory footprint low by flushing the source sheet cache
    sourceSheet.flushMemory();

    return excludedCount;
  }

  /**
   * Evaluates and injects manual override "Ghost Rows" from the PatchManager.
   * Ghost rows are manual entries/corrections that do not exist in the source payload.
   * 
   * If a ghost row's key already exists within the target window, it is merged with the existing row.
   * If it is a completely new record, it is appended to targetObjects.
   *
   * @param {Array<Object>} targetObjects - The collection of calculated row objects.
   * @param {number|null} targetBoundaryFY - The boundary FY threshold to exclude historical records.
   * @param {string} fyFieldName - The field name of the FY column.
   * @private
   */
  _injectGhostRows(targetObjects, targetBoundaryFY, fyFieldName = "FY", nextSeqObj) {
    if (typeof PatchManager === 'undefined') return;

    // Retrieve unused patches for this table (meaning patches not matched to active source records)
    const unused = PatchManager.getUnusedPatches(this.longName);
    if (unused.length === 0) return;

    let excludedGhostCount = 0;

    // 1. Filter out ghost entries that fall before the boundary FY window
    const withinWindow = unused.filter(ghost => {
      if (!targetBoundaryFY) return true;

      // A. Extract FY from standard FY field
      let ghostFYRaw = ghost[fyFieldName] || ghost.FY || ghost.fy;
      
      // B. Fallback: Parse date from PK string if formatted as Table#YYYYMMDD and compute FY
      if (!ghostFYRaw && ghost.PK) {
        const pkStr = String(ghost.PK);
        const dateMatch = pkStr.match(/#(\d{8})(_|$)/) || pkStr.match(/#(\d{4}-\d{2}-\d{2})(_|$)/);
        if (dateMatch) {
          const rawDatePart = dateMatch[1];
          let y, m;
          if (rawDatePart.length === 8) {
            y = Number(rawDatePart.substring(0, 4));
            m = Number(rawDatePart.substring(4, 6)) - 1; // 0-indexed
          } else {
            const parsedDate = new Date(rawDatePart);
            y = parsedDate.getFullYear();
            m = parsedDate.getMonth();
          }
          // FY is labelled by its END year (April 1st rule, e.g. Apr 2026 - Mar 2027 = FY2027)
          ghostFYRaw = (m >= 3) ? y + 1 : y;
        }
      }

      if (ghostFYRaw !== undefined && ghostFYRaw !== null && ghostFYRaw !== "") {
        const ghostFY = Number(ghostFYRaw);
        if (!isNaN(ghostFY) && ghostFY <= targetBoundaryFY) {
          excludedGhostCount++;
          myLog("trace", "ImportTable [Boundary Guard]: Excluded ghost entry PK '%s' with FY %d (precedes boundary FY %d)", 
            ghost.PK, ghostFY, targetBoundaryFY);
          return false;
        }
      }
      return true;
    });

    if (excludedGhostCount > 0 && targetBoundaryFY) {
      myLog("info", "ImportTable [Boundary Guard]: Excluded %d ghost entries preceding boundary FY %d", 
        excludedGhostCount, targetBoundaryFY);
    }

    if (withinWindow.length === 0) return;

    myLog("info", "Injecting %d new manual entries (Ghost Rows) for %s", withinWindow.length, withinWindow.length);
    const labels = this.getLabels();
    const targetSeqCol = this.getColOffset("Sequence");
    
     // 2. Process each eligible ghost row using only the cached active window map
    withinWindow.forEach(ghost => {
      const ghostPKLower = String(ghost.PK).trim().toLowerCase();
      
      const duplicateIdx = targetObjects.findIndex(obj => {
        const pk = obj.PK || obj.pk;
        return pk && String(pk).trim().toLowerCase() === ghostPKLower;
      });
      if (duplicateIdx !== -1) {
        myLog("error", "TRAP DETECTED: Ghost row PK '%s' already exists in targetObjects (added from source sheet)!", ghost.PK);
      }

      const existingRowOff = this.getHashKeyMap().get(ghostPKLower);
      
      if (existingRowOff !== undefined) {
        // Case A: The ghost row key exists in our active write window.
        // Retrieve and merge fields, overwriting with ghost manual updates.
        const existingRowArray = this.getWindow()[existingRowOff];
        const existingObj = labels.reduce((obj, label, colOff) => {
          obj[label] = existingRowArray[colOff];
          return obj;
        }, {});
        const mergedObj = Object.assign({}, existingObj, ghost);
        if (targetSeqCol !== -1) {
          if (mergedObj.Sequence === undefined || mergedObj.Sequence === null || mergedObj.Sequence === "") {
            if (nextSeqObj) {
              mergedObj.Sequence = nextSeqObj.val++;
            }
          } else {
            mergedObj.Sequence = Number(mergedObj.Sequence);
          }
        }
        targetObjects.push(mergedObj);
      } else {
        // Case B: Truly new manual transaction within this window. Insert it directly.
        if (targetSeqCol !== -1) {
          if (ghost.Sequence === undefined || ghost.Sequence === null || ghost.Sequence === "") {
            if (nextSeqObj) {
              ghost.Sequence = nextSeqObj.val++;
            }
          } else {
            ghost.Sequence = Number(ghost.Sequence);
          }
        }
        targetObjects.push(ghost);
      }
    });
  }

  /**
   * Resolves the target sheet's FY boundary to prevent processing older duplicate records.
   * Looks at the preceding row first, then falls back to the first row of the cached window.
   * 
   * @param {string} fyFieldName - The column label representing the FY field.
   * @returns {number|null} The resolved boundary FY, or null if not found.
   * @protected
   */
  _getTargetBoundaryFY(fyFieldName = "FY") {
    // 1. Retrieve the FromFY property from the configuration
    const fromFYRaw = this.getProperty("FromFY");
    if (fromFYRaw !== undefined && fromFYRaw !== null && fromFYRaw !== "") {
      let fromFY = null;
      if (fromFYRaw instanceof Date) {
        const y = fromFYRaw.getFullYear();
        const m = fromFYRaw.getMonth();
        fromFY = (m >= 3) ? y + 1 : y;
      } else if (typeof fromFYRaw === 'number') {
        fromFY = fromFYRaw;
      } else {
        // Try parsing as a number first to avoid new Date(number) issues
        const parsedNum = Number(fromFYRaw);
        if (!isNaN(parsedNum) && parsedNum > 0) {
          fromFY = parsedNum;
        } else {
          const parsedDate = new Date(fromFYRaw);
          if (!isNaN(parsedDate.getTime())) {
            const y = parsedDate.getFullYear();
            const m = parsedDate.getMonth();
            fromFY = (m >= 3) ? y + 1 : y;
          }
        }
      }

      if (fromFY !== null && !isNaN(fromFY) && fromFY > 0) {
        // The boundary guardrail excludes anything preceding this FY (i.e. <= fromFY - 1)
        const boundary = fromFY - 1;
        myLog("info", "Target Window FY Boundary for %s: %d (Registry FromFY %d - 1)", 
          this.longName, boundary, fromFY);
        return boundary;
      }
    }
    return null;
  }

  /**
   * [PIPELINE PHASE 1]: Data Generation
   * Calculates the initial raw values for a row based on formulas.
   */
  _calculateRow(sourceRow, rowOff, context, plan, sourceSheet) {
    return this._executePlan({}, sourceRow, rowOff, context, plan, sourceSheet);
  }

  /**
   * The Core Execution Engine.
   * Runs a specific plan against a provided calc object, returning a new object containing the calculated fields.
   */
  _executePlan(initialCalc, sourceRow, rowOff, context, plan, sourceSheet) {
    const sourceLabels = sourceSheet ? sourceSheet.getLabels() : [];
    
    return plan.reduce((calc, step) => {
      const targetField = step.targetField;
      
      const rawResult = step.isSimple 
        ? sourceRow[step.sourceIdx] 
        : step.compiledFormula(rowOff, calc, context, context.props, sourceRow, sourceLabels);
      
      const fieldType = Registry.getType(this.longName, targetField);
      const castVal = TypeUtils.castType(rawResult, fieldType);
      
      // Border Guard: Perimeter Validation
      const physicalRow = rowOff + (sourceSheet._windowStartRow !== null ? sourceSheet._windowStartRow : (sourceSheet.firstDataRowIndex || 2));
      TypeUtils.validate(castVal, fieldType, { sheet: this.longName, row: physicalRow, col: targetField });
      
      calc[targetField] = castVal;
      return calc;
    }, { ...initialCalc });
  }

  /**
   * [PIPELINE PHASE 2]: Filtering
   * Evaluates if the row should be kept based on the 'NewFilter' property.
   */
  _shouldKeepRow(calc, rowOff, context, sourceSheet) {
    const filter = this._compiledFilter;
    if (!filter) return true;
    const activeSourceSheet = sourceSheet || Utils.getSourceSheet(this);
    const sourceRow = activeSourceSheet.getWindow()[rowOff];
    const sourceLabels = activeSourceSheet.getLabels();
    const result = filter(rowOff, calc, context, context.props, sourceRow, sourceLabels);
    return TypeUtils.isTrue(result);
  }

  /**
   * [PIPELINE PHASE 3]: Patching
   * Applies manual corrections from the PatchManager (Patch Layer).
   */
  _applyGlobalPatches(calc) {
    if (typeof PatchManager !== 'undefined') {
      const patch = PatchManager.getPatch(this.longName, calc.PK);
      if (patch) {
        myLog("info", "Patch Layer: Applying global patch to %s [PK: %s]", this.longName, calc.PK);
        Object.assign(calc, patch);
      }
    }
    return calc;
  }

  /**
   * Bootstraps the mapping rules and compiles formulas into executable functions.
   */
  _initializeMappingEngine(sourceSheet) {
    const sourceLongName = sourceSheet.longName;

    // 1. Fetch and Resolve mapping rules
    const targetFieldKey = CONFIG_CONSTANTS.FORMULAS_CONFIG_PK;
    const formulaKey = "Formula";
    
    const parsedRules = Registry.getFormulasFor(this.longName)
      .map(row => {
        const targetField = row.targetField;
        const formula = row.formula;
        if (!targetField) return null;

        return { targetField, formula };
      })
      .filter(rule => rule !== null);

    // 2. Compile custom formulas
    const compiledEntries = parsedRules.reduce((acc, { targetField, formula }) => {
      try {
        const parsedFormula = FormulaUtils.parse(formula, sourceLongName, targetField, this.longName);
        myLog("trace", "Formula Engine: Compiling %s -> %s", targetField, parsedFormula);
        acc.raw.push([targetField, formula]);
        acc.compiled.push([targetField, new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFormula)]);
      } catch (e) {
        myLog("error", "Failed to compile formula for %s: %s", targetField, e.message);
      }
      return acc;
    }, { raw: [], compiled: [] });

    // 3. Auto-fill missing targets with implicit defaults
    const compiledFields = new Set(compiledEntries.compiled.map(([field]) => field));
    const defaultEntries = this.getLabels().reduce((acc, targetField) => {
      if (!compiledFields.has(targetField)) {
        try {
          let formula = `[${targetField}]`;
          if (targetField === "Sequence") {
            const hasSourceSeq = sourceSheet && typeof sourceSheet.getColOffset === 'function' && sourceSheet.getColOffset("Sequence") !== -1;
            if (!hasSourceSeq) {
              formula = "''";
            }
          }
          const parsedFormula = FormulaUtils.parse(formula, sourceLongName, targetField, this.longName);
          myLog("trace", "Formula Engine: Compiling Default %s -> %s", targetField, parsedFormula);
          acc.raw.push([targetField, formula]);
          acc.compiled.push([targetField, new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFormula)]);
        } catch (e) {
          myLog("error", "Failed to compile default formula for %s: %s", targetField, e.message);
        }
      }
      return acc;
    }, { raw: [], compiled: [] });

    // Re-instantiate the maps functionally using the accumulated entry arrays
    this._rawFormulaMap = new Map([...compiledEntries.raw, ...defaultEntries.raw]);
    this._compiledFormulaMap = new Map([...compiledEntries.compiled, ...defaultEntries.compiled]);

    // 4. Resolve filtering logic
    const filterFormula = this.getProperty("NewFilter");
    this._compiledFilter = null;
    this._filterDeps = [];
    if (filterFormula) {
      const parsedFilter = FormulaUtils.parse(filterFormula, sourceLongName, "__FILTER__", this.longName);
      myLog("info", "Filter for %s: Original='%s' | Compiled='%s'", this.longName, filterFormula, parsedFilter);
      this._compiledFilter = new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFilter);
      this._filterDeps = FormulaUtils.extractDependencies(filterFormula, "__FILTER__");
    }

    // 5. Final Topological Sort
    this._compiledFormulaMap = FormulaUtils.resolveDependencies(this._compiledFormulaMap, this._rawFormulaMap, this._filterDeps);
  }

  /**
   * Pre-calculates whether columns can be copied 1:1 to bypass the script engine.
   */
  _buildExecutionPlan(sourceSheet) {
    const sourceLabels = sourceSheet.getLabels();
    this._initializeMappingEngine(sourceSheet);
    const formulaMap = this._compiledFormulaMap;
    return Array.from(formulaMap.entries()).map(([targetField, compiledFormula]) => {
      const formulaStr = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formulaStr).trim().match(/^\[([^\]]+)\]$/);
      let sourceIdx = -1;
      if (match) {
        const sourceLabel = match[1].trim();
        sourceIdx = sourceLabels.indexOf(sourceLabel);
        if (sourceIdx === -1) {
          const colIdx = this.getColOffset(targetField);
          const colNum = colIdx + 1;
          const colLetter = StringUtils.columnToLetter(colIdx);
          throw new Error(`CRITICAL MAPPING ERROR: Target field '${targetField}' (Column ${colLetter}/${colNum}) requires source column '[${sourceLabel}]', but it was not found in ${sourceSheet.longName}. Available source columns: [${sourceLabels.slice(0, 5).join(", ")}...]`);
        }
      }
      
      return { targetField, isSimple: sourceIdx !== -1, sourceIdx, compiledFormula };
    });
  }

  /**
   * Ultra-fast array copy for tables with zero complex logic.
   */
  _tryFastClone(sourceSheet) {
    this._initializeMappingEngine(sourceSheet);
    if (this._compiledFilter) {
      myLog("info", "Fast Clone candidate %s rejected: NewFilter is configured. Falling back to full engine.", this.longName);
      return { success: false };
    }
    
    // If we have complex formulas (non-bracket), we MUST use the full engine.
    const bracketRegex = /^\[[^\]]+\]$/;
    if (this._rawFormulaMap.size > 0 && !Array.from(this._rawFormulaMap.values()).every(f => bracketRegex.test(String(f).trim()))) {
      return { success: false };
    }

    myLog("info", "Fast Clone triggered for %s...", this.longName);
    const sourceWindow = sourceSheet.getWindow();
    const sourceLabels = sourceSheet.getLabels();
    const targetLabels = this.getLabels();

    const sourceIndexMap = targetLabels.map(targetField => {
      const formula = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formula).trim().match(/^\[([^\]]+)\]$/);
      return match ? sourceLabels.indexOf(match[1].trim()) : -1;
    });

    const missingIdx = sourceIndexMap.indexOf(-1);
    if (missingIdx !== -1) {
      const targetField = targetLabels[missingIdx];
      const colIdx = this.getColOffset(targetField);
      const colNum = colIdx + 1;
      const colLetter = StringUtils.columnToLetter(colIdx);
      myLog("info", "Fast Clone candidate %s rejected: missing source column for '%s' (Column ${colLetter}/${colNum}). Falling back to full engine.", this.longName, targetField);
      return { success: false };
    }

    const targetBoundaryFY = (this.longName !== "Ledgers_GeneratedTransactions")
      ? this._getTargetBoundaryFY("FY")
      : null;

    const result = [];
    sourceWindow.forEach((sourceRow, sourceRowOff) => {
      const targetRow = sourceIndexMap.map((sourceIdx, targetIdx) => {
        const val = sourceRow[sourceIdx];
        const targetField = targetLabels[targetIdx];
        const type = TypeUtils.getType(this.longName, targetField);
        const castVal = TypeUtils.castType(val, type);
        TypeUtils.validate(castVal, type, { sheet: this.longName, row: sourceSheet.firstDataRowIndex + sourceRowOff, col: targetField });
        return TypeUtils.toSheetValue(castVal, type);
      });

      if (targetBoundaryFY) {
        const fyColIdx = targetLabels.indexOf("FY");
        if (fyColIdx !== -1) {
          const rowFY = Number(targetRow[fyColIdx]);
          if (!isNaN(rowFY) && rowFY <= targetBoundaryFY) {
            return; // Skip this row
          }
        }
      }

      result.push(targetRow);
    });

    return { success: true, data: result };
  }

  // =========================================================================
  // UTILITIES & CLEANUP
  // =========================================================================

  _serializeObjectsToMatrix(objects) {
    if (!Array.isArray(objects)) return [];
    const labels = this.getLabels();
    return objects.map(obj => {
      return labels.map(label => {
        let val = obj[label];
        const type = TypeUtils.getType(this.longName, label);
        
        // If the field is missing (Ghost Row), get the correct default (0, "", etc.)
        if (val === undefined || val === null) {
          val = TypeUtils.castType(null, type);
        }
        
        return TypeUtils.toSheetValue(val, type);
      });
    });
  }

  flushMemory() {
    super.flushMemory();
  }
}

// Register with globals
globals.tableMap['ImportTable'] = ImportTable;
globals.tableMap['GenerateTable'] = ImportTable;
globals.tableMap['CorrectionsTable'] = ImportTable;
