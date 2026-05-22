"use strict";

/**
 * gitCode_Redesign - ReconcileBuilder (Level 3/4 — Builder)
 * Provides Union-Find grouping logic and the private MODE 1 helper methods
 * used to build the Reconcile matrix from unreconciled transactions.
 * Extends UpdateTable to leverage its persistence infrastructure.
 *
 * Public MODE 1 entry point (startNewReconciliation) lives in ReconcileTable.
 * Load order: must precede ReconcileProcessor (181) and ReconcileTable (182).
 */
class ReconcileBuilder extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
  }


  // =========================================================================
  // UNION-FIND HELPERS
  // =========================================================================

  /**
   * Path-compressed root finder.
   * @param {number} index
   * @param {number[]} parentMap
   * @returns {number}
   */
  root(index, parentMap) {
    if (parentMap[index] === undefined) return index;
    if (parentMap[index] === index) return index;
    parentMap[index] = this.root(parentMap[index], parentMap);
    return parentMap[index];
  }

  /**
   * Unites two elements into the same group.
   * @param {number} index1
   * @param {number} index2
   * @param {number[]} parentMap
   */
  union(index1, index2, parentMap) {
    const root1 = this.root(index1, parentMap);
    const root2 = this.root(index2, parentMap);
    if (root1 !== root2) {
      parentMap[root2] = root1;
    }
  }

  /**
   * Unions all indices in a set together under a single root.
   * @param {Set<number>} indexSet
   * @param {number[]} parentMap
   */
  unifyRelatedRows(indexSet, parentMap) {
    if (indexSet.size > 1) {
      const indexArray = Array.from(indexSet);
      const baseIndex = indexArray[0];
      indexArray.slice(1).forEach(index => this.union(baseIndex, index, parentMap));
    }
  }


  // =========================================================================
  // MODE 1: PRIVATE HELPERS
  // =========================================================================

  /**
   * Extracts all unreconciled rows from the Merged table, enriched with
   * the identifiers and metadata needed for Union-Find grouping.
   * @param {Table} mergedTable
   * @param {Map<string,string>} existingTxMap  PK → existing Transaction ID
   * @returns {Array}
   */
  _extractUnreconciledRows(mergedTable, existingTxMap) {
    const mergedCols = mergedTable.getSymbolicOffsets();

    return mergedTable.getWindow()
      .map((row, offset) => ({ row, offset }))
      .filter(({ row }) => !TypeUtils.isTrue(row[mergedCols.cleared]) && row[mergedCols.pk])
      .map(({ row, offset }) => {
        const pkStr = StringUtils.sanitizeName(row[mergedCols.pk]);
        return {
          rowOffset:   offset,
          PK:          pkStr,
          existingTx:  existingTxMap.get(pkStr) || "",
          identifiers: [row[mergedCols.pk], row[mergedCols.fk], row[mergedCols.depositId], row[mergedCols.paymentId]]
                        .map(id => StringUtils.sanitizeName(id))
                        .filter(id => id !== null),
          entryType:   (StringUtils.sanitizeName(row[mergedCols.entryType]) || "").toUpperCase(),
          account:     StringUtils.sanitizeName(row[mergedCols.account]) || "",
          prefix:      pkStr ? pkStr.split('#')[0] : ""
        };
      });
  }

  /**
   * Sorts unreconciled rows: Accounts first (alphabetically by account),
   * then Activities (alphabetically by prefix).
   * @param {Array} unreconciledRows
   * @returns {Array}
   */
  _sortUnreconciledRows(unreconciledRows) {
    return unreconciledRows.sort((rowA, rowB) => {
      const isRowAAccount = rowA.entryType === "ACCOUNT";
      const isRowBAccount = rowB.entryType === "ACCOUNT";

      // Accounts always come before Activities
      if (isRowAAccount && !isRowBAccount) return -1;
      if (!isRowAAccount && isRowBAccount) return 1;

      // If both are Accounts, sort alphabetically by Account name/type
      if (isRowAAccount && isRowBAccount) {
        return rowA.account.localeCompare(rowB.account);
      }

      // If both are Activities (neither is an Account), sort alphabetically by prefix
      if (!isRowAAccount && !isRowBAccount) {
        return rowA.prefix.localeCompare(rowB.prefix);
      }

      return 0;
    });
  }

  /**
   * Runs Union-Find over shared identifiers and preserved Transaction IDs
   * to group related rows together.
   * @param {Array} unreconciledRows
   * @returns {number[]} parentMap
   */
  _buildUnionFindGroups(unreconciledRows) {
    const parentMap  = Array.from({ length: unreconciledRows.length }, (_, i) => i);
    const idToRowMap = new Map();
    const txToRowMap = new Map();

    unreconciledRows.forEach((item, index) => {
      item.identifiers.forEach(id => {
        const cleanId = StringUtils.sanitizeName(id);
        if (cleanId) {
          if (!idToRowMap.has(cleanId)) idToRowMap.set(cleanId, new Set());
          idToRowMap.get(cleanId).add(index);
        }
      });

      if (item.existingTx) {
        if (!txToRowMap.has(item.existingTx)) txToRowMap.set(item.existingTx, new Set());
        txToRowMap.get(item.existingTx).add(index);
      }
    });

    idToRowMap.forEach(indexSet => this.unifyRelatedRows(indexSet, parentMap));
    txToRowMap.forEach(indexSet => this.unifyRelatedRows(indexSet, parentMap));

    return parentMap;
  }

  /**
   * Converts grouped rows into the output matrix for the Reconcile sheet.
   * Singletons get no Transaction ID; groups of ≥2 get an auto-assigned or preserved ID.
   * @param {Array}    unreconciledRows
   * @param {number[]} parentMap
   * @param {number}   startingTxId  First ID to use for new groups.
   * @returns {Array<Array>}
   */
  _generateReconcileOutput(unreconciledRows, parentMap, startingTxId = 1) {
    // Count the size of each group first
    const groupSizes = new Map();
    const rootToTxId = new Map();

    unreconciledRows.forEach((item, index) => {
      const rootIndex = this.root(index, parentMap);
      groupSizes.set(rootIndex, (groupSizes.get(rootIndex) || 0) + 1);

      if (item.existingTx) {
        const currentExisting = rootToTxId.get(rootIndex);
        if (!currentExisting || Number(item.existingTx) < Number(currentExisting)) {
          rootToTxId.set(rootIndex, item.existingTx);
        }
      }
    });

    let nextTxId = startingTxId;
    const outputData = [];

    unreconciledRows.forEach((item, index) => {
      const rootIndex = this.root(index, parentMap);
      const size = groupSizes.get(rootIndex);

      let currentTxId = ""; // Default to blank for singletons

      if (rootToTxId.has(rootIndex)) {
        currentTxId = rootToTxId.get(rootIndex);
      } else if (size >= 2) {
        rootToTxId.set(rootIndex, nextTxId++);
        currentTxId = rootToTxId.get(rootIndex);
      }

      const outRow = new Array(this.getLabels().length).fill("");
      const reconcileCols = this.getSymbolicOffsets();

      if (reconcileCols.pk          !== -1) outRow[reconcileCols.pk]          = item.PK;
      if (reconcileCols.transaction !== -1) outRow[reconcileCols.transaction] = currentTxId;

      outputData.push(outRow);
    });

    return outputData;
  }

  /**
   * Restores the complex array formulas to the first data row of the Reconcile sheet.
   */
  restoreFormulas() {
    const formulas = {};
    const base = StringUtils.toRangeName(this.sheetName);
    const mergedConfig = Registry.getSheetConfig("AnnualSummaries_Merged");
    const mergedSheetName = mergedConfig ? (mergedConfig.SheetName || "Merged") : "Merged";
    const mergedBase = StringUtils.toRangeName(mergedSheetName);

    // Dynamic Named Range Builders
    const rng  = (col) => base      + StringUtils.toRangeName(col);
    const mRng = (col) => mergedBase + StringUtils.toRangeName(col);

    // Complex BYROW/MAP logic (using dynamically calculated named ranges)
    formulas["Balanced"]      = `=MAP(${rng("ActivitySum")}, ${rng("AccountSum")}, LAMBDA(activity, account, IF(AND(activity="", account=""), False, IF(AND(activity=account, activity<>0), TRUE, FALSE) ) ))`;
    formulas["ActivitySum"]   = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Activity") )))`;
    formulas["AccountSum"]    = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Account") ) ))`;
    formulas["TransactionFY"] = `=BYROW(${rng("Transaction")}, LAMBDA(current_transaction_id, IF(current_transaction_id="", "", LET( transaction_is_balanced, INDEX(${rng("Balanced")}, MATCH(current_transaction_id, ${rng("Transaction")}, 0)), IF(transaction_is_balanced = TRUE, MAXIFS(${rng("xFY")}, ${rng("Transaction")}, current_transaction_id, ${rng("EntryType")}, "Account"), "" ) ) ) ))`;

    // Calculate xFY dynamically based on the Date column (reconcile date) using April 1st FY start, named as the ending year of the FY
    formulas["xFY"] = `=MAP(${rng("Date")}, LAMBDA(d, IF(d="", "", YEAR(d) + IF(MONTH(d) >= 4, 1, 0) )))`;

    // Lookup formulas
    const lookupCols = ["Date", "Amount", "Customer", "Description", "Category", "Account", "EntryType", "FK", "DepositID", "PaymentID"];
    lookupCols.forEach(col => {
      formulas[col] = `=ARRAYFORMULA(IF(${rng("PK")}="","",VLOOKUP(${rng("PK")}, {${mRng("PK")}, ${mRng(col)}}, 2, 0)))`;
    });

    const labels = this.getLabels();
    const formulaRow = new Array(labels.length).fill("");

    labels.forEach((label, idx) => {
      if (formulas[label]) {
        formulaRow[idx] = formulas[label];
      }
    });

    const range = this.sheet.getRange(this.firstDataRowIndex, 1, 1, labels.length);
    range.setFormulas([formulaRow]);
  }
}
