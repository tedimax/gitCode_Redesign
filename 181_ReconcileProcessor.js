"use strict";

/**
 * gitCode_Redesign - ReconcileProcessor (Level 3/4 — Processor)
 * Provides the private MODE 2 helper methods for committing balanced transaction
 * groups back to all destination sheets (Groups, Merged, ReconcileLog, ledgers).
 * Extends ReconcileBuilder.
 *
 * Public MODE 2 entry point (processBalancedRows) lives in ReconcileTable.
 * Load order: must follow ReconcileBuilder (180) and precede ReconcileTable (182).
 */
class ReconcileProcessor extends ReconcileBuilder {

  // =========================================================================
  // MODE 2: PRIVATE HELPERS
  // =========================================================================

  /**
   * Scans the Reconcile window and returns all rows where Balanced = TRUE,
   * along with the physical row indices that should be cleared afterwards.
   * @returns {{ balancedTxs: Array, rowsToDelete: number[] }}
   */
  _collectBalancedTransactions() {
    const reconcileCols = this.getSymbolicOffsets();
    const balancedTxs   = [];
    const rowsToDelete  = [];

    this.getWindow().forEach((row, offset) => {
      if (TypeUtils.isTrue(row[reconcileCols.balanced])) {
        balancedTxs.push({
          PK:      String(row[reconcileCols.pk]),
          Group:   row[reconcileCols.transaction],
          Cleared: true,
          FY:      row[reconcileCols.transactionFY]
        });
        rowsToDelete.push(offset + this.firstDataRowIndex);
      }
    });

    return { balancedTxs, rowsToDelete };
  }

  /**
   * Opens and fetches all destination tables before any write operations.
   * Batching reads first prevents Google Sheets recalculation from blocking writes.
   * @returns {{ groupsTable: UpdateTable, mergedTable: Table, logTable: UpdateTable }}
   */
  _prefetchDestinationTables() {
    const groupsTable = getSheetInstance("AnnualSummaries_Groups");
    // Groups sheet has formula columns beyond D that return #N/A when unpopulated.
    // We only read columns A-D (PK, Group, Cleared, FY) so bypass full type validation.
    groupsTable.withoutValidation();
    groupsTable.fetchWindow();

    const mergedTable = getSheetInstance("AnnualSummaries_Merged");
    mergedTable.fetchWindow();

    const logTable = getSheetInstance("NewAccounts_ReconcileLog");
    logTable.fetchWindow(); // May be empty, but safely initialized

    return { groupsTable, mergedTable, logTable };
  }

  /**
   * Assigns a GlobalGroupID to each balanced transaction, then for each:
   *   A. Stages a row for AnnualSummaries_Groups
   *   B. Writes Cleared & Group directly to AnnualSummaries_Merged
   *   C. Stages a row for NewAccounts_ReconcileLog
   * @param {Array}       balancedTxs
   * @param {UpdateTable} groupsTable
   * @param {Table}       mergedTable
   * @param {UpdateTable} logTable
   * @returns {{ groupsNewData: Array<Array<any>>, logNewData: Array<Array<any>> }}
   */
  _stageAndApplyGroupUpdates(balancedTxs, groupsTable, mergedTable, logTable) {
    const groupCols  = groupsTable.getSymbolicOffsets();
    const mergedCols = mergedTable.getSymbolicOffsets();
    const logCols    = logTable.getSymbolicOffsets();

    const existingGroupIds = groupsTable.getWindow()
      .map(row => groupCols.group !== -1 ? Number(row[groupCols.group]) : 0)
      .filter(n => !isNaN(n));
    let nextGlobalGroupId = existingGroupIds.length > 0 ? Math.max(...existingGroupIds) + 1 : 1;

    const localToGlobalTxMap = new Map();
    const groupsNewData = [];
    const logNewData    = [];

    balancedTxs.forEach(tx => {
      // Assign a stable global group ID per local transaction group
      if (!localToGlobalTxMap.has(tx.Group)) {
        localToGlobalTxMap.set(tx.Group, nextGlobalGroupId++);
      }
      tx.GlobalGroupID = localToGlobalTxMap.get(tx.Group);

      // A. Stage row for Groups sheet
      const gRow = new Array(groupsTable.getLabels().length).fill("");
      if (groupCols.pk      !== -1) gRow[groupCols.pk]      = tx.PK;
      if (groupCols.group   !== -1) gRow[groupCols.group]   = tx.GlobalGroupID;
      if (groupCols.cleared !== -1) gRow[groupCols.cleared] = tx.Cleared;
      if (groupCols.fy      !== -1) gRow[groupCols.fy]      = tx.FY;
      groupsNewData.push(gRow);

      // B. Update Merged sheet in place
      const cleanPk = StringUtils.sanitizeName(tx.PK);
      const mRowOff = mergedTable.getRowOffset(cleanPk);
      if (mRowOff !== undefined) {
        const pRow = mRowOff + mergedTable.firstDataRowIndex;
        if (mergedCols.cleared !== -1) mergedTable.sheet.getRange(pRow, mergedCols.cleared + 1).setValue(true);
        if (mergedCols.group   !== -1) mergedTable.sheet.getRange(pRow, mergedCols.group   + 1).setValue(tx.GlobalGroupID);
      }

      // C. Stage row for ReconcileLog
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (prefixMatch) {
        const ledgerName = this._getLedgerNameFromPrefix(prefixMatch[1]);
        if (ledgerName) {
          const logRow = new Array(logTable.getLabels().length).fill("");
          if (logCols.sheetName     !== -1) logRow[logCols.sheetName]     = ledgerName;
          if (logCols.transactionId !== -1) logRow[logCols.transactionId] = tx.PK;
          if (logCols.groupId       !== -1) logRow[logCols.groupId]       = tx.GlobalGroupID;
          if (logCols.clearStatus   !== -1) logRow[logCols.clearStatus]   = true;
          logNewData.push(logRow);
        }
      }
    });

    return { groupsNewData, logNewData };
  }

  /**
   * Writes Group & Cleared back to the originating ledger sheet for each balanced transaction.
   * Groups transactions by ledger to avoid redundant fetches.
   * Fails hard on any miss — these are the source ledgers; everything must resolve cleanly.
   * @param {Array} balancedTxs
   */
  _writeBackToLedgers(balancedTxs) {
    const txsByLedger = new Map();
    balancedTxs.forEach(tx => {
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (!prefixMatch) {
        throw new Error(`CRITICAL: Cannot resolve ledger prefix from PK '${tx.PK}'. PK format is invalid.`);
      }
      const ledgerName = this._getLedgerNameFromPrefix(prefixMatch[1]);
      if (!ledgerName) {
        throw new Error(`CRITICAL: Cannot resolve ledger name from prefix '${prefixMatch[1]}' (PK: '${tx.PK}'). Check SourceSheets config for AnnualSummaries_Merged.`);
      }
      if (!txsByLedger.has(ledgerName)) txsByLedger.set(ledgerName, []);
      txsByLedger.get(ledgerName).push(tx);
    });

    txsByLedger.forEach((txList, ledgerName) => {
      const ledger = getSheetInstance(ledgerName);
      ledger.fetchWindow();     // Ensures _window is populated for non-UpdateTable ledgers
      ledger.buildHashKeyMap(); // UpdateTable: efficient single-column scan; others: uses window

      const groupOff   = ledger.getColOffset("Group");

      if (groupOff   === -1) throw new Error(`CRITICAL: Ledger '${ledgerName}' has no 'Group' column. Cannot write back reconciliation group ID.`);

      txList.forEach(tx => {
        const rowOff = ledger.getRowOffset(tx.PK);
        if (rowOff === undefined) {
          throw new Error(`CRITICAL: Ledger write-back failed. PK '${tx.PK}' not found in '${ledgerName}'. Data integrity error — this row was reconciled from this ledger.`);
        }
        const pRow = rowOff + ledger.firstDataRowIndex;
        ledger.sheet.getRange(pRow, groupOff   + 1).setValue(tx.GlobalGroupID);
      });

      myLog("info", "Wrote Group back to %d row(s) in ledger %s.", txList.length, ledgerName);
    });
  }

  /**
   * Clears the content of all reconciled rows from the Reconcile sheet.
   * Uses RangeList to batch all clears into a single API call.
   * Clearing (not deleting) preserves named ranges and avoids triggering recalculations.
   * @param {number[]} rowsToDelete Physical row indices to clear.
   */
  _clearReconciledRows(rowsToDelete) {
    if (rowsToDelete.length === 0) return;

    const lastCol = this.sheet.getLastColumn();
    let colLetter = "";
    let tempCol = lastCol;
    while (tempCol > 0) {
      const modulo = (tempCol - 1) % 26;
      colLetter = String.fromCharCode(modulo + 65) + colLetter;
      tempCol = (tempCol - modulo - 1) / 26;
    }

    const a1Notations = rowsToDelete.map(r => `A${r}:${colLetter}${r}`);
    this.sheet.getRangeList(a1Notations).clearContent();
  }

  /**
   * Resolves a PK prefix to the originating ledger sheet's long name,
   * by cross-referencing the SourceSheets config for AnnualSummaries_Merged.
   * @param {string} prefix
   * @returns {string|null} Long name of the ledger, or the prefix itself as a fallback.
   */
  _getLedgerNameFromPrefix(prefix) {
    let targetLongName = null;
    const mergeSheetsRaw = globals.sheetsObj.lookupValue("LongName", "SourceSheets", "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "SourceSheet",  "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "MergeSheets",  "AnnualSummaries_Merged");
    if (!mergeSheetsRaw) return prefix;

    const mergeSheets = String(mergeSheetsRaw).split(",").map(s => s.trim());
    const sheetCols   = globals.sheetsObj.getSymbolicOffsets();

    globals.sheetsObj.getWindow().forEach(row => {
      const name  = row[sheetCols.longName];
      const prefs = String(row[sheetCols.keyPrefix] || "").split(",").map(p => p.trim());
      if (prefs.includes(prefix) && mergeSheets.includes(name)) {
        targetLongName = name;
      }
    });

    return targetLongName || prefix;
  }
}
