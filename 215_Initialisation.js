/**
 * gitCode_Redesign - Patch Manager
 * Handles global, JSON-based row overrides for auditability.
 */
const PatchManager = (() => {
  const _patches = new Map(); // TableName -> Map(PK -> PatchObject)

  return {
    hydrate() {
      if (!globals.correctionsObj) return;
      
      const pkOff = globals.correctionsObj.getColOffset(CONFIG_CONSTANTS.CORRECTIONS_CONFIG_PK);
      const patchOff = globals.correctionsObj.getColOffset("PatchData");
      
      if (pkOff === -1 || patchOff === -1) {
        throw new Error("Bootstrap Failure: PatchManager Corrections sheet is missing mandatory columns [GlobalID, PatchData].");
      }

      globals.correctionsObj.getWindow().forEach(row => {
        const globalId = String(row[pkOff] || "").trim();
        const patchJson = String(row[patchOff] || "").trim();
        
        if (!globalId || !patchJson) return;

        try {
          const [tableName, pk] = globalId.split("@");
          if (!tableName || !pk) {
            throw new Error(`Bootstrap Failure: PatchManager found invalid GlobalID format '${globalId}'. Expected 'TableName@PK'.`);
          }

          if (!_patches.has(tableName)) _patches.set(tableName, new Map());
          _patches.get(tableName).set(String(pk).trim().toLowerCase(), JSON.parse(patchJson));
        } catch (e) {
          throw new Error(`Bootstrap Failure: PatchManager failed to parse JSON patch for '${globalId}': ${e.message}`);
        }
      });
      
      myLog("info", "PatchManager: Hydrated patches for %d tables.", _patches.size);
    },

    getPatch(tableName, pk) {
      const tablePatches = _patches.get(tableName);
      if (!tablePatches) return null;
      
      const patch = tablePatches.get(String(pk).trim().toLowerCase());
      if (patch) {
        patch._isConsumed = true; // Mark as used
      }
      return patch;
    },

    /**
     * Returns all patches for a table that were NOT applied during the transform.
     * These are treated as "New Entries" (Ghost Rows).
     */
    getUnusedPatches(tableName) {
      const tablePatches = _patches.get(tableName);
      if (!tablePatches) return [];
      
      const unused = [];
      tablePatches.forEach((patch, pk) => {
        if (!patch._isConsumed) {
          // Ensure the PK is part of the object so the Table logic can see it
          unused.push({ ...patch, PK: pk });
        }
      });
      return unused;
    }
  };
})();

/**
 * gitCode_Redesign - Registry Singleton
 * Provides high-performance, pre-indexed access to system configuration.
 */
const Registry = (() => {
  const _sheets = new Map();    // LongName -> Config Object
  const _sheetsByName = new Map(); // SheetName -> Config Object
  const _formulas = new Map();  // LongName -> Array of Formula Rows
  const _dataTypes = new Map(); // LongName:Column -> Type String

  return {
    /**
     * Internal helper to normalize and index DataTypes.
     * Can be called early during bootstrap.
     */
    hydrateTypes() {
      if (globals.dataTypesMap) {
        globals.dataTypesMap.forEach((type, ref) => {
          let normalized = ref;
          const match = ref.match(/^(?:\[([^\]]+)\]|([^\[:]+))[:\[]?([^\]]*)\]?$/);
          if (match) {
            const table = (match[1] || match[2]).trim();
            const col = match[3].trim();
            if (col) normalized = `${table}:${col}`;
          }
          _dataTypes.set(normalized.toUpperCase(), type);
        });
      }
    },

    hydrate() {
      // 1. Index Sheets
      if (globals.sheetsObj) {
        const labels = globals.sheetsObj.getLabels();
        globals.sheetsObj.getWindow().forEach((row, idx) => {
          const config = globals.sheetsObj.getRowObjectByOffset(idx);
          
          // --- NEW: Parse JSON Properties ---
          if (config.Properties) {
            try {
              const extra = JSON.parse(config.Properties);
              Object.assign(config, extra);
              if (config.LongName === "Ledgers_Bank") {
                myLog("trace", "Registry Hydration [Ledgers_Bank]: Merged properties -> %s", JSON.stringify(extra));
              }
            } catch (e) {
              throw new Error(`Bootstrap Failure: Failed to parse JSON Properties for sheet '${config.LongName}': ${e.message}`);
            }
          }
          
          if (config.LongName) {
            const trimmedLongName = String(config.LongName).trim();
            _sheets.set(trimmedLongName, config);
            
            const sheetName = (config.SheetName || trimmedLongName.split('_').slice(1).join('_')).trim();
            _sheetsByName.set(sheetName, config);
          } else {
            myLog("warn", "Registry: Found row with missing LongName at index %d", idx);
          }
        });
      }

      // 2. Index Formulas (Grouped by Table)
      if (globals.formulasObj) {
        const targetFieldOff = globals.formulasObj.getColOffset(CONFIG_CONSTANTS.FORMULAS_CONFIG_PK);
        const formulaOff = globals.formulasObj.getColOffset("Formula");
        
        globals.formulasObj.getWindow().forEach(row => {
          const fullRef = String(row[targetFieldOff] || "").trim();
          
          // --- NEW: Skip Comment Rows ---
          if (fullRef.startsWith("//") || fullRef.startsWith("#") || fullRef === "") return;

          const match = fullRef.match(/^([^\[]+)\[(.*?)\]/);
          if (match) {
            const longName = match[1].trim();
            const fieldName = match[2].trim();
            if (!_formulas.has(longName)) _formulas.set(longName, []);
            
            const formula = String(row[formulaOff] || "").trim();
            const obj = { 
               targetField: fieldName, 
               formula: formula === "" ? `[${fieldName}]` : formula,
               SourceTable: longName
            };
            
            _formulas.get(longName).push(obj);
          }
        });
      }

      // 3. Index DataTypes (Full Pass)
      this.hydrateTypes();
      
      myLog("info", "Registry hydrated: %d sheets, %d formula groups, %d types.", _sheets.size, _formulas.size, _dataTypes.size);
    },

    lookupValue(pkValue, targetField) {
      if (!globals.sheetsObj) return null;
      const val = globals.sheetsObj.lookupValue(CONFIG_CONSTANTS.SHEETS_CONFIG_PK, targetField, pkValue);
      
      if (globals.sheetsObj.getColOffset(targetField) === -1) {
         myLog("trace", "Registry Column Missing [%s]: Column '%s' not found in config sheet.", 
           CONFIG_CONSTANTS.SHEETS_CONFIG_NAME, targetField);
      }

      return val === "" ? null : val;
    },

    getSheetConfig: (longName) => {
      const trimmed = String(longName || "").trim();
      const config = _sheets.get(trimmed);
      if (!config) {
        throw new Error(`Registry Configuration Error: The sheet identifier '${trimmed}' is not configured in the 'NewAccounts_Sheets' Registry.\n\n` +
          `👉 Action Required: Please open your 'NewAccounts_Sheets' configuration table and verify that a row exists with LongName = '${trimmed}'.\n\n` +
          `Available registered sheets: [${Array.from(_sheets.keys()).join(", ")}]`);
      }
      return config;
    },
    getSheetConfigBySheetName: (sheetName) => _sheetsByName.get(String(sheetName || "").trim()),
    getFormulasFor: (longName) => {
      const formulas = _formulas.get(longName) || [];
      if (formulas.length === 0) {
        myLog("info", "No explicit formulas found for %s in Registry. Defaulting to 1:1 mapping.", longName);
      }
      return formulas;
    },
    getType: (longName, colName) => {
      const key = `${String(longName || "").trim()}:${String(colName || "").trim()}`.toUpperCase();
      return _dataTypes.get(key) || "String";
    },

    /**
     * Force a full re-read of the Registry tables from the spreadsheet.
     */
    refresh() {
      myLog("info", "Registry: Force refreshing configuration tables and instance cache...");
      if (globals.sheetsObj) globals.sheetsObj.clearCache();
      if (globals.formulasObj) globals.formulasObj.clearCache();
      if (globals.dataTypesObj) globals.dataTypesObj.clearCache();
      if (globals.correctionsObj) globals.correctionsObj.clearCache();
      
      // CRITICAL: Clear the instance cache so objects are re-created with new properties
      globals.sheetInstances = {};
      
      // Re-register configuration singletons
      if (globals.sheetsObj) globals.sheetInstances[CONFIG_CONSTANTS.SHEETS_CONFIG_NAME] = globals.sheetsObj;
      if (globals.dataTypesObj) globals.sheetInstances[CONFIG_CONSTANTS.DATATYPES_SHEET_NAME] = globals.dataTypesObj;
      if (globals.formulasObj) globals.sheetInstances[CONFIG_CONSTANTS.FORMULAS_SHEET_NAME] = globals.formulasObj;
      if (globals.correctionsObj) globals.sheetInstances[CONFIG_CONSTANTS.CORRECTIONS_SHEET_NAME] = globals.correctionsObj;

      _sheets.clear();
      _sheetsByName.clear();
      _formulas.clear();
      _dataTypes.clear();
      this.hydrate();
    }
  };
})();

/**
 * gitCode_Redesign - System Initialization
 * Bootstraps the registries from the NewAccounts source of truth.
 */
function initialize() {
  if (globals.initialized) return;

  myLog("info", "Bootstrapping gitCode_Redesign system (" + (CONFIG_CONSTANTS.VERSION || "unknown") + ")...");

  // Stage 1: Anchor Spreadsheet
  const anchorSS = SpreadsheetApp.openById(globals.defaultSSID);
  globals.spreadsheetInstances[globals.defaultSSID] = anchorSS;

  // Stage 2: Sheets Config (The "Map of the World")
  const sheetsConfig = {
    SheetName: CONFIG_CONSTANTS.SHEETS_CONFIG_NAME.split("_")[1],
    FirstRow: CONFIG_CONSTANTS.DEFAULT_FIRST_ROW,
    LabelRow: CONFIG_CONSTANTS.DEFAULT_LABEL_ROW,
    Key: CONFIG_CONSTANTS.SHEETS_CONFIG_PK
  };
  globals.sheetsObj = new Table(anchorSS, CONFIG_CONSTANTS.SHEETS_CONFIG_NAME, sheetsConfig);
  globals.sheetInstances[CONFIG_CONSTANTS.SHEETS_CONFIG_NAME] = globals.sheetsObj;

  // Stage 3: SSID Map (Strict matching)
  const ssNameOff = globals.sheetsObj.getColOffset("SpreadSheetName");
  const ssidOff = globals.sheetsObj.getColOffset("SSID");
  
  if (ssNameOff === -1 || ssidOff === -1) {
    const labels = globals.sheetsObj.getLabels();
    throw new Error(`Registry Initialization Failed: Missing mandatory column(s) in "${CONFIG_CONSTANTS.SHEETS_CONFIG_NAME}". 
    Expected: "SpreadSheetName" and "SSID". 
    Found Columns: [${labels.join(", ")}]. 
    Please ensure your configuration sheet exactly matches the required header names (Case-Sensitive).`);
  }

  globals.ssMap = new Map(globals.sheetsObj.getWindow()
    .filter(row => row[ssNameOff] && row[ssidOff])
    .map(row => {
      const name = String(row[ssNameOff]).trim();
      const id = String(row[ssidOff]).trim();
      return [name, id];
    })
  );

  // Index initial sheets to enable lookupValue
  Registry.hydrate();

  // Stage 4: DataType Hydration (Registry-Driven)
  const dtName = CONFIG_CONSTANTS.DATATYPES_SHEET_NAME;
  const dtFirstRow = Registry.lookupValue(dtName, "FirstRow");
  const dtLabelRow = Registry.lookupValue(dtName, "LabelRow");
  const dtKey = Registry.lookupValue(dtName, "Key");
  
  if (!dtFirstRow || !dtLabelRow || !dtKey) {
    throw new Error(`Bootstrap Failure: Missing mandatory Registry metadata for "${dtName}". Check columns [FirstRow, LabelRow, Key].`);
  }

  myLog("info", "Configuring %s: Row %d, Labels at %d, Key: %s", dtName, dtFirstRow, dtLabelRow, dtKey);

  const datatypesConfig = {
    SheetName: dtName.split("_")[1],
    FirstRow: dtFirstRow,
    LabelRow: dtLabelRow,
    Key: dtKey
  };
  globals.dataTypesObj = new Table(anchorSS, dtName, datatypesConfig);
  globals.sheetInstances[dtName] = globals.dataTypesObj;
  
  const colOff = globals.dataTypesObj.getColOffset(datatypesConfig.Key);
  const typeOff = globals.dataTypesObj.getColOffset("Type");
  
  myLog("info", "DataTypes Columns -> %s (%s), Type (%s)", 
    datatypesConfig.Key, StringUtils.columnToLetter(colOff), StringUtils.columnToLetter(typeOff));

  if (colOff !== -1 && typeOff !== -1) {
    globals.dataTypesMap = new Map(globals.dataTypesObj.getWindow()
      .filter(row => row[colOff] && row[typeOff])
      .map(row => [String(row[colOff]).trim(), String(row[typeOff]).trim()])
    );
    Registry.hydrateTypes();
  }

  // Stage 5: Formula Hydration (Registry-Driven)
  const fName = CONFIG_CONSTANTS.FORMULAS_SHEET_NAME;
  const fFirstRow = Registry.lookupValue(fName, "FirstRow");
  const fLabelRow = Registry.lookupValue(fName, "LabelRow");
  const fKey = Registry.lookupValue(fName, "Key");

  if (!fFirstRow || !fLabelRow || !fKey) {
    throw new Error(`Bootstrap Failure: Missing mandatory Registry metadata for "${fName}". Check columns [FirstRow, LabelRow, Key].`);
  }

  myLog("info", "Configuring %s: Row %d, Labels at %d, Key: %s", fName, fFirstRow, fLabelRow, fKey);

  const formulasConfig = {
    SheetName: fName.split("_")[1],
    FirstRow: fFirstRow,
    LabelRow: fLabelRow,
    Key: fKey
  };
  globals.formulasObj = new Table(anchorSS, fName, formulasConfig);
  globals.sheetInstances[fName] = globals.formulasObj;
  
  const fTargetOff = globals.formulasObj.getColOffset(formulasConfig.Key);
  const fFormulaOff = globals.formulasObj.getColOffset("Formula");

  myLog("info", "Formulas Columns -> %s (%s), Formula (%s)", 
    formulasConfig.Key, StringUtils.columnToLetter(fTargetOff), StringUtils.columnToLetter(fFormulaOff));

  if (fTargetOff !== -1 && fFormulaOff !== -1) {
    globals.formulaMap = new Map(globals.formulasObj.getWindow()
      .filter(row => row[fTargetOff] && row[fFormulaOff])
      .map(row => [String(row[fTargetOff]).trim(), String(row[fFormulaOff]).trim()])
    );
    myLog("info", "Hydrated %d formulas.", globals.formulaMap.size);
  }

  // Stage 6: Corrections Hydration (Registry-Driven)
  const cName = CONFIG_CONSTANTS.CORRECTIONS_SHEET_NAME;
  const cFirstRow = Registry.lookupValue(cName, "FirstRow") || CONFIG_CONSTANTS.DEFAULT_FIRST_ROW;
  const cLabelRow = Registry.lookupValue(cName, "LabelRow") || CONFIG_CONSTANTS.DEFAULT_LABEL_ROW;
  const cKey = Registry.lookupValue(cName, "Key") || CONFIG_CONSTANTS.CORRECTIONS_CONFIG_PK;

  const correctionsConfig = {
    SheetName: cName.split("_")[1],
    FirstRow: cFirstRow,
    LabelRow: cLabelRow,
    Key: cKey
  };
  
  try {
    globals.correctionsObj = new Table(anchorSS, cName, correctionsConfig);
    globals.sheetInstances[cName] = globals.correctionsObj;
    PatchManager.hydrate();
  } catch (e) {
    throw new Error(`Bootstrap Failure: System Initialization failed at Patch Layer. Details: ${e.message}`);
  }

  // Stage 7: Active Context
  const activeSS = SpreadsheetApp.getActiveSpreadsheet();
  globals.activeSS = activeSS;
  globals.activeSSID = activeSS.getId();
  // FINAL STAGE: Re-hydrate Registry to pick up formulas now that the table is ready
  Registry.hydrate();
  
  globals.initialized = true;
  myLog("info", "System initialized.");
}
