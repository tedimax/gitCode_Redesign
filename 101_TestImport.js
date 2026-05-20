/**
 * gitCode_Redesign - Prototype Testing
 * Validates the ImportTable pipeline using the TestSheetDest configuration.
 */

function test_PrototypeImport() {
  // 1. Boot up the system
  initialize();
  
  const longName = "NewAccounts_TestSheetDest";
  myLog("info", "Starting Prototype Import Test for: %s", longName);
  
  try {
    // 2. Resolve the Table Instance from Registry
    const testTable = Utils.getSheetInstance(longName);
    
    if (!testTable) {
      throw new Error(`Registry Failure: Could not find configuration for '${longName}'. Please ensure it exists in your NewAccounts_Sheets tab.`);
    }

    if (!(testTable instanceof ImportTable)) {
       myLog("warn", "Warning: %s is not an ImportTable instance. Testing standard execution instead.", longName);
    }

    // 3. Execute the full pipeline (Calculate -> Patch -> Filter -> Inject)
    myLog("info", "Executing transformation pipeline...");
    const result = testTable.execute();
    
    // 4. Report results
    myLog("info", "SUCCESS: Prototype import complete.");
    myLog("info", "Result details: %s", JSON.stringify(result));
    
  } catch (e) {
    myLog("error", "TEST FAILED: %s", e.message);
    if (e.stack) myLog("error", "Stack trace: %s", e.stack);
  }
}

/**
 * NEW: Fluent API Demonstration
 */
function testFluentImport() {
  initialize();
  myLog("info", "--- Testing Fluent API Import ---");
  
  // Example: Import into the Test Destination but redirect the source 
  // on-the-fly and force 'update' mode.
  const target = Utils.getSheetInstance("NewAccounts_TestSheetDest");
  
  if (target) {
    target
      .withUpdateMode()
      .execute();
      
    myLog("info", "Fluent Import Test Complete.");
  }
}
