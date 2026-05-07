"use strict";

/**
 * gitCode_Redesign - General Utilities & Factory
 * Contains the Singleton Factory and functional helpers.
 */
const Utils = (() => {

  /**
   * Spreadsheet Singleton Factory
   */
  const getSpreadsheetInstance = (ssid) => {
    if (!ssid) return null;
    if (globals.spreadsheetInstances[ssid]) return globals.spreadsheetInstances[ssid];
    
    const ss = SpreadsheetApp.openById(ssid);
    globals.spreadsheetInstances[ssid] = ss;
    return ss;
  };

  /**
   * Table Singleton Factory
   * Resolves instances based on the NewAccounts_Sheets registry.
   * @param {string} longName
   * @param {string} ssidOverride - Optional SSID to force a specific spreadsheet.
   */
  const getSheetInstance = (longName, ssidOverride = null) => {
    if (!longName) return null;
    if (globals.sheetInstances[longName]) return globals.sheetInstances[longName];

    // Read hydrated config from Registry (needed to determine Type/SSID)
    const config = Registry.getSheetConfig(longName);
    
    // Resolve SSID (Priority: Override > Config > Default)
    const ssName = config.SpreadSheetName || longName.split("_")[0];
    const ssid = ssidOverride || globals.ssMap.get(ssName) || globals.defaultSSID;
    const ss = getSpreadsheetInstance(ssid);

    // Instantiate correct Type
    const type = config.SheetType || "Table";
    const Constructor = globals.tableMap[type] || globals.tableMap['Table'];
    
    myLog("trace", "Instantiating %s as %s (SSID: %s)", longName, Constructor.name, ssid);

    // The Constructor now handles its own Registry lookup internally.
    const instance = new Constructor(ss, longName);
    globals.sheetInstances[longName] = instance;
    
    return instance;
  };

  /**
   * Determines the primary source table (the loop driver) for an ImportTable instance.
   * 1. Checks 'SourceSheet' in properties.
   */
  const getSourceSheet = (tableInstance) => {
    // 1. Explicitly defined in Registry
    const explicitSource = tableInstance.getProperty("SourceSheet");
    if (explicitSource) {
      const instance = getSheetInstance(explicitSource);
      if (instance) return instance;
    }

    // 2. Error if no source sheet is defined
    throw new Error(`No SourceSheet defined in properties for table "${tableInstance.longName}". Virtual mapping requires an explicit driver sheet.`);
  };

  return {
    getSpreadsheetInstance,
    getSheetInstance,
    getSourceSheet
  };
})();

// Assign to global scope for easier access
const getSheetInstance = Utils.getSheetInstance;
const getSpreadsheetInstance = Utils.getSpreadsheetInstance;
