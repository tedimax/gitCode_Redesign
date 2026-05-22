"use strict";

/**
 * gitCode_Redesign - ReconcileTable (Level 3/4 — Orchestrator)
 * Public entry point for all reconciliation operations.
 * Wires ReconcileBuilder and ReconcileProcessor into a single concrete class.
 *
 * This file intentionally contains the two public-facing orchestrator methods so
 * that the complete MODE 1 / MODE 2 flow is visible in one place. All private
 * helper methods live in the builder (180) and processor (181) layers.
 *
 * Load order: must follow ReconcileProcessor (181).
 *
 * Inheritance chain:
 *   Table → UpdateTable → ReconcileBuilder → ReconcileProcessor → ReconcileTable
 */
class ReconcileTable extends ReconcileProcessor {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    // Reconcile sheets are dynamic matching scratchpads and do not require fact validation
    this.withoutValidation();
  }


  // =========================================================================
  // MODE 1: BUILD RECONCILE MATRIX
  // =========================================================================

  /**
   * Extracts unreconciled transactions from the Merged table, groups them via
   * Union-Find, assigns Transaction IDs, and rebuilds the Reconcile sheet.
   * Private helpers: _extractUnreconciledRows, _sortUnreconciledRows,
   *                  _buildUnionFindGroups, _generateReconcileOutput  (ReconcileBuilder)
   */
  startNewReconciliation() {
    myLog("info", "Starting new reconciliation on %s", this.longName);

    // Fetch existing Reconcile table to preserve manual Transaction IDs
    this.fetchWindow();
    const reconcileCols = this.getSymbolicOffsets();
    const existingTxMap = new Map();

    if (reconcileCols.pk !== -1 && reconcileCols.transaction !== -1) {
      this.getWindow().forEach(row => {
        const pk = StringUtils.sanitizeName(row[reconcileCols.pk]);
        const tx = StringUtils.sanitizeName(row[reconcileCols.transaction]);
        if (pk && tx) existingTxMap.set(pk, tx);
      });
    }

    const mergedTable = getSheetInstance("AnnualSummaries_Merged");
    mergedTable.fetchWindow();

    // 1. Extract Unreconciled Rows
    const unreconciledRows = this._extractUnreconciledRows(mergedTable, existingTxMap);

    if (unreconciledRows.length === 0) {
      myLog("info", "No unreconciled rows found in Merged table.");
      this.clearDataArea();
      this.restoreFormulas();
      return;
    }

    // 2. Sort Rows (Accounts first then by Account Type, Activities by prefix)
    const sortedRows = this._sortUnreconciledRows(unreconciledRows);

    // 3. Build Union-Find Groups
    const parentMap = this._buildUnionFindGroups(sortedRows);

    // 4. Assign Transaction IDs & Generate Output
    // Pass the max existing transaction ID to ensure new IDs don't collide
    const existingTxIds = Array.from(existingTxMap.values()).map(Number).filter(n => !isNaN(n));
    const nextTxId = existingTxIds.length > 0 ? Math.max(...existingTxIds) + 1 : 1;
    const outputData = this._generateReconcileOutput(sortedRows, parentMap, nextTxId);

    // 5. Write to Sheet
    this.clearDataArea();
    if (outputData.length > 0) {
      // Offset by 1 row to leave the first data row strictly for formulas
      this.writeBlock(this.firstDataRowIndex + 1, outputData);
    }

    // 6. Restore Formulas
    this.restoreFormulas();
    myLog("info", "Reconciliation started. Wrote %d rows.", outputData.length);
  }


  // =========================================================================
  // MODE 2: COMMIT BALANCED GROUPS
  // =========================================================================

  /**
   * Commits all balanced transaction groups back to their destination sheets.
   * Private helpers: _collectBalancedTransactions, _prefetchDestinationTables,
   *                  _stageAndApplyGroupUpdates, _writeBackToLedgers,
   *                  _clearReconciledRows, _getLedgerNameFromPrefix  (ReconcileProcessor)
   */
  processBalancedRows() {
    myLog("info", "Processing balanced rows in %s", this.longName);
    this.fetchWindow();

    // 1. Identify which rows are balanced and collect their data
    const { balancedTxs, rowsToDelete } = this._collectBalancedTransactions();
    if (balancedTxs.length === 0) {
      myLog("info", "No balanced rows found to process.");
      return;
    }

    // 2. Pre-fetch all destination tables BEFORE any mutations
    const { groupsTable, mergedTable, logTable } = this._prefetchDestinationTables();

    // 3. Assign global group IDs, stage Groups/Log rows, update Merged cells
    const { groupsNewData, logNewData } = this._stageAndApplyGroupUpdates(balancedTxs, groupsTable, mergedTable, logTable);

    // 4. Write Group & Cleared back to the originating ledger sheets
    this._writeBackToLedgers(balancedTxs);

    // 5. Persist staged rows to Groups and ReconcileLog
    if (typeof groupsTable.persist !== "function") {
      throw new Error(`CRITICAL CONFIG ERROR: AnnualSummaries_Groups must be configured as an UpdateTable in NewAccounts_Sheets (SheetType=UpdateTable) to persist ${groupsNewData.length} group rows. Current type does not support persist().`);
    }
    groupsTable.persist(groupsNewData, "add");

    if (logNewData.length > 0) {
      if (typeof logTable.persist !== "function") {
        throw new Error(`CRITICAL CONFIG ERROR: NewAccounts_ReconcileLog must be configured as an UpdateTable in NewAccounts_Sheets (SheetType=UpdateTable) to persist ${logNewData.length} logs. Current type does not support persist().`);
      }
      logTable.persist(logNewData, "add");
    } else {
      myLog("warn", "No rows staged for ReconcileLog. ColLabels length: %d", logTable.getLabels().length);
    }

    // 6. Clear processed rows from the Reconcile sheet
    this._clearReconciledRows(rowsToDelete);

    // 7. Restore array formulas to the first data row
    this.restoreFormulas();

    myLog("info", "Processed %d balanced rows successfully.", balancedTxs.length);
  }
}

// Register with globals
globals.tableMap['ReconcileTable'] = ReconcileTable;

