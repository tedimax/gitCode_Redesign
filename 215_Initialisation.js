/**
 * gitCode_Redesign - Registry Singleton
 * Provides high-performance, pre-indexed access to system configuration.
 */
const Registry = (() => {
  const _sheets = new Map();    // LongName -> Config Object
  const _formulas = new Map();  // LongName -> Array of Formula Rows
  const _dataTypes = new Map(); // LongName:Column -> Type String

  return {
    hydrate() {
      // 1. Index Sheets
      if (globals.sheetsObj) {
        const labels = globals.sheetsObj.getColLabels();
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
        const targetFieldOff = globals.formulasObj.getColOffset("TargetField");
        globals.formulasObj.getWindow().forEach(row => {
          const fullRef = String(row[targetFieldOff] || "");
          const match = fullRef.match(/^([^\[]+)\[/);
          if (match) {
            const longName = match[1].trim();
            if (!_formulas.has(longName)) _formulas.set(longName, []);
            _formulas.get(longName).push(row);
          }
        });
      }

      // 3. Index DataTypes
      if (globals.dataTypesMap) {
        globals.dataTypesMap.forEach((type, ref) => _dataTypes.set(ref, type));
      }
      
      myLog("info", "Registry hydrated: %d sheets, %d formula groups, %d types.", _sheets.size, _formulas.size, _dataTypes.size);
    },

    getSheetConfig: (longName) => _sheets.get(longName) || {},
    getFormulasFor: (longName) => _formulas.get(longName) || [],
    getType: (longName, colName) => _dataTypes.get(`${longName}:${colName}`) || "String"
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

  // Stage 2: Sheet Registry (NewAccounts_Sheets)
  const sheetsConfig = {
    SheetName: CONFIG_CONSTANTS.SHEETS_CONFIG_NAME.split("_")[1] || "Sheets",
    FirstRow: 2,
    LabelRow: 1,
    Key: "LongName"
  };
  globals.sheetsObj = new Table(anchorSS, CONFIG_CONSTANTS.SHEETS_CONFIG_NAME, sheetsConfig);

  // Stage 3: SSID Map (Strict matching)
  const ssNameOff = globals.sheetsObj.getColOffset("SpreadSheetName");
  const ssidOff = globals.sheetsObj.getColOffset("SSID");
  
  if (ssNameOff === -1 || ssidOff === -1) {
    const labels = globals.sheetsObj.getColLabels();
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

  // Stage 4: DataType Hydration
  const datatypesConfig = {
    SheetName: CONFIG_CONSTANTS.DATATYPES_SHEET_NAME.split("_")[1] || "DataTypes",
    FirstRow: 2,
    LabelRow: 1
  };
  globals.dataTypesObj = new Table(anchorSS, CONFIG_CONSTANTS.DATATYPES_SHEET_NAME, datatypesConfig);
  
  const colOff = globals.dataTypesObj.getColOffset("TargetField");
  const typeOff = globals.dataTypesObj.getColOffset("Type");
  
  if (colOff !== -1 && typeOff !== -1) {
    globals.dataTypesMap = new Map(globals.dataTypesObj.getWindow()
      .filter(row => row[colOff] && row[typeOff])
      .map(row => [String(row[colOff]).trim(), String(row[typeOff]).trim()])
    );
  }

  // Stage 5: Formula Registry Hydration
  const formulasConfig = {
    SheetName: CONFIG_CONSTANTS.FORMULAS_SHEET_NAME.split("_")[1] || "Formulas",
    FirstRow: 2,
    LabelRow: 1
  };
  globals.formulasObj = new Table(anchorSS, CONFIG_CONSTANTS.FORMULAS_SHEET_NAME, formulasConfig);

  // --- NEW: Registry Indexing ---
  Registry.hydrate();

  // Stage 6: Active Context
  const activeSS = SpreadsheetApp.getActiveSpreadsheet();
  globals.activeSS = activeSS;
  globals.activeSSID = activeSS.getId();
  
  globals.initialized = true;
  myLog("info", "System initialized.");
}
