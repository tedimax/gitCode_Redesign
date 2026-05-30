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
    // Utils.getSourceSheet() handles fail-fast if missing.
    const sourceSheet = Utils.getSourceSheet(this);
    const sourceRows = sourceSheet.getWindow(); // Ensure data is fetched
    myLog("info", "Driving Source for %s: %s (%d rows)", this.longName, sourceSheet.longName, sourceRows.length);

    // --- FAST PATH: Aligned Clone ---
    const fastClone = this._tryFastClone(sourceSheet);
    if (fastClone.success) {
      return fastClone.data;
    }

    // --- STANDARD PATH: High-Level Pipeline ---
    const context = FormulaUtils.createContext(sourceSheet, this);
    myLog("info", "Starting transformation engine for %s...", this.longName);

    // --- TARGET BOUNDARY DATE DEDUPLICATION GUARD ---
    let targetBoundaryDate = null;
    const dateFieldName = this.getProperty("DateField") || "Date";
    const dateColOffset = this.getColOffset(dateFieldName);
    if (this.longName !== "Ledgers_GeneratedTransactions" && dateColOffset !== -1) {
      const prevRowIndex = this.firstDataRowIndex - 1;
      const labelRowIdx = Number(this.getProperty("LabelRow")) || 1;
      
      let resolvedDateRaw = null;
      if (this.sheet && prevRowIndex > labelRowIdx) {
        resolvedDateRaw = this.sheet.getRange(prevRowIndex, dateColOffset + 1).getValue();
        if (resolvedDateRaw) {
          const parsed = resolvedDateRaw instanceof Date ? resolvedDateRaw : new Date(resolvedDateRaw);
          if (!isNaN(parsed.getTime())) {
            targetBoundaryDate = parsed;
            myLog("info", "Target Window Date Boundary for %s: %s (preceding row %d date)", 
              this.longName, targetBoundaryDate.toISOString().split('T')[0], prevRowIndex);
          }
        }
      }
      
      // Fallback: If no preceding row, look at the first row of the current window
      if (!targetBoundaryDate) {
        const targetRows = this.getWindow();
        if (targetRows.length > 0) {
          const firstRowDateRaw = targetRows[0][dateColOffset];
          if (firstRowDateRaw) {
            const parsed = firstRowDateRaw instanceof Date ? firstRowDateRaw : new Date(firstRowDateRaw);
            if (!isNaN(parsed.getTime())) {
              targetBoundaryDate = parsed;
              myLog("info", "Target Window Date Boundary for %s: %s (first row date fallback)", 
                this.longName, targetBoundaryDate.toISOString().split('T')[0]);
            }
          }
        }
      }
    }

    // 1. Build Hybrid Execution Plan
    const executionPlan = this._buildExecutionPlan(sourceSheet);
    let excludedCount = 0;

    // 2. Execute Phased Pipeline (Calculate -> Patch -> Filter)
    const targetObjects = sourceSheet.getWindow()
      .map((sourceRow, rowOff) => {
        const calc = this._calculateRow(sourceRow, rowOff, context, executionPlan, sourceSheet);
        const patched = this._applyGlobalPatches(calc);
        return { calc: patched, rowOff };
      })
      .filter(({ calc, rowOff }) => {
        // A. Standard Registry filter (e.g. Cleared status, etc)
        if (!this._shouldKeepRow(calc, rowOff, context)) return false;

        // B. Target Boundary Date Exclusion Rule
        if (targetBoundaryDate) {
          const calcDateRaw = calc[dateFieldName];
          if (calcDateRaw) {
            const calcDate = calcDateRaw instanceof Date ? calcDateRaw : new Date(calcDateRaw);
            if (!isNaN(calcDate.getTime()) && calcDate.getTime() < targetBoundaryDate.getTime()) {
              excludedCount++;
              return false;
            }
          }
        }
        return true;
      })
      .map(({ calc }) => calc);

    if (excludedCount > 0 && targetBoundaryDate) {
      myLog("info", "ImportTable [Boundary Guard]: Excluded %d source rows preceding boundary date %s", 
        excludedCount, targetBoundaryDate.toISOString().split('T')[0]);
    }

    // 3. Injection (Ghost Rows)
    if (typeof PatchManager !== 'undefined') {
      const unused = PatchManager.getUnusedPatches(this.longName);
      if (unused.length > 0) {
        const withinWindow = unused.filter(ghost => {
          if (!targetBoundaryDate) return true;

          // A. Resolve date from the ghost object fields
          let ghostDateRaw = ghost[dateFieldName];
          
          // B. Fallback: Parse date from PK if PK has the format Table#YYYYMMDD_... or similar
          if (!ghostDateRaw && ghost.PK) {
            const pkStr = String(ghost.PK);
            const dateMatch = pkStr.match(/#(\d{8})(_|$)/) || pkStr.match(/#(\d{4}-\d{2}-\d{2})(_|$)/);
            if (dateMatch) {
              const rawDatePart = dateMatch[1];
              if (rawDatePart.length === 8) {
                // Format YYYYMMDD
                const y = rawDatePart.substring(0, 4);
                const m = rawDatePart.substring(4, 6);
                const d = rawDatePart.substring(6, 8);
                ghostDateRaw = new Date(`${y}-${m}-${d}`);
              } else {
                // Format YYYY-MM-DD
                ghostDateRaw = new Date(rawDatePart);
              }
            }
          }

          if (ghostDateRaw) {
            const ghostDate = ghostDateRaw instanceof Date ? ghostDateRaw : new Date(ghostDateRaw);
            if (!isNaN(ghostDate.getTime()) && ghostDate.getTime() < targetBoundaryDate.getTime()) {
              myLog("info", "ImportTable [Boundary Guard]: Excluded ghost entry PK '%s' with date %s (precedes boundary date %s)", 
                ghost.PK, ghostDate.toISOString().split('T')[0], targetBoundaryDate.toISOString().split('T')[0]);
              return false;
            }
          }
          return true;
        });

        if (withinWindow.length > 0) {
          myLog("info", "Injecting %d new manual entries (Ghost Rows) for %s", withinWindow.length, this.longName);
          const labels = this.getLabels();
          
          // Build a set of all keys in the full sheet to check for existence outside the window
          const fullSheetKeys = new Set();
          if (this.sheet) {
            this._initializeKeyMetadata();
            const keyMetadata = this._keyMetadata;
            const lastRow = this.sheet.getLastRow();
            const labelRow = Number(this.getProperty("LabelRow")) || 1;
            const startRow = labelRow + 1;
            if (lastRow >= startRow) {
              if (keyMetadata.type === "single") {
                const keyCol = keyMetadata.offset + 1;
                const values = this.sheet.getRange(startRow, keyCol, lastRow - startRow + 1, 1).getValues();
                values.forEach(valArr => {
                  const rawVal = valArr[0];
                  if (rawVal !== undefined && rawVal !== "") {
                    const key = String(TypeUtils.castType(rawVal, keyMetadata.fieldType) || "").trim().toLowerCase();
                    if (key) fullSheetKeys.add(key);
                  }
                });
              } else {
                const lastCol = this.sheet.getLastColumn();
                const fullData = this.sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
                fullData.forEach(row => {
                  const key = this.getRowKey(row);
                  if (key) fullSheetKeys.add(key.toLowerCase());
                });
              }
            }
          }

          withinWindow.forEach(ghost => {
            const ghostPKLower = String(ghost.PK).trim().toLowerCase();
            const existingRowOff = this.getHashKeyMap().get(ghostPKLower);
            
            if (existingRowOff !== undefined) {
              const existingRowArray = this.getWindow()[existingRowOff];
              const existingObj = labels.reduce((obj, label, colOff) => {
                obj[label] = existingRowArray[colOff];
                return obj;
              }, {});
              const mergedObj = Object.assign({}, existingObj, ghost);
              targetObjects.push(mergedObj);
            } else if (fullSheetKeys.has(ghostPKLower)) {
              // Row already exists in the sheet outside the current target window: skip to avoid duplicates/blanks
              myLog("info", "ImportTable [Ghost Injection]: Skipped ghost entry PK '%s' because it already exists in the sheet outside the target window.", ghost.PK);
            } else {
              // Truly new manual entry: inject it
              targetObjects.push(ghost);
            }
          });
        }
      }
    }

    // 4. Serialize results
    const newData = this._serializeObjectsToMatrix(targetObjects);

    myLog("info", "Transformation complete for %s. (Total: %d rows)", this.longName, targetObjects.length);
    return newData;
  }

  /**
   * [PIPELINE PHASE 1]: Data Generation
   * Calculates the initial raw values for a row based on formulas.
   */
  _calculateRow(sourceRow, rowOff, context, plan, sourceSheet) {
    const calc = {};
    this._executePlan(calc, sourceRow, rowOff, context, plan, sourceSheet);
    return calc;
  }

  /**
   * The Core Execution Engine.
   * Runs a specific plan against a provided calc object.
   */
  _executePlan(calc, sourceRow, rowOff, context, plan, sourceSheet) {
    const sourceLabels = sourceSheet ? sourceSheet.getLabels() : [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const targetField = step.targetField;
      
      const rawResult = step.isSimple 
        ? sourceRow[step.sourceIdx] 
        : step.compiledFormula(rowOff, calc, context, context.props, sourceRow, sourceLabels);
      
      const fieldType = Registry.getType(this.longName, targetField);
      calc[targetField] = TypeUtils.castType(rawResult, fieldType);
      
      // Border Guard: Perimeter Validation
      const physicalRow = rowOff + (sourceSheet.firstDataRowIndex || 2);
      TypeUtils.validate(calc[targetField], fieldType, { sheet: this.longName, row: physicalRow, col: targetField });
    }
  }

  /**
   * [PIPELINE PHASE 2]: Filtering
   * Evaluates if the row should be kept based on the 'NewFilter' property.
   */
  _shouldKeepRow(calc, rowOff, context) {
    const filter = this.getCompiledFilter();
    if (!filter) return true;
    const sourceSheet = Utils.getSourceSheet(this);
    const sourceRow = sourceSheet.getWindow()[rowOff];
    const sourceLabels = sourceSheet.getLabels();
    const result = filter(rowOff, calc, context, context.props, sourceRow, sourceLabels);
    return TypeUtils.isTrue(result);
  }

  /**
   * [PIPELINE PHASE 3]: Patching
   * Applies manual corrections from the PatchManager (Audit Layer).
   */
  _applyGlobalPatches(calc) {
    if (typeof PatchManager !== 'undefined') {
      const patch = PatchManager.getPatch(this.longName, calc.PK);
      if (patch) {
        myLog("info", "Audit Layer: Applying global patch to %s [PK: %s]", this.longName, calc.PK);
        Object.assign(calc, patch);
      }
    }
    return calc;
  }

  // =========================================================================
  // MAPPING ENGINE & INITIALIZATION
  // =========================================================================

  /**
   * Lazy Getter for Formula Map
   */
  getCompiledFormulaMap() {
    this._initializeMappingEngine();
    return this._compiledFormulaMap;
  }

  /**
   * Lazy Getter for Row Filter
   */
  getCompiledFilter() {
    this._initializeMappingEngine();
    return this._compiledFilter;
  }

  /**
   * Bootstraps the mapping rules and compiles formulas into executable functions.
   */
  _initializeMappingEngine() {
    if (this._isEngineInitialized) return;
    this._isEngineInitialized = true;

    const sourceSheet = Utils.getSourceSheet(this);
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

    // 2. Compile and store formulas
    parsedRules.forEach(({ targetField, formula }) => {
      try {
        const parsedFormula = FormulaUtils.parse(formula, sourceLongName, targetField, this.longName);
        myLog("trace", "Formula Engine: Compiling %s -> %s", targetField, parsedFormula);
        this._rawFormulaMap.set(targetField, formula);
        this._compiledFormulaMap.set(targetField, new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFormula));
      } catch (e) {
        myLog("error", "Failed to compile formula for %s: %s", targetField, e.message);
      }
    });

    // 3. Auto-fill missing targets with implicit defaults
    this.getLabels().forEach(targetField => {
      if (!this._compiledFormulaMap.has(targetField)) {
        try {
          const formula = `[${targetField}]`;
          const parsedFormula = FormulaUtils.parse(formula, sourceLongName, targetField, this.longName);
          myLog("trace", "Formula Engine: Compiling Default %s -> %s", targetField, parsedFormula);
          this._rawFormulaMap.set(targetField, formula);
          this._compiledFormulaMap.set(targetField, new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFormula));
        } catch (e) {
          myLog("error", "Failed to compile default formula for %s: %s", targetField, e.message);
        }
      }
    });

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
    const formulaMap = this.getCompiledFormulaMap();
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
    // REVIEW: Bypassing Fast Clone if a filter is configured prevents filter bypass bugs.
    // In the future, we could optimize this by executing the filter logic inside the fast clone loop itself.
    if (this.getCompiledFilter()) {
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

    const result = sourceWindow.map((sourceRow, sourceRowOff) => {
      return sourceIndexMap.map((sourceIdx, targetIdx) => {
        const val = sourceRow[sourceIdx];
        const targetField = targetLabels[targetIdx];
        const type = TypeUtils.getType(this.longName, targetField);
        const castVal = TypeUtils.castType(val, type);
        TypeUtils.validate(castVal, type, { sheet: this.longName, row: sourceSheet.firstDataRowIndex + sourceRowOff, col: targetField });
        return TypeUtils.toSheetValue(castVal, type);
      });
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
