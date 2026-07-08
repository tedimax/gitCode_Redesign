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
   * Overrides ImportTable._initializeMappingEngine to inject special DateEvent & PK rules
   * only if they are not already defined in the formulas sheet.
   */
  _initializeMappingEngine(sourceSheet) {
    if (this._compiledFormulaMap.size > 0) return;

    if (!sourceSheet) {
      sourceSheet = Utils.getSourceSheet(this);
    }

    // 1. Run standard registry formula compilation
    super._initializeMappingEngine(sourceSheet);

    // 2. Inject explicit fallbacks ONLY if they are not defined in the sheet
    const labels = this.getLabels();
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

    if (labels.includes("Group") && !this._compiledFormulaMap.has("Group")) {
      myLog("trace", "GenerateTable: Injecting fallback formula for Group");
      this._rawFormulaMap.set("Group", 'lookup("Reconciliation_Groups", "PK", "Group", calc.PK)');
      this._compiledFormulaMap.set("Group", new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return utils.lookup("Reconciliation_Groups", "PK", "Group", calc.PK)'));
    }

    if (labels.includes("Cleared") && !this._compiledFormulaMap.has("Cleared")) {
      myLog("trace", "GenerateTable: Injecting fallback formula for Cleared");
      this._rawFormulaMap.set("Cleared", 'lookup("Reconciliation_Groups", "PK", "Cleared", calc.PK)');
      this._compiledFormulaMap.set("Cleared", new Function('rowOff', 'calc', 'utils', 'props', 'sourceRow', 'sourceLabels', 'return utils.lookup("Reconciliation_Groups", "PK", "Cleared", calc.PK)'));
    }
  }

  /**
   * Overrides ImportTable.transform to implement 1:N expansion logic.
   */
  transform() {
    this._initializeMappingEngine();

    // Utils.getSourceSheet() handles fail-fast if missing.
    const sourceSheet = Utils.getSourceSheet(this);

    if (sourceSheet.column.datestart === undefined || sourceSheet.column.dateend === undefined || sourceSheet.column.interval === undefined) {
      throw new Error(`Scheduling Error: Source sheet '${sourceSheet.longName}' is missing mandatory scheduling columns (DateStart, DateEnd, Interval).`);
    }

    const context = FormulaUtils.createContext(sourceSheet, this);
    const executionPlan = this._buildExecutionPlan(sourceSheet);
    let excludedCount = 0;

    // --- TARGET BOUNDARY DATE DEDUPLICATION GUARD ---
    const dateFieldName = this.getProperty("DateField") || "DateEvent";
    const targetBoundaryDate = this._getTargetBoundaryDate(dateFieldName);

    // --- ACTIVE FINANCIAL YEAR RESOLUTION & GENERATION BOUNDARY ---
    // The scheduling engine expands template rows into transaction occurrences. 
    // To prevent generating transactions infinitely into the future, we cap generation 
    // at the end of the active Financial Year (which runs April 1st to March 31st).
    let activeYear = new Date().getFullYear();

    if (targetBoundaryDate) {
      // Strategy A: If we have a target boundary date (last synced transaction date),
      // resolve the active Financial Year based on that transaction's date context.
      const fyStart = DateUtils.getFYStartYear(targetBoundaryDate);
      if (fyStart) activeYear = Number(fyStart);
    } else {
      // Strategy B (Fallback): If the sheet is empty, resolve the FY based on the current date.
      // In the UK fiscal calendar, if the current calendar month is Jan, Feb, or March (months < 3),
      // the active Financial Year began in the previous calendar year.
      const now = new Date();
      if (now.getMonth() < 3) activeYear = now.getFullYear() - 1;
      else activeYear = now.getFullYear();
    }

    // Cap generation at March 31st of the calendar year following the FY start (Month 2 is March in 0-indexed JS Dates)
    const fyEndDate = new Date(activeYear + 1, 2, 31);

    myLog("info", "GenerateTable: Active Financial Year resolved as FY%d. Capping scheduled occurrences at %s",
      activeYear, fyEndDate.toISOString().split('T')[0]);

    myLog("info", "Starting Expansion Engine for %s...", this.longName);

    // 1. Loop through each Template Row in the Source and reduce them to a single flat array of expanded objects
    const expandedObjects = sourceSheet.getWindow().reduce((accumulator, sourceRow, rowOff) => {
      const pk = sourceSheet.getRowKey(sourceRow);
      if (!pk) {
        myLog("trace", "GenerateTable: Skipping spacer/comment row %d in source templates.", rowOff + sourceSheet.firstDataRowIndex);
        return accumulator;
      }

      const startDate = sourceRow[sourceSheet.column.datestart];
      const endDate = sourceRow[sourceSheet.column.dateend];
      const multiplier = sourceRow[sourceSheet.column.interval];
      const frequency = sourceRow[sourceSheet.column.unit];

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

      // 3. Transform scheduled dates functionally into calculated row objects
      const validOccurrences = occurrenceDates
        .filter(date => {
          const dateObj = new Date(date.toString());
          const isBeforeBoundary = targetBoundaryDate && dateObj.getTime() < targetBoundaryDate.getTime();
          if (isBeforeBoundary) {
            excludedCount++;
            return false;
          }
          return true;
        })
        .map(date => {
          const calc = { EventDate: DateUtils.toEgressDate(date.toString()) };
          // Execute plan returns the calculated row object
          const calculated = this._executePlan(calc, sourceRow, rowOff, context, executionPlan, sourceSheet);
          return this._applyGlobalPatches(calculated);
        })
        .filter(finalized => this._shouldKeepRow(finalized, rowOff, context));

      // Accumulate resolved occurrences
      return accumulator.concat(validOccurrences);
    }, []);

    if (excludedCount > 0 && targetBoundaryDate) {
      myLog("info", "GenerateTable [Boundary Guard]: Excluded %d generated transactions preceding boundary date %s",
        excludedCount, targetBoundaryDate.toISOString().split('T')[0]);
    }

    // 4. Serialize to matrix
    const newData = this._serializeRowObjectsToMatrix(expandedObjects);

    myLog("info", "Expansion complete for %s. Generated %d rows from %d templates.",
      this.longName, newData.length, sourceSheet.windowDataLength);

    return newData;
  }

  /**
   * Resolves the target sheet's date boundary to prevent processing older duplicate records.
   * Looks at the preceding row first, then falls back to the first row of the cached window.
   *
   * @param {string} dateFieldName - The column label representing the date field.
   * @returns {Date|null} The resolved boundary Date object, or null if not found.
   * @private
   */
  _getTargetBoundaryDate(dateFieldName) {

    const prevRowIndex = this.firstDataRowIndex - 1;
    const labelRowIdx = Number(this.getProperty("LabelRow")) || 1;

    // 1. Primary Strategy: Try to read the date from the row immediately above our target write window
    if (this.sheet && prevRowIndex > labelRowIdx) {
      const resolvedDateRaw = this.sheet.getRange(prevRowIndex, this.column[dateFieldName] + 1).getValue();
      if (resolvedDateRaw) {
        const parsed = resolvedDateRaw instanceof Date ? resolvedDateRaw : new Date(resolvedDateRaw);
        if (!isNaN(parsed.getTime())) {
          myLog("info", "Target Window Date Boundary for %s: %s (preceding row %d date)",
            this.longName, parsed.toISOString().split('T')[0], prevRowIndex);
          return parsed;
        }
      }
    }

    // 2. Secondary Strategy (Fallback): If there is no preceding row, look at the first cached window row
    const targetRows = this.getWindow();
    if (targetRows.length > 0) {
      const firstRowDateRaw = targetRows[0][this.column[dateFieldName]];
      if (firstRowDateRaw) {
        const parsed = firstRowDateRaw instanceof Date ? firstRowDateRaw : new Date(firstRowDateRaw);
        if (!isNaN(parsed.getTime())) {
          myLog("info", "Target Window Date Boundary for %s: %s (first row date fallback)",
            this.longName, parsed.toISOString().split('T')[0]);
          return parsed;
        }
      }
    }

    return null;
  }
}

// Register with globals
globals.tableMap['GenerateTable'] = GenerateTable;
