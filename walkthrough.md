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

## Formula Parsing Resolution (Shorthand Column References)

### Root Cause
Shorthand column references in brackets like `[Column]` are designed to refer to fields in the **source sheet** (e.g. `ImportsArchive_RawSMApp`) by default.
- However, if a column is a target-only virtual column that does not exist in the source sheet (for example, `[DateEvent]` or `[BookingID]` in `Ledgers_Bookings`), the compiler needs to resolve it to the target row calculated state (`calc['Column']`).
- To handle this, the compiler used `isVirtual` logic. Previously, it checked if a column name existed in the **target sheet's** registry/labels. If it did, it set `isVirtual = true`.
- But this logic was flawed: because `Status` and `Label` are present in *both* the source sheet (`ImportsArchive_RawSMApp`) and the target sheet (`Ledgers_Bookings`), they were hijacked to `calc['Status']` and `calc['Label']`.
- This caused the filter formula `[Status] == "Confirmed" || [Label] == "Paid"` to evaluate against intermediate target states (which were static defaults or not yet computed) rather than raw source values, causing cancelled bookings to be imported.

### Fix
- Updated `FormulaUtils.parse` in [245_FormulaUtils.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/245_FormulaUtils.js#L101) to implement a unified, robust lookup strategy:
  1. It first checks if the column name exists in the **source sheet's labels** (`existsInSource`). If it does (e.g., `Status`, `Label`), it keeps `isVirtual = false` so it cleanly evaluates against the source sheet (`utils.getVal(...)`).
  2. If it is *not* found in the source sheet, it checks the target sheet registry/labels. If found there (e.g., `DateEvent`, `BookingID`), it sets `isVirtual = true` and resolves it to `calc['Column']`.
- This unified approach works perfectly across all transformation formulas, default mappings, and filters without requiring any special-case hacks or rules for filters.
- Verified using the scratch script [scratch/test_parse.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/scratch/test_parse.js) that:
  - Filter `[Status]` and `[Label]` correctly compile to source sheet lookups:
    `utils.getVal("ImportsArchive_RawSMApp", "Status", rowOff) == "Confirmed" || utils.getVal("ImportsArchive_RawSMApp", "Label", rowOff) == "Paid"`
  - Mapping formulas for target fields like `PK` containing `[DateEvent]` and `[BookingID]` correctly compile to target row lookups:
    `utils.pk(props.KeyPrefix, calc['DateEvent'], calc['BookingID'], rowOff)`

## Target Boundary FY Exclusion Bug Fix (e.g., Unchecked Sheet)

### Root Cause
Previously, the import engine used a date-based target boundary check (`_getTargetBoundaryDate(dateFieldName)`) to filter incoming source rows. 
- However, for derived or filtered sheets like `Unchecked`, dates are non-contiguous because it only contains uncleared transactions. The row immediately above the write window in the existing `Unchecked` sheet could contain a later date (e.g., late May 2026).
- When filtering source rows by date, this incorrectly excluded uncleared transactions dated before that boundary (e.g., April 2026 transactions), leading to missing rows.
- Furthermore, the engine previously performed blind slicing (`newData.slice(sourceSlackOffset)`) at the physical persistence level to drop the source sheet's boundary/slack rows. Because the filter shifted row indices, this sliced off valid transactions instead of the slack rows.

### Fix
- Modified [150_ImportTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/150_ImportTable.js#L206-L251) to replace the date-based check with an **FY-based target boundary check** (`_getTargetBoundaryFY(fyFieldName)`).
- The check reads the `FY` value of the row immediately preceding the write window (e.g. `2026`).
- In [150_ImportTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/150_ImportTable.js#L54-L100) (and `_tryFastClone`), the row is processed entirely, and then evaluated: if the output row's calculated `calc.FY` is less than or equal to the boundary `targetBoundaryFY`, it is excluded from being added to the target sheet. 
- This naturally handles carried-forward uncleared transactions (which may have older transaction dates but are reconciled in the current FY, setting their calculated target `FY` to the current active year).
- Removed the blind array slicing from `_persistReplace` in [140_UpdateTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/140_UpdateTable.js#L200-L215) entirely since slack rows are now handled correctly at the transform level based on their output `FY`.## Consolidated Mapping Engine and isLast Cache Building Bug Fix

### Root Cause
During the transition from the virtual `UnionTable` to the sequential multi-source loop, the spreadsheet recalculation hung during `isLast` cache building for `AnnualSummaries_Merged`.
1. **Redundant & Crashy Initialization**: In [245_FormulaUtils.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/245_FormulaUtils.js), the `isLast` cache builder eagerly called `target._initializeMappingEngine();` with no arguments. Because `ImportTable._initializeMappingEngine` expects the `sourceSheet` to obtain its column offsets and compile formulas, this call failed and threw a `TypeError` (attempting to read `longName` of `undefined`).
2. **GenerateTable Subclass Typings**: In [160_GenerateTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/160_GenerateTable.js), `_initializeMappingEngine` did not accept a `sourceSheet` argument and called `super._initializeMappingEngine()` without arguments. This also threw `TypeError` under the new structured mapping architecture.

### Fix
1. **Removed Redundant Call**: Deleted the redundant `target._initializeMappingEngine();` call from the `isLast` cache building logic in [245_FormulaUtils.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/245_FormulaUtils.js). This call was unnecessary because `target._buildExecutionPlan(driver)` already calls `this._initializeMappingEngine(sourceSheet)` internally on its very first line with the correct sheet context.
2. **Optional Parameter Support in GenerateTable**: Updated `_initializeMappingEngine(sourceSheet)` in [160_GenerateTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/160_GenerateTable.js) to accept the `sourceSheet` parameter. If not provided, it gracefully falls back to `Utils.getSourceSheet(this)` before invoking the superclass.
3. **Pushed Changes**: Executed `clasp push -f` to ensure the clean, error-free code is deployed to Google Apps Script.

## Union Sheet Multi-Source Filter Context and Window Offset Bug Fixes

### Root Cause
When executing updates on consolidated tables like `Reconciliation_Merged`, two primary issues caused incorrect dirty-flag comparisons, duplicate row generation, and incorrect writes:
1. **Filter Context Mismatch (`_shouldKeepRow`):** For multi-source sheets (e.g. `Reconciliation_Merged`), `_shouldKeepRow` was hardcoded to fetch the default source sheet instance (`Utils.getSourceSheet(this)`), which always resolved to `Ledgers_Transactions` (the first configured source). This caused the filter engine to fetch the wrong source window data and labels when evaluating filters for subsequent source sheets like `Ledgers_Bank` or `Ledgers_SquareFees`.
2. **Incorrect Physical Row Alignment (`_windowStartRow`):** In `UpdateTable._identifyChanges` and `_writeRowBlock`, the physical row index translation used `this.firstDataRowIndex` instead of `this._windowStartRow`. In windowed sheets where the active window is offset (e.g., beginning at row 2000 for the current financial year), this mismatch caused offset 0 of the window to target row 2 instead of row 2000. Consequently, updates compared incoming rows against completely different physical rows (flagging them as dirty) and wrote modifications back to the wrong physical addresses, causing header corruption and duplicates.

### Fix
1. **Source-Aware Filter Evaluation:** Updated `_shouldKeepRow` in [150_ImportTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/150_ImportTable.js#L346) to accept an optional `sourceSheet` argument, falling back to `Utils.getSourceSheet(this)` only if omitted. Modified the transformation loop in `_transformSourceSheet` to explicitly pass the active `sourceSheet` being processed.
2. **Strict Window Offset Calculations:** Replaced hardcoded references to `firstDataRowIndex` with `this._windowStartRow` in `UpdateTable._identifyChanges` and `_writeRowBlock` in [140_UpdateTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/140_UpdateTable.js#L255) to guarantee updates map to their correct physical locations regardless of window offsets.
3. **Robust Physical Row Mapping in Validation:** Updated `_executePlan` in [150_ImportTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/150_ImportTable.js#L335) to calculate physical rows using `sourceSheet._windowStartRow` to keep perimeter validation errors accurate during windowed imports.

## Registry Key Mismatch in Sheets Configuration

### Root Cause
In your spreadsheet registry `NewAccounts_Sheets`, the `"Key"` column for `"Reconciliation_Merged"` (or `"Merged"`) row was configured as `"Group"` instead of `"PK"`. 
* Because `Group` is the reconciliation group ID (which is shared by all transactions in a reconciled group, and is `0` or blank for unreconciled ones), it is not a unique row identifier.
* When executing updates, the engine grouped all transactions by their `Group` ID. If a new transaction had `Group = 0`, it matched the first row in the sheet that had `Group = 0` (e.g. `Book#20270329_3MJJA101`). 
* The engine compared their columns and flagged them as dirty (e.g., `Column 'PK' is dirty: New [Book#20260515_3MJJA010] vs Existing [Book#20270329_3MJJA101]`), overwriting rows and generating massive duplicates because keys collided.

### Action Required
* Open your `NewAccounts_Sheets` configuration tab and change the value in the **Key** column for the **Reconciliation_Merged** row from `Group` to **`PK`** to align the sheet configuration with the logical architecture. This allows the generic engine to correctly compare and update rows using their unique transaction keys.

## Date and PK Stable Sorting (Sequence Removed)

To prevent sorting inconsistencies and ensure that `LastBalance` always selects the correct authoritative row when dates match, the system was refined to eliminate the artificial `Sequence` column entirely. Instead, all sheets and in-memory caches are sorted deterministically using a native composite sort key: **Date** (primary) and **PK** (secondary tiebreaker).

### Changes and Refinements:
1. **Removed Sequence Column Overhead**:
   - Cleaned up the ingestion code to avoid allocating and tracking dynamic sequence numbers. This simplifies both physical sheets and the in-memory transform pipeline.
2. **Stable Physical Sorting by Date + PK**:
   - Refined `sortData()` in [140_UpdateTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/140_UpdateTable.js) to build a stable sort specification where `SortField` (Date) is the primary sort key, and the table's `Key` (PK) is automatically appended as the secondary ascending tiebreaker to guarantee a deterministic physical layout on the sheet.
3. **Consistent in-Memory `isLast` Evaluation**:
   - Refined the `isLast` cache builder inside [245_FormulaUtils.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/245_FormulaUtils.js) to replicate this exact sort order. If there is a tie on the date column, the rows are sorted alphabetically by their unique `PK` string to ensure the in-memory model matches the sheet's physical order. This ensures `LastBalance` evaluates deterministically and is never altered by a change in sort order.

## Dynamic UI Toast Progress Messages

When processing tables that pull from multiple source sheets (e.g. `Reconciliation_Merged`), the spreadsheet's loading overlays (toasts) now update dynamically in real time:
- Added interactive toast triggers to `_transformSourceSheet` in [150_ImportTable.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/150_ImportTable.js).
- Displays `Processing source: [SourceName]` as each individual sheet starts running, rather than displaying a static, single toast at the beginning of the entire batch sequence.

## Auto-expanding Sheet Boundaries (Coordinates Out of Bounds Fix)

If the number of incoming transaction rows written during a replacement/update import exceeds the Google Sheet's physical dimensions (the sheet has too few physical rows or columns), the script previously crashed with:
`The coordinates of the range are outside the dimensions of the sheet.`

- **Fix**: Added dynamic physical expansion logic to `writeBlock` in [120_Sheet.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/120_Sheet.js). The sheet now automatically detects if a write targets a cell coordinate outside its current boundaries and calls `insertRowsAfter` / `insertColumnsAfter` to grow the sheet size on the fly before writing, preventing boundary coordinates errors.

## Refined AnnualLedger Safety Boundary Check

Previously, during backward scans (e.g. for `AnnualSummaries_2026`), the scanner immediately stopped and finalized scanning if it encountered *any* transaction (such as an out-of-period activity or unreconciled item) belonging to an older year than the safety buffer (e.g., `< 2024` when scanning for `2026`). In cases where older transactions were interleaved with newer ones, this caused the scan to terminate prematurely, resulting in `0` rows being written to the annual report sheet.

- **Fix**: Modified `loadYear` in [171_AnnualLedger.js](file:///d:/Users/Peter/Documents/VillageHallCode/gitCode_Redesign/171_AnnualLedger.js#L154-L165) to only terminate the scan when it encounters a **cleared ACCOUNT row** (e.g. Bank, Cash, or Asset balance rows) belonging to an older year. Activities and uncleared rows (which naturally float across periods) are safely passed over without shutting down the scanner.





