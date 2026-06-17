"use strict";

/**
 * gitCode_Redesign - AnnualLedger
 * The "Fact Engine" for annual reporting.
 * Responsible for single-scan longitudinal ingestion and fact caching.
 * Pattern: Lazy-Loading Getters (hides data initialization behind method calls).
 */
class AnnualLedger {
  constructor(sourceTable, namesTable) {
    this.sourceTable = sourceTable;
    this.namesTable = namesTable;
    
    this.sourceCols = sourceTable ? sourceTable.getSymbolicOffsets() : {};
    this.nameCols = namesTable ? namesTable.getSymbolicOffsets() : {};

    // Internal persistent state (The "Fact Store")
    this._cachedFacts = { 
      yearlyData: new Map(), 
      globalAccountMeta: new Map() 
    };
    this._isFullyLoaded = false;

    // Logic caches
    this._categoryToType = null;
    this._assetPrefixes = null;
  }

  static get INGEST_CONFIG() {
    return { 
      TRANSFER_KEYWORD: "TRANSFER", 
      HIDDEN_TYPES: ["IDENTIFIERS"]
    };
  }

  /**
   * Orchestration: Clears all cached state.
   */
  refresh() {
    myLog("info", "AnnualLedger: Refreshing data and metadata.");
    this._cachedFacts = { yearlyData: new Map(), globalAccountMeta: new Map() };
    this._isFullyLoaded = false;
    this._categoryToType = null;
    this._assetPrefixes = null;
    if (this.sourceTable) this.sourceTable.flushMemory();
    if (this.namesTable) this.namesTable.flushMemory();
  }

  /**
   * Public Entry Point: Returns the current fact snapshot.
   */
  getFacts() {
    return this._cachedFacts;
  }

  /**
   * Strategy: Full Scan
   * Pulls the entire table and ingests every row top-down.
   */
  loadFull() {
    if (this._isFullyLoaded) return;
    if (!this.sourceTable) return;

    myLog("info", "AnnualLedger: Triggering Full Longitudinal Scan of %s", this.sourceTable.longName);
    this._ensureColumns();
    
    // 1. Force the table to load from the very beginning to ensure the window is complete
    this.sourceTable.fetch(this.sourceTable.firstDataRowIndex);

    // 2. Use the dynamic window start for accurate physical row mapping
    const data = this.sourceTable.getWindow();
    const winStart = this.sourceTable._windowStartRow;

    data.forEach((row, rowOff) => {
      this._ingestRow(row, rowOff + winStart);
    });

    this._finalize();
    this._isFullyLoaded = true;
  }

  /**
   * Strategy: Targeted Backward Scan (Optimized)
   * Pulls rows from the bottom in chunks until targetYear facts and FY-1 balances are resolved.
   */
  loadYear(targetYear) {
    if (this._isFullyLoaded) return;
    if (!this.sourceTable) return;
    
    const targetFY = String(targetYear);
    const prevFY = String(Number(targetYear) - 1);
    
    myLog("info", "AnnualLedger: Triggering Targeted Backward Scan for FY%s", targetFY);
    this._ensureColumns();

    const targetAccounts = new Set();
    const resolvedBalances = new Set();
    const seenActivityInPrev = new Set();
    
    let currentChunkSize = 1000;
    let stopScan = false;
    let absoluteLimitReached = false;

    const labelRow = this.sourceTable.getProperty("LabelRow") || 1;
    const absoluteStart = labelRow + 1;
    let lastRow = this.sourceTable.getLastRowIndex();
    
    myLog("info", "AnnualLedger: Initializing scan for %s (Physical Rows: %d, Data starts at: %d)", this.sourceTable.longName, lastRow, absoluteStart);
    myLog("info", "AnnualLedger: Labels -> %s", this.sourceTable.getLabels().join(", "));
    myLog("info", "AnnualLedger: Column Offsets -> FY: Col %s, Account: Col %s, Amount: Col %s, Cleared: Col %s, LastBalance: Col %s, Balance: Col %s", 
      StringUtils.columnToLetter(this.sourceCols.fy), 
      StringUtils.columnToLetter(this.sourceCols.account), 
      StringUtils.columnToLetter(this.sourceCols.amount), 
      StringUtils.columnToLetter(this.sourceCols.cleared),
      StringUtils.columnToLetter(this.sourceCols.lastBalance),
      StringUtils.columnToLetter(this.sourceCols.balance));

    let isFinished = false;
    let chunkStart = Math.max(absoluteStart, lastRow - 1000 + 1);

    while (!isFinished && lastRow >= absoluteStart) {
      myLog("info", "AnnualLedger: Scanning backward chunk from row %d to %d...", chunkStart, lastRow);
      
      // Request the physical window expansion (Explicit backward move)
      this.sourceTable.fetch(chunkStart, (lastRow - chunkStart + 1));
      const data = this.sourceTable.getWindow();
      
      const windowStart = this.sourceTable._windowStartRow;
      const startIdx = chunkStart - windowStart;
      const endIdx = lastRow - windowStart;

      for (let i = endIdx; i >= startIdx; i--) {
        const row = data[i];
        const pRow = windowStart + i;
        let rowFY = String(row[this.sourceCols.fy] || "").trim();
        if (rowFY.length > 4) rowFY = rowFY.substring(0, 4);
        const groupVal = row[this.sourceCols.group];
        const groupKey = groupVal !== undefined && groupVal !== null && groupVal !== "" ? String(groupVal).trim() : null;
        if (groupKey && Number(groupKey) !== 0) {
          const groupsTable = getSheetInstance("Reconciliation_Groups");
          if (groupsTable) {
            const groupFY = groupsTable.lookupValue("Group", "FY", groupKey);
            if (groupFY) {
              rowFY = String(groupFY).trim();
              if (rowFY.length > 4) rowFY = rowFY.substring(0, 4);
            }
          }
        }
        if (!rowFY) continue;

        if (i === endIdx) {
          myLog("info", "AnnualLedger: Scan head at row %d (Year: %s)", pRow, rowFY);
        }

        // 1. Hard Boundary: We scan the target year, the previous year, 
        // and one additional year as a safety buffer for out-of-period reconciliations.
        // We only stop the scan if we hit a CLEARED ACCOUNT row from an older year.
        const safetyBoundary = Number(prevFY) - 1;
        if (Number(rowFY) < safetyBoundary) {
          const rowType = String(row[this.sourceCols.entryType] || "").trim().toUpperCase();
          const isCleared = (row[this.sourceCols.cleared] === true || String(row[this.sourceCols.cleared]).trim().toUpperCase() === "TRUE");
          if (rowType === "ACCOUNT" && isCleared) {
            myLog("info", "AnnualLedger: Reached safety boundary (%s) at cleared account row %d. Scan complete.", rowFY, pRow);
            isFinished = true;
            break;
          }
        }

        // 2. Process Row
        this._ingestRow(row, pRow);

        // 4. Track resolution state (Continue scanning to catch out-of-order rows)
        const accName = row[this.sourceCols.account];
        const type = (row[this.sourceCols.entryType] || "").toUpperCase();

        if (rowFY === targetFY) {
          targetAccounts.add(accName);
        } else if (rowFY === prevFY) {
          const isLastBalance = row[this.sourceCols.lastBalance] === true || String(row[this.sourceCols.lastBalance]).trim().toUpperCase() === "TRUE";
          if (type === "ACCOUNT" && isLastBalance) {
            resolvedBalances.add(accName);
          }
        }
      }

      if (!isFinished) {
        if (chunkStart <= absoluteStart) {
          isFinished = true;
        } else {
          // Shift the next chunk backward
          lastRow = chunkStart - 1;
          chunkStart = Math.max(absoluteStart, lastRow - 1000 + 1);
        }
      }
    }

    this._finalize();
  }

  /**
   * Internal Core: Ingests a single row into the state.
   */
  _ingestRow(row, rowNum) {
    const type = (row[this.sourceCols.entryType] || "").trim().toUpperCase();
    const isCleared = (row[this.sourceCols.cleared] === true || String(row[this.sourceCols.cleared]).trim().toUpperCase() === "TRUE");
    let rowFY = String(row[this.sourceCols.fy] || "").trim();
    if (rowFY.length > 4) rowFY = rowFY.substring(0, 4);
    const groupVal = row[this.sourceCols.group];
    const groupKey = groupVal !== undefined && groupVal !== null && groupVal !== "" ? String(groupVal).trim() : null;
    if (groupKey && Number(groupKey) !== 0) {
      const groupsTable = getSheetInstance("Reconciliation_Groups");
      if (groupsTable) {
        const groupFY = groupsTable.lookupValue("Group", "FY", groupKey);
        if (groupFY) {
          rowFY = String(groupFY).trim();
          if (rowFY.length > 4) rowFY = rowFY.substring(0, 4);
        }
      }
    }

    // Track uncleared activities before returning early
    if (type === "ACTIVITY" && !isCleared) {
      const state = this._getYearState(rowFY);
      if (!state.unclearedEntries) state.unclearedEntries = [];
      state.unclearedEntries.push({
        rowNum: rowNum,
        type: type,
        pk: row[this.sourceCols.pk],
        date: row[this.sourceCols.date],
        amount: Number(row[this.sourceCols.amount] || 0),
        desc: row[this.sourceCols.description] || "",
        account: row[this.sourceCols.account]
      });
      return;
    }
    
    if (type !== "ACTIVITY" && type !== "ACCOUNT") return; // Safety check

    const amount = Number(row[this.sourceCols.amount] || 0);
    const accName = row[this.sourceCols.account];
    const state = this._getYearState(rowFY);
    const yearlyAccountState = this._getYearlyAccountState(state, accName);

    // Track uncleared account entries
    if (type === "ACCOUNT" && !isCleared) {
      if (!state.unclearedEntries) state.unclearedEntries = [];
      state.unclearedEntries.push({
        rowNum: rowNum,
        type: type,
        pk: row[this.sourceCols.pk],
        date: row[this.sourceCols.date],
        amount: amount,
        desc: row[this.sourceCols.description] || "",
        account: accName
      });
    }

    // Track reconciled group details

    if (groupKey && Number(groupKey) !== 0 && isCleared) {
      if (!state.groups) state.groups = new Map();
      if (!state.groups.has(groupKey)) {
        state.groups.set(groupKey, { activitySum: 0, accountSum: 0, rows: [] });
      }
      const g = state.groups.get(groupKey);
      g.rows.push({
        rowNum: rowNum,
        type: type,
        account: accName,
        pk: row[this.sourceCols.pk],
        date: row[this.sourceCols.date],
        amount: amount,
        desc: row[this.sourceCols.description] || ""
      });
      if (type === "ACTIVITY") {
        g.activitySum += amount;
      } else if (type === "ACCOUNT") {
        g.accountSum += amount;
      }
    } else if (isCleared) {
      // Track cleared entries with no Group ID
      if (!state.ungroupedCleared) state.ungroupedCleared = [];
      state.ungroupedCleared.push({
        rowNum: rowNum,
        type: type,
        pk: row[this.sourceCols.pk],
        date: row[this.sourceCols.date],
        amount: amount,
        desc: row[this.sourceCols.description] || "",
        account: accName
      });
    }

    if (type === "ACCOUNT") {
      const isLastBalance = row[this.sourceCols.lastBalance] === true || String(row[this.sourceCols.lastBalance]).trim().toUpperCase() === "TRUE";
      const rawBal = row[this.sourceCols.balance];
// Log suppressed for ACCOUNT rows

      const accountMeta = this._cachedFacts.globalAccountMeta.get(accName);
      if (accountMeta && !accountMeta.pk) accountMeta.pk = row[this.sourceCols.pk];

      if (isLastBalance) {
        const newBal = Number(row[this.sourceCols.balance] || 0);
        const prevRow = yearlyAccountState._balCurrentRow || 0;
        // The highest physical row number is always the authoritative closing balance —
        // it is the most recent row the bank wrote a balance into.
        if (rowNum > prevRow) {
          yearlyAccountState.balCurrent = newBal;
          yearlyAccountState._balCurrentRow = rowNum;
          myLog("debug", `AnnualLedger: [Row ${rowNum}] Balance snapshot for "${accName}" in FY${rowFY}: £${newBal.toFixed(2)} (PK: ${row[this.sourceCols.pk]}).`);
        } else {
          myLog("debug", `AnnualLedger: [Row ${rowNum}] LastBalance SKIPPED for "${accName}" — row ${prevRow} (£${(yearlyAccountState.balCurrent||0).toFixed(2)}) is more recent (PK: ${row[this.sourceCols.pk]}).`);
        }
      }
    } else if (type === "ACTIVITY") {
      yearlyAccountState.ledgerNet = (Number(yearlyAccountState.ledgerNet) || 0) + amount;
      this._ingestTransaction(state, row[this.sourceCols.category], amount);
    }
  }

  _ensureColumns() {
    CONFIG_CONSTANTS.LEDGER_MANDATORY_SYMBOLS.forEach(key => {
      if (this.sourceCols[key] === undefined || this.sourceCols[key] === -1) {
        throw new Error(`Data Integrity Failure: Required column "${key}" was not found in ${this.sourceTable.longName}.`);
      }
    });
  }

  _finalize() {
    this._cachedFacts.globalAccountMeta.forEach(accountMeta => {
      accountMeta.isValidAsset = this._isAssetAccount(accountMeta.pk, accountMeta.name);
    });
  }

  // =========================================================================
  // LAZY-LOADING GETTERS
  // =========================================================================

  _getCategoryMap() {
    if (this._categoryToType) return this._categoryToType;
    if (!this.namesTable || this.nameCols.name === undefined) return new Map();

    this._categoryToType = new Map();
    this.namesTable.getWindow().forEach(row => {
      const name = String(row[this.nameCols.name] || "").trim();
      const type = String(row[this.nameCols.type] || "General").trim();
      if (name) {
        this._categoryToType.set(name.toUpperCase(), type);
      }
    });
    return this._categoryToType;
  }

  _getAssetPrefixes() {
    if (this._assetPrefixes) return this._assetPrefixes;
    const configTable = getSheetInstance(CONFIG_CONSTANTS.SHEETS_CONFIG_NAME);
    if (!configTable) return [];

    this._assetPrefixes = CONFIG_CONSTANTS.DEFAULT_ASSET_LEDGERS.map(name => {
      const prefix = configTable.lookupValue("LongName", "KeyPrefix", name);
      if (!prefix) throw new Error(`AnnualLedger: Missing KeyPrefix for ${name}`);
      return prefix.toUpperCase();
    });
    return this._assetPrefixes;
  }

  _getYearState(yearStr) {
    const map = this._cachedFacts.yearlyData;
    if (!map.has(yearStr)) {
      map.set(yearStr, {
        accounts: new Map(),
        categoryGroupStats: {},
        totals: { in: 0, out: 0, net: 0 },
        ghosts: { net: 0, list: [] },
        groups: new Map(),
        ungroupedCleared: [],
        unclearedEntries: []
      });
    }
    return map.get(yearStr);
  }

  _getYearlyAccountState(state, name) {
    if (!state.accounts.has(name)) {
      state.accounts.set(name, { ledgerNet: 0, balCurrent: null, _balCurrentRow: 0 });
      if (!this._cachedFacts.globalAccountMeta.has(name)) {
        this._cachedFacts.globalAccountMeta.set(name, { name: name, pk: null, isValidAsset: false });
      }
    }
    return state.accounts.get(name);
  }

  /**
   * Lazy-getter for the yearly statistics of a specific category group (e.g., Social, General).
   */
  _getCategoryGroupStats(state, groupName) {
    if (!state.categoryGroupStats[groupName]) {
      state.categoryGroupStats[groupName] = { in: 0, out: 0, net: 0, categories: {} };
    }
    return state.categoryGroupStats[groupName];
  }

  /**
   * Lazy-getter for the yearly statistics of a specific category.
   */
  _getCategoryStats(groupStats, categoryName) {
    if (!groupStats.categories[categoryName]) {
      groupStats.categories[categoryName] = { name: categoryName, in: 0, out: 0, net: 0 };
    }
    return groupStats.categories[categoryName];
  }

  // =========================================================================
  // TRANSACTION INGESTION (Declarative)
  // =========================================================================

  /**
   * Main Entry Point for Transaction Logic.
   * Describes WHAT is happening to the transaction.
   */
  _ingestTransaction(state, category, amount) {
    const groupName = this._resolveCategoryGroup(category);
    
    if (!groupName) {
      this._recordGhost(state, category, amount);
    } else {
      this._aggregateTransaction(state, groupName, category, amount);
    }
  }

  /**
   * Determines the logical group for a category.
   */
  _resolveCategoryGroup(category) {
    const categoryUpper = String(category || "").toUpperCase();
    
    // Rule 1: Special Keyword "TRANSFER" overrides everything
    if (categoryUpper.includes(AnnualLedger.INGEST_CONFIG.TRANSFER_KEYWORD)) return "Transfers";
    
    // Rule 2: Lookup the official group from the Names registry (Case-Insensitive)
    const mappedGroup = this._getCategoryMap().get(categoryUpper);
    
    // Rule 3: Hidden system groups (like Identifiers) are treated as internal transfers
    if (mappedGroup && AnnualLedger.INGEST_CONFIG.HIDDEN_TYPES.includes(mappedGroup.toUpperCase())) return "Transfers";
    
    return mappedGroup;
  }

  /**
   * Handles items with no registered category.
   */
  _recordGhost(state, category, amount) {
    state.ghosts.net += amount;
    if (!state.ghosts.list.includes(category)) state.ghosts.list.push(category);
  }

  /**
   * Aggregates a known transaction into the yearly facts.
   */
  _aggregateTransaction(state, groupName, category, amount) {
    const groupStats = this._getCategoryGroupStats(state, groupName);
    const catStats = this._getCategoryStats(groupStats, category);

    // 1. Update the category and its parent group
    this._applyAmount(catStats, amount);
    this._applyAmount(groupStats, amount);

    // 2. Update the Grand Totals (unless it's an internal transfer)
    if (groupName.toUpperCase() !== "TRANSFERS") {
      this._applyAmount(state.totals, amount);
    }
  }

  /**
   * Declarative math helper. 
   * Encapsulates the In/Out/Net logic in one place.
   */
  _applyAmount(statsObj, amount) {
    if (amount > 0) {
      statsObj.in += amount;
    } else {
      statsObj.out += Math.abs(amount);
    }
    statsObj.net += amount;
  }

  // =========================================================================
  // IDENTITY HELPERS
  // =========================================================================

  _isAssetAccount(pk, name) {
    const pkU = String(pk || "").toUpperCase();
    const nmU = String(name || "").toUpperCase();
    return this._getAssetPrefixes().some(p => pkU.startsWith(p)) || /CASH|ASSET/.test(nmU);
  }
}
