# Walkthrough - Restoring All-Dirty Behavior

The `markAllDirty` behavior has been restored to align with specifications: all runnable sheets, including `FileTable` Drive staging sheets, are marked as dirty when triggering the "Set all sheets dirty" command.

## Status

### 005_EntryPoints.js

#### [MODIFY] [005_EntryPoints.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/005_EntryPoints.js)

1. Reverted the filter to include `filetable` in the runnable list for `markAllDirty()`.
2. Modified `importPendingSheets()` to pass the pending sheets list through `_sortSheetsByDependency()` before execution.
3. Updated `showRepairManager()` to use `HtmlService.createTemplateFromFile()` and eagerly stringify/inject the core sheet configs and dependency map as JSON variables.
4. Filtered out `ManualEntry_` sheets from `getCoreSheetConfigs()`, preventing them from appearing in the Repair Manager since they are manually populated and not imported.

### RepairManager.html

#### [MODIFY] [RepairManager.html](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/RepairManager.html)

1. Modified `loadData()` to read the pre-injected JSON configs directly from the template context, eliminating two server round-trips via `google.script.run` and resolving the client-side library lookup issue for loading the sheet list.
2. Introduced an `activeBatch` set in the UI script to track the active queue of running/pending sheets during the repair execution. 
3. Updated `reevaluateUI()` to keep checkbox states ticked for any sheets still in `activeBatch`. Checked items are now unticked individually only *after* their specific server-side execution succeeds, providing a clean visual progression of completed versus pending items.

### 120_Sheet.js

#### [MODIFY] [120_Sheet.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/120_Sheet.js)

Commented out the repetitive "Dimension Audit" log statement under `_resolveRequestedRange` to suppress it from the execution logs completely:
```javascript
    // myLog("trace", "Sheet [%s] Dimension Audit: startRow=%d, physicalLastRow=%d", 
    //   this.longName, resolvedStart, physicalLastRow);
```

### 181_ReconcileProcessor.js

#### [MODIFY] [181_ReconcileProcessor.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/181_ReconcileProcessor.js)

1. Simplified the `_getLedgerNameFromPrefix` helper to delegate directly to `Registry.getLongNameByPrefix(prefix)` in O(1) time.
2. Added systematic programmatic redirection: if the resolved target sheet is an active manual entry table (`ManualEntry_Ledger`, `ManualEntry_Holdings`, `ManualEntry_Cashbox`), it is automatically redirected to the corresponding active ledger sheet in the `Ledgers` spreadsheet (`Ledgers_Transactions`, `Ledgers_Assets`, `Ledgers_Cash`). This guarantees the program never writes back to the raw manual entry input templates.

### 215_Initialisation.js

#### [MODIFY] [215_Initialisation.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/215_Initialisation.js)

1. Fixed a `TypeError` during Registry hydration by casting `config.SheetName` to a `String` before trimming it.
2. Built an internal `_prefixToLongName` map during Registry hydration. It is populated dynamically from the `KeyPrefix` configuration column across all rows in `NewAccounts_Sheets`.
3. Reordered hydration such that `CONFIG_CONSTANTS.HISTORICAL_PREFIX_MAP` overrides are loaded **after** the configuration sheet entries. This ensures the constants map acts as a true programmatic override that cannot be overwritten by spreadsheet config cell edits.
4. Exposed a public `getLongNameByPrefix(prefix)` method on the `Registry` singleton to handle O(1) case-insensitive lookups.

### 001_Constants.js

#### [MODIFY] [001_Constants.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/001_Constants.js)

Added the `HISTORICAL_PREFIX_MAP` skeleton structure to `CONFIG_CONSTANTS` so that any legacy/retired prefixes can be manually mapped in code later. The map remains an empty template.

## Reconciliation Save Physical Offset Fix

Reconciliation save write-backs were targeting incorrect rows or silently skipping some transactions because of window limits and virtual layout mismatches:

1. **Physical Merged Table Alignment:** Modified `_prefetchDestinationTables` in [181_ReconcileProcessor.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/181_ReconcileProcessor.js#L53-L67) to load the Merged table as a standard physical `Table` starting at row 2 (full load) rather than a virtual, concatenated `UnionTable`. This ensures the transaction offsets mapped during reconciliation match actual physical cell locations in the sheet (which may have been sorted or filtered).
2. **Out-of-Window Ledger Lookups:** Updated `_stageLedgerUpdates` in [182_ReconcileTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/182_ReconcileTable.js#L230-L248) to dynamically instantiate ledger sheets as full-load tables (starting at row 2) bypassing any Registry-defined `FirstRow` financial year window. This allows the write-back engine to locate and update older, out-of-window unreconciled transactions.
3. **Write-back Context Preserving:** Modified the write-back batching to pass the full ledger instance to `_executeLedgerBatchUpdates` so that offsets are written back against the exact same sheet dimension context they were calculated on, preventing misalignment writes.

## Reconciliation Data Recovery Tool

A one-off recovery utility has been added to [005_EntryPoints.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/005_EntryPoints.js#L395-L577): `recoverReconciliationData()`.

### How it Works:
1. **Full Load cross-referencing:** It instantiates the `Groups`, `ReconcileLog`, `Merged`, and all ledger sheets bypassing any windowing/financial-year restrictions (full load starting at row 2).
2. **Groups-Driven Verification:** It scans `AnnualSummaries_Groups` (the absolute database of record for groupings) as the master loop. For each transaction with a Group ID, it resolves its originating ledger (e.g. `Ledgers_SquareFees`, `Ledgers_SquarePayments`, or `Ledgers_Transactions`) by extracting and mapping its PK prefix (`SqFee#`, `SqPay#`, `Tx#`, etc.).
3. **Robust Prefix Resolution:** Added programmatic mappings for all standard transaction key prefixes (`SqFee`, `SqPay`, `SqDep`, `SqTx`, `Tx`, `Bank`, `Cash`, `Asset`, `Book`) to `HISTORICAL_PREFIX_MAP` in [001_Constants.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/001_Constants.js). This ensures that sheet name resolutions for originating ledgers never fail or fall back to unresolved short codes (which previously caused ledger writes to be skipped).
4. **Data Repair:**
   - The tool corrects the `GroupID` in the transaction's originating ledger sheet.
   - It also corrects the `GroupID` and marks it `Cleared = TRUE` in the physical `AnnualSummaries_Merged` sheet.
5. **Summary Alert:** When execution completes, it displays a popup summarizing the number of groups processed, unresolved ledger prefixes, and written records.

### How to Run:
You can run the recovery tool in one of two ways:
* **Option A (From the Spreadsheet Menu):** Reload the spreadsheet, then go to the top menu: **Village Hall** > **Reconcile** > **🔧 Recover missing Group IDs**.
* **Option B (From the Script Editor):** Open the Google Apps Script editor, select **`recoverReconciliationData`** from the function dropdown at the top, and click **Run**.

## Registry Formula Sheet Name Resolution Fix

When importing generated transactions (or other sheet transformations), you might have encountered a mapping error looking for `EntryType` in the source sheet `ManualEntry_ScheduledTransactions`.

### Root Cause:
The destination sheet `Ledgers_GeneratedTransactions` has an `EntryType` column in its physical structure. You configured a custom formula for it in the formulas sheet (e.g. `Ledgers_Generatedtransactions[EntryType] = "Activity"` or using a short name like `GeneratedTransactions[EntryType]`).
- Previously, the formula parser indexed formulas strictly by the case-sensitive string written in the formulas table (e.g. `Ledgers_Generatedtransactions`).
- Because of strict case-sensitivity or naming mismatches (e.g. lowercase `t` in `transactions` vs uppercase `T` in `Transactions`), the lookup for the logical name (`Ledgers_GeneratedTransactions`) returned `[]` (no formulas loaded).
- The system fell back to a default 1:1 mapping `[EntryType]`, which expected the source sheet `ManualEntry_ScheduledTransactions` to contain an `EntryType` column. Since it didn't, the import failed with a column mapping error.

### Fix (Strict Fail-Fast on Data Errors):
1. **Case-Insensitive LongName Resolution:** Modified formula indexing in `Registry.hydrate()` in [215_Initialisation.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/215_Initialisation.js#L171-L188) to resolve sheet names (short names, physical sheet tab names, or casing mismatches) to their official logical `LongName` configured in `NewAccounts_Sheets` case-insensitively. This resolves minor casing typos and short names to the correct, case-sensitive logical key.
2. **Strict Fail-Fast Validation:** If a formula target references a sheet name that is not configured anywhere in your Sheets registry, the system **fails fast** during initialization and throws a descriptive error detailing exactly which formula is referencing an unregistered sheet.
3. **Strict Sheets Config lookup:** Reverted any sheet-lookup fallbacks in `Registry.getSheetConfig()` to keep its lookups strictly tied to logical `LongName`, ensuring that sheet mismatch errors fail fast.
4. **Transaction-Level Validation Scope Optimization:** Modified row validation in `Table.fetch()` in [130_Table.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/130_Table.js#L297-L309) to restrict strict transaction-level mandatory field validation (e.g. checks on `EntryType`, `Category`, `Group`, etc.) solely to actual financial transaction tables with complete data (sheets starting with `Ledgers_`, `AnnualSummaries_Merged`, and `AnnualSummaries_UnChecked`). Staging files, template tables (like `ManualEntry_ScheduledTransactions`), and partial/summary configuration sheets are now excluded from these transaction-level validation rules since they do not represent complete ledger transaction entries directly.

## Repair Manager Reconcile Sheet Integration

The **Reconcile** sheet has been integrated into the **Repair Manager**'s UI list:
1. **Registered in Sheet Config:** Added `{ label: "🔄 Reconcile", longName: "AnnualSummaries_NewReconcile" }` to `CORE_SHEET_CONFIG` in [001_Constants.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/001_Constants.js).
2. **Dependency Mapping:** Added `"AnnualSummaries_UnChecked": ["AnnualSummaries_NewReconcile"]` to `SHEET_DEPENDENCY_MAP` in [001_Constants.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/001_Constants.js). Ticking the **Unchecked** sheet in the Repair Manager will now automatically select the **Reconcile** sheet as a dependent target.
3. **Execution Interception:** Modified `runRepairSingle` in [005_EntryPoints.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/005_EntryPoints.js) to intercept execution of `AnnualSummaries_NewReconcile` and trigger `recon.startNewReconciliation()`, automatically rebuilding the reconciliation matrix using fresh Unchecked data.

## Intended Workflow
1. **Set all sheets dirty**: Marks every runnable sheet (including Drive `File...` staging sheets) as `Process = TRUE`.
2. **Batch Import**: Downloads fresh files from Google Drive and rebuilds downstream sheets from scratch.
3. **Subsequent Corrections / Re-runs**: Errors are corrected using the **Repair Manager**, which targets specific sheets. Running **Unchecked** now automatically triggers the downstream **Reconcile** generation to rebuild the matching workspace.
4. **Reconciliation**: Balanced groups can be saved to write back Group IDs, FY, and Cleared flags to the physical Merged sheet and origin source ledgers safely across any financial year boundary.
5. **Database Recovery (If Needed):** Run `recoverReconciliationData` from the script editor dropdown to reconstruct missing/corrupted Group IDs and Cleared flags across all ledgers and the Merged sheet from the ReconcileLog source of truth.
