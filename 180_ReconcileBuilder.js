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
  // MODE 1: BUILD RECONCILE MATRIX (Calling Sequence)
  // =========================================================================

  /**
   * Extracts all unreconciled rows from the Merged table, enriched with
   * the identifiers and metadata needed for Union-Find grouping.
   * @param {Table} mergedTable
   * @param {Map<string,string>} existingTxMap  PK → existing Transaction ID
   * @returns {Array}
   */
  _extractUnreconciledRows(mergedTable, existingTxMap) {
    return mergedTable.getWindow()
      .map((row, offset) => ({ row, offset }))
      .filter(({ row }) => !TypeUtils.isTrue(row[mergedTable.column.cleared]) && row[mergedTable.column.pk])
      .map(({ row, offset }) => {
        const pkStr = row[mergedTable.column.pk];
        return {
          rowOffset:   offset,
          PK:          pkStr,
          existingTx:  existingTxMap.get(pkStr) || "",
          identifiers: CONFIG_CONSTANTS.RECONCILE_IDENTIFIER_FIELDS
                        .map(fieldName => row[mergedTable.column[fieldName]])
                        .map(id => (id || "").trim())
                        .filter(id => id !== ""),
          entryType:   (row[mergedTable.column.entrytype] || "").toUpperCase(),
          account:     row[mergedTable.column.account] || "",
          prefix:      pkStr ? pkStr.split('#')[0] : "",
          date:        row[mergedTable.column.date] || ""
        };
      });
  }

  /**
   * Runs Union-Find over shared identifiers and preserved Transaction IDs
   * to group related rows together.
   * 
   * The algorithm operates in three distinct phases:
   *   1. Initialization: Every row starts in its own group.
   *   2. Indexing: Group row indices by shared keys (Identifiers & Existing Transactions).
   *   3. Union: Connect all rows that share any of these keys.
   * 
   * @param {Array} unreconciledRows
   * @returns {number[]} parentMap
   */
  _buildUnionFindGroups(unreconciledRows) {
    // 1. Initial State: Every row is its own group root
    const parentMap = Array.from({ length: unreconciledRows.length }, (_, i) => i);

    // 2. Indexing Phase: Map keys to the row indices that share them
    const idToRowMap = this._indexRowIndicesByIdentifier(unreconciledRows);
    const txToRowMap = this._indexRowIndicesByTransactionId(unreconciledRows);

    // 3. Union Phase: Merge groups sharing any identifier or Transaction ID
    this._connectSharedGroups(idToRowMap, parentMap);
    this._connectSharedGroups(txToRowMap, parentMap);

    return parentMap;
  }

  /**
   * Indexing helper: Groups row indices by their transaction identifiers.
   */
  _indexRowIndicesByIdentifier(unreconciledRows) {
    return unreconciledRows.reduce((acc, item, index) => {
      item.identifiers.forEach(id => {
        if (id) {
          if (!acc.has(id)) acc.set(id, new Set());
          acc.get(id).add(index);
        }
      });
      return acc;
    }, new Map());
  }

  /**
   * Indexing helper: Groups row indices by their existing preserved Transaction IDs.
   */
  _indexRowIndicesByTransactionId(unreconciledRows) {
    return unreconciledRows.reduce((acc, item, index) => {
      if (item.existingTx) {
        if (!acc.has(item.existingTx)) acc.set(item.existingTx, new Set());
        acc.get(item.existingTx).add(index);
      }
      return acc;
    }, new Map());
  }

  /**
   * Union helper: Unifies sets of related indices using the parent map.
   */
  _connectSharedGroups(lookupMap, parentMap) {
    lookupMap.forEach(indexSet => this.unifyRelatedRows(indexSet, parentMap));
  }

  /**
   * Unions all indices in a set together under a single root.
   * @param {Set<number>} indexSet
   * @param {number[]} parentMap
   */
  unifyRelatedRows(indexSet, parentMap) {
    if (indexSet.size < 2) return;
    let baseIndex = null;
    for (const index of indexSet) {
      if (baseIndex === null) {
        baseIndex = index;
      } else {
        this.union(baseIndex, index, parentMap);
      }
    }
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
   * Path-compressed root finder. (Called externally and internally by union)
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
   * Sorts unreconciled rows by Group-Priority:
   * 1. If they belong to the same group, sort them within the group (Accounts first, then Activities by prefix/date).
   * 2. If they belong to different groups, sort by their group roots.
   * @param {Array} unreconciledRows
   * @returns {Array} sortedRows
   */
  _sortGroupedRows(unreconciledRows) {
    return unreconciledRows.sort((rowA, rowB) => {
      // If they belong to the same group, sort them internally
      if (rowA.rootRow === rowB.rootRow) {
        return this._compareSingleRows(rowA, rowB);
      }

      // If they belong to different groups, sort by their group roots
      const rootCompare = this._compareSingleRows(rowA.rootRow, rowB.rootRow);
      if (rootCompare !== 0) return rootCompare;

      // Tie-breaker: use PK of the group root to ensure stability
      return rowA.rootRow.PK.localeCompare(rowB.rootRow.PK);
    });
  }

  /**
   * Compare helper for two rows (individual sort rules).
   */
  _compareSingleRows(rowA, rowB) {
    const isRowAAccount = rowA.entryType === "ACCOUNT";
    const isRowBAccount = rowB.entryType === "ACCOUNT";

    // Accounts always come before Activities
    if (isRowAAccount && !isRowBAccount) return -1;
    if (!isRowAAccount && isRowBAccount) return 1;

    // If both are Accounts, sort alphabetically by Account name/type
    if (isRowAAccount && isRowBAccount) {
      return rowA.account.localeCompare(rowB.account);
    }

    // If both are Activities (neither is an Account), sort alphabetically by prefix, then chronologically by date
    if (!isRowAAccount && !isRowBAccount) {
      const prefixCompare = rowA.prefix.localeCompare(rowB.prefix);
      if (prefixCompare !== 0) return prefixCompare;
      
      const timeA = rowA.date ? (rowA.date instanceof Date ? rowA.date.getTime() : new Date(rowA.date).getTime()) : 0;
      const timeB = rowB.date ? (rowB.date instanceof Date ? rowB.date.getTime() : new Date(rowB.date).getTime()) : 0;
      return timeA - timeB;
    }

    return 0;
  }
}
