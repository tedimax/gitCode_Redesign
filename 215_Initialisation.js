/**
 * gitCode_Redesign - Registry Singleton
 * Provides high-performance, pre-indexed access to system configuration.
 */
const Registry = (() => {
  const _sheets = new Map();    // LongName -> Config Object
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
              myLog("trace", "Merged %d extra properties for %s", Object.keys(extra).length, config.LongName);
            } catch (e) {
              myLog("warn", "Failed to parse Properties for %s: %s", config.LongName, e.message);
            }
          }
          
          if (config.LongName) _sheets.set(config.LongName.trim(), config);
        });
      }

      // 2. Index Formulas (Grouped by Table)
      if (globals.formulasObj) {
        const targetFieldOff = globals.formulasObj.getColOffset(CONFIG_CONSTANTS.FORMULAS_CONFIG_PK);
        globals.formulasObj.getWindow().forEach(row => {
          const fullRef = String(row[targetFieldOff] || "");
          const match = fullRef.match(/^([^\[]+)\[/);
          if (match) {
            const longName = match[1].trim();
            if (!_formulas.has(longName)) _formulas.set(longName, []);
            const obj = globals.formulasObj.getRowObjectByOffset(globals.formulasObj.getWindow().indexOf(row));
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
      return val === "" ? null : val;
    },

    getSheetConfig: (longName) => _sheets.get(longName) || {},
    getFormulasFor: (longName) => _formulas.get(longName) || [],
    getType: (longName, colName) => {
      const key = `${String(longName || "").trim()}:${String(colName || "").trim()}`.toUpperCase();
      return _dataTypes.get(key) || "String";
    }
  };
})();

/**
 * gitCode_Redesign - System Initialization
 * Bootstraps the registries from the NewAccounts source of truth.
 */
function initialize() {
  if (globals.initialized) return;

  myLog("info", "Bootstrapping gitCode_Redesign system...");

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

  // Stage 3: SSID Map (Strict matching)
  const ssNameOff = globals.sheetsObj.getColOffset("SpreadSheetName");
  const ssidOff = globals.sheetsObj.getColOffset("SSID");
  
  myLog("info", "Registry Hydrated: SpreadSheetName (%s), SSID (%s), FirstRow (%s), LabelRow (%s)",
    StringUtils.columnToLetter(ssNameOff),
    StringUtils.columnToLetter(ssidOff),
    StringUtils.columnToLetter(globals.sheetsObj.getColOffset("FirstRow")),
    StringUtils.columnToLetter(globals.sheetsObj.getColOffset("LabelRow"))
  );

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
  myLog("info", "Built SSID Map with %d entries.", globals.ssMap.size);

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

  // Stage 6: Active Context
  const activeSS = SpreadsheetApp.getActiveSpreadsheet();
  globals.activeSS = activeSS;
  globals.activeSSID = activeSS.getId();
  
  globals.initialized = true;
  myLog("info", "System initialized.");
}
