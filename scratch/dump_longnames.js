/**
 * SCRATCH: Dump LongNames
 */
function dumpRegistryLongNames() {
  initialize();
  const sheetsTable = globals.sheetsObj;
  const data = sheetsTable.getWindow();
  const longNameOff = sheetsTable.getColOffset("LongName");
  const sheetNameOff = sheetsTable.getColOffset("SheetName");
  
  const results = data.map(row => {
    return {
      longName: row[longNameOff],
      label: row[sheetNameOff]
    };
  }).filter(r => r.longName);
  
  console.log(JSON.stringify(results, null, 2));
}
