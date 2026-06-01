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

  // 1. Annual Reports Submenu (Dynamic)
  const singleYearMenu = ui.createMenu('📅 Single Year Run');
  for (let y = 2016; y <= currentFY; y++) {
    singleYearMenu.addItem(String(y), `runYear${y}`);
  }

  const annualMenu = ui.createMenu('Annual Reports')
    .addItem('🚀 Run Annual Report (Active)', 'runActiveAnnualSheet')
    .addItem(`🔄 Run All Years (2016-${currentFY})`, 'runAllAnnualReports')
    .addSeparator()
    .addSubMenu(singleYearMenu);

  // 2. Reconciliation Submenu
  const reconMenu = ui.createMenu('Reconciliation')
    .addItem('🆕 Start New Reconciliation', 'startReconciliation')
    .addItem('🧹 Clear Reconciliation', 'clearReconciliation')
    .addItem('💾 Save Reconciled Entries', 'saveReconciliation');

  // 3. Import Submenu (Dynamic)
  const namedImportMenu = ui.createMenu('Import Named Sheet');
  const namedRangeMenu = ui.createMenu('Set Named Range for Sheet');

  CONFIG_CONSTANTS.CORE_SHEET_CONFIG.forEach(item => {
    const safeName = item.longName.replace(/[^a-zA-Z0-9]/g, '');
    if (!item.longName.startsWith("ManualEntry_")) {
      namedImportMenu.addItem(item.label, `importSheet${safeName}`);
    }
    namedRangeMenu.addItem(item.label, `defineSheet${safeName}`);
  });

  const importMenu = ui.createMenu('Import')
    .addItem('📄 Import Current Sheet', 'importActiveSheet')
    .addItem('🛠️ Repair Manager...', 'showRepairManager')
    .addSeparator()
    .addItem('🏁 Set All Windows', 'setAllWindows')
    .addSeparator()
    .addSubMenu(namedImportMenu)
    .addSeparator()
    .addSubMenu(ui.createMenu('Batch Import')
      .addItem('⏳ Import Pending Sheets', 'importPendingSheets')
      .addItem('🟢 Set All Sheets Clean', 'resetPendingSheets')
      .addItem('🔴 Set All Sheets Dirty', 'markAllDirty'));


  // 4. Set Ranges Submenu (Dynamic)
  const rangeMenu = ui.createMenu('Set Ranges')
    .addItem('🏷️ Set Named Ranges (Active)', 'defineActiveSheetNamedRanges')
    .addSeparator()
    .addSubMenu(namedRangeMenu)
    .addSeparator()
    .addItem('📏 Set All Named Ranges', 'defineAllNamedRanges');

  // Main Menu Assembly
  ui.createMenu('Village Hall')
    .addSubMenu(annualMenu)
    .addSeparator()
    .addSubMenu(reconMenu)
    .addSeparator()
    .addSubMenu(importMenu)
    .addSeparator()
    .addSubMenu(rangeMenu)
    .addSeparator()
    .addItem('🧪 Run Prototype Test', 'test_PrototypeImport')
    .addItem('🔍 Debug Merged Sources', 'debugMergedSourcesAndColumns')
    .addToUi();
}
