# Formula Engine: Syntax & Usage Guide

The `gitCode_Redesign` system uses a **Virtual Column Mapping Engine**. Formulas are written in the `NewAccounts_Formulas` sheet and compiled into high-performance Javascript functions.

---

## 1. Core Syntax

### Column References
*   **`[Amount]`**: References a column in the **current** driving source.
*   **`Bank[Amount]`**: References a column in a **specific** table named "Bank".

### Pure Javascript
Anything outside of the square brackets is standard Javascript.
*   `[Qty] * [Price]`
*   `([Amount] > 100) ? "High" : "Low"`
*   `[Name].toUpperCase()`
*   `Math.abs([Amount])`

---

## 2. Local vs. Remote References

### Local: `calc`
Use `calc` to reference a virtual column that you defined in the **same table**.
*   **TargetField**: `AnnualSummaries[Net]`
*   **Formula**: `calc.Gross - calc.Tax`
*   *Note: This is faster than reaching back to the source because it uses the values already calculated in the current row loop.*

### Remote: `utils.getVal()`
The `[]` syntax automatically uses `utils.getVal()` under the hood to reach out to physical or virtual sheets.
*   `lookup(Members, [ID], [Name])`

---

## 3. Specialized Shorthands

### `merge(...)` (The Virtual Union)
Used to consolidate multiple sheets with different naming conventions into one unified report.

*   **Syntax**: `merge(SheetName: [OverrideField], ...)`
*   **Usage**: `merge(Cash: [Tendered], Square: [Net])`
*   **Logic**: 
    1. It checks which source sheet the current row came from.
    2. If it's "Cash", it pulls `[Tendered]`.
    3. If it's "Square", it pulls `[Net]`.
    4. Otherwise, it defaults to the `[TargetField]` name (e.g., `[Amount]`).

### `lookup(...)`
Performs a fast, indexed lookup against another table.

*   **Syntax**: `lookup(TableName, SearchColumn, ResultColumn, SearchValue)`
*   **Usage**: `lookup(Categories, [CategoryID], [CategoryName], [ID])`

### `truth(...)`
Safely casts a value to a Boolean (True/False). Useful for filtering or status flags.

*   **Syntax**: `truth([Field])`
*   **Example**: `truth([IsPaid])` -> returns `true` for "TRUE", 1, "Yes", etc.

---

## 4. Built-in Utilities
The `utils` object provides access to the project's standard library:

*   **`utils.DateUtils`**: `formatToYYYYMMDD([Date])`, `getYear([Date])`.
*   **`utils.StringUtils`**: `clean([Name])`, `toTitleCase([Text])`.
*   **`utils.hash(...)`**: Generates a stable SHA-256 hash of the provided arguments.
*   **`utils.pk(prefix, date, hash)`**: Generates a standard Village Hall Primary Key.

---

## 5. Architectural Patterns

### Mapping by Exception (Harmonization)
Instead of a complex merge formula, you can define "Virtual Columns" on your source sheets to make them match the report's expected schema.

1.  **Source Fix**: `Ledgers_Cash[Amount]` = `[Tendered]`
2.  **Report Logic**: Now your report just uses `[Amount]`. It works for `Bank` (physical) and `Cash` (virtual) without any special code in the report itself.

### Double Implicit Mapping
If you use a trailing underscore in a `merge` or `lookup`, the engine automatically pivots to the current report's year.
*   **Context**: `AnnualSummaries_2023`
*   **Formula**: `merge(Ledgers_)` -> expands to `Ledgers_2023`.

---

## 6. Comment Rows
You can add descriptive rows to your formulas sheet to group or document sections of logic.

*   **Syntax**: Any row where the **TargetField** starts with `//` or `#` is ignored.
*   **Example**:
    *   `TargetField`: `// --- REVENUE FORMULAS ---`
    *   `Formula`: (empty)
*   *Note: This is useful for keeping large formula sheets organized and readable.*
