# Virtual Column Formula Specification

This document defines the syntax and execution context for formulas used in the `gitCode_Redesign` mapping engine.

## 1. The Language: "Augmented JavaScript"
All formulas are essentially JavaScript (ES6+) expressions. They are executed within a sandboxed `new Function()` context after being pre-processed to expand shorthand references.

## 2. Grammar (BNF)
```bnf
<formula>           ::= <js_expression> | <shorthand_ref> | <constant>
<shorthand_ref>     ::= ( <long_name> )? "[" <column_name> "]"
<long_name>         ::= <spreadsheet_name> "_" <sheet_name>
<spreadsheet_name>  ::= [a-zA-Z0-9]+
<sheet_name>        ::= [a-zA-Z0-9]+
<column_name>       ::= [a-zA-Z0-9_ ]+

<js_expression>     ::= <expression_part> ( <operator> <expression_part> )*
<expression_part>   ::= <shorthand_ref> | <scoped_obj> | <constant> | "(" <js_expression> ")"
<scoped_obj>        ::= "utils." <util_method> | "props." <prop_key> | "calc." <target_col> | "constants." <const_key>

<util_method>       ::= "lookup(" <string> "," <string> "," <string> "," <any> ")" 
                      | "hash(" <any> ( "," <any> )* ")"
                      | "DateUtils." <date_fn>
                      | "StringUtils." <string_fn>
<prop_key>          ::= "KeyPrefix" | "SSID" | "SheetType" | [Any Column in NewAccounts_Sheets]
<target_col>        ::= [Any previously processed column in the current row]
<constant>          ::= <number> | <string_literal> | <boolean>
```

## 3. Core Concepts

| Concept | Syntax Example | Description |
| :--- | :--- | :--- |
| **Shorthand Ref** | `Archive_Ledger[Amount]` or `[Amount]` | Automatically expanded to a row-aware data lookup for the current index. If `long_name` is omitted, defaults to the table's SourceSheet. |
| **Implicit Default** | *(Empty Formula)* | If no formula/source field is specified, it defaults to the same name as the target field, looking in the default SourceSheet (equivalent to `[TargetFieldName]`). |
| **Target Calc** | `calc.BasePrice * 1.2` | Accesses a column value calculated *earlier in the same row* during the current import. |
| **Sheet Config** | `props.KeyPrefix` | Accesses the configuration parameters for the current destination sheet from `NewAccounts_Sheets`. |
| **Lookup Map** | `utils.lookup("Map_Categories", "ID", "Name", [CatID])` | Performs a high-speed O(1) cached search in another sheet. |
| **Stable Hash** | `utils.hash([Date], [ID])` | Generates a SHA-256 hex string used for creating unique primary keys. |

## 4. Execution Context
Every formula has the following parameters injected into its scope:
*   **i**: The current row index (0-indexed).
*   **calc**: An object containing the results of previous columns in the current row.
*   **props**: The configuration row for the target table (from `NewAccounts_Sheets`).
*   **utils**: A library containing `DateUtils`, `StringUtils`, `Temporal`, `lookup`, `getVal`, and `hash`.
*   **constants**: Global system-wide constants.

## 5. Logic Flow
1.  **Parse**: The `FormulaUtils.parse` pre-processor replaces all `SheetName[Col]` and `[Col]` patterns with `utils.getVal(...)`.
2.  **Compile**: The logic snippet is turned into an executable JS function.
3.  **Execute**: The function runs for every row in the driving source.
4.  **Cast**: The resulting value is strictly typed (Date, Currency, etc.) based on the `NewAccounts_DataTypes` sheet.
5.  **Commit**: The typed value is written to the table's internal data matrix.
