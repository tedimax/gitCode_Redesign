"use strict";

/**
 * gitCode_Redesign - Menu GUI
 * Handles the construction of the Village Hall custom menu.
 */

/**
 * Trigger: Runs when the spreadsheet is opened.
 * Builds the custom "Village Hall" menu with submenus.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  
  // Calculate Current Financial Year (April 1st rule)
  const now = new Date();
  const currentYear = now.getFullYear();
  // FY is labelled by its END year (e.g. Apr 2026 - Mar 2027 = FY2027)
  const currentFY = (now.getMonth() >= 3) ? currentYear + 1 : currentYear;

  // 1. Reconcile Submenu
  const reconMenu = ui.createMenu('Reconcile')
    .addItem('🆕 Start new reconciliation', 'vh.startReconciliation')
    .addItem('💾 Save reconciliation entries', 'vh.saveReconciliation');

  // 2. Batch Import Submenu (to be added directly to the Main Menu)
  const batchImportMenu = ui.createMenu('Batch import')
    .addItem('⏳ Import pending sheets', 'vh.importPendingSheets')
    .addItem('🔴 Set all sheets dirty', 'vh.markAllDirty')
    .addItem('🟢 Set all sheets clean', 'vh.resetPendingSheets');

  // 3. Import Named Sheets Submenu (uses the sheet config update method, i.e. vh.importSheet<Name>)
  const importNamedSheetsMenu = ui.createMenu('Import named sheet');
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => {
    const safeName = item.longName.replace(/[^a-zA-Z0-9]/g, '');
    importNamedSheetsMenu.addItem(item.label, `vh.importSheet${safeName}`);
  });

  const importMenu = ui.createMenu('Import')
    .addItem('📄 Import current sheet', 'vh.importActiveSheet')
    .addItem('🛠️ Repair manager', 'vh.showRepairManager')
    .addSubMenu(importNamedSheetsMenu)
    .addItem('🏁 Set all windows', 'vh.setAllWindows');

  // 4. Set Ranges Submenu
  const namedRangeMenu = ui.createMenu('Set named sheet range');
  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => {
    const safeName = item.longName.replace(/[^a-zA-Z0-9]/g, '');
    namedRangeMenu.addItem(item.label, `vh.defineSheet${safeName}`);
  });

  const rangeMenu = ui.createMenu('Set Ranges')
    .addItem('🏷️ Set current sheet range', 'vh.defineActiveSheetNamedRanges')
    .addItem('📏 Set all ranges', 'vh.defineAllNamedRanges')
    .addSubMenu(namedRangeMenu);

  // 5. Annual Reports Submenu
  const runNamedYearMenu = ui.createMenu('Run named year');
  for (let y = 2016; y <= currentFY; y++) {
    runNamedYearMenu.addItem(String(y), `vh.runYear${y}`);
  }

  const annualMenu = ui.createMenu('Annual reports')
    .addItem('📅 Run current year', 'vh.runCurrentYear')
    .addItem('🔄 Run all years', 'vh.runAllAnnualReports')
    .addItem('🚀 Run active sheet', 'vh.runActiveAnnualSheet')
    .addSubMenu(runNamedYearMenu);

  // 6. Keys Submenu
  const syncSubMenu = ui.createMenu('Sync')
    .addItem('🎟️ Sync PINs', 'vh.issueTempPINs')
    .addItem('📅 Sync Calendar', 'vh.syncCalendar')
    .addItem('🔑 Sync Temporary PINs', 'vh.syncTempPINS')
    .addItem('🔒 Sync Permanent Locks', 'vh.syncTuyaLogs');

  const keysMenu = ui.createMenu('Keys')
    .addItem('🔄 Update PINS', 'vh.updatePINSFromCalendar')
    .addSubMenu(syncSubMenu);

  // 7. Trace Level Submenu
  const traceLevelMenu = ui.createMenu('Trace level')
    .addItem('All', 'vh.setLogLevelAll')
    .addItem('Trace', 'vh.setLogLevelTrace')
    .addItem('Info', 'vh.setLogLevelInfo')
    .addItem('Error', 'vh.setLogLevelError')
    .addItem('None', 'vh.setLogLevelNone');

  // Main Menu Assembly
  ui.createMenu('Village Hall')
    .addItem('🔑 Make keys in current sheet', 'vh.makeKeys')
    .addSeparator()
    .addSubMenu(reconMenu)
    .addSeparator()
    .addSubMenu(batchImportMenu)
    .addSeparator()
    .addSubMenu(importMenu)
    .addSeparator()
    .addSubMenu(rangeMenu)
    .addSeparator()
    .addSubMenu(annualMenu)
    .addSeparator()
    .addSubMenu(keysMenu)
    .addSeparator()
    .addSubMenu(traceLevelMenu)
    .addToUi();
}
