function testRangeCoordinates() {
  initialize();
  const sheetsTable = globals.sheetsObj;
  const cols = sheetsTable.getSymbolicOffsets();
  
  console.log("Process column offset:", cols.process);
  console.log("Sheet columns count:", sheetsTable.sheet.getLastColumn());
  console.log("Sheet max columns:", sheetsTable.sheet.getMaxColumns());
  console.log("Sheet max rows:", sheetsTable.sheet.getMaxRows());
  
  const targetLongName = "Reconciliation_UnChecked";
  const regRowOff = sheetsTable.getRowOffset(targetLongName);
  console.log("regRowOff for " + targetLongName + ":", regRowOff);
  
  if (regRowOff !== undefined) {
    const physicalRow = regRowOff + sheetsTable.firstDataRowIndex;
    console.log("Target physical row:", physicalRow);
    console.log("Target physical column:", cols.process + 1);
  }
}
