"use strict";

/**
 * gitCode_Redesign - AnnualReporter
 * The "Analysis Engine" for annual reporting.
 * Responsible for transforming raw facts into structured report objects.
 */
class AnnualReporter {
  constructor(config = {}) {
    this.config = Object.assign({
      DISPLAY_LABELS: { "SOCIAL": "Social Events", "GENERAL": "General", "TRANSFERS": "Transfers" }
    }, config);
  }

  /**
   * Finalizes a single year's report structure with carry-overs.
   */
  getYearlyReport(facts, targetYear, prevBalances = new Map()) {
    const { yearlyData, globalAccountMeta } = facts;
    const years = Array.from(yearlyData.keys()).sort((a, b) => Number(a) - Number(b));
    const targetYearStr = String(targetYear);

    // We must process all years leading up to the target to ensure correct carry-overs
    const result = years.reduce((acc, yearStr) => {
      const report = this._finalizeYear(yearStr, yearlyData, globalAccountMeta, acc.balances, targetYearStr);
      if (yearStr === targetYearStr) acc.targetReport = report;
      acc.balances = report.closingBalances;
      return acc;
    }, { targetReport: null, balances: prevBalances });

    return result.targetReport;
  }

  /**
   * Returns a chronological list of finalized reports.
   */
  getLongitudinalReport(facts) {
    const { yearlyData, globalAccountMeta } = facts;
    const years = Array.from(yearlyData.keys()).sort((a, b) => Number(a) - Number(b));

    const result = years.reduce((acc, yearStr) => {
      const report = this._finalizeYear(yearStr, yearlyData, globalAccountMeta, acc.balances);
      acc.list.push(report);
      acc.balances = report.closingBalances;
      return acc;
    }, { list: [], balances: new Map() });

    return result.list;
  }

  /**
   * Internal pass to finalize the math for a specific year.
   */
  _finalizeYear(yearStr, yearlyDataMap, globalAccountMeta, prevBalances, targetYearStr) {
    const state = yearlyDataMap.get(yearStr);
    const closingBalances = new Map();
    const accountsArray = [];
    
    let totalAccountsBalance = 0;
    let totalLedgerNet = 0;
    let totalBankChange = 0;

    Array.from(globalAccountMeta.keys()).sort().forEach(acc => {
      const accountMeta = globalAccountMeta.get(acc);
      if (!accountMeta.isValidAsset) return;

      const accFacts = state.accounts.get(acc) || { ledgerNet: 0, balCurrent: null };
      const balPrev = prevBalances.get(acc) || 0;
      const balCurrent = accFacts.balCurrent !== null ? accFacts.balCurrent : balPrev;
      
      closingBalances.set(acc, balCurrent);

      const bankChange = balCurrent - balPrev;
      const discrepancy = accFacts.ledgerNet - bankChange;
      const isOK = Math.abs(discrepancy) < 0.01;

      if (!isOK) {
        if (targetYearStr && yearStr === targetYearStr) {
          myLog("warn", `Account "${acc}" in FY${yearStr} is unbalanced by £${discrepancy.toFixed(2)}. (balCurrent: £${balCurrent.toFixed(2)}, balPrev: £${balPrev.toFixed(2)}, bankChange: £${bankChange.toFixed(2)}, ledgerNet: £${accFacts.ledgerNet.toFixed(2)}). Auditing reconciled groups...`);
          
          let hasAuditOutput = false;

          if (state.groups) {
            state.groups.forEach((g, groupKey) => {
              const diff = g.activitySum - g.accountSum;
              if (Math.abs(diff) >= 0.01) {
                hasAuditOutput = true;
                myLog("error", `AUDIT FAILURE: Reconciled Group ${groupKey} for account "${acc}" is UNBALANCED by £${diff.toFixed(2)}.`);
                myLog("error", `  Activity Sum: £${g.activitySum.toFixed(2)}, Account Sum: £${g.accountSum.toFixed(2)}`);
                g.rows.forEach(r => {
                  myLog("error", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${r.date}, Amount: ${r.amount}, Desc: ${r.desc}`);
                });
              }
            });
          }

          if (state.ungroupedCleared) {
            const ungroupedForAcc = state.ungroupedCleared.filter(r => r.account === acc);
            if (ungroupedForAcc.length > 0) {
              hasAuditOutput = true;
              myLog("error", `AUDIT FAILURE: Found ${ungroupedForAcc.length} cleared entries with NO Group ID for account "${acc}":`);
              ungroupedForAcc.forEach(r => {
                myLog("error", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${r.date}, Amount: ${r.amount}, Desc: ${r.desc}`);
              });
            }
          }

          if (state.unclearedEntries) {
            const unclearedForAcc = state.unclearedEntries.filter(r => r.account === acc);
            if (unclearedForAcc.length > 0) {
              hasAuditOutput = true;
              myLog("error", `AUDIT INFO: Found ${unclearedForAcc.length} uncleared entries in ledger for account "${acc}":`);
              unclearedForAcc.forEach(r => {
                myLog("error", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${r.date}, Amount: ${r.amount}, Desc: ${r.desc}`);
              });
            }
          }

          if (!hasAuditOutput) {
            myLog("warn", `AUDIT: All groups and cleared transactions balance, and no uncleared transactions found for "${acc}". Please check the ending and starting balance snapshots.`);
          }
        }
      }

      totalAccountsBalance += balCurrent;
      totalLedgerNet += accFacts.ledgerNet;
      totalBankChange += bankChange;

      if (Math.abs(balCurrent) < 0.01 && Math.abs(accFacts.ledgerNet) < 0.01) return;

      accountsArray.push({
        name: acc,
        status: isOK ? "" : "Unbalanced",
        diff: isOK ? "" : Math.abs(discrepancy),
        diffStyle: isOK ? null : (discrepancy > 0 ? "blackFont" : "redFont"),
        balance: balCurrent
      });
    });

    const totalDiff = totalLedgerNet - totalBankChange;
    const isBalanced = Math.abs(totalDiff) < 0.01;

    const orderedGroups = Object.keys(state.categoryGroupStats).sort((a, b) => {
      const A = a.toUpperCase(), B = b.toUpperCase();
      if (A === "SOCIAL") return -1;
      if (B === "SOCIAL") return 1;
      if (A === "TRANSFERS") return 1;
      if (B === "TRANSFERS") return -1;
      return a.localeCompare(b);
    });

    const groupsArray = orderedGroups.map(groupKey => {
      const s = state.categoryGroupStats[groupKey];
      return {
        groupLabel: this.config.DISPLAY_LABELS[groupKey.toUpperCase()] || groupKey,
        groupIn: s.in, groupOut: s.out, groupNet: s.net,
        categories: Object.values(s.categories).sort((a,b) => a.name.localeCompare(b.name))
      };
    });

    return {
      year: yearStr,
      assets: { status: isBalanced ? "" : "Unbalanced", diff: isBalanced ? "" : Math.abs(totalDiff), total: totalAccountsBalance },
      accounts: accountsArray,
      totals: state.totals,
      categoryGroups: groupsArray,
      ghosts: state.ghosts,
      closingBalances: closingBalances
    };
  }
}
