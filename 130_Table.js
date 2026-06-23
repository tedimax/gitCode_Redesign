"use strict";

/**
 * gitCode_Redesign - Table Class (Level 2)
 * Represents the Logical & Property Layer.
 * Extends Sheet to provide configuration-driven logic, hashing, and type casting.
 */
class Table extends Sheet {
  constructor(ss, longName, properties = null) {
    super(ss, longName, properties);
    this._hashKeyMap = new Map();
    this._isHashed = false;
    this._keyMetadata = null;
    this._labels = null;
    this._modeOverride = null; // Internal override for Fluent API
    this._isInMemory = false;  // If true, persist() will not write to the sheet
    this._buffer = [];         // Stores results for in-memory runs
    this._validStartRow = null; // Physical row index of the first validated row
    this._validEndRow = null;   // Physical row index of the last validated row
    this._skipValidation = false; // Internal flag for fast lookups
    this.initializeHeaderMap();
  }

  /**
   * Fluent API: Forces 'update' mode for this specific instance.
   * @returns {Table}
   */
  withUpdateMode() {
    this._modeOverride = "update";
    return this;
  }  /**
   * Fluent API: Prevents physical writes to the sheet.
   * @returns {Table}
   */
  asInMemory() {
    this._isInMemory = true;
    return this;
  }

  /**
   * Returns the data generated during an in-memory execution.
   */
  getBuffer() {
    return this._buffer;
  }

  // =========================================================================
  // FOUNDATIONAL METHODS (CONSTRUCTOR HELPERS)
  // =========================================================================

  /**
   * Builds a Map of Label -> Column Offset.
   * Stores both the ordered array and the lookup map for O(1) retrieval.
   */

  // 2. Updated Initialization (where you build this.column)

  initializeHeaderMap() {
    const labelRowRawIndex = this.getProperty("LabelRow");
    // Coerce to a number to ensure type-safe comparison (e.g. string "0" vs number 0)
    const labelRowIndex = (labelRowRawIndex === null || labelRowRawIndex === undefined || labelRowRawIndex === "") ? 0 : Number(labelRowRawIndex);

    // 1. Capture and trim labels in their physical order (Skip if LabelRow is 0)
    const rawLabels = (labelRowIndex === 0) ? [] : this._fetchRowValues(labelRowIndex);
    this._labels = rawLabels.map(label => String(label || "").trim());

    // 2. Fail Fast: If no physical labels found but LabelRow is not 0, throw an error!
    const validLabelsCount = this._labels.filter(label => label !== "").length;
    if (validLabelsCount === 0 && labelRowIndex !== 0) {
      throw new Error(`[Schema Error: ${this.longName}] Physical sheet has no headers at row ${labelRowIndex}. ` +
        `The columnMap MUST be derived from physical headers. Please add headers to the sheet or set LabelRow to 0 in the Registry.`);
    } else if (labelRowIndex === 0) {
      myLog("trace", "Table %s: Confirmed as Raw/Output sheet (LabelRow=0).", this.longName);
    }
    this.initColumns()

    myLog("trace", "Initialized columns for %s with %d labels", this.longName, validLabelsCount);
  }

  // 1. Centralized cleaning logic (Helper method)
  _canonicalize(label) {
    if (typeof label !== 'string') return label;
    return label.trim().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  }

  initColumns() {
    const rawTarget = Object.fromEntries(
      this._labels
        .filter(label => label !== "")
        .map((label, offset) => [this._canonicalize(label), offset])
    );

    // Wrap in a Proxy to auto-clean keys on lookup
    const self = this; // Maintain reference to the class helper
    this.column = new Proxy(rawTarget, {
      get(target, prop) {
        if (typeof prop === 'string') {
          return target[self._canonicalize(prop)];
        }
        return Reflect.get(target, prop);
      }
    });
  }

  // =========================================================================
  // PROPERTY, COLUMN & CELL ACCESSORS (GETTERS/SETTERS)
  // =========================================================================

  /**
   * Safe access to table constants from the Sheets config.
   * Uses standardized O(1) lookup.
   */

  /**
   * Lazy accessor for the list of column labels.
   */
  getLabels() {
    return this._labels || [];
  }

  /**
   * Fluent setter to disable row validation for high-volume lookup tables.
   */
  withoutValidation() {
    this._skipValidation = true;
    return this;
  }

  /**
   * Data Access by Label
   */
  getValueByLabel(rowOffset, label) {
    try {
      return this.get(rowOffset, this.column[label]);
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getValueByLabel(${rowOffset}, "${label}") Failure: ${e.message}`);
    }
  }

  setValueByLabel(rowOffset, label, val) {
    try {
      this.set(rowOffset, this.column[label], val);
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] setValueByLabel(${rowOffset}, "${label}") Failure: ${e.message}`);
    }
  }

  /**
   * Bulk updates disjoint cells by column label using relative row offsets.
   */
  setValueByLabelAndRowOffsets(label, value, rowOffsetsArray) {
    this.setValueByColumnOffsetAndRowOffsets(this.column[label], value, rowOffsetsArray);
  }

  /**
   * Converts a window row into a JavaScript object.
   * Functional Pattern: .reduce() over columnMap.
   */
  getRowObjectByOffset(rowOffset) {
    try {
      if (rowOffset < 0 || rowOffset >= this.windowDataLength) {
        throw new Error(`Invalid row offset ${rowOffset} for object conversion. Window length: ${this.windowDataLength}`);
      }

      // Pass a dummy target object (or metadata) into the Proxy
      // We intercept reads and pull live from `this.get` via `this.column`
      return new Proxy({ _rowOffset: rowOffset }, {
        get: (target, prop) => {
          // Handle normal string property lookups (column names)
          if (typeof prop === 'string') {
            const colOff = this.column[prop]; // Reuses the exact proxy lookup from initColumns!
            if (colOff !== undefined) {
              return this.get(target._rowOffset, colOff);
            }
          }
          return Reflect.get(target, prop);
        },
        // Optional: Allows Object.keys() or spreading to work seamlessly if needed
        ownKeys: () => {
          return this._labels.filter(label => label !== "");
        },
        getOwnPropertyDescriptor: (target, prop) => {
          return { enumerable: true, configurable: true };
        }
      });

    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getRowObjectByOffset(${rowOffset}) Failure: ${e.message}`);
    }
  }

  // =========================================================================
  // FETCH & VALIDATION ENGINE
  // =========================================================================

  /**
   * Overrides Sheet.fetch to apply Incremental Strict Typing and Perimeter Validation.
   */
  fetch(startRow = null, numRows = null) {
    try {
      super.fetch(startRow, numRows);
      if (this.windowDataLength === 0) return;

      const labels = this.getLabels();
      const fieldTypes = labels.map(label => TypeUtils.getType(this.longName, label));

      // Resolve which physical range needs validation
      const winEndRow = this._windowStartRow + this.windowDataLength - 1;

      // We only validate rows that haven't been validated in this session
      const validateStart = this._validStartRow ? Math.min(this._windowStartRow, this._validStartRow) : this._windowStartRow;
      const validateEnd = this._validEndRow ? Math.max(winEndRow, this._validEndRow) : winEndRow;

      for (let pRow = validateStart; pRow <= validateEnd; pRow++) {
        // Skip if already validated OR if global bypass is active
        if (this._skipValidation) continue;
        if (this._validStartRow && this._validEndRow && pRow >= this._validStartRow && pRow <= this._validEndRow) continue;

        const rowOff = pRow - this._windowStartRow;
        const row = this._window[rowOff];
        const keyValue = this.getRowKey(row);

        // If the row has no key, it is a comment or spacer row. Bypass validation entirely.
        if (keyValue === null || keyValue === "") continue;

        let isCleared = true;
        let rawCleared = "true";
        if (this.column.cleared !== undefined) {
          rawCleared = row[this.column.cleared];
          isCleared = (String(rawCleared).toUpperCase() === "TRUE");
        } else if (this.column.group !== undefined) {
          const rawGroup = row[this.column.group];
          isCleared = (rawGroup !== undefined && rawGroup !== null && String(rawGroup).trim() !== "" && String(rawGroup).trim() !== "0");
          rawCleared = isCleared ? "true" : "false";
        }

        this._window[rowOff] = row.map((cell, colOff) => {
          const type = fieldTypes[colOff];
          const label = labels[colOff];
          const context = { row: pRow, col: label, sheet: this.longName };
          const val = TypeUtils.castType(cell, type);
          TypeUtils.validate(val, type, context);

          // Only enforce transaction-level mandatory field validation for actual financial ledger or merged/group sheets
          const isTransactionTable = this.longName.startsWith("Ledgers_") ||
            this.longName === CONFIG_CONSTANTS.MERGED_TABLE_NAME ||
            this.longName === "Reconciliation_UnChecked";

          let isMandatory = isTransactionTable && (CONFIG_CONSTANTS.MANDATORY_TABLE_FIELDS || []).includes(label);
          const entryType = this.column.entrytype !== undefined ? String(row[this.column.entrytype] || "").trim().toUpperCase() : "ACTIVITY";

          // Rule 1: Group is only mandatory once the row is Cleared
          if (label === "Group" && !isCleared) isMandatory = false;

          // Rule 2: Category is only mandatory for Activity rows (regardless of cleared status)
          if (label === "Category" && entryType !== "ACTIVITY") isMandatory = false;

          // Rule 3: FY is mandatory for all Account balance snapshots, but for anything else (Activity, etc), it's only mandatory if Cleared
          if (label === "FY") {
            if (entryType !== "ACCOUNT" && !isCleared) isMandatory = false;
          }

          // Note: Core fields (PK, Amount, Account) remain mandatory regardless of state.

          if (isMandatory && (val === "" || val === null || val === undefined)) {
            const stateInfo = `[Type: ${entryType}, Cleared: ${isCleared} (raw: "${rawCleared}")]`;
            throw new Error(`Validation Error ${stateInfo}: Mandatory field "${label}" is empty at row ${pRow} [Key: ${keyValue}].`);
          }

          if (isMandatory && label === "Group" && Number(val) === 0) {
            throw new Error(`Validation Error: Group ID cannot be zero at row ${pRow} [Key: ${keyValue}].`);
          }

          return val;
        });
      }

      // Update the validation bounds
      this._validStartRow = this._windowStartRow;
      this._validEndRow = winEndRow;
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] fetch(${startRow}, ${numRows}) Failure: ${e.message}`);
    }
  }

  fetchWindow() {
    if (!this._isFetched) {
      this.fetch(this.firstDataRowIndex);
    }
  }

  /**
   * Ensures that at least 'count' rows from the bottom are loaded and validated.
   */
  ensureRows(count) {
    const totalLast = this.getLastRowIndex();
    const targetStart = Math.max(this.firstDataRowIndex, totalLast - count + 1);

    if (!this._windowStartRow || targetStart < this._windowStartRow) {
      this.fetch(targetStart);
    }
  }

  // =========================================================================
  // KEY MANAGEMENT & HASH UTILITIES
  // =========================================================================

  /**
   * Lazy Getter for Key Metadata.
   * Parses the Registry property 'Key' or 'KeyFields' to build the metadata schema.
   * This ensures we only perform column lookups once, and cache the result.
   */
  getKeyMetadata() {
    // 1. Lazy Cache Guard: Return the schema immediately if we've already built it.
    if (this._keyMetadata) return this._keyMetadata;

    // 2. Read Registry Configuration: Look for primary keys or composite key definitions.
    const targetKeyField = this.getProperty("Key");
    const keyFieldsRaw = this.getProperty("KeyFields");

    // 3. Schema Resolution: We use a switch(true) for strict priority routing.
    switch (true) {
      case !!targetKeyField: {
        // PRIORITY 1: Single Key
        // If a 'Key' is explicitly defined (e.g., "PK"), it overrides everything else.

        // Cache the metadata schema
        this._keyMetadata = {
          type: "single",
          offset: this.column[targetKeyField],
          fieldType: TypeUtils.getType(this.longName, targetKeyField)
        };
        break;
      }

      case !!keyFieldsRaw: {
        // PRIORITY 2: Composite Key (Fallback)
        // If no Single Key exists, check if multiple columns are grouped to form a unique hash.
        const fieldList = String(keyFieldsRaw).split(",").map(field => field.trim());

        this._keyMetadata = {
          type: "composite",
          fields: fieldList.map(field => {
            const fieldOffset = this.column[field];

            // Fail-Fast: Every sub-field in the composite key must physically exist.
            if (fieldOffset === undefined) throw new Error("CRITICAL: KeyField '" + field + "' not found in " + this.longName);

            return {
              offset: fieldOffset,
              type: TypeUtils.getType(this.longName, field)
            };
          })
        };
        break;
      }

      default:
        // FAIL-FAST: A Table without a defined Primary Key cannot safely perform Replace/Update operations.
        const available = Object.keys(this._properties).join(", ");
        throw new Error(`CRITICAL: Table ${this.longName} has no 'Key' or 'KeyFields' configured in the registry. Available properties: [${available}]. Check your spreadsheet column headers.`);
    }

    return this._keyMetadata;
  }

  /**
   * Calculates the primary key for a given row array.
   * @param {Array} row The row data array.
   * @param {number} pRow Optional physical row number for logging context.
   */
  getRowKey(row, pRow = null) {
    try {
      // 1. Fetch the cached metadata schema (Single vs Composite)
      const meta = this.getKeyMetadata();

      if (meta.type === "single") {
        // --- SINGLE KEY RESOLUTION ---
        const rawVal = row[meta.offset];

        // "Ghost Row" Guard: If the primary key cell is entirely empty, treat the row as a spacer/ghost row.
        // Returning null signals to the engine that this row should be skipped entirely.
        if (rawVal === undefined || rawVal === "") return null;

        // Cast the value strictly according to the TypeUtils definition to ensure exact matching 
        // (e.g. converting numeric strings to numbers, formatting dates)
        const val = TypeUtils.castType(rawVal, meta.fieldType);
        return val === null ? null : String(val).trim();
      } else {
        // --- COMPOSITE KEY RESOLUTION ---
        if (meta.fields.length === 0) return null;

        let allEmpty = true;

        // Map over all configured composite fields to build a pipe-delimited string of values
        const compositeValue = meta.fields.map(fieldMeta => {
          const rawCell = row[fieldMeta.offset];

          // Track if the entire composite footprint is blank (another Ghost Row check)
          if (rawCell !== undefined && rawCell !== null && String(rawCell).trim() !== "") {
            allEmpty = false;
          }

          // Strictly cast and normalize each piece of the composite key to guarantee consistent hashing
          const val = TypeUtils.castType(rawCell, fieldMeta.type);
          return String(val || "").trim().toLowerCase();
        }).join("|");

        // If every single column that makes up the composite key is empty, it's a ghost row. Skip it.
        if (allEmpty) return null;

        // Pass the standardized, pipe-delimited string through a cryptographic hash function
        // to generate a reliable, collision-resistant string ID (e.g., an MD5/SHA hash).
        return CryptoUtils.generateHash(compositeValue);
      }
    } catch (e) {
      throw new Error(`[Logical Layer: ${this.longName}] getRowKey() Failure: ${e.message}`);
    }
  }

  /**
   * Scans the physical table rows in memory, identifies duplicate rows by their calculated Primary Key,
   * and clears/rewrites the table in-place leaving only the first occurrence of each unique key.
   *
   * @returns {Object} Statistics about the operation: { beforeCount, afterCount, duplicatesRemoved }
   */
  deduplicate() {
    this.withoutValidation();

    const labelRowRaw = this.getProperty("LabelRow");
    const labelRow = (labelRowRaw === null || labelRowRaw === undefined || labelRowRaw === "") ? 1 : Number(labelRowRaw);
    const startRow = labelRow + 1;

    // 1. Force load the entire physical sheet from the label row + 1
    this.clearCache();
    this.fetch(startRow);
    const window = this.getWindow();
    const beforeCount = window.length;

    if (window.length === 0) {
      myLog("info", "Deduplicate %s: Sheet is already empty.", this.longName);
      return { beforeCount: 0, afterCount: 0, duplicatesRemoved: 0 };
    }

    // 2. Identify and filter out duplicate rows
    // 2. Identify and filter out duplicate rows functionally
    const { deduplicatedRows, duplicatePKs } = window.reduce((acc, row, rOff) => {
      const keyRaw = this.getRowKey(row);

      if (!keyRaw) {
        // If a row has no PK, preserve it blindly
        acc.deduplicatedRows.push(row);
        return acc;
      }

      const trimmedKey = String(keyRaw).trim();
      const normalizedKey = trimmedKey.toLowerCase();

      if (acc.seenKeys.has(normalizedKey)) {
        myLog("info", "Deduplicate %s: Identified duplicate PK '%s' at row offset %d", this.longName, keyRaw, rOff);
        acc.duplicatePKs.push(trimmedKey);
      } else {
        acc.seenKeys.add(normalizedKey);
        acc.deduplicatedRows.push(row);
      }

      return acc;
    }, { deduplicatedRows: [], duplicatePKs: [], seenKeys: new Set() });

    const afterCount = deduplicatedRows.length;
    const duplicatesRemoved = beforeCount - afterCount;

    if (duplicatesRemoved > 0) {
      // 3. Clear data area and write deduplicated rows back to the sheet
      myLog("info", "Deduplicate %s: Removing %d duplicates...", this.longName, duplicatesRemoved);

      const lastRow = this.getLastRowIndex();
      if (lastRow >= startRow) {
        this.sheet.getRange(startRow, 1, lastRow - startRow + 1, this.getLastColumnIndex()).clearContent();
      }
      this._cachedLastRowIndex = startRow - 1;
      this._maxWrittenRow = 0;

      this.writeChunks(startRow, deduplicatedRows);
      this.clearCache();
      myLog("info", "Deduplicate %s COMPLETE. Kept %d / %d rows.", this.longName, afterCount, beforeCount);
    } else {
      myLog("info", "Deduplicate %s: No duplicates found. Kept all %d rows.", this.longName, beforeCount);
    }

    return { beforeCount, afterCount, duplicatesRemoved, duplicatePKs };
  }

  /**
 * Initializes and populates the Primary Key Hash Map.
 * This provides O(1) lookups for deduplication during Update/Replace operations.
 */
  buildHashKeyMap() {
    // Use flatMap to build key-value pairs while natively satisfying type inference (no nulls)
    this._hashKeyMap = new Map(
      this.getWindow().flatMap((row, index) => {
        const key = this.getRowKey(row);
        return key ? [[String(key).trim().toLowerCase(), index]] : [];
      })
    );

    this._isHashed = true;

    myLog("trace", "Table %s: Hashed %d keys from RAM window.", this.longName, this._hashKeyMap.size);
  }

  /**
   * Lazy accessor for the Hash Key Map.
   * Ensures the map is built exactly once on demand.
   */
  getHashKeyMap() {
    if (!this._isHashed) this.buildHashKeyMap();
    return this._hashKeyMap;
  }

  getRowOffsetFromKey(key) {
    return this.getHashKeyMap().get(String(key).trim().toLowerCase());
  }

  /**
   * High-Performance In-Memory VLOOKUP.
   * Retrieves a specific value from a target column by searching for a key in a key column.
   * Builds a lazy, nested cache (Map of Maps) for KeyCol -> ValCol to guarantee O(1) retrieval
   * even if called thousands of times consecutively.
   * 
   * @param {string} keyCol The column name to search inside.
   * @param {string} valCol The column name containing the return value.
   * @param {any} searchVal The target value to search for.
   */
  lookupValue(keyCol, valCol, searchVal) {
    // 1. Initialize the master cache Map if this is the first lookup on this Table
    if (!this._lookupCacheMap) this._lookupCacheMap = new Map();

    // Create a unique cache string for this specific column combination (e.g. "LongName_KeyPrefix")
    const cacheKey = `${keyCol}_${valCol}`;

    // 2. Cache Miss: We have never performed a lookup for this column pair yet
    if (!this._lookupCacheMap.has(cacheKey)) {

      // Fail safely if the columns don't physically exist in the sheet
      if (this.column[keyCol] === undefined || this.column[valCol] === undefined) return "";

      const lookupMap = new Map();
      this._lookupCacheMap.set(cacheKey, lookupMap);

      if (this.longName === "Reconciliation_Groups") {
        this._lookupLastRowFetched = this.getLastRowIndex();
        myLog("info", "Registry: Initialized backward chunk lookup cache for %s (%s->%s), bottom row is %d",
          this.longName, keyCol, valCol, this._lookupLastRowFetched);
      } else {
        // Force the RAM window to load in full for other smaller config tables
        this.fetch(this.firstDataRowIndex);

        this._window.forEach(row => {
          const k = row[this.column[keyCol]];
          if (k !== undefined && k !== "") {
            lookupMap.set(String(k).toLowerCase(), row[this.column[valCol]]);
          }
        });
        myLog("trace", "Built lookup cache for %s (%s->%s)", this.longName, keyCol, valCol);
      }
    }

    const lookupMap = this._lookupCacheMap.get(cacheKey);
    const searchKeyLower = String(searchVal).toLowerCase();

    // 3. Backward Chunk Scan Fallback: If searching Reconciliation_Groups and not yet in cache, fetch next chunk of CONFIG_CONSTANTS.SHEET_CHUNK_SIZE rows
    if (this.longName === "Reconciliation_Groups" && !lookupMap.has(searchKeyLower) && this._lookupLastRowFetched && this._lookupLastRowFetched >= this.firstDataRowIndex) {
      const chunkSize = CONFIG_CONSTANTS.SHEET_CHUNK_SIZE;

      while (!lookupMap.has(searchKeyLower) && this._lookupLastRowFetched >= this.firstDataRowIndex) {
        const startRow = Math.max(this.firstDataRowIndex, this._lookupLastRowFetched - chunkSize + 1);
        const numRows = this._lookupLastRowFetched - startRow + 1;

        myLog("info", "Groups Lookup: Scanning backward chunk from row %d to %d for Group '%s'...", startRow, this._lookupLastRowFetched, searchVal);

        this.fetch(startRow, numRows);

        this._window.forEach(row => {
          const k = row[this.column[keyCol]];
          if (k !== undefined && k !== "") {
            lookupMap.set(String(k).toLowerCase(), row[this.column[valCol]]);
          }
        });

        this._lookupLastRowFetched = startRow - 1;
      }
    }

    // 4. Cache Hit: Instantly retrieve the value in O(1) time
    return lookupMap.get(searchKeyLower) || "";
  }

  /**
   * Calculates required Named Ranges and delegates creation to the Physical layer.
   */
  writeNamedRanges() {
    if (!this.sheet) {
      myLog("warn", `Cannot write named ranges for Virtual Sheet: ${this.longName}`);
      return;
    }

    const labelRowRaw = this.getProperty("LabelRow");
    const labelRow = (labelRowRaw == null || labelRowRaw === "") ? 1 : Number(labelRowRaw);
    const startRow = labelRow + 1;
    const endRow = this.sheet.getMaxRows();
    const lastCol = this.getLastColumnIndex();

    if (endRow < startRow || lastCol === 0) return;

    const numRows = endRow - startRow + 1;
    const safeSheetName = Utils.cleanNameForRange(this.sheetName);

    // 1. SheetNameSheet (Row 1 to end)
    this.writeNamedRange(`${safeSheetName}Sheet`, 1, 1, endRow, lastCol);

    // 2. SheetNameData (Row LabelRow+1 to end)
    this.writeNamedRange(`${safeSheetName}Data`, startRow, 1, numRows, lastCol);

    // 3. SheetNameColumnName (Per column)
    this.getLabels().forEach(label => {
      const colOff = this.column[label];
      if (colOff !== undefined) {
        this.writeNamedRange(safeSheetName + Utils.cleanNameForRange(label), startRow, colOff + 1, numRows, 1);
      }
    });

    myLog("info", `Successfully wrote Named Ranges for ${this.longName}`);
  }


  /**
   * Scans the physical sheet to find the first row that matches or follows the target date.
   * Useful for setting the ingestion window for a specific Financial Year.
   * @param {Date} targetDate
   * @param {string} dateLabel - The name of the column to scan (defaults to 'Date')
   * @returns {number} The physical row index.
   */
  calculateFirstRowByDate(targetDate, dateLabel = "Date") {
    if (!this.sheet) return this.firstDataRowIndex;


    if (this.column[dateLabel] === undefined) {
      myLog("warn", "Table %s: Cannot calculate FirstRow by date. Column '%s' not found.", this.longName, dateLabel);
      return this.firstDataRowIndex;
    }

    // Fetch only the date column for efficiency
    const lastRow = this.getLastRowIndex();

    let labelRow = Number(this.getProperty("LabelRow"));
    if (isNaN(labelRow) || labelRow === undefined || labelRow === null) {
      labelRow = 1;
    }
    const searchStartRow = labelRow + 1; // Always scan from the top of the data

    if (lastRow < searchStartRow) return searchStartRow;

    const dateValues = this.sheet.getRange(searchStartRow, this.column[dateLabel] + 1, lastRow - searchStartRow + 1, 1).getValues();
    const targetTime = targetDate.getTime();

    for (let i = 0; i < dateValues.length; i++) {
      const cellValue = dateValues[i][0];
      const cellDate = cellValue instanceof Date ? cellValue : new Date(cellValue);

      if (!isNaN(cellDate.getTime())) {
        if (cellDate.getTime() >= targetTime) {
          return i + searchStartRow;
        }
      }
    }
    return lastRow; // Default to end if no future dates found
  }

  /**
   * Generates and writes keys for rows that have dates but no keys.
   */
  makeKeys() {
    const keyFieldName = this.getProperty("Key");
    const dateFieldName = this.getProperty("DateField");
    const keyPrefix = this.getProperty("KeyPrefix") || "";

    let count = 0;
    this.getWindow().forEach((row, rowOffset) => {
      const keyVal = row[this.column[keyFieldName]];
      const dateVal = row[this.column[dateFieldName]];
      const hasDate = dateVal !== "" && dateVal !== null && dateVal !== undefined;
      const hasNoKey = keyVal === "" || keyVal === null || keyVal === undefined;

      if (hasNoKey && hasDate) {
        const newKey = this.makeKey(dateVal, keyPrefix);
        const physicalRow = this.firstDataRowIndex + rowOffset;
        this.sheet.getRange(physicalRow, this.column[keyFieldName] + 1).setValue(newKey);
        this.set(rowOffset, this.column[keyFieldName], newKey);
        count++;
      }
    });

    if (count > 0) {
      myLog("info", "Generated and saved %d keys in %s", count, this.longName);
      SpreadsheetApp.flush();
    }
  }

  /**
   * Generates a unique key based on date, prefix, and a random string.
   */
  makeKey(date = new Date(), prefix = "", length = 6) {
    let d = (typeof date === 'string') ? new Date(date) : date;
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randStr = "";
    for (let i = 0; i < length; i++) {
      randStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return prefix + "#" + dateStr + "_" + randStr;
  }
}

// Register with globals
globals.tableMap['Table'] = Table;
