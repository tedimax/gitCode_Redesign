"use strict";

/**
 * gitCode_Redesign - ReconcileRenderer (Level 3/4 — Presenter / Layout Engine)
 * Responsible for rendering the Reconciliation table representation:
 *   1. Translating grouped/sorted rows into 2D sheet output format.
 *   2. Rebuilding/restoring complex array formulas onto the first data row.
 */
class ReconcileRenderer {
  constructor(table) {
    this.table = table;
  }

  /**
   * Generates the output matrix and restores formulas on the Reconcile sheet.
   * @param {Array}  reconcileRows
   * @param {number} startingTxId
   * @returns {number} count of written rows
   */
  render(reconcileRows, startingTxId = 1) {
    // 1. Generate the 2D output array
    const outputData = this.generateOutput(reconcileRows, startingTxId);

    // 2. Write output to the table's sheet
    this.table.clearDataArea();
    if (outputData.length > 0) {
      // Offset by 1 row to leave the first data row strictly for formulas
      this.table.writeBlock(this.table.firstDataRowIndex + 1, outputData);
    }

    // 3. Restore array formulas
    this.restoreFormulas();
    return outputData.length;
  }

  /**
   * Converts grouped rows into the output matrix for the Reconcile sheet.
   * Singletons get no Transaction ID; groups of >=2 get an auto-assigned or preserved ID.
   * @param {Array}    reconcileRows
   * @param {number}   startingTxId  First ID to use for new groups.
   * @returns {Array<Array>}
   */
  generateOutput(reconcileRows, startingTxId = 1) {
    // 1. Analyze groups to determine sizes and capture any manually preserved transaction IDs
    const { groupSizes, rootToTxId } = this._analyzeGroups(reconcileRows);

    // 2. Generate the 2D output matrix, assigning new IDs where necessary
    return this._buildRenderedRows(reconcileRows, groupSizes, rootToTxId, startingTxId);
  }

  /**
   * Scans rows to determine the size of each connected group and captures the lowest 
   * existing manual transaction ID for each group (if any exist).
   * 
   * @param {Array} reconcileRows 
   * @returns {{ groupSizes: Map<string, number>, rootToTxId: Map<string, number> }}
   */
  _analyzeGroups(reconcileRows) {
    return reconcileRows.reduce((acc, item) => {
      const rootPK = item.rootRow.PK;
      
      acc.groupSizes.set(rootPK, (acc.groupSizes.get(rootPK) || 0) + 1);

      if (item.existingTx) {
        const currentExisting = acc.rootToTxId.get(rootPK);
        if (!currentExisting || Number(item.existingTx) < Number(currentExisting)) {
          acc.rootToTxId.set(rootPK, item.existingTx);
        }
      }
      
      return acc;
    }, { groupSizes: new Map(), rootToTxId: new Map() });
  }

  /**
   * Maps parsed row data into the flat 2D array matrix required by Google Sheets.
   * Assigns auto-incrementing Transaction IDs to newly formed groups of 2 or more.
   * 
   * @param {Array} reconcileRows 
   * @param {Map<string, number>} groupSizes 
   * @param {Map<string, number>} rootToTxId 
   * @param {number} startingTxId 
   * @returns {Array<Array<string|number>>} A 2D matrix representing physical sheet rows. 
   * Each row is an array of length `rowLength` initialized with empty strings `""`, 
   * containing the `item.PK` and `currentTxId` values at their symbolic column offsets.
   */
  _buildRenderedRows(reconcileRows, groupSizes, rootToTxId, startingTxId) {
    let nextTxId = startingTxId;
    const reconcileCols = this.table.getSymbolicOffsets();
    const rowLength = this.table.getLabels().length;

    return reconcileRows.map(item => {
      const rootPK = item.rootRow.PK;
      const size = groupSizes.get(rootPK);

      let currentTxId = ""; // Default to blank for singletons

      if (rootToTxId.has(rootPK)) {
        currentTxId = String(rootToTxId.get(rootPK));
      } else if (size >= 2) {
        rootToTxId.set(rootPK, nextTxId++);
        currentTxId = String(rootToTxId.get(rootPK));
      }

      const outRow = new Array(rowLength).fill("");
      if (reconcileCols.pk !== -1) outRow[reconcileCols.pk] = item.PK;
      if (reconcileCols.transaction !== -1) outRow[reconcileCols.transaction] = currentTxId;

      return outRow;
    });
  }

  /**
   * Restores the complex array formulas to the first data row of the Reconcile sheet.
   */
  restoreFormulas() {
    // Recalculate named ranges for the sheet to cover the new dimensions
    this.table.writeNamedRanges();

    const formulas = {};
    const base = StringUtils.toRangeName(this.table.sheetName);
    const mergedConfig = Registry.getSheetConfig(CONFIG_CONSTANTS.MERGED_TABLE_NAME);
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
      formulas[col] = `=ARRAYFORMULA(IF(${rng("PK")}="","",XLOOKUP(${rng("PK")}, ${mRng("PK")}, ${mRng(col)}, "")))`;
    });

    const labels = this.table.getLabels();
    const formulaRow = new Array(labels.length).fill("");

    labels.forEach((label, idx) => {
      if (formulas[label]) {
        formulaRow[idx] = formulas[label];
      }
    });

    const range = this.table.sheet.getRange(this.table.firstDataRowIndex, 1, 1, labels.length);
    range.setFormulas([formulaRow]);
  }
}

// Register with globals
globals.tableMap['ReconcileRenderer'] = ReconcileRenderer;
