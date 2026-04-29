"use strict";

/**
 * gitCode_Redesign - ReconcileTable (Level 3/4)
 * Orchestrates the matching and reconciliation of transactions.
 * Extends Table to manage the Reconcile matrix and dispatch updates to Groups/Merged.
 */
class ReconcileTable extends Table {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
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
    const existingTxMap = new Map();
    const pkOff = this.getColOffset("PK");
    const txOff = this.getColOffset("Transaction");
    if (pkOff !== -1 && txOff !== -1) {
      this.getWindow().forEach(row => {
        const pk = String(row[pkOff]).trim();
        const tx = String(row[txOff]).trim();
        if (pk && tx) existingTxMap.set(pk, tx);
      });
    }

    const mergedTable = getSheetInstance("AnnualSummaries_NewMerged");
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
    const clearedCol = mergedTable.getColOffset("Cleared");
    const pkCol = mergedTable.getColOffset("PK");
    const fkCol = mergedTable.getColOffset("FK");
    const depCol = mergedTable.getColOffset("DepositID");
    const payCol = mergedTable.getColOffset("PaymentID");
    const entryTypeCol = mergedTable.getColOffset("EntryType");
    const accountCol = mergedTable.getColOffset("Account");
    
    return mergedTable.getWindow()
      .map((row, offset) => ({ row, offset }))
      .filter(({ row }) => !row[clearedCol] && row[pkCol])
      .map(({ row, offset }) => {
        const pkStr = String(row[pkCol]).trim();
        return {
          rowOffset: offset,
          PK: pkStr,
          existingTx: existingTxMap.get(pkStr) || "",
          identifiers: [row[pkCol], row[fkCol], row[depCol], row[payCol]]
                        .filter(val => val !== undefined && val !== null && String(val).trim() !== ""),
          entryType: entryTypeCol !== -1 ? String(row[entryTypeCol] || "").trim() : "",
          account: accountCol !== -1 ? String(row[accountCol] || "").trim() : "",
          prefix: pkStr.split('#')[0]
        };
      });
  }

  _sortUnreconciledRows(unreconciledRows) {
    return unreconciledRows.sort((rowA, rowB) => {
      const isRowAAccount = rowA.entryType.toLowerCase() === "account";
      const isRowBAccount = rowB.entryType.toLowerCase() === "account";
      
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
        const cleanId = String(id).trim();
        if (!idToRowMap.has(cleanId)) idToRowMap.set(cleanId, new Set());
        idToRowMap.get(cleanId).add(index);
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
      
      const outRow = new Array(this.getColLabels().length).fill("");
      const pkOutOff = this.getColOffset("PK");
      const txOutOff = this.getColOffset("Transaction");
      
      if (pkOutOff !== -1) outRow[pkOutOff] = item.PK;
      if (txOutOff !== -1) outRow[txOutOff] = currentTxId;
      
      outputData.push(outRow);
    });

    return outputData;
  }

  /**
   * Restores the complex array formulas to the first data row.
   */
  restoreFormulas() {
    const formulas = {};
    const base = StringUtils.toRangeName(this.longName); 
    const mergedBase = StringUtils.toRangeName("AnnualSummaries_NewMerged");

    // Dynamic Named Range Builders
    const rng = (col) => base + StringUtils.toRangeName(col);
    const mRng = (col) => mergedBase + StringUtils.toRangeName(col);

    // Complex BYROW/MAP logic (using dynamically calculated named ranges)
    formulas["Balanced"] = `=MAP(${rng("ActivitySum")}, ${rng("AccountSum")}, LAMBDA(activity, account, IF(AND(activity="", account=""), False, IF(AND(activity=account, activity<>0), TRUE, FALSE) ) ))`;
    formulas["ActivitySum"] = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Activity") )))`;
    formulas["AccountSum"] = `=BYROW(${rng("Transaction")}, LAMBDA(transaction_id,  IF(transaction_id="", "", SUMIFS(${rng("Amount")}, ${rng("Transaction")}, transaction_id, ${rng("EntryType")}, "Account") ) ))`;
    formulas["TransactionFY"] = `=BYROW(${rng("Transaction")}, LAMBDA(current_transaction_id, IF(current_transaction_id="", "", LET( transaction_is_balanced, INDEX(${rng("Balanced")}, MATCH(current_transaction_id, ${rng("Transaction")}, 0)), IF(transaction_is_balanced = TRUE, MAXIFS(${rng("xFY")}, ${rng("Transaction")}, current_transaction_id, ${rng("EntryType")}, "Account"), "" ) ) ) ))`;

    // Lookup formulas
    const lookupCols = ["xFY", "Date", "Amount", "Customer", "Description", "Category", "Account", "EntryType", "FK", "DepositID", "PaymentID"];
    lookupCols.forEach(col => {
      // Assuming PK is in column A and we look up based on the literal PK column in Reconcile
      formulas[col] = `=ARRAYFORMULA(IF(${rng("PK")}="","",VLOOKUP(${rng("PK")}, {${mRng("PK")}, ${mRng(col)}}, 2, 0)))`;
    });

    const labels = this.getColLabels();
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
    
    const pkOff = this.getColOffset("PK");
    const txOff = this.getColOffset("Transaction");
    const balOff = this.getColOffset("Balanced");
    const fyOff = this.getColOffset("TransactionFY");
    
    const rowsToDelete = [];
    const balancedTxs = []; 
    
    // 1. Identify Balanced Rows
    this.getWindow().forEach((row, offset) => {
      if (String(row[balOff]).toUpperCase() === "TRUE") {
        balancedTxs.push({
          PK: String(row[pkOff]),
          Group: row[txOff],
          Cleared: true,
          FY: row[fyOff]
        });
        rowsToDelete.push(offset + this.firstDataRowIndex); 
      }
    });

    if (balancedTxs.length === 0) {
      myLog("info", "No balanced rows found to process.");
      return;
    }

    // 2. Pre-fetch all destination tables BEFORE any mutations to avoid Google Sheets recalculation blocking
    const groupsTable = getSheetInstance("AnnualSummaries_NewGroups");
    groupsTable.fetchWindow(); 
    
    const mergedTable = getSheetInstance("AnnualSummaries_NewMerged");
    mergedTable.fetchWindow();
    
    const logTable = getSheetInstance("NewAccounts_ReconcileLog");
    logTable.fetchWindow(); // May be empty, but safely initialized

    // 3. Remap Local Transactions to Global Groups
    const existingGroupIds = groupsTable.getWindow().map(row => {
       const gOff = groupsTable.getColOffset("Group");
       return gOff !== -1 ? Number(row[gOff]) : 0;
    }).filter(n => !isNaN(n));
    
    let nextGlobalGroupId = existingGroupIds.length > 0 ? Math.max(...existingGroupIds) + 1 : 1;
    const localToGlobalTxMap = new Map();

    if (!groupsTable._newData) groupsTable._newData = [];
    if (!logTable._newData) logTable._newData = [];
    
    const mPkOff = mergedTable.getColOffset("PK");
    const mClrOff = mergedTable.getColOffset("Cleared");
    const mGrpOff = mergedTable.getColOffset("Group");

    balancedTxs.forEach(tx => {
      // Map global group ID
      if (!localToGlobalTxMap.has(tx.Group)) {
         localToGlobalTxMap.set(tx.Group, nextGlobalGroupId++);
      }
      tx.GlobalGroupID = localToGlobalTxMap.get(tx.Group);

      // A. Stage data for NewGroups
      const gRow = new Array(groupsTable.getColLabels().length).fill("");
      const gPkOff = groupsTable.getColOffset("PK");
      const gGrpOff = groupsTable.getColOffset("Group");
      const gClrOff = groupsTable.getColOffset("Cleared");
      const gFyOff = groupsTable.getColOffset("FY");
      
      if(gPkOff !== -1) gRow[gPkOff] = tx.PK;
      if(gGrpOff !== -1) gRow[gGrpOff] = tx.GlobalGroupID;
      if(gClrOff !== -1) gRow[gClrOff] = tx.Cleared;
      if(gFyOff !== -1) gRow[gFyOff] = tx.FY;
      
      groupsTable._newData.push(gRow);

      // B. Update Merged Table (Physical Set)
      const cleanPk = String(tx.PK).trim();
      const mRowOff = mergedTable.getRowOffsetByKey(cleanPk);

      if (mRowOff !== undefined) {
         const pRow = mRowOff + mergedTable.firstDataRowIndex;
         if (mClrOff !== -1) mergedTable.sheet.getRange(pRow, mClrOff + 1).setValue(true);
         if (mGrpOff !== -1) mergedTable.sheet.getRange(pRow, mGrpOff + 1).setValue(tx.GlobalGroupID);
      }

      // C. Stage data for ReconcileLog
      const prefixMatch = tx.PK.match(/^([^#]+)#/);
      if (prefixMatch) {
        const prefix = prefixMatch[1];
        const ledgerName = this._getLedgerNameFromPrefix(prefix);
        if (ledgerName) {
          const logRow = new Array(logTable.getColLabels().length).fill("");
          const logSheetOff = logTable.getColOffset("SheetName");
          const logTxOff = logTable.getColOffset("TransactionId");
          const logGrpOff = logTable.getColOffset("GroupId");
          const logClrOff = logTable.getColOffset("ClearStatus");
          
          if(logSheetOff !== -1) logRow[logSheetOff] = ledgerName;
          else if(logTable.getColOffset("Sheet") !== -1) logRow[logTable.getColOffset("Sheet")] = ledgerName;
          
          if(logTxOff !== -1) logRow[logTxOff] = tx.PK;
          else if(logTable.getColOffset("TransactionID") !== -1) logRow[logTable.getColOffset("TransactionID")] = tx.PK;
          
          if(logGrpOff !== -1) logRow[logGrpOff] = tx.GlobalGroupID;
          else if(logTable.getColOffset("GroupID") !== -1) logRow[logTable.getColOffset("GroupID")] = tx.GlobalGroupID;
          
          if(logClrOff !== -1) logRow[logClrOff] = true;
          else if(logTable.getColOffset("Cleared") !== -1) logRow[logTable.getColOffset("Cleared")] = true;
          
          logTable._newData.push(logRow);
        }
      }
    });

    // 4. Commit all staged data physically
    if (typeof groupsTable.commit === "function") {
      groupsTable.commit("add");
    }
    
    if (logTable._newData.length > 0) {
      if (typeof logTable.commit === "function") {
        logTable.commit("add");
      } else {
        throw new Error(`CRITICAL CONFIG ERROR: NewAccounts_ReconcileLog must be configured as an UpdateTable in the Registry to commit ${logTable._newData.length} logs.`);
      }
    } else {
      myLog("warn", "No rows staged for ReconcileLog. ColLabels length: %d", logTable.getColLabels().length);
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
    const mergeSheetsRaw = globals.sheetsObj.lookupValue("LongName", "MergeSheets", "AnnualSummaries_NewMerged");
    if (!mergeSheetsRaw) return prefix; 
    
    const mergeSheets = String(mergeSheetsRaw).split(",").map(s => s.trim());
    
    const longNameOff = globals.sheetsObj.getColOffset("LongName");
    const prefixOff = globals.sheetsObj.getColOffset("KeyPrefix");
    
    globals.sheetsObj.getWindow().forEach(row => {
       const name = row[longNameOff];
       const prefs = String(row[prefixOff] || "").split(",").map(p => p.trim());
       if (prefs.includes(prefix) && mergeSheets.includes(name)) {
         targetLongName = name;
       }
    });
    
    return targetLongName || prefix;
  }
}

// Register with globals
globals.tableMap['ReconcileTable'] = ReconcileTable;
