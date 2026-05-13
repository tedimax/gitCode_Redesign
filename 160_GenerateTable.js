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
    this.initializeMappingEngine();

    // Utils.getSourceSheet() handles fail-fast if missing.
    const sourceSheet = Utils.getSourceSheet(this);

    // Identify required columns in the source sheet for expansion math
    const scheduleCols = sourceSheet.getSymbolicOffsets(TABLE_COLUMN_MAP.Schedules);

    if (scheduleCols.dateStart === -1 || scheduleCols.dateEnd === -1 || scheduleCols.interval === -1) {
      throw new Error(`Scheduling Error: Source sheet '${sourceSheet.longName}' is missing mandatory scheduling columns (DateStart, DateEnd, Interval).`);
    }

    const context = FormulaUtils.createContext(sourceSheet);
    const executionPlan = this._buildExecutionPlan(sourceSheet);
    const expandedObjects = [];

    myLog("info", "Starting Expansion Engine for %s...", this.longName);

    // 1. Loop through each Template Row in the Source
    sourceSheet.getWindow().forEach((sourceRow, rowOff) => {
      const startDate = sourceRow[scheduleCols.dateStart];
      const endDate = sourceRow[scheduleCols.dateEnd];
      const interval = sourceRow[scheduleCols.interval];
      const unit = (scheduleCols.unit !== -1) ? sourceRow[scheduleCols.unit] : 1;

      // 2. Generate the series of dates using the Temporal helper
      const occurrenceDates = DateUtils.getScheduledDates(startDate, endDate, interval, unit);

      // 3. For each date, execute a custom transformation
      occurrenceDates.forEach(date => {
        // Inject the current date into the row context
        const calc = { EventDate: date };
        
        // Execute the plan against this specific occurrence
        this._executePlan(calc, sourceRow, rowOff, context, executionPlan, sourceSheet);
        
        // Finalize with patches (if any)
        const finalized = this._applyGlobalPatches(calc);
        expandedObjects.push(finalized);
      });
    });

    // 4. Serialize to matrix
    const newData = this._serializeObjectsToMatrix(expandedObjects);

    myLog("info", "Expansion complete for %s. Generated %d rows from %d templates.", 
      this.longName, newData.length, sourceSheet.windowDataLength);
    
    return newData;
  }
}

// Register with globals
globals.tableMap['GenerateTable'] = GenerateTable;
