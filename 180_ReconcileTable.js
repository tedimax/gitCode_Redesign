"use strict";

/**
 * gitCode_Redesign - ReconcileTable (Level 3/4)
 * Orchestrates the matching and reconciliation of transactions.
 * Extends Table to manage the Reconcile matrix and dispatch updates to Groups/Merged.
 */
class ReconcileTable extends Table {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
    this._mergedSourceOverride = null;
    this.withoutValidation(); // Reconcile sheets are dynamic matching scratchpads and do not require fact validation
  }

  /**
   * Fluent API: Overrides the merged ledger source for reconciliation.
   */
  withMergedSource(longName) {
    this._mergedSourceOverride = longName;
    return this;
  }



  // --- Union Find Helpers ---
  root(index, parentMap) {
    if (parentMap[index] === undefined) return index;
    if (parentMap[index] === index) return index;
    parentMap[index] = this.root(parentMap[index], parentMap);
    return parentMap[index];
  }

  union(index1, index2, parentMap) {
    const root1 = this.root(index1, parentMap);
    const root2 = this.root(index2, parentMap);
    if (root1 !== root2) {
      parentMap[root2] = root1;
    }
  }

  unifyRelatedRows(indexSet, parentMap) {
    if (indexSet.size > 1) {
      const indexArray = Array.from(indexSet);
      const baseIndex = indexArray[0];
      indexArray.slice(1).forEach(index => this.union(baseIndex, index, parentMap));
    }
  }

  /**
   * MODE 1: Recreate From Scratch
   * Extracts unreconciled transactions from Merged table, groups them, and rebuilds the Reconcile table.
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

    const sourceName = this._mergedSourceOverride || "AnnualSummaries_Merged";
    const mergedTable = getSheetInstance(sourceName);
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

  _extractUnreconciledRows(mergedTable, existingTxMap) {
    const mergedCols = mergedTable.getSymbolicOffsets();
    
    return mergedTable.getWindow()
      .map((row, offset) => ({ row, offset }))
      .filter(({ row }) => !TypeUtils.isTrue(row[mergedCols.cleared]) && row[mergedCols.pk])
      .map(({ row, offset }) => {
        const pkStr = StringUtils.sanitizeName(row[mergedCols.pk]);
        return {
          rowOffset: offset,
          PK: pkStr,
          existingTx: existingTxMap.get(pkStr) || "",
          identifiers: [row[mergedCols.pk], row[mergedCols.fk], row[mergedCols.depositId], row[mergedCols.paymentId]]
                        .map(id => StringUtils.sanitizeName(id))
                        .filter(id => id !== null),
          entryType: (StringUtils.sanitizeName(row[mergedCols.entryType]) || "").toUpperCase(),
          account: StringUtils.sanitizeName(row[mergedCols.account]) || "",
          prefix: pkStr ? pkStr.split('#')[0] : ""
        };
      });
  }

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

  _buildUnionFindGroups(unreconciledRows) {
    const parentMap = Array.from({ length: unreconciledRows.length }, (_, i) => i);
    
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
      
      if (reconcileCols.pk !== -1) outRow[reconcileCols.pk] = item.PK;
      if (reconcileCols.transaction !== -1) outRow[reconcileCols.transaction] = currentTxId;
      
      outputData.push(outRow);
    });

    return outputData;
  }

  /**
   * Restores the complex array formulas to the first data row.
   */
  restoreFormulas() {
    const formulas = {};
    const base = StringUtils.toRangeName(this.sheetName); 
    const mergedConfig = Registry.getSheetConfig("AnnualSummaries_Merged");
    const mergedSheetName = mergedConfig ? (mergedConfig.SheetName || "Merged") : "Merged";
    const mergedBase = StringUtils.toRangeName(mergedSheetName);

    // Dynamic Named Range Builders
    const rng = (col) => base + StringUtils.toRangeName(col);
    const mRng = (col) => mergedBase + StringUtils.toRangeName(col);

    // Complex BYROW/MAP logic (using dynamically calculated named ranges)
    formulas["Balanced"] = `=MAP(${rng("ActivitySum")}, ${rng("AccountSum")}, LAMBDA(activity, account, IF(AND(activity="", account=""), False, IF(AND(activity=account, activity<>0), TRUE, FALSE) ) ))`;
    formulas["ActivitySum"] = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Activity") )))`;
    formulas["AccountSum"] = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Account") ) ))`;
    formulas["TransactionFY"] = `=BYROW(${rng("Transaction")}, LAMBDA(current_transaction_id, IF(current_transaction_id="", "", LET( transaction_is_balanced, INDEX(${rng("Balanced")}, MATCH(current_transaction_id, ${rng("Transaction")}, 0)), IF(transaction_is_balanced = TRUE, MAXIFS(${rng("xFY")}, ${rng("Transaction")}, current_transaction_id, ${rng("EntryType")}, "Account"), "" ) ) ) ))`;

    // Calculate xFY dynamically based on the Date column (reconcile date) using April 1st FY start, named as the ending year of the FY
    formulas["xFY"] = `=MAP(${rng("Date")}, LAMBDA(d, IF(d="", "", YEAR(d) + IF(MONTH(d) >= 4, 1, 0) )))`;

    // Lookup formulas
    const lookupCols = ["Date", "Amount", "Customer", "Description", "Category", "Account", "EntryType", "FK", "DepositID", "PaymentID"];
    lookupCols.forEach(col => {
      // Assuming PK is in column A and we look up based on the literal PK column in Reconcile
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

  /**
   * MODE 2: Commit Balanced Groups
   * Processes the Reconcile table, extracting balanced rows and distributing updates.
   */
  processBalancedRows() {
    myLog("info", "Processing balanced rows in %s", this.longName);
    this.fetchWindow();
    
    const reconcileCols = this.getSymbolicOffsets();
    
    const rowsToDelete = [];
    const balancedTxs = []; 
    
    // 1. Identify Balanced Rows
    this.getWindow().forEach((row, offset) => {
      if (TypeUtils.isTrue(row[reconcileCols.balanced])) {
        balancedTxs.push({
          PK: String(row[reconcileCols.pk]),
          Group: row[reconcileCols.transaction],
          Cleared: true,
          FY: row[reconcileCols.transactionFY]
        });
        rowsToDelete.push(offset + this.firstDataRowIndex); 
      }
    });

    if (balancedTxs.length === 0) {
      myLog("info", "No balanced rows found to process.");
      return;
    }

    // 2. Pre-fetch all destination tables BEFORE any mutations to avoid Google Sheets recalculation blocking
    const groupsTable = getSheetInstance("AnnualSummaries_Groups");
    groupsTable.fetchWindow(); 
    
    const mergedTable = getSheetInstance("AnnualSummaries_Merged");
    mergedTable.fetchWindow();
    
    const logTable = getSheetInstance("NewAccounts_ReconcileLog");
    logTable.fetchWindow(); // May be empty, but safely initialized

    // 3. Remap Local Transactions to Global Groups
    const groupCols = groupsTable.getSymbolicOffsets();
    const existingGroupIds = groupsTable.getWindow().map(row => {
       return groupCols.group !== -1 ? Number(row[groupCols.group]) : 0;
    }).filter(n => !isNaN(n));
    
    let nextGlobalGroupId = existingGroupIds.length > 0 ? Math.max(...existingGroupIds) + 1 : 1;
    const localToGlobalTxMap = new Map();

    const groupsNewData = [];
    const logNewData = [];
    
    const mergedCols = mergedTable.getSymbolicOffsets();

    balancedTxs.forEach(tx => {
      // Map global group ID
      if (!localToGlobalTxMap.has(tx.Group)) {
         localToGlobalTxMap.set(tx.Group, nextGlobalGroupId++);
      }
      tx.GlobalGroupID = localToGlobalTxMap.get(tx.Group);

      // A. Stage data for NewGroups
      const gRow = new Array(groupsTable.getLabels().length).fill("");
      
      if(groupCols.pk !== -1) gRow[groupCols.pk] = tx.PK;
      if(groupCols.group !== -1) gRow[groupCols.group] = tx.GlobalGroupID;
      if(groupCols.cleared !== -1) gRow[groupCols.cleared] = tx.Cleared;
      if(groupCols.fy !== -1) gRow[groupCols.fy] = tx.FY;
      
      groupsNewData.push(gRow);

      // B. Update Merged Table (Physical Set)
      const cleanPk = StringUtils.sanitizeName(tx.PK);
      const mRowOff = mergedTable.getRowOffset(cleanPk);

      if (mRowOff !== undefined) {
         const pRow = mRowOff + mergedTable.firstDataRowIndex;
         if (mergedCols.cleared !== -1) mergedTable.sheet.getRange(pRow, mergedCols.cleared + 1).setValue(true);
         if (mergedCols.group !== -1) mergedTable.sheet.getRange(pRow, mergedCols.group + 1).setValue(tx.GlobalGroupID);
      }

      // C. Stage data for ReconcileLog
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (prefixMatch) {
        const prefix = prefixMatch[1];
        const ledgerName = this._getLedgerNameFromPrefix(prefix);
        if (ledgerName) {
          const logCols = logTable.getSymbolicOffsets();
          const logRow = new Array(logTable.getLabels().length).fill("");
          
          if(logCols.sheetName !== -1) logRow[logCols.sheetName] = ledgerName;
          if(logCols.transactionId !== -1) logRow[logCols.transactionId] = tx.PK;
          if(logCols.groupId !== -1) logRow[logCols.groupId] = tx.GlobalGroupID;
          if(logCols.clearStatus !== -1) logRow[logCols.clearStatus] = true;
          
          logNewData.push(logRow);
        }
      }
    });

    // 4. Commit all staged data physically
    if (typeof groupsTable.commit === "function") {
      groupsTable.commit(groupsNewData, "add");
    }
    
    if (logNewData.length > 0) {
      if (typeof logTable.commit === "function") {
        logTable.commit(logNewData, "add");
      } else {
        throw new Error(`CRITICAL CONFIG ERROR: NewAccounts_ReconcileLog must be configured as an UpdateTable in the Registry to commit ${logNewData.length} logs.`);
      }
    } else {
      myLog("warn", "No rows staged for ReconcileLog. ColLabels length: %d", logTable.getLabels().length);
    }

    // 4. Clear Rows from Reconcile (clearing preserves named ranges without triggering massive recalculations)
    // Using RangeList batches all row clears into a single lightning-fast API call
    const lastCol = this.sheet.getLastColumn();
    let colLetter = "";
    let tempCol = lastCol;
    while (tempCol > 0) {
      let modulo = (tempCol - 1) % 26;
      colLetter = String.fromCharCode(modulo + 65) + colLetter;
      tempCol = (tempCol - modulo - 1) / 26;
    }
    
    const a1Notations = rowsToDelete.map(r => `A${r}:${colLetter}${r}`);
    if (a1Notations.length > 0) {
      this.sheet.getRangeList(a1Notations).clearContent();
    }

    // 5. Ensure Formulas Survive
    this.restoreFormulas();
    
    myLog("info", "Processed %d balanced rows successfully.", balancedTxs.length);
  }

  _getLedgerNameFromPrefix(prefix) {
    let targetLongName = null;
    const mergeSheetsRaw = globals.sheetsObj.lookupValue("LongName", "SourceSheets", "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "SourceSheet", "AnnualSummaries_Merged")
                       || globals.sheetsObj.lookupValue("LongName", "MergeSheets", "AnnualSummaries_Merged");
    if (!mergeSheetsRaw) return prefix; 
    
    const mergeSheets = String(mergeSheetsRaw).split(",").map(s => s.trim());
    
    const sheetCols = globals.sheetsObj.getSymbolicOffsets();
    
    globals.sheetsObj.getWindow().forEach(row => {
       const name = row[sheetCols.longName];
       const prefs = String(row[sheetCols.keyPrefix] || "").split(",").map(p => p.trim());
       if (prefs.includes(prefix) && mergeSheets.includes(name)) {
         targetLongName = name;
       }
    });
    
    return targetLongName || prefix;
  }
}

// Register with globals
globals.tableMap['ReconcileTable'] = ReconcileTable;
