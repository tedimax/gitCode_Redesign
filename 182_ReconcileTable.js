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
    const mergedTable = getSheetInstance(CONFIG_CONSTANTS.MERGED_TABLE_NAME);
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

    // Filter out groups that are entirely before or at the FirstRow (previous FY)
    const absoluteFirstRow = mergedTable.absoluteFirstRow;
    const firstDataRowIndex = mergedTable.firstDataRowIndex;

    const rowsByGroupRoot = new Map();
    unreconciledRows.forEach(row => {
      const rootPK = row.rootRow.PK;
      if (!rowsByGroupRoot.has(rootPK)) {
        rowsByGroupRoot.set(rootPK, []);
      }
      rowsByGroupRoot.get(rootPK).push(row);
    });

    const validGroupRoots = new Set();
    rowsByGroupRoot.forEach((rows, rootPK) => {
      const hasCurrentFYRow = rows.some(row => {
        const physicalRowIndex = firstDataRowIndex + row.rowOffset;
        return !absoluteFirstRow || physicalRowIndex > absoluteFirstRow;
      });
      if (hasCurrentFYRow) {
        validGroupRoots.add(rootPK);
      } else {
        myLog("info", "Reconcile: Rejecting group %s because all its rows are before or at the FirstRow (row %d).", rootPK, absoluteFirstRow);
      }
    });

    const filteredRows = unreconciledRows.filter(row => validGroupRoots.has(row.rootRow.PK));

    if (filteredRows.length === 0) {
      myLog("info", "No unreconciled rows remaining after filtering out historical groups.");
      this.clearDataArea();
      this.restoreFormulas();
      return;
    }

    // 4. Sort rows using Group-Priority sorting (keeps connected groups contiguous)
    const sortedRows = this._sortGroupedRows(filteredRows);

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
    const { pk, transaction: txId } = this.getSymbolicOffsets();

    // Guard clause: If columns aren't valid, throw an error
    if (pk === -1 || txId === -1) {
      throw new Error("CRITICAL CONFIG ERROR: Required columns 'pk' or 'transaction' missing in Reconcile sheet.");
    }

    // Functional pipeline: Map rows to pairs, filter out invalids, format, and construct the Map
    return new Map(
      this.getWindow()
        .map(row => [row[pk], row[txId]])
        .filter(([id, tx]) => id && tx)
        .map(([id, tx]) => [id, String(tx).trim()])
    );
  }

  /**
   * Groups rows by their Union-Find root index, then identifies the best 
   * representative row for each group (preferring 'ACCOUNT' entries).
   * The chosen representative is attached to the `rootRow` property of every row in that group.
   *
   * @param {Array<Object>} unreconciledRows - Array of row objects to process.
   * @param {Array<number>} parentMap - Union-Find parent array where index is row index and value is parent index.
   */
  _resolveGroupRepresentatives(unreconciledRows, parentMap) {
    // rootToRowsMap maps a Union-Find root index to an array of all row objects belonging to that connected group.
    const rootToRowsMap = unreconciledRows.reduce((groupMap, row, i) => {
      // Find the ultimate parent (root) index for the current row using Union-Find.
      // All connected rows in the same transaction group will resolve to the exact same rootIdx.
      const rootIdx = this.root(i, parentMap);
      const existing = groupMap.get(rootIdx);
      if (!existing) {
        groupMap.set(rootIdx, [row]);
      } else {
        existing.push(row);
      }
      return groupMap;
    }, new Map());

    // rootToRepMap maps a root index to its single designated representative row.
    // Determine the representative for each connected group.
    const rootToRepMap = new Map(
      Array.from(rootToRowsMap.entries()).map(([rootIdx, rows]) => {
        const accountRow = rows.find(r => r.entryType === "ACCOUNT");
        // Yield a [key, value] pair for the Map constructor. The value defaults to the raw root row if no ACCOUNT row exists.
        return [rootIdx, accountRow || unreconciledRows[rootIdx]];
      })
    );

    // Map over unreconciledRows to attach the chosen representative to each row
    unreconciledRows.map((row, i) => {
      const rootIdx = this.root(i, parentMap);
      row.rootRow = rootToRepMap.get(rootIdx);
      return row;
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
    const { balancedTxs } = this._collectBalancedTransactions();
    if (balancedTxs.length === 0) {
      myLog("info", "No balanced rows found to process.");
      return;
    }

    // ==========================================
    // PHASE 1: PREPARATION & VALIDATION (No mutations)
    // ==========================================
    // 2. Pre-fetch all destination tables BEFORE any mutations
    const { groupsTable, mergedTable, logTable } = this._prefetchDestinationTables();

    // 3. Stage updates for Merged, Groups, and Log tables
    const { txsWithGlobalIds, groupsNewData, logNewData, mergedBatches } = this._stageGroupUpdates(balancedTxs, groupsTable, mergedTable, logTable);

    // 4. Stage updates for originating Ledgers
    const ledgerBatches = this._stageLedgerUpdates(txsWithGlobalIds);

    // ==========================================
    // PHASE 2: COMMIT (Write-Only)
    // ==========================================
    // If execution reaches here, all logic and lookup validations have passed.
    
    this._executeMergedTableBatchUpdates(mergedTable, mergedBatches);
    this._executeLedgerBatchUpdates(ledgerBatches);

    // 5. Persist staged rows to Groups and ReconcileLog
    try {
      groupsTable.persist(groupsNewData, "add");
    } catch (e) {
      throw new Error(`CRITICAL CONFIG ERROR: Reconciliation_Groups failed to persist. Ensure it is configured as an UpdateTable. Original error: ${e.message}`);
    }

    if (logNewData.length > 0) {
      try {
        logTable.persist(logNewData, "add");
      } catch (e) {
        throw new Error(`CRITICAL CONFIG ERROR: NewAccounts_ReconcileLog failed to persist. Ensure it is configured as an UpdateTable. Original error: ${e.message}`);
      }
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
   * Builds batch update payloads for originating ledger sheets.
   * Fails hard on any miss — these are the source ledgers; everything must resolve cleanly.
   * 
   * @param {Array} balancedTxs
   * @returns {Map<string, { groupOffsetsByVal: Map<number, number[]>, fyOffsetsByVal: Map<string, number[]> }>}
   */
  _stageLedgerUpdates(balancedTxs) {
    const txsByLedger = new Map();
    balancedTxs.forEach(tx => {
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (!prefixMatch) {
        throw new Error(`CRITICAL: Cannot resolve ledger prefix from PK '${tx.PK}'. PK format is invalid.`);
      }
      const ledgerName = this._getLedgerNameFromPrefix(prefixMatch[1]);
      if (!ledgerName) {
        throw new Error(`CRITICAL: Cannot resolve ledger name from prefix '${prefixMatch[1]}' (PK: '${tx.PK}'). Check SourceSheets config for ${CONFIG_CONSTANTS.MERGED_TABLE_NAME}.`);
      }
      if (!txsByLedger.has(ledgerName)) txsByLedger.set(ledgerName, []);
      txsByLedger.get(ledgerName).push(tx);
    });

    const ledgerBatches = new Map();

    txsByLedger.forEach((txList, ledgerName) => {
      // Force the ledger table to load from row 2 (full load) so we can find and update
      // historical/out-of-window transactions.
      const config = Registry.getSheetConfig(ledgerName);
      const fullConfig = { ...config, FirstRow: 2, firstrow: 2 };
      
      const ssName = config.SpreadSheetName || ledgerName.split("_")[0];
      const ssid = globals.ssMap.get(ssName) || globals.defaultSSID;
      const ss = getSpreadsheetInstance(ssid);
      
      const type = config.SheetType || "Table";
      const Constructor = globals.tableMap[type] || globals.tableMap['Table'];
      const ledger = new Constructor(ss, ledgerName, fullConfig);

      if (ledger.getColOffset("Group") === -1) {
        throw new Error(`CRITICAL: Ledger '${ledgerName}' has no 'Group' column. Cannot write back reconciliation group ID.`);
      }

      // Group relative row offsets by target value for logical batch writes
      const groupOffsetsByVal = new Map();
      const fyOffsetsByVal = new Map();

      txList.forEach(tx => {
        const rowOff = ledger.getRowOffset(tx.PK);
        if (rowOff === undefined) {
          throw new Error(`CRITICAL: Ledger write-back failed. PK '${tx.PK}' not found in '${ledgerName}'. Data integrity error — this row was reconciled from this ledger.`);
        }
        
        // Group ID offsets
        const groupsExistingOffsets = groupOffsetsByVal.get(tx.GlobalGroupID) || [];
        groupOffsetsByVal.set(tx.GlobalGroupID, [...groupsExistingOffsets, rowOff]);

        // FY offsets (if exists and has value)
        if (tx.FY) {
          const fyExistingOffsets = fyOffsetsByVal.get(tx.FY) || [];
          fyOffsetsByVal.set(tx.FY, [...fyExistingOffsets, rowOff]);
        }
      });

      ledgerBatches.set(ledgerName, { ledger, groupOffsetsByVal, fyOffsetsByVal });
    });

    return ledgerBatches;
  }

  /**
   * Executes the accumulated batch updates against the source ledgers.
   * 
   * @param {Map<string, Object>} ledgerBatches 
   */
  _executeLedgerBatchUpdates(ledgerBatches) {
    ledgerBatches.forEach((batches, ledgerName) => {
      const ledger = batches.ledger;

      batches.groupOffsetsByVal.forEach((offsets, groupId) => {
        ledger.setBatchedValuesByLabel("Group", groupId, offsets);
      });
      batches.fyOffsetsByVal.forEach((offsets, fyVal) => {
        ledger.setBatchedValuesByLabel("FY", fyVal, offsets);
      });

      myLog("info", "Wrote Group (and FY if applicable) back to ledger %s.", ledgerName);
    });
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

