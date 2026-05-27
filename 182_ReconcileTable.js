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

    // 1. Load existing manual Transaction IDs from the Reconcile sheet
    const existingTxMap = this._loadExistingManualTxIds();

    // 2. Extract unreconciled rows from Merged sheet
    const mergedTable = getSheetInstance("AnnualSummaries_Merged");
    const unreconciledRows = this._extractUnreconciledRows(mergedTable, existingTxMap);

    if (unreconciledRows.length === 0) {
      myLog("info", "No unreconciled rows found in Merged table.");
      this.clearDataArea();
      this.restoreFormulas();
      return;
    }

    // 3. Group rows using Union-Find and designate group representatives (preferring Accounts)
    const parentMap = this._buildUnionFindGroups(unreconciledRows);
    this._resolveGroupRepresentatives(unreconciledRows, parentMap);

    // 4. Sort rows using Group-Priority sorting (keeps connected groups contiguous)
    const sortedRows = this._sortGroupedRows(unreconciledRows);

    // 5. Assign Transaction IDs & generate output data
    const nextTxId = this._calculateNextTransactionId(existingTxMap);

    // 6. Present / Render output to Reconcile sheet
    const renderer = new ReconcileRenderer(this);
    const count = renderer.render(sortedRows, nextTxId);
    myLog("info", "Reconciliation started. Wrote %d rows.", count);
  }

  /**
   * Loads existing manually entered Transaction IDs from the Reconcile sheet to preserve them.
   * @returns {Map<string, string>} PK -> Transaction ID
   */
  _loadExistingManualTxIds() {
    const reconcileCols = this.getSymbolicOffsets();
    const existingTxMap = new Map();

    if (reconcileCols.pk !== -1 && reconcileCols.transaction !== -1) {
      this.getWindow().forEach(row => {
        const pk = row[reconcileCols.pk];
        const tx = row[reconcileCols.transaction];
        if (pk && tx) existingTxMap.set(pk, String(tx).trim());
      });
    }
    return existingTxMap;
  }

  /**
   * Identifies the best representative for each group (preferring ACCOUNT rows)
   * and attaches it to the rootRow property of each transaction row.
   */
  _resolveGroupRepresentatives(unreconciledRows, parentMap) {
    const rootToRowsMap = new Map();
    unreconciledRows.forEach((row, i) => {
      const rootIdx = this.root(i, parentMap);
      if (!rootToRowsMap.has(rootIdx)) {
        rootToRowsMap.set(rootIdx, []);
      }
      rootToRowsMap.get(rootIdx).push(row);
    });

    const rootToRepMap = new Map();
    rootToRowsMap.forEach((rows, rootIdx) => {
      const accountRow = rows.find(r => r.entryType === "ACCOUNT");
      rootToRepMap.set(rootIdx, accountRow || unreconciledRows[rootIdx]);
    });

    unreconciledRows.forEach((row, i) => {
      const rootIdx = this.root(i, parentMap);
      row.rootRow = rootToRepMap.get(rootIdx);
    });
  }

  /**
   * Calculates the next starting Transaction ID based on existing preserved IDs.
   */
  _calculateNextTransactionId(existingTxMap) {
    const existingTxIds = Array.from(existingTxMap.values()).map(Number).filter(n => !isNaN(n));
    return existingTxIds.length > 0 ? Math.max(...existingTxIds) + 1 : 1;
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
    this.getWindow();

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

    // 6. Clear caches to force a fresh fetch from Google Sheets
    this.clearCache();
    mergedTable.clearCache();

    // 7. Re-render the Reconcile sheet cleanly, fully compacted
    myLog("info", "Balanced rows committed. Re-building the Reconcile sheet to compact it.");
    this.startNewReconciliation();

    myLog("info", "Processed %d balanced rows successfully.", balancedTxs.length);
  }

  /**
   * Restores the complex array formulas to the first data row of the Reconcile sheet.
   * Delegates layout presentation to the ReconcileRenderer layout engine.
   */
  restoreFormulas() {
    new ReconcileRenderer(this).restoreFormulas();
  }
}

// Register with globals
globals.tableMap['ReconcileTable'] = ReconcileTable;

