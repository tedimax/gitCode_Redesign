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
   * Overrides UpdateTable.importData
   * Explicitly triggers the transformation engine.
   */
  importData() {
    return this.transform();
  }

  /**
   * Loads mapping rules from the centralized Formula sheet.
   * Filters for entries matching this table's longName.
   */
  initializeMappingEngine() {
    // 0. Resolve the Source Sheet to support bracketed shorthand [Column]
    const sourceSheet = Utils.getSourceSheet(this);
    const sourceLongName = sourceSheet ? sourceSheet.longName : "";

    // 1. Fetch pre-indexed formulas from the Registry
    const relevantFormulas = Registry.getFormulasFor(this.longName);
    
    if (relevantFormulas.length === 0) {
      myLog("info", "No explicit formulas found for %s in Registry. Defaulting to 1:1 mapping.", this.longName);
    }

    const formulaCols = globals.formulasObj.getSymbolicOffsets();

    relevantFormulas.forEach(row => {
      const fullRef = String(row[formulaCols.targetField]).trim();
      let formula = String(row[formulaCols.formula] || "").trim();
      
      const match = fullRef.match(/\[(.*?)\]/);
      if (!match) return;
      const targetField = match[1].trim();
    
      if (formula === "") {
        formula = `[${targetField}]`;
      }
      
      try {
        const parsedFormula = FormulaUtils.parse(formula, sourceLongName);
        this._rawFormulaMap.set(targetField, formula);
        const compiledFormula = new Function('rowOff', 'calc', 'utils', 'props', 'return ' + parsedFormula);
        this._compiledFormulaMap.set(targetField, compiledFormula);
      } catch (e) {
        myLog("error", "Failed to compile formula for %s: %s", targetField, e.message);
      }
    });

    // 2. Auto-fill missing targets with implicit defaults
    this.getLabels().forEach(targetField => {
      if (!this._compiledFormulaMap.has(targetField)) {
        try {
          const formula = `[${targetField}]`;
          const parsedFormula = FormulaUtils.parse(formula, sourceLongName);
          this._rawFormulaMap.set(targetField, formula);
          const compiledFormula = new Function('rowOff', 'calc', 'utils', 'props', 'return ' + parsedFormula);
          this._compiledFormulaMap.set(targetField, compiledFormula);
        } catch (e) {
          myLog("error", "Failed to compile default formula for %s: %s", targetField, e.message);
        }
      }
    });

    myLog("info", "Mapping engine loaded %d formulas for %s. Resolving dependencies...", this._compiledFormulaMap.size, this.longName);
    this._compiledFormulaMap = FormulaUtils.resolveDependencies(this._compiledFormulaMap, this._rawFormulaMap);
  }

  /**
   * Evaluates if this table is eligible for a Fast Aligned Clone.
   * Eligible if EVERY formula is exactly `[SomeColumnName]` (a pure 1:1 mapping from the driving source).
   */
  _canFastClone() {
    if (this._rawFormulaMap.size === 0) return false;
    
    // Strict regex: exactly one bracketed column reference from the driving sheet
    const bracketRegex = /^\[[a-zA-Z0-9_ ]+\]$/;
    for (const formula of this._rawFormulaMap.values()) {
      if (!bracketRegex.test(String(formula).trim())) {
        return false;
      }
    }
    return true;
  }

  /**
   * Executes a high-performance array copy.
   * Bypasses the V8 eval engine, object instantiation, and context lookups.
   */
  _doFastClone(sourceSheet) {
    myLog("info", "Fast Clone triggered for %s (pure 1:1 mapping detected). Bypassing execution engine...", this.longName);
    
    const sourceWindow = sourceSheet.getWindow();
    const sourceLabels = sourceSheet.getLabels();
    const targetLabels = this.getLabels();

    // 1. Build an index map: Target Column Index -> Source Column Index
    const sourceIndexMap = targetLabels.map(targetField => {
      const formula = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formula).trim().match(/^\[([a-zA-Z0-9_ ]+)\]$/);
      return match ? sourceLabels.indexOf(match[1].trim()) : -1;
    });

    if (sourceIndexMap.includes(-1)) {
       myLog("warn", "Fast Clone failed: A required mapped column does not exist in the source sheet. Falling back to transform engine.");
       return false;
    }

    // 2. Ultra-fast aligned clone with pure functional type casting
    return sourceWindow.map((sourceRow, sourceRowOff) => {
      return sourceIndexMap.map((sourceIdx, targetIdx) => {
        const val = sourceRow[sourceIdx];
        const targetField = targetLabels[targetIdx];
        const type = TypeUtils.getType(this.longName, targetField);
        const castVal = TypeUtils.castType(val, type);
        
        // Border Guard: Validate even on Fast Clone
        const context = { sheet: this.longName, row: sourceSheet.firstDataRowIndex + sourceRowOff, col: targetField };
        TypeUtils.validate(castVal, type, context);
        
        return TypeUtils.toSheetValue(castVal, type);
      });
    });
  }

  /**
   * Executes the Virtual Column transformation.
   * Orchestrates the high-level Row loop.
   */
  transform() {
    if (this._compiledFormulaMap.size === 0) {
      this.initializeMappingEngine();
    }

    const sourceSheet = Utils.getSourceSheet(this);
    if (!sourceSheet) {
      myLog("error", "No source sheet found for %s", this.longName);
      return;
    }

    // --- FAST PATH: Aligned Clone ---
    if (this._canFastClone()) {
      const fastResult = this._doFastClone(sourceSheet);
      if (fastResult) {
        myLog("info", "Transformation complete via Fast Clone for %s.", this.longName);
        return fastResult;
      }
    }

    // --- STANDARD PATH: Execution Engine ---
    // Create the execution "Toolbox" (utils) available inside formulas
    // Provides access to: getVal, lookup, hash, DateUtils, etc.
    const context = FormulaUtils.createContext();
    myLog("info", "Starting transformation engine for %s...", this.longName);

    // --- BUILD HYBRID EXECUTION PLAN ---
    // Avoids executing formulas for columns that are just 1:1 copies
    const sourceLabels = sourceSheet.getLabels();
    const executionPlan = [];
    
    this._compiledFormulaMap.forEach((compiledFormula, targetField) => {
      const formulaStr = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formulaStr).trim().match(/^\[([a-zA-Z0-9_ ]+)\]$/);
      const sourceIdx = match ? sourceLabels.indexOf(match[1].trim()) : -1;
      
      executionPlan.push({
        targetField: targetField,
        isSimple: sourceIdx !== -1,
        sourceIdx: sourceIdx,
        compiledFormula: compiledFormula
      });
    });

    // 1. Functional Map: Transform each row in the source window
    const targetObjects = sourceSheet.getWindow().map((sourceRow, rowOff) => {
      return this._transformRow(sourceRow, rowOff, context, executionPlan);
    });

    // 2. Serialize the objects back to the new data matrix
    const newData = this._serializeObjectsToMatrix(targetObjects);

    myLog("info", "Transformation complete for %s.", this.longName);
    return newData;
  }

  /**
   * Internal helper to transform a single row using the hybrid execution plan.
   */
  _transformRow(sourceRow, rowOff, context, executionPlan) {
    const calc = {}; // The accumulator for this row
    
    for (let i = 0; i < executionPlan.length; i++) {
      const step = executionPlan[i];
      const targetField = step.targetField;
      
      try {
        // Execute transformation: Fast array pull OR compile V8 execution
        const rawResult = step.isSimple 
          ? sourceRow[step.sourceIdx] 
          : step.compiledFormula(rowOff, calc, context, this._properties);
        
        // 1. Apply Strict Type Casting (Functional & Silent)
        const fieldType = Registry.getType(this.longName, targetField);
        calc[targetField] = TypeUtils.castType(rawResult, fieldType);
        
        // 2. The Border Guard: Perform validation and log warnings ONLY here (at the input)
        const sourceSheet = Utils.getSourceSheet(this);
        const physicalRow = sourceSheet ? rowOff + (sourceSheet.firstDataRowIndex || 2) : rowOff;
        const contextObj = { sheet: this.longName, row: physicalRow, col: targetField };
        TypeUtils.validate(calc[targetField], fieldType, contextObj);
        
      } catch (e) {
        const sourceSheet = Utils.getSourceSheet(this);
        const physicalRow = sourceSheet ? rowOff + (sourceSheet.firstDataRowIndex || 2) : rowOff;
        myLog("error", "Transformation error at row %d, field %s: %s", physicalRow, targetField, e.message);
        
        if (typeof AuditUtils !== 'undefined') {
          const sourceSheet = Utils.getSourceSheet(this);
          const physicalRow = sourceSheet ? rowOff + (sourceSheet.firstDataRowIndex || 2) : rowOff;
          const formulaStr = this._rawFormulaMap.get(targetField) || "Implicit Default";
          AuditUtils.logError(this.longName, physicalRow, targetField, e.message, formulaStr);
        }

        calc[targetField] = "";
      }
    }

    return calc;
  }

  /**
   * Structural Utility: Serializes a list of JS objects into a 2D matrix
   * using the table's current column mapping.
   */
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

  /**
   * Overrides UpdateTable.flushMemory
   */
  flushMemory() {
    super.flushMemory();
    // Intentionally leaving formulas in memory, they consume ~0 bytes 
    // and re-compiling them causes a heavy CPU hit on subsequent runs.
  }
}

// Register with globals
globals.tableMap['ImportTable'] = ImportTable;
globals.tableMap['GenerateTable'] = ImportTable;
globals.tableMap['CorrectionsTable'] = ImportTable;
