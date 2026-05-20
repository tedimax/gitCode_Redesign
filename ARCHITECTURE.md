# Virtual Column Engine Architecture

This document outlines the architecture, data flow, and scalability strategies of the `gitCode_Redesign` framework for Google Apps Script. 

## 1. Core Philosophy
The redesigned engine moves away from procedural, hardcoded data pipelines towards a **Configuration-Driven, Object-Oriented** architecture. 
*   **Decoupled Responsibilities:** IO, Data Mapping, and Persistence are handled by distinct layers in an inheritance hierarchy.
*   **Performance First:** Heavy utilization of caching, array math, and V8 bypass strategies to circumvent Google Apps Script API quotas and execution time limits.
*   **Self-Healing:** The engine resolves its own formula dependency chains and safely manages its own memory bounds.

---

## 2. Class Hierarchy

The system operates on a strict prototype inheritance chain:

### Level 1: `Sheet` (`120_Sheet.js`)
*   **Role:** Raw Google Sheets IO and Physical Boundary Management.
*   **Responsibilities:** 
    *   Finds physical bounds (`firstDataRowIndex`, `getLastRowIndex()`).
    *   Handles bulk read/write operations (`getValues()`, `setValues()`).
    *   Generates and sanitizes Google Named Ranges.
    *   Manages the low-level `_window` memory cache.

### Level 2: `Table` (`130_Table.js`)
*   **Role:** Configuration and Metadata.
*   **Responsibilities:** 
    *   Parses the `NewAccounts_Sheets` and `NewAccounts_DataTypes` registries.
    *   Maintains the `_properties` dictionary (e.g., `SourceSheet`, `Key`, `SortField`).
    *   Extracts schema labels and determines key indices.

### Level 3: `UpdateTable` (`140_UpdateTable.js`)
*   **Role:** Persistence, Diffing, and Sorting.
*   **Responsibilities:**
    *   Implements the core diff engine using SHA-256 row hashing.
    *   Executes localized persistence modes: `replace`, `update`, `add`.
    *   Responsible for post-commit physical sorting.
    *   Executes Smart Garbage Collection (automatically flushes memory cache if mutations occurred).

### Level 4: `ImportTable` (`150_ImportTable.js`)
*   **Role:** The Virtual Column Mapping Engine.
*   **Responsibilities:**
    *   Parses the `NewAccounts_Formulas` registry.
    *   Hydrates missing mappings with implicit `[TargetField]` defaults.
    *   Resolves topological dependencies to ensure variables are computed in the correct order.
    *   Executes the Hybrid Execution Plan to construct the `_newData` matrix.

---

## 3. Data Transformation Lifecycle

When an import is triggered (e.g., `table.transform()` followed by `table.commit()`), data flows through a strict pipeline:

1. **Hydration & Topology (`150_ImportTable`)**: 
   The engine reads the formula registry. It identifies target dependencies (`calc.Field`) and builds a topological execution graph. It identifies source dependencies (`[Field]`) and categorizes the column complexity.
2. **Hybrid Row Execution (`150_ImportTable`)**: 
   The engine loops over the Driving Source Sheet.
   *   *Fast Path:* If a column is a pure 1:1 map, it natively slices the data from the array (`sourceRow[idx]`).
   *   *Standard Path:* If a column has complex math, it dynamically compiles and executes a V8 function.
3. **Type Casting (`248_TypeUtils`)**:
   Before being saved, every single cell is forced through strict type enforcement (Integer, String, Currency, Temporal Date) based on the `DataTypes` registry.
4. **Hashing & Diffing (`140_UpdateTable`)**:
   The engine generates a `Key` for the new row and a SHA-256 hash. It compares this against the target sheet's cache to mark the row as *Added* or *Dirty*.
5. **Persistence & Cleanup (`140_UpdateTable`)**:
   Only dirty/new rows are written to the physical sheet. The sheet is then physically sorted. Finally, the target table's memory cache is flushed to prevent downstream tasks from reading stale data.

---

## 4. Scalability & Performance Optimizations

The system was designed to handle massive end-of-year syncs without hitting the 50MB GAS memory limit or the 6-minute execution timeout.

*   **100% Native Batching:** The engine completely abandons cell-by-cell `getRange().getValue()` calls. Entire sheets are read into `_window` memory arrays and written back using `writeBlock()`.
*   **Hybrid Execution Plan:** V8 `eval` is notoriously slow. The execution plan analyzes formulas upfront and completely bypasses the execution compiler for columns that simply pull data from the source sheet, resulting in 10x faster row mapping.
*   **Fast Aligned Clones:** If an *entire sheet* consists of 1:1 mappings, the engine abandons the row-loop entirely and executes a native 2D array map, completing in milliseconds.
*   **O(1) Memory Lookups:** Cross-table reference functions (like `utils.lookup`) hold target tables in memory and use Hash Maps for instant $O(1)$ lookups, rather than expensive linear array scans.
*   **Smart Cache Retention:** If a delta-sync runs on a table but finds $0$ changed rows, `commit()` intelligently bypasses the Google Sheet `sort()` and preserves the RAM cache. This drastically cuts down on API reads during cascading syncs.

---

## 5. Financial Integrity Mandate (Fail-Fast)

This system operates as a financial-grade ledger server. **Data Integrity is prioritized over System Availability.**

*   **Hard Failures:** Silent fallbacks (e.g., substituting empty strings for errors) are strictly forbidden. If a transformation, lookup, or type-cast fails, the system MUST throw a critical exception and halt the process immediately.
*   **Registry Enforcement:** All tables must have a valid configuration in the `NewAccounts_Sheets` registry. If a table is instantiated without a corresponding config row (except during the bootstrap phase), the system will fail fast.
*   **Column Validation:** If a formula references a column that is missing from the source sheet, or if a target field lacks a valid data type, the engine must throw a CRITICAL MAPPING ERROR before writing any data.
*   **Auditability:** Every failure is logged with a physical row index and full stack trace to ensure immediate human correction of the underlying source data or mapping rules.
