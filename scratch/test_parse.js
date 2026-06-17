const fs = require('fs');
const path = require('path');

// Mock Globals and Registry
global.globals = {
  sheetInstances: {},
  tableMap: {}
};
global.myLog = function(level, msg, ...args) {
  console.log(`[${level}] ` + msg.replace(/%s|%d/g, () => args.shift()));
};
global.CONFIG_CONSTANTS = {
  RANGE_NAME_REGEX: /[^a-zA-Z0-9_]/g
};

// Mock Registry
global.Registry = {
  getFormulasFor(longName) {
    return [];
  },
  getType(longName, colName) {
    return "String";
  }
};

global.getSheetInstance = function(name) {
  if (name === "Ledgers_Bookings") {
    return {
      getLabels() {
        return ["Status", "Label", "DateEvent", "BookingID", "PK"];
      }
    };
  } else if (name === "ImportsArchive_RawSMApp") {
    return {
      getLabels() {
        return ["Status", "Label", "Booking ID", "Cost", "Appointment date", "Appointment time"];
      }
    };
  }
  return null;
};

const vm = require('vm');

// Load DateUtils, StringUtils, FormulaUtils
const dateUtilsContent = fs.readFileSync(path.join(__dirname, '../242_DateUtils.js'), 'utf8');
const stringUtilsContent = fs.readFileSync(path.join(__dirname, '../244_StringUtils.js'), 'utf8');
const formulaUtilsContent = fs.readFileSync(path.join(__dirname, '../245_FormulaUtils.js'), 'utf8');

// Evaluate them in global context
vm.runInThisContext(dateUtilsContent);
vm.runInThisContext(stringUtilsContent);
vm.runInThisContext(formulaUtilsContent);

// Test 1: Filter parse (Status and Label are present in source sheet)
const filterFormula = '[Status] == "Confirmed"  || [Label] == "Paid"';
const parsedFilter = FormulaUtils.parse(filterFormula, "ImportsArchive_RawSMApp", "__FILTER__", "Ledgers_Bookings");
console.log("--- TEST 1: Filter Formula ---");
console.log("Original: ", filterFormula);
console.log("Parsed:   ", parsedFilter);

// Test 2: Target mapping formula referencing virtual target columns (DateEvent, BookingID are NOT in source sheet)
const pkFormula = 'pk(getKeyPrefix(), [DateEvent], [BookingID])';
const parsedPk = FormulaUtils.parse(pkFormula, "ImportsArchive_RawSMApp", "PK", "Ledgers_Bookings");
console.log("\n--- TEST 2: PK Formula ---");
console.log("Original: ", pkFormula);
console.log("Parsed:   ", parsedPk);
