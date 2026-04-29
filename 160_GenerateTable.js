"use strict";

/**
 * gitCode_Redesign - GenerateTable (Level 4 specialty)
 * Expands a single "Schedule" row into multiple "Transaction" rows.
 * Inherits from ImportTable to reuse the formula execution engine.
 */
class GenerateTable extends ImportTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
  }

  /**
   * Overrides ImportTable.transform to implement 1:N expansion logic.
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

    // Identify required columns in the source sheet for expansion math
    const sourceLabels = sourceSheet.getColLabels();
    const startOff = sourceSheet.getColOffset("DateStart");
    const endOff = sourceSheet.getColOffset("DateEnd");
    const intervalOff = sourceSheet.getColOffset("Interval");
    const unitOff = sourceSheet.getColOffset("Unit");

    if (startOff === -1 || endOff === -1 || intervalOff === -1) {
      myLog("error", "Source sheet %s is missing mandatory scheduling columns (DateStart, DateEnd, Interval).", sourceSheet.longName);
      return;
    }

    const context = FormulaUtils.createContext();
    const executionPlan = this._buildExecutionPlan(sourceLabels);
    const expandedObjects = [];

    myLog("info", "Starting Expansion Engine for %s...", this.longName);

    // 1. Loop through each Template Row in the Source
    sourceSheet.getWindow().forEach((sourceRow, rowOff) => {
      const startDate = sourceRow[startOff];
      const endDate = sourceRow[endOff];
      const interval = sourceRow[intervalOff];
      const unit = (unitOff !== -1) ? sourceRow[unitOff] : 1;

      // 2. Generate the series of dates using the Temporal helper
      const occurrenceDates = DateUtils.getScheduledDates(startDate, endDate, interval, unit);

      // 3. For each date, execute the standard transformation engine
      occurrenceDates.forEach(date => {
        // Inject the current date into the row context
        // This allows formulas to use 'calc.EventDate'
        const customCalc = { EventDate: date };
        
        const transformedRow = this._transformRow(sourceRow, rowOff, context, executionPlan, customCalc);
        expandedObjects.push(transformedRow);
      });
    });

    // 4. Serialize to matrix
    this._newData = this._serializeObjectsToMatrix(expandedObjects);

    myLog("info", "Expansion complete for %s. Generated %d rows from %d templates.", 
      this.longName, this._newData.length, sourceSheet.windowDataLength);
  }

  /**
   * Internal helper to build the execution plan.
   * Reuse logic from ImportTable but made accessible.
   */
  _buildExecutionPlan(sourceLabels) {
    const plan = [];
    this._compiledFormulaMap.forEach((compiledFormula, targetField) => {
      const formulaStr = this._rawFormulaMap.get(targetField) || `[${targetField}]`;
      const match = String(formulaStr).trim().match(/^\[([a-zA-Z0-9_ ]+)\]$/);
      const sourceIdx = match ? sourceLabels.indexOf(match[1].trim()) : -1;
      
      plan.push({
        targetField: targetField,
        isSimple: sourceIdx !== -1,
        sourceIdx: sourceIdx,
        compiledFormula: compiledFormula
      });
    });
    return plan;
  }

  /**
   * Overrides ImportTable._transformRow to accept a seed 'calc' object.
   */
  _transformRow(sourceRow, rowOff, context, executionPlan, seedCalc = {}) {
    const calc = { ...seedCalc }; // Initialize with EventDate
    
    for (let i = 0; i < executionPlan.length; i++) {
      const step = executionPlan[i];
      const targetField = step.targetField;
      
      // Skip if this field was already seeded (e.g. EventDate)
      if (calc[targetField] !== undefined && !step.compiledFormula) continue;

      try {
        const rawResult = step.isSimple 
          ? sourceRow[step.sourceIdx] 
          : step.compiledFormula(rowOff, calc, context, this._properties);
        
        const fieldType = Registry.getType(this.longName, targetField);
        calc[targetField] = TypeUtils.castType(rawResult, fieldType);
        
      } catch (e) {
        const sourceSheet = Utils.getSourceSheet(this);
        const physicalRow = sourceSheet ? rowOff + (sourceSheet.firstDataRowIndex || 2) : rowOff;
        const formulaStr = this._rawFormulaMap.get(targetField) || "Implicit Default";
        AuditUtils.logError(this.longName, physicalRow, targetField, e.message, formulaStr);
        calc[targetField] = "";
      }
    }
    return calc;
  }
}

// Register with globals
globals.tableMap['GenerateTable'] = GenerateTable;
