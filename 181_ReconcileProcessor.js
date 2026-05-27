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
        let fy = String(row[reconcileCols.transactionFY] || "").trim();
        if (!fy && reconcileCols.date !== undefined && reconcileCols.date !== -1 && row[reconcileCols.date]) {
          fy = DateUtils.toFY(row[reconcileCols.date]);
        }

        balancedTxs.push({
          PK:      String(row[reconcileCols.pk]),
          Group:   row[reconcileCols.transaction],
          Cleared: true,
          FY:      fy
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
    // Optimized: Do not call groupsTable.fetchWindow() to avoid loading all 10,800+ rows.
    // We will selectively load only the bottom of the sheet when computing next group ID.

    const mergedTable = getSheetInstance("AnnualSummaries_Merged");
    mergedTable.getWindow(); // Eagerly loads the window into RAM on first access

    const logTable = getSheetInstance("NewAccounts_ReconcileLog");
    logTable.getWindow(); // May be empty, but safely initialized

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

    // Optimized: Fetch only the last 50 rows of Groups to locate the highest Group ID,
    // relying on the sheet being kept sorted by Group in ascending order.
    groupsTable.ensureRows(50);

    const existingGroupIds = groupsTable.getWindow()
      .map(row => groupCols.group !== -1 ? Number(row[groupCols.group]) : 0)
      .filter(n => !isNaN(n));
    let nextGlobalGroupId = existingGroupIds.length > 0 ? Math.max(...existingGroupIds) + 1 : 1;

    const localToGlobalTxMap = new Map();
    const groupsNewData = [];
    const logNewData    = [];

    // Batch writes mapping for Merged updates
    const mergedClearedA1List = [];
    const mergedGroupsA1ByVal = new Map();
    const mergedFYA1ByVal = new Map();

    balancedTxs.forEach(tx => {
      // Assign a stable global group ID per local transaction group
      if (!localToGlobalTxMap.has(tx.Group)) {
        localToGlobalTxMap.set(tx.Group, nextGlobalGroupId++);
      }
      tx.GlobalGroupID = localToGlobalTxMap.get(tx.Group);

      const cleanPk = tx.PK;
      const mRowOff = mergedTable.getRowOffset(cleanPk);

      // A. Stage row for Groups sheet
      const gRow = new Array(groupsTable.getLabels().length).fill("");
      if (groupCols.pk      !== -1) gRow[groupCols.pk]      = tx.PK;
      if (groupCols.group   !== -1) gRow[groupCols.group]   = tx.GlobalGroupID;
      if (groupCols.cleared !== -1) gRow[groupCols.cleared] = tx.Cleared;
      if (groupCols.fy      !== -1) gRow[groupCols.fy]      = tx.FY;

      // Copy matching lookup columns dynamically from Merged (e.g. Amount, EntryType, Date, Customer, Description)
      if (mRowOff !== undefined) {
        groupsTable.getLabels().forEach((label, colIdx) => {
          const labelUpper = label.toUpperCase();
          if (["PK", "GROUP", "CLEARED", "FY"].includes(labelUpper)) return;

          const mergedColOff = mergedTable.getColOffset(label);
          if (mergedColOff !== -1) {
            gRow[colIdx] = mergedTable.get(mRowOff, mergedColOff);
          }
        });
      }
      groupsNewData.push(gRow);

      // B. Collect A1 notations for batched updates to Merged instead of writing cell-by-cell
      if (mRowOff !== undefined) {
        const pRow = mRowOff + mergedTable.firstDataRowIndex;
        if (mergedCols.cleared !== -1) {
          const colLetter = StringUtils.columnToLetter(mergedCols.cleared);
          mergedClearedA1List.push(`${colLetter}${pRow}`);
        }
        if (mergedCols.group !== -1) {
          const colLetter = StringUtils.columnToLetter(mergedCols.group);
          const a1 = `${colLetter}${pRow}`;
          if (!mergedGroupsA1ByVal.has(tx.GlobalGroupID)) {
            mergedGroupsA1ByVal.set(tx.GlobalGroupID, []);
          }
          mergedGroupsA1ByVal.get(tx.GlobalGroupID).push(a1);
        }
        if (mergedCols.fy !== -1 && tx.FY) {
          const colLetter = StringUtils.columnToLetter(mergedCols.fy);
          const a1 = `${colLetter}${pRow}`;
          if (!mergedFYA1ByVal.has(tx.FY)) {
            mergedFYA1ByVal.set(tx.FY, []);
          }
          mergedFYA1ByVal.get(tx.FY).push(a1);
        }
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

    // Execute the batched updates to Merged outside the loop
    if (mergedClearedA1List.length > 0) {
      mergedTable.sheet.getRangeList(mergedClearedA1List).setValue(true);
    }
    mergedGroupsA1ByVal.forEach((a1List, groupId) => {
      mergedTable.sheet.getRangeList(a1List).setValue(groupId);
    });
    mergedFYA1ByVal.forEach((a1List, fyVal) => {
      mergedTable.sheet.getRangeList(a1List).setValue(fyVal);
    });

    // Optimized: Sort the staged rows by Group ID in ascending order so that
    // the sheet remains sorted by Group ID when they are written.
    if (groupCols.group !== -1 && groupsNewData.length > 0) {
      groupsNewData.sort((a, b) => Number(a[groupCols.group] || 0) - Number(b[groupCols.group] || 0));
    }

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

      const groupOff = ledger.getColOffset("Group");
      const fyOff    = ledger.getColOffset("FY");

      if (groupOff === -1) throw new Error(`CRITICAL: Ledger '${ledgerName}' has no 'Group' column. Cannot write back reconciliation group ID.`);

      // Group A1 cell coordinates by GlobalGroupID / FY value for RangeList batch writes
      const a1ByGroupId = new Map();
      const a1ByFYValue = new Map();

      txList.forEach(tx => {
        const rowOff = ledger.getRowOffset(tx.PK);
        if (rowOff === undefined) {
          throw new Error(`CRITICAL: Ledger write-back failed. PK '${tx.PK}' not found in '${ledgerName}'. Data integrity error — this row was reconciled from this ledger.`);
        }
        const pRow = rowOff + ledger.firstDataRowIndex;
        
        // Group ID write-back
        const colLetter = StringUtils.columnToLetter(groupOff);
        const a1 = `${colLetter}${pRow}`;
        if (!a1ByGroupId.has(tx.GlobalGroupID)) {
          a1ByGroupId.set(tx.GlobalGroupID, []);
        }
        a1ByGroupId.get(tx.GlobalGroupID).push(a1);

        // FY write-back (if exists and has value)
        if (fyOff !== -1 && tx.FY) {
          const fyColLetter = StringUtils.columnToLetter(fyOff);
          const fyA1 = `${fyColLetter}${pRow}`;
          if (!a1ByFYValue.has(tx.FY)) {
            a1ByFYValue.set(tx.FY, []);
          }
          a1ByFYValue.get(tx.FY).push(fyA1);
        }
      });

      // Write GlobalGroupIDs in batches using RangeList
      a1ByGroupId.forEach((a1List, groupId) => {
        ledger.sheet.getRangeList(a1List).setValue(groupId);
      });

      // Write FY values in batches using RangeList
      a1ByFYValue.forEach((a1List, fyValue) => {
        ledger.sheet.getRangeList(a1List).setValue(fyValue);
      });

      myLog("info", "Wrote Group (and FY if applicable) back to %d row(s) in ledger %s.", txList.length, ledgerName);
    });
  }


  /**
   * Resolves a PK prefix to the originating ledger sheet's long name,
   * by cross-referencing the SourceSheets config for AnnualSummaries_Merged.
   * @param {string} prefix
   * @returns {string|null} Long name of the ledger, or the prefix itself as a fallback.
   */
  _getLedgerNameFromPrefix(prefix) {
    if (!this._prefixCacheMap) {
      this._prefixCacheMap = new Map();
    }
    if (this._prefixCacheMap.has(prefix)) {
      return this._prefixCacheMap.get(prefix);
    }

    let targetLongName = null;
    const mergeSheetsRaw = globals.sheetsObj.lookupValue("LongName", "SourceSheets", "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "SourceSheet",  "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "MergeSheets",  "AnnualSummaries_Merged");
    if (!mergeSheetsRaw) {
      this._prefixCacheMap.set(prefix, prefix);
      return prefix;
    }

    const mergeSheets = String(mergeSheetsRaw).split(",").map(s => s.trim());
    const sheetCols   = globals.sheetsObj.getSymbolicOffsets();

    globals.sheetsObj.getWindow().forEach(row => {
      const name  = row[sheetCols.longName];
      const prefs = String(row[sheetCols.keyPrefix] || "").split(",").map(p => p.trim());
      if (prefs.includes(prefix) && mergeSheets.includes(name)) {
        targetLongName = name;
      }
    });

    const result = targetLongName || prefix;
    this._prefixCacheMap.set(prefix, result);
    return result;
  }
}
