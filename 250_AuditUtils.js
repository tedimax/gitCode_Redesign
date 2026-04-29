"use strict";

/**
 * gitCode_Redesign - Audit Logger
 * Accumulates transformation and execution errors and flushes them to a physical sheet.
 */
const AuditUtils = (() => {
  let errorQueue = [];

  /**
   * Logs an error to the internal queue.
   * @param {string} targetName - The LongName of the table being processed.
   * @param {number|string} sourceRow - The row number or identifier where the error occurred.
   * @param {string} field - The target column that failed to compute.
   * @param {string} message - The actual error message.
   * @param {string} formula - The formula that caused the error.
   */
  const logError = (targetName, sourceRow, field, message, formula = "") => {
    errorQueue.push([
      Temporal.Now.instant().toString(),
      targetName,
      sourceRow,
      field,
      message,
      formula
    ]);
  };

  /**
   * Flushes the accumulated errors to the specified audit table.
   * Clears the queue after writing.
   */
  const flush = (auditTableLongName = "NewAccounts_SyncAudit") => {
    if (errorQueue.length === 0) return;

    try {
      const auditTable = getSheetInstance(auditTableLongName);
      if (!auditTable) {
        myLog("warn", "Could not flush Audit log: Table '%s' not found in registry.", auditTableLongName);
        return; // Don't clear queue, in case it gets created later in the session
      }

      const startRow = auditTable.getLastRowIndex() + 1;
      const safeStartRow = Math.max(startRow, auditTable.firstDataRowIndex || 2);
      
      auditTable.writeBlock(safeStartRow, errorQueue);
      
      // Flush sheet changes so it's physically visible
      SpreadsheetApp.flush();
      
      myLog("info", "Flushed %d errors to Audit log (%s).", errorQueue.length, auditTableLongName);
      errorQueue = []; // Clear queue on success
    } catch (e) {
      myLog("error", "Failed to write to Audit Log: %s", e.message);
    }
  };

  return {
    logError,
    flush
  };
})();
