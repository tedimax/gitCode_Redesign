"use strict";

/**
 * gitCode_Redesign - Audit Logger
 * Accumulates transformation and execution errors and flushes them to a physical sheet.
 */
const AuditUtils = (() => {
  let errorQueue = [];

  let groupsExpectedMap = null;

  /**
   * Logs an error to the internal queue.
   * @param {string} targetName - The LongName of the table being processed.
   * @param {number|string} sourceRow - The row number or identifier where the error occurred.
   * @param {string} field - The target column that failed to compute.
   * @param {string} message - The actual error message.
   * @param {string} formula - The formula that caused the error.
   * @param {string} pk - Optional primary key associated with the error.
   */
  const logError = (targetName, sourceRow, field, message, formula = "", pk = "") => {
    errorQueue.push([
      Temporal.Now.instant().toString(),
      targetName,
      sourceRow,
      field,
      message,
      formula,
      pk
    ]);
  };

  /**
   * Internal helper to load and index expected mappings from Reconciliation_Groups.
   */
  const _loadGroupsExpectedMap = () => {
    if (groupsExpectedMap) return groupsExpectedMap;
    groupsExpectedMap = new Map();
    
    const groupsTable = getSheetInstance("Reconciliation_Groups");
    if (!groupsTable) {
      myLog("warn", "AuditUtils: Reconciliation_Groups table not found. Cannot perform expected groups audit.");
      return groupsExpectedMap;
    }

    try {
      groupsTable.fetch(groupsTable.firstDataRowIndex);
      const rows = groupsTable.getWindow();
      const pkCol = groupsTable.column.pk;
      const groupCol = groupsTable.column.group;

      if (pkCol !== undefined && groupCol !== undefined) {
        const amountCol = groupsTable.column.amount;
        const accountCol = groupsTable.column.account;
        const typeCol = groupsTable.column.type !== undefined ? groupsTable.column.type : groupsTable.column.entrytype;
        const dateCol = groupsTable.column.date;
        const descCol = groupsTable.column.description !== undefined ? groupsTable.column.description : groupsTable.column.desc;

        rows.forEach(row => {
          const groupVal = row[groupCol];
          const gKey = groupVal !== undefined && groupVal !== null && groupVal !== "" ? String(groupVal).trim() : null;
          if (!gKey || Number(gKey) === 0) return;

          if (!groupsExpectedMap.has(gKey)) {
            groupsExpectedMap.set(gKey, new Map());
          }

          const pk = String(row[pkCol] || "").trim();
          if (!pk) return;

          groupsExpectedMap.get(gKey).set(pk, {
            pk: pk,
            amount: amountCol !== -1 ? Number(row[amountCol] || 0) : 0,
            account: accountCol !== -1 ? String(row[accountCol] || "").trim() : "",
            type: typeCol !== -1 ? String(row[typeCol] || "").trim().toUpperCase() : "",
            date: dateCol !== -1 ? row[dateCol] : null,
            desc: descCol !== -1 ? String(row[descCol] || "").trim() : ""
          });
        });
      }
    } catch (e) {
      myLog("error", "AuditUtils: Failed to load expected group map: %s", e.message);
    }
    return groupsExpectedMap;
  };

  /**
   * Service routine to audit and log account imbalance.
   */
  const auditAccountBalance = (acc, balPrev, balCurrent, bankChange, ledgerNet, yearStr) => {
    if (!globals.enableAuditAnalysis) return;

    const discrepancy = ledgerNet - bankChange;
    const targetName = "AnnualSummaries_" + yearStr;
    const message = `Account "${acc}" is unbalanced. Start Bal: £${balPrev.toFixed(2)}, End Bal: £${balCurrent.toFixed(2)}, Net Change: £${bankChange.toFixed(2)}, Ledger Sum: £${ledgerNet.toFixed(2)} (Diff: £${discrepancy.toFixed(2)}).`;
    
    logError(targetName, acc, "Account Balance", message);
  };

  /**
   * Service routine to audit and log group reconciliation discrepancies.
   */
  const auditGroupReconciliation = (groupKey, g, yearStr) => {
    if (!globals.enableAuditAnalysis) return;

    const targetName = "AnnualSummaries_" + yearStr;
    const expectedMap = _loadGroupsExpectedMap();
    const expectedTxs = expectedMap.get(groupKey) || new Map();

    const actualTxs = new Map();
    g.rows.forEach(r => {
      actualTxs.set(r.pk, r);
    });

    const missingInLedger = [];
    const extraInLedger = [];
    const amountMismatches = [];

    expectedTxs.forEach((expVal, pk) => {
      if (!actualTxs.has(pk)) {
        missingInLedger.push(expVal);
      } else {
        const actVal = actualTxs.get(pk);
        if (Math.abs(expVal.amount - actVal.amount) >= CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD) {
          amountMismatches.push({ pk, expected: expVal.amount, actual: actVal.amount });
        }
      }
    });

    actualTxs.forEach((actVal, pk) => {
      if (!expectedTxs.has(pk)) {
        extraInLedger.push(actVal);
      }
    });

    // Log the mismatches to syncAudit
    missingInLedger.forEach(item => {
      const msg = `Group "${groupKey}" imbalance: Missing ledger transaction. PK: "${item.pk}" (Expected Amount: £${item.amount.toFixed(2)}, Account: "${item.account}").`;
      logError(targetName, "Group " + groupKey, "Group Reconciliation", msg);
    });

    extraInLedger.forEach(item => {
      const msg = `Group "${groupKey}" imbalance: Extra ledger transaction. PK: "${item.pk}" (Amount: £${item.amount.toFixed(2)}, Account: "${item.account}", Type: "${item.type}").`;
      logError(targetName, "Group " + groupKey, "Group Reconciliation", msg);
    });

    amountMismatches.forEach(item => {
      const msg = `Group "${groupKey}" imbalance: Amount mismatch for PK "${item.pk}". Groups sheet expected £${item.expected.toFixed(2)}, but ledger has £${item.actual.toFixed(2)}.`;
      logError(targetName, "Group " + groupKey, "Group Reconciliation", msg);
    });

    // Verify if the expected values in the Groups sheet itself are unbalanced
    let expectedActivitySum = 0;
    let expectedAccountSum = 0;
    expectedTxs.forEach(item => {
      if (item.type === "ACTIVITY") expectedActivitySum += item.amount;
      else if (item.type === "ACCOUNT") expectedAccountSum += item.amount;
    });
    const expectedDiff = expectedActivitySum - expectedAccountSum;
    if (Math.abs(expectedDiff) >= CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD) {
      const msg = `Group "${groupKey}" expected values in Groups sheet are unbalanced by £${expectedDiff.toFixed(2)} (Activity Sum: £${expectedActivitySum.toFixed(2)}, Account Sum: £${expectedAccountSum.toFixed(2)}).`;
      logError(targetName, "Group " + groupKey, "Group Reconciliation", msg);
    }
  };

  /**
   * Flushes the accumulated errors to the specified audit table.
   * Clears the queue after writing.
   */
  const flush = (auditTableLongName = "NewAccounts_SyncAudit") => {
    groupsExpectedMap = null; // Clear lookup cache on flush
    if (errorQueue.length === 0) return;

    try {
      const auditTable = getSheetInstance(auditTableLongName);
      if (!auditTable) {
        throw new Error(`Audit Logging Failure: Audit table '${auditTableLongName}' not found in registry. Cannot discard ${errorQueue.length} errors silently.`);
      }

      const startRow = auditTable.getLastRowIndex() + 1;
      const safeStartRow = Math.max(startRow, auditTable.firstDataRowIndex || 2);
      
      auditTable.writeBlock(safeStartRow, errorQueue);
      
      // Flush sheet changes so it's physically visible
      SpreadsheetApp.flush();
      
      myLog("info", "Flushed %d errors to Audit log (%s).", errorQueue.length, auditTableLongName);
      errorQueue = []; // Clear queue on success
    } catch (e) {
      myLog("error", "Failed to write to Audit Log: %s", e.message);
    }
  };

  return {
    logError,
    auditAccountBalance,
    auditGroupReconciliation,
    flush
  };
})();
