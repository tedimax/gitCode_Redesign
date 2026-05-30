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
   * Overrides ImportTable.initializeMappingEngine to inject special DateEvent & PK rules
   * only if they are not already defined in the formulas sheet.
   */
  initializeMappingEngine() {
    if (this._compiledFormulaMap.size > 0) return;

    // 1. Run standard registry formula compilation
    super.initializeMappingEngine();

    // 2. Inject explicit fallbacks ONLY if they are not defined in the sheet
    const labels = this.getLabels();
    const sourceSheet = Utils.getSourceSheet(this);
    const sourceLongName = sourceSheet.longName;

    if (labels.includes("DateEvent") && !this._compiledFormulaMap.has("DateEvent")) {
      myLog("trace", "GenerateTable: Injecting fallback formula for DateEvent");
      this._rawFormulaMap.set("DateEvent", "eventDate()");
      this._compiledFormulaMap.set("DateEvent", new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return calc.EventDate'));
    }

    if (labels.includes("PK") && !this._compiledFormulaMap.has("PK")) {
      myLog("trace", "GenerateTable: Injecting fallback formula for PK");
      this._rawFormulaMap.set("PK", "pk2([PK], eventDate())");
      
      const parsedFormula = FormulaUtils.parse("pk2([PK], eventDate())", sourceLongName, "PK", this.longName);
      this._compiledFormulaMap.set("PK", new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return ' + parsedFormula));
    }
  }

  /**
   * Overrides ImportTable.transform to implement 1:N expansion logic.
   */
  transform() {
    this.initializeMappingEngine();

    // Utils.getSourceSheet() handles fail-fast if missing.
    const sourceSheet = Utils.getSourceSheet(this);

    // Identify required columns in the source sheet for expansion math
    const scheduleCols = sourceSheet.getSymbolicOffsets();

    // Fallback search for unit/multiplier column if "Unit" is missing
    if (scheduleCols.unit === -1) {
      const unitHeaders = ["Period", "Every", "Repeat", "Multiplier", "RepeatEvery", "Times"];
      for (const h of unitHeaders) {
        const off = sourceSheet.getColOffset(h);
        if (off !== -1) {
          scheduleCols.unit = off;
          myLog("info", "GenerateTable: Found unit/multiplier column under name '%s' at offset %d", h, off);
          break;
        }
      }
    }

    if (scheduleCols.dateStart === -1 || scheduleCols.dateEnd === -1 || scheduleCols.interval === -1) {
      throw new Error(`Scheduling Error: Source sheet '${sourceSheet.longName}' is missing mandatory scheduling columns (DateStart, DateEnd, Interval).`);
    }

    const context = FormulaUtils.createContext(sourceSheet, this);
    const executionPlan = this._buildExecutionPlan(sourceSheet);
    const expandedObjects = [];
    let excludedCount = 0;

    // --- TARGET BOUNDARY DATE DEDUPLICATION GUARD ---
    let targetBoundaryDate = null;
    const dateFieldName = this.getProperty("DateField") || "DateEvent";
    const dateColOffset = this.getColOffset(dateFieldName);
    if (dateColOffset !== -1) {
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

    // Resolve the active Financial Year range for this spreadsheet
    let activeYear = new Date().getFullYear();
    if (targetBoundaryDate) {
      const fyStart = DateUtils.getFYStartYear(targetBoundaryDate);
      if (fyStart) activeYear = Number(fyStart);
    } else {
      const now = new Date();
      if (now.getMonth() < 3) activeYear = now.getFullYear() - 1;
      else activeYear = now.getFullYear();
    }
    const fyEndDate = new Date(activeYear + 1, 2, 31); // 31st March of the next calendar year
    myLog("info", "GenerateTable: Active Financial Year resolved as FY%d. Capping scheduled occurrences at %s", 
      activeYear, fyEndDate.toISOString().split('T')[0]);

    myLog("info", "Starting Expansion Engine for %s...", this.longName);

    // 1. Loop through each Template Row in the Source
    sourceSheet.getWindow().forEach((sourceRow, rowOff) => {
      const pk = sourceSheet.getRowKey(sourceRow);
      if (!pk) {
        myLog("trace", "GenerateTable: Skipping spacer/comment row %d in source templates.", rowOff + sourceSheet.firstDataRowIndex);
        return;
      }

      const startDate = sourceRow[scheduleCols.dateStart];
      const endDate = sourceRow[scheduleCols.dateEnd];
      const multiplier = sourceRow[scheduleCols.interval];
      const frequency = sourceRow[scheduleCols.unit];

      // Strict Validation: Enforce that DateStart and DateEnd are always set for active templates (PK is present)
      if (!startDate) {
        throw new Error(`Scheduling Validation Failure: Row ${rowOff + sourceSheet.firstDataRowIndex} is missing 'DateStart'. Every scheduled transaction must have a starting date.`);
      }
      if (!endDate) {
        throw new Error(`Scheduling Validation Failure: Row ${rowOff + sourceSheet.firstDataRowIndex} is missing 'DateEnd'. Every scheduled transaction must have an ending date.`);
      }

      const parsedStart = startDate instanceof Date ? startDate : new Date(startDate);
      if (isNaN(parsedStart.getTime())) {
        throw new Error(`Scheduling Validation Failure: Row ${rowOff + sourceSheet.firstDataRowIndex} has an invalid 'DateStart' value.`);
      }

      const parsedEnd = endDate instanceof Date ? endDate : new Date(endDate);
      if (isNaN(parsedEnd.getTime())) {
        throw new Error(`Scheduling Validation Failure: Row ${rowOff + sourceSheet.firstDataRowIndex} has an invalid 'DateEnd' value.`);
      }

      // Strict Validation: The Unit MUST be one of Yearly, Monthly, Weekly.
      const freqStr = String(frequency || "").trim();
      const validUnits = ["Yearly", "Monthly", "Weekly"];
      const match = validUnits.find(u => u.toLowerCase() === freqStr.toLowerCase());
      if (!match) {
        throw new Error(`Scheduling Validation Failure: Row ${rowOff + sourceSheet.firstDataRowIndex} has invalid Unit '${freqStr}'. Unit must be one of Yearly, Monthly, Weekly.`);
      }

      // 2. Generate the series of dates using the Temporal helper
      const occurrenceDates = DateUtils.getScheduledDates(parsedStart, parsedEnd, match, multiplier);

      // 3. For each date, execute a custom transformation
      occurrenceDates.forEach(date => {
        const dateObj = new Date(date.toString());
        
        // Deduplication Guard: Exclude generated rows that are older than targetBoundaryDate
        if (targetBoundaryDate && dateObj.getTime() < targetBoundaryDate.getTime()) {
          excludedCount++;
          return;
        }

        // Inject the current date into the row context
        const calc = { EventDate: DateUtils.toEgressDate(date.toString()) };
        
        // Execute the plan against this specific occurrence
        this._executePlan(calc, sourceRow, rowOff, context, executionPlan, sourceSheet);
        
        // Finalize with patches (if any)
        const finalized = this._applyGlobalPatches(calc);
        
        // Apply Registry filter if defined
        if (this._shouldKeepRow(finalized, rowOff, context)) {
          expandedObjects.push(finalized);
        }
      });
    });

    if (excludedCount > 0 && targetBoundaryDate) {
      myLog("info", "GenerateTable [Boundary Guard]: Excluded %d generated transactions preceding boundary date %s",
        excludedCount, targetBoundaryDate.toISOString().split('T')[0]);
    }

    // 4. Serialize to matrix
    const newData = this._serializeObjectsToMatrix(expandedObjects);

    myLog("info", "Expansion complete for %s. Generated %d rows from %d templates.", 
      this.longName, newData.length, sourceSheet.windowDataLength);
    
    return newData;
  }
}

// Register both naming conventions with globals
globals.tableMap['GenerateTable'] = GenerateTable;
globals.tableMap['GeneratedTransactions'] = GenerateTable;
