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
   * @returns {{ balancedTxs: Array }}
   */
  _collectBalancedTransactions() {

    const balancedTxs = this.getWindow()
      .filter(row => TypeUtils.isTrue(row[this.column.balanced]))
      .map(row => {
        let fy = String(row[this.column.transactionFY] || "").trim();
        if (!fy && this.column.date !== undefined && row[this.column.date]) {
          fy = DateUtils.toFY(row[this.column.date]);
        }

        return {
          PK: String(row[this.column.pk]),
          Group: row[this.column.transaction],
          Cleared: true,
          FY: fy
        };
      });

    // rowsToDelete has been deprecated since the Reconcile sheet is now fully regenerated
    return { balancedTxs };
  }

  /**
   * Initializes destination tables for the reconciliation process.
   * @returns {{ groupsTable: UpdateTable, mergedTable: Table, logTable: UpdateTable }}
   */
  _prefetchDestinationTables() {
    const groupsTable = getSheetInstance("Reconciliation_Groups");
    // Groups sheet may contain formula columns that return #N/A when unpopulated.
    // We bypass full type validation to avoid errors when reading these cells.
    groupsTable.withoutValidation();

    // Force the Merged table to be loaded as a standard physical Table starting at row 2 (full load)
    // rather than a virtual UnionTable, so that row offsets correspond to actual physical cells.
    const config = Registry.getSheetConfig(CONFIG_CONSTANTS.MERGED_TABLE_NAME);
    const physicalConfig = { ...config, SheetType: "Table", FirstRow: 2, firstrow: 2 };

    const ssName = config.SpreadSheetName || "Reconciliation";
    const ssid = globals.ssMap.get(ssName) || globals.defaultSSID;
    const ss = getSpreadsheetInstance(ssid);

    const mergedTable = new Table(ss, CONFIG_CONSTANTS.MERGED_TABLE_NAME, physicalConfig);
    
    const uncheckedConfig = Registry.getSheetConfig("Reconciliation_UnChecked");
    const uncheckedPhysicalConfig = { ...uncheckedConfig, SheetType: "Table", FirstRow: 2, firstrow: 2 };
    const uncheckedTable = new Table(ss, "Reconciliation_UnChecked", uncheckedPhysicalConfig);

    const logTable = getSheetInstance("NewAccounts_ReconcileLog");

    return { groupsTable, mergedTable, uncheckedTable, logTable };
  }

  /**
   * Orchestrates the transformation of balanced transactions into output formats.
   * Generates new Global Group IDs, builds new rows for Groups and Log sheets,
   * and builds batches for the Merged sheet (does not execute them).
   * 
   * @param {Array} balancedTxs - Array of objects from _collectBalancedTransactions
   * @param {UpdateTable} groupsTable 
   * @param {Table} mergedTable 
   * @param {Table} uncheckedTable 
   * @param {UpdateTable} logTable 
   * * @returns {{ txsWithGlobalIds: Array, groupsNewData: Array, logNewData: Array, mergedBatches: Object, uncheckedBatches: Object }}
   */
  _stageGroupUpdates(balancedTxs, groupsTable, mergedTable, uncheckedTable, logTable) {
    // 1. Assign auto-incrementing Global Group IDs
    const nextGroupId = this._calculateNextGlobalGroupId(groupsTable);
    const txsWithGlobalIds = this._assignGlobalGroupIds(balancedTxs, nextGroupId);

    // 2. Generate 2D physical matrix payloads for the destination sheets
    const groupsNewData = this._buildGroupsTableRows(txsWithGlobalIds, groupsTable, mergedTable);
    const logNewData = this._buildReconcileLogRows(txsWithGlobalIds, logTable);

    // 3. Accumulate logical batch updates for the Merged sheet and Unchecked sheet
    const mergedBatches = this._buildMergedTableBatchUpdates(txsWithGlobalIds, mergedTable);
    const uncheckedBatches = this._buildUncheckedTableBatchUpdates(txsWithGlobalIds, uncheckedTable);

    return { txsWithGlobalIds, groupsNewData, logNewData, mergedBatches, uncheckedBatches };
  }

  /**
   * Scans the existing Groups table to find the highest GlobalGroupID in use.
   * Calculates and returns the next available integer ID.
   * 
   * @param {UpdateTable} groupsTable
   * @returns {number} The next starting GlobalGroupID
   */
  _calculateNextGlobalGroupId(groupsTable) {
    const existingGroupIds = groupsTable.getWindow()
      .map(row => groupsTable.column.group !== undefined ? Number(row[groupsTable.column.group]) : 0)
      .filter(n => !isNaN(n));
    return existingGroupIds.length > 0 ? Math.max(...existingGroupIds) + 1 : 1;
  }

  /**
   * Assigns a consistent GlobalGroupID to each local transaction group.
   * Returns a new array of transactions enriched with this global ID, 
   * preserving the original objects.
   * 
   * @param {Array} balancedTxs - Array of local transaction objects
   * @param {number} nextGlobalGroupId - The starting ID to assign
   * @returns {Array} New array of transactions with GlobalGroupID attached
   */
  _assignGlobalGroupIds(balancedTxs, nextGlobalGroupId) {
    const localToGlobalTxMap = new Map();
    return balancedTxs.map(tx => {
      if (!localToGlobalTxMap.has(tx.Group)) {
        localToGlobalTxMap.set(tx.Group, nextGlobalGroupId++);
      }
      return { ...tx, GlobalGroupID: localToGlobalTxMap.get(tx.Group) };
    });
  }

  /**
   * Generates a 2D array of row data intended for the Groups table.
   * Dynamically populates core transaction values (PK, GroupID, Cleared, FY)
   * and copies any additional columns from the Merged table by header name.
   * The resulting array is sorted ascending by Group ID.
   * 
   * @param {Array} txsWithGlobalIds - Array of enriched transaction objects
   * @param {UpdateTable} groupsTable
   * @param {Table} mergedTable
   * @returns {Array<Array<any>>} The newly generated rows ready for persistence
   */
  _buildGroupsTableRows(txsWithGlobalIds, groupsTable, mergedTable) {
    const groupTableLabels = groupsTable.getLabels();

    const groupsNewData = txsWithGlobalIds.map(tx => {
      const mergedRowOffset = mergedTable.getRowOffsetFromKey(tx.PK);
      return groupTableLabels.map((label, colIdx) => {
        switch (colIdx) {
          case groupsTable.column.pk: return tx.PK;
          case groupsTable.column.group: return tx.GlobalGroupID;
          case groupsTable.column.cleared: return tx.Cleared;
          case groupsTable.column.fy: return tx.FY;
          default:
            if (mergedRowOffset !== undefined) {
              const mergedColOffset = mergedTable.column[label];
              if (mergedColOffset !== -1) {
                return mergedTable.get(mergedRowOffset, mergedColOffset);
              }
            }
            return "";
        }
      });
    });

    if (groupsTable.column.group !== undefined && groupsNewData.length > 0) {
      groupsNewData.sort((a, b) => Number(a[groupsTable.column.group] || 0) - Number(b[groupsTable.column.group] || 0));
    }
    return groupsNewData;
  }

  /**
   * Accumulates Google Sheets A1 notations into batches for bulk updating the Merged sheet.
   * This minimizes slow cell-by-cell API calls by grouping updates by value.
   * 
   * @param {Array} txsWithGlobalIds - Array of enriched transaction objects
   * @param {Table} mergedTable
   * @returns {{ clearedOffsets: number[], groupsOffsetsByVal: Map<number, number[]>, fyOffsetsByVal: Map<string, number[]> }}
   */
  _buildMergedTableBatchUpdates(txsWithGlobalIds, mergedTable) {
    return txsWithGlobalIds.reduce((groupedOffsets, tx) => {
      const mergedRowOffset = mergedTable.getRowOffsetFromKey(tx.PK);
      if (mergedRowOffset !== undefined) {
        // Every balanced transaction gets its 'Cleared' checkbox set to TRUE in the Merged sheet.
        groupedOffsets.clearedOffsets.push(mergedRowOffset);

        const groupsExistingOffsets = groupedOffsets.groupsOffsetsByVal.get(tx.GlobalGroupID) || [];
        groupedOffsets.groupsOffsetsByVal.set(tx.GlobalGroupID, [...groupsExistingOffsets, mergedRowOffset]);

        if (tx.FY) {
          const fyExistingOffsets = groupedOffsets.fyOffsetsByVal.get(tx.FY) || [];
          groupedOffsets.fyOffsetsByVal.set(tx.FY, [...fyExistingOffsets, mergedRowOffset]);
        }
      }
      return groupedOffsets;
    }, {
      clearedOffsets: [],
      groupsOffsetsByVal: new Map(),
      fyOffsetsByVal: new Map()
    });
  }

  /**
   * Generates a 2D array of log rows intended for the ReconcileLog table.
   * Each row records the reconciliation event for a single transaction.
   * 
   * @param {Array} txsWithGlobalIds - Array of enriched transaction objects
   * @param {UpdateTable} logTable
   * @returns {Array<Array<any>>} The newly generated log rows ready for persistence
   */
  _buildReconcileLogRows(txsWithGlobalIds, logTable) {
    const labelsLength = logTable.getLabels().length;

    return txsWithGlobalIds.reduce((logs, tx) => {
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (prefixMatch) {
        const ledgerName = this._getLedgerNameFromPrefix(prefixMatch[1]);
        if (ledgerName) {
          const logRow = new Array(labelsLength).fill("");
          if (logTable.column.sheetname !== undefined) logRow[logTable.column.sheetname] = ledgerName;
          if (logTable.column.transactionid !== undefined) logRow[logTable.column.transactionid] = tx.PK;
          if (logTable.column.groupid !== undefined) logRow[logTable.column.groupid] = tx.GlobalGroupID;
          if (logTable.column.clearstatus !== undefined) logRow[logTable.column.clearstatus] = true;
          logs.push(logRow);
        }
      }
      return logs;
    }, []);
  }

  /**
   * Executes the accumulated batch updates against the Merged sheet using the Logical Layer.
   * Applies the 'cleared' boolean, group IDs, and FY values in bulk without touching A1 addresses directly.
   * 
   * @param {Table} mergedTable
   * @param {Object} batchUpdates - The accumulated row offset batches
   */
  _executeMergedTableBatchUpdates(mergedTable, batchUpdates) {
    if (batchUpdates.clearedOffsets.length > 0) {
      mergedTable.setValueByLabelAndRowOffsets("Cleared", true, batchUpdates.clearedOffsets);
    }
    batchUpdates.groupsOffsetsByVal.forEach((offsets, groupId) => {
      mergedTable.setValueByLabelAndRowOffsets("Group", groupId, offsets);
    });
    batchUpdates.fyOffsetsByVal.forEach((offsets, fyVal) => {
      mergedTable.setValueByLabelAndRowOffsets("FY", fyVal, offsets);
    });
  }

  /**
   * Accumulates Google Sheets A1 notations into batches for bulk updating the Unchecked sheet.
   * This mirrors the logic of _buildMergedTableBatchUpdates.
   * 
   * @param {Array} txsWithGlobalIds - Array of enriched transaction objects
   * @param {Table} uncheckedTable
   * @returns {{ clearedOffsets: number[], groupsOffsetsByVal: Map<number, number[]>, fyOffsetsByVal: Map<string, number[]> }}
   */
  _buildUncheckedTableBatchUpdates(txsWithGlobalIds, uncheckedTable) {
    return txsWithGlobalIds.reduce((groupedOffsets, tx) => {
      const uncheckedRowOffset = uncheckedTable.getRowOffsetFromKey(tx.PK);
      if (uncheckedRowOffset !== undefined) {
        // Every balanced transaction gets its 'Cleared' checkbox set to TRUE in the Unchecked sheet.
        groupedOffsets.clearedOffsets.push(uncheckedRowOffset);

        const groupsExistingOffsets = groupedOffsets.groupsOffsetsByVal.get(tx.GlobalGroupID) || [];
        groupedOffsets.groupsOffsetsByVal.set(tx.GlobalGroupID, [...groupsExistingOffsets, uncheckedRowOffset]);

        if (tx.FY) {
          const fyExistingOffsets = groupedOffsets.fyOffsetsByVal.get(tx.FY) || [];
          groupedOffsets.fyOffsetsByVal.set(tx.FY, [...fyExistingOffsets, uncheckedRowOffset]);
        }
      }
      return groupedOffsets;
    }, {
      clearedOffsets: [],
      groupsOffsetsByVal: new Map(),
      fyOffsetsByVal: new Map()
    });
  }

  /**
   * Executes the accumulated batch updates against the Unchecked sheet using the Logical Layer.
   * Applies the 'cleared' boolean, group IDs, and FY values in bulk.
   * 
   * @param {Table} uncheckedTable
   * @param {Object} batchUpdates - The accumulated row offset batches
   */
  _executeUncheckedTableBatchUpdates(uncheckedTable, batchUpdates) {
    if (batchUpdates.clearedOffsets.length > 0) {
      uncheckedTable.setValueByLabelAndRowOffsets("Cleared", true, batchUpdates.clearedOffsets);
    }
    batchUpdates.groupsOffsetsByVal.forEach((offsets, groupId) => {
      uncheckedTable.setValueByLabelAndRowOffsets("Group", groupId, offsets);
    });
    batchUpdates.fyOffsetsByVal.forEach((offsets, fyVal) => {
      uncheckedTable.setValueByLabelAndRowOffsets("FY", fyVal, offsets);
    });
  }




  /**
   * Resolves a PK prefix to the originating ledger sheet's long name,
   * by cross-referencing the SourceSheets config for AnnualSummaries_Merged.
   * @param {string} prefix
   * @returns {string|null} Long name of the ledger, or the prefix itself as a fallback.
   */
  _getLedgerNameFromPrefix(prefix) {
    if (!prefix) return null;
    const target = Registry.getLongNameByPrefix(prefix) || prefix;

    // Redirect active manual entry tables to their corresponding ledgers.
    // The manual entry sheets themselves are purely for data entry and are never written to by the program.
    const redirections = {
      "ManualEntry_Ledger": "Ledgers_Transactions",
      "ManualEntry_Holdings": "Ledgers_Assets",
      "ManualEntry_Cashbox": "Ledgers_Cash"
    };

    return redirections[target] || target;
  }
}
