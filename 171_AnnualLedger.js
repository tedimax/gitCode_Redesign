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

    // Internal cache buckets
    this._categoryToType = null;
    this._assetPrefixes = null;
    this._cachedFacts = null;
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
    this._cachedFacts = null;
    this._categoryToType = null;
    this._assetPrefixes = null;
    if (this.sourceTable) this.sourceTable.flushMemory();
    if (this.namesTable) this.namesTable.flushMemory();
  }

  /**
   * Public Entry Point: Returns the multi-year fact snapshot.
   */
  getFacts() {
    if (this._cachedFacts) return this._cachedFacts;
    if (!this.sourceTable) return null;

    myLog("trace", "AnnualLedger: Performing longitudinal fact scan.");
    const data = this.sourceTable.getWindow();
    
    // Diagnostic: Log mapping for audit trail
    const labels = this.sourceTable.getColLabels();
    const mappingAudit = {};
    Object.entries(this.sourceCols).forEach(([key, off]) => {
      mappingAudit[key] = off >= 0 ? `${off} (Label: "${labels[off] || 'MISSING'}")` : "MISSING";
    });
    myLog("info", "AnnualLedger Mapping Audit: %s", JSON.stringify(mappingAudit));

    // FAIL FAST: Ensure mandatory columns exist
    const mandatory = ["amount", "account", "fy", "pk", "category", "entryType"];
    mandatory.forEach(key => {
      if (this.sourceCols[key] === undefined || this.sourceCols[key] === -1) {
        throw new Error(`Data Integrity Failure: Required column "${key}" (mapped to "${this.sourceTable.getProperty(key)}") was not found in sheet "${this.sourceTable.sheetName}".`);
      }
    });

    /**
     * Robust Numeric Parsing with Precision Guard.
     * Rounds to 2 decimal places to handle Google Sheets floating point garbage (e.g. 7.20999... -> 7.21)
     */
    const parseNum = (v) => {
      if (v === null || v === undefined || v === "") return 0;
      let n;
      if (typeof v === "number") {
        n = v;
      } else {
        const clean = String(v).replace(/[£$,\s]/g, '');
        n = parseFloat(clean);
      }
      
      return isNaN(n) ? 0 : Math.round(n * 100) / 100;
    };

    this._cachedFacts = { yearlyData: new Map(), globalAccountMeta: new Map() };

    // Pass: Hydrate and Ingest
    data.forEach((row, rowOff) => {
      const rowNum = rowOff + this.sourceTable.firstDataRowIndex;
      
      let rowFY = String(row[this.sourceCols.fy] || "").trim();
      if (rowFY.length > 4) rowFY = rowFY.substring(0, 4);

      const rawV = row[this.sourceCols.amount];
      const amount = parseNum(rawV);
      const pk = row[this.sourceCols.pk] || "Unknown";
      const accName = row[this.sourceCols.account];

      // FAIL FAST: Strict safety limit (£1M)
      if (Math.abs(amount) > 1000000) {
        const rowDump = row.map((v, i) => `[${i}]: ${v}`).join(" | ");
        myLog("error", "Data Integrity Failure at Row %d [PK: %s]. Value £%s exceeds £1M. Raw Row: %s", rowNum, pk, amount, rowDump);
        throw new Error(`Data Integrity Failure: Value (£${amount}) exceeds £1M limit at Row ${rowNum} [PK: ${pk}].`);
      }

      if (!row[this.sourceCols.cleared]) return;

      const state = this._getYearState(rowFY);
      const yearlyAccountState = this._getYearlyAccountState(state, row[this.sourceCols.account]);

      if ((row[this.sourceCols.entryType] || "").toUpperCase() === "ACCOUNT") {
        const accountMeta = this._cachedFacts.globalAccountMeta.get(accName);
        if (accountMeta && !accountMeta.pk) accountMeta.pk = row[this.sourceCols.pk];

        if (row[this.sourceCols.lastBalance] === true || row[this.sourceCols.lastBalance] === "true") {
          const rawBal = row[this.sourceCols.balance];
          yearlyAccountState.balCurrent = parseNum(rawBal);
          myLog("trace", "Balance Audit: Setting closing balance for '%s' in %s to £%s (Row %d).", accName, rowFY, yearlyAccountState.balCurrent, rowNum);
        }
        
      } else if ((row[this.sourceCols.entryType] || "").toUpperCase() === "ACTIVITY") {
        yearlyAccountState.ledgerNet = (Number(yearlyAccountState.ledgerNet) || 0) + amount;
        this._ingestTransaction(state, row[this.sourceCols.category], amount);
      }
    });

    // Final Pass: Finalize Account Identities (Interpret the PKs)
    this._cachedFacts.globalAccountMeta.forEach(accountMeta => {
      accountMeta.isValidAsset = this._isAssetAccount(accountMeta.pk, accountMeta.name);
    });

    return this._cachedFacts;
  }

  // =========================================================================
  // LAZY-LOADING GETTERS
  // =========================================================================

  _getCategoryMap() {
    if (this._categoryToType) return this._categoryToType;
    if (!this.namesTable || this.nameCols.name === undefined) return new Map();

    this._categoryToType = new Map(
      this.namesTable.getWindow()
        .map(row => [row[this.nameCols.name], row[this.nameCols.type] || "General"])
        .filter(([name]) => name !== "" && name !== null)
    );
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
        ghosts: { net: 0, list: [] }
      });
    }
    return map.get(yearStr);
  }

  _getYearlyAccountState(state, name) {
    if (!state.accounts.has(name)) {
      state.accounts.set(name, { ledgerNet: 0, balCurrent: null });
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
    const config = AnnualLedger.INGEST_CONFIG;
    const categoryUpper = String(category || "").toUpperCase();
    
    // Rule 1: Special Keyword "TRANSFER" overrides everything
    if (categoryUpper.includes(config.TRANSFER_KEYWORD)) return "Transfers";
    
    // Rule 2: Lookup the official group from the Names registry
    const mappedGroup = this._getCategoryMap().get(category);
    
    // Rule 3: Hidden system groups (like Identifiers) are treated as internal transfers
    if (mappedGroup && config.HIDDEN_TYPES.includes(mappedGroup.toUpperCase())) return "Transfers";
    
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
