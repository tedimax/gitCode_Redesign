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

    if (targetYearStr && yearStr === targetYearStr) {
      this._auditedGroups = new Set();
    }

    Array.from(globalAccountMeta.keys()).sort().forEach(acc => {
      const accountMeta = globalAccountMeta.get(acc);
      if (!accountMeta.isValidAsset) return;

      const accFacts = state.accounts.get(acc) || { ledgerNet: 0, balCurrent: null };
      const balPrev = prevBalances.get(acc) || 0;
      const balCurrent = accFacts.balCurrent !== null ? accFacts.balCurrent : balPrev;
      
      closingBalances.set(acc, balCurrent);

      const bankChange = balCurrent - balPrev;
      const discrepancy = accFacts.ledgerNet - bankChange;
      const isOK = Math.abs(discrepancy) < CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD;

      if (!isOK) {
        if (targetYearStr && yearStr === targetYearStr) {
          myLog("warn", `Account "${acc}" in FY${yearStr} is unbalanced by £${discrepancy.toFixed(2)}. (balCurrent: £${balCurrent.toFixed(2)}, balPrev: £${balPrev.toFixed(2)}, bankChange: £${bankChange.toFixed(2)}, ledgerNet: £${accFacts.ledgerNet.toFixed(2)}). Auditing reconciled groups...`);
          
          if (typeof AuditUtils !== 'undefined') {
            AuditUtils.auditAccountBalance(acc, balPrev, balCurrent, bankChange, accFacts.ledgerNet, yearStr);
          }

          let hasAuditOutput = false;

          // Helper: format a raw date value for readable log output
          const _fmtDate = (d) => {
            if (!d) return "(no date)";
            if (d instanceof Date || (typeof d === "object" && typeof d.getTime === "function")) {
              return d.toLocaleDateString("en-GB");
            }
            const s = String(d);
            // Trim ISO datetime to date portion only
            return s.length > 10 && s[10] === "T" ? s.substring(0, 10) : s;
          };

          // Audit 1: Reconciled groups — filtered to rows touching this account
          if (state.groups) {
            state.groups.forEach((g, groupKey) => {
              // Recalculate per-account sums from rows tagged with this account
              const accActivity = g.rows.filter(r => r.account === acc && r.type === "ACTIVITY");
              const accAccount  = g.rows.filter(r => r.account === acc && r.type === "ACCOUNT");
              const accActSum   = accActivity.reduce((s, r) => s + r.amount, 0);
              const accAccSum   = accAccount.reduce((s, r) => s + r.amount, 0);
              const diff = accActSum - accAccSum;
              // Only flag if this group has rows for this account AND they are unbalanced
              if ((accActivity.length > 0 || accAccount.length > 0) && Math.abs(diff) >= CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD) {
                hasAuditOutput = true;
                myLog("error", `AUDIT FAILURE: Reconciled Group ${groupKey} for account "${acc}" is UNBALANCED by £${diff.toFixed(2)}.`);
                myLog("error", `  Activity Sum: £${accActSum.toFixed(2)}, Account Sum: £${accAccSum.toFixed(2)}`);
                g.rows.filter(r => r.account === acc).forEach(r => {
                  myLog("error", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${_fmtDate(r.date)}, Amount: £${r.amount}, Desc: ${r.desc}`);
                });

                if (typeof AuditUtils !== 'undefined') {
                  if (!this._auditedGroups.has(groupKey)) {
                    this._auditedGroups.add(groupKey);
                    AuditUtils.auditGroupReconciliation(groupKey, g, yearStr);
                  }
                }
              }
            });
          }

          // Audit 2: Cleared entries with no Group ID
          if (state.ungroupedCleared) {
            const ungroupedForAcc = state.ungroupedCleared.filter(r => r.account === acc);
            if (ungroupedForAcc.length > 0) {
              hasAuditOutput = true;
              myLog("error", `AUDIT FAILURE: Found ${ungroupedForAcc.length} cleared entries with NO Group ID for account "${acc}":`);
              ungroupedForAcc.forEach(r => {
                myLog("error", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${_fmtDate(r.date)}, Amount: £${r.amount}, Desc: ${r.desc}`);
              });
            }
          }

          // Audit 3: Uncleared entries
          if (state.unclearedEntries) {
            const unclearedForAcc = state.unclearedEntries.filter(r => r.account === acc);
            if (unclearedForAcc.length > 0) {
              hasAuditOutput = true;
              myLog("warn", `AUDIT INFO: Found ${unclearedForAcc.length} uncleared ACTIVITY entries in ledger for account "${acc}" (not counted in ledgerNet):`);
              unclearedForAcc.forEach(r => {
                myLog("warn", `    - [Row ${r.rowNum}] [${r.type}] PK: ${r.pk}, Date: ${_fmtDate(r.date)}, Amount: £${r.amount}, Desc: ${r.desc}`);
              });
            }
          }

          // Audit 4: ledgerNet breakdown — list every ACTIVITY row contributing to this account's net
          if (state.groups) {
            let activityTotal = 0;
            let activityCount = 0;
            state.groups.forEach((g) => {
              g.rows.filter(r => r.account === acc && r.type === "ACTIVITY").forEach(r => {
                activityTotal += r.amount;
                activityCount++;
              });
            });
            if (state.ungroupedCleared) {
              state.ungroupedCleared.filter(r => r.account === acc && r.type === "ACTIVITY").forEach(r => {
                activityTotal += r.amount;
                activityCount++;
              });
            }
            myLog("warn", `AUDIT DETAIL: Tracked ${activityCount} cleared ACTIVITY rows for "${acc}" totalling £${activityTotal.toFixed(2)} (ledgerNet includes ALL activity: cleared + uncleared).`);
          }

          if (!hasAuditOutput) {
            myLog("warn", `AUDIT: All groups and cleared transactions balance, and no uncleared transactions found for "${acc}". Please check the ending and starting balance snapshots.`);
          }
        }
      }

      totalAccountsBalance += balCurrent;
      totalLedgerNet += accFacts.ledgerNet;
      totalBankChange += bankChange;

      if (Math.abs(balCurrent) < CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD && isOK) return;

      accountsArray.push({
        name: acc,
        status: isOK ? "" : "Unbalanced",
        diff: isOK ? "" : Math.abs(discrepancy),
        diffStyle: isOK ? null : (discrepancy > 0 ? "blackFont" : "redFont"),
        balance: balCurrent
      });
    });

    const totalDiff = totalLedgerNet - totalBankChange;
    const isBalanced = Math.abs(totalDiff) < CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD;

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

    if (Math.abs(totalAccountsBalance) < CONFIG_CONSTANTS.FUZZY_BALANCE_THRESHOLD) {
      totalAccountsBalance = 0;
    }

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
