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
    this.initializeMappingEngine();

    // Utils.getSourceSheet() handles fail-fast if missing.
    const sourceSheet = Utils.getSourceSheet(this);
    myLog("info", "Driving Source for %s: %s (%d rows)", this.longName, sourceSheet.longName, sourceSheet.windowDataLength);

    // --- FAST PATH: Aligned Clone ---
    const fastClone = this._tryFastClone(sourceSheet);
    if (fastClone.success) return fastClone.data;

    // --- STANDARD PATH: High-Level Pipeline ---
    const context = FormulaUtils.createContext(sourceSheet);
    myLog("info", "Starting transformation engine for %s...", this.longName);

    // 1. Build Hybrid Execution Plan
    const executionPlan = this._buildExecutionPlan(sourceSheet);

    // 2. Execute Phased Pipeline
    const targetObjects = sourceSheet.getWindow()
      .map((sourceRow, rowOff) => ({
        calc: this._calculateRow(sourceRow, rowOff, context, executionPlan, sourceSheet),
        rowOff
      }))
      .filter(({ calc, rowOff }) => this._shouldKeepRow(calc, rowOff, context))
      .map(({ calc }) => this._applyGlobalPatches(calc));

    // 3. Serialize results
    const newData = this._serializeObjectsToMatrix(targetObjects);

    myLog("info", "Transformation complete for %s.", this.longName);
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
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const targetField = step.targetField;
      
      try {
        const rawResult = step.isSimple 
          ? sourceRow[step.sourceIdx] 
          : step.compiledFormula(rowOff, calc, context, this._properties);
        
        const fieldType = Registry.getType(this.longName, targetField);
        calc[targetField] = TypeUtils.castType(rawResult, fieldType);
        
        // Border Guard: Perimeter Validation
        const physicalRow = rowOff + (sourceSheet.firstDataRowIndex || 2);
        TypeUtils.validate(calc[targetField], fieldType, { sheet: this.longName, row: physicalRow, col: targetField });
        
      } catch (e) {
        const physicalRow = rowOff + (sourceSheet.firstDataRowIndex || 2);
        myLog("error", "Transformation error at row %d, field %s: %s", physicalRow, targetField, e.message);
        
        if (typeof AuditUtils !== 'undefined') {
          const formulaStr = this._rawFormulaMap.get(targetField) || "Implicit Default";
          AuditUtils.logError(this.longName, physicalRow, targetField, e.message, formulaStr);
        }
        calc[targetField] = "";
      }
    }
  }

  /**
   * [PIPELINE PHASE 2]: Filtering
   * Evaluates if the row should be kept based on the 'NewFilter' property.
   */
  _shouldKeepRow(calc, rowOff, context) {
    if (!this._compiledFilter) return true;
    return this._compiledFilter(rowOff, calc, context, this._properties);
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
   * Bootstraps the mapping rules and compiles formulas into executable functions.
   */
  initializeMappingEngine() {
    if (this._compiledFormulaMap.size > 0) return;

    const sourceSheet = Utils.getSourceSheet(this);
    const sourceLongName = sourceSheet.longName;
    const formulaCols = globals.formulasObj.getSymbolicOffsets();

    // 1. Fetch and Resolve mapping rules
    const parsedRules = Registry.getFormulasFor(this.longName)
      .map(row => {
        const fullRef = String(row[formulaCols.targetField]).trim();
        const match = fullRef.match(/\[(.*?)\]/);
        if (fullRef.startsWith("//") || fullRef.startsWith("#") || !match) return null;

        const targetField = match[1].trim();
        const formula = String(row[formulaCols.formula] || "").trim();
        return { targetField, formula: formula === "" ? `[${targetField}]` : formula };
      })
      .filter(rule => rule !== null);

    // 2. Compile and store formulas
    parsedRules.forEach(({ targetField, formula }) => {
      try {
        const parsedFormula = FormulaUtils.parse(formula, sourceLongName, targetField, this.longName);
        this._rawFormulaMap.set(targetField, formula);
        this._compiledFormulaMap.set(targetField, new Function('rowOff', 'calc', 'utils', 'props', 'return ' + parsedFormula));
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
          this._rawFormulaMap.set(targetField, formula);
          this._compiledFormulaMap.set(targetField, new Function('rowOff', 'calc', 'utils', 'props', 'return ' + parsedFormula));
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
      this._compiledFilter = new Function('rowOff', 'calc', 'utils', 'props', 'return ' + parsedFilter);
      this._filterDeps = FormulaUtils.extractDependencies(filterFormula);
    }

    // 5. Final Topological Sort
    this._compiledFormulaMap = FormulaUtils.resolveDependencies(this._compiledFormulaMap, this._rawFormulaMap, this._filterDeps);
  }

  /**
   * Pre-calculates whether columns can be copied 1:1 to bypass the script engine.
   */
  _buildExecutionPlan(sourceSheet) {
    const sourceLabels = sourceSheet.getLabels();
    return Array.from(this._compiledFormulaMap.entries()).map(([targetField, compiledFormula]) => {
      const formulaStr = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formulaStr).trim().match(/^\[([a-zA-Z0-9_ ]+)\]$/);
      const sourceIdx = match ? sourceLabels.indexOf(match[1].trim()) : -1;
      
      return { targetField, isSimple: sourceIdx !== -1, sourceIdx, compiledFormula };
    });
  }

  /**
   * Ultra-fast array copy for tables with zero complex logic.
   */
  _tryFastClone(sourceSheet) {
    this.initializeMappingEngine();
    
    if (this._rawFormulaMap.size === 0) return { success: false };
    const bracketRegex = /^\[[a-zA-Z0-9_ ]+\]$/;
    if (!Array.from(this._rawFormulaMap.values()).every(f => bracketRegex.test(String(f).trim()))) return { success: false };

    myLog("info", "Fast Clone triggered for %s...", this.longName);
    const sourceWindow = sourceSheet.getWindow();
    const sourceLabels = sourceSheet.getLabels();
    const targetLabels = this.getLabels();

    const sourceIndexMap = targetLabels.map(targetField => {
      const formula = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formula).trim().match(/^\[([a-zA-Z0-9_ ]+)\]$/);
      return match ? sourceLabels.indexOf(match[1].trim()) : -1;
    });

    if (sourceIndexMap.includes(-1)) throw new Error(`Fast Clone Failure: Missing column in source.`);

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
        const val = obj[label];
        const type = TypeUtils.getType(this.longName, label);
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
