/**
 * gitCode_Redesign - Google Apps Script Test Suite
 * Contains comprehensive test cases for core ledger, report generation,
 * source/destination pair ingestion, and Tuya lock/calendar syncing.
 */

/**
 * Triggers the dynamic Annual Report generation for 2023.
 * Target sheet: 2023_Redesign (configured in Registry)
 */
function test_AnnualReportRedesign() {
  initialize();
  const longName = "AnnualSummaries_2023_Redesign";
  const reportTable = getSheetInstance(longName);
  
  if (!reportTable) {
    myLog("error", "FAILED: Could not find configuration for %s.", longName);
    return;
  }
  
  myLog("info", "Starting Dynamic Report Sync for %s...", longName);
  try {
    const stats = reportTable.runSync();
    myLog("info", "SUCCESS: Sync complete. Stats: %s", JSON.stringify(stats));
  } catch (e) {
    myLog("error", "Sync failed: %s", e.message);
  }
}

/**
 * Test Case: Source/Destination Ingestion Pair using the Normal Interface
 */
function test_SourceDestinationPair_Normal() {
  initialize();
  const longName = "NewAccounts_TestSheetDest";
  myLog("info", "--- Testing Source/Destination Ingestion Pair (Normal Interface) ---");
  
  try {
    const testTable = getSheetInstance(longName);
    if (!testTable) {
      throw new Error(`Registry Failure: Configuration for '${longName}' was not found.`);
    }
    
    myLog("info", "Executing transformation pipeline via execute()...");
    const result = testTable.execute();
    myLog("info", "SUCCESS: Normal Ingestion complete. Result: %s", JSON.stringify(result));
  } catch (e) {
    myLog("error", "Normal Ingestion Test FAILED: %s", e.message);
  }
}

/**
 * Test Case: Source/Destination Ingestion Pair using the Fluent (Fluid) Interface
 */
function test_SourceDestinationPair_Fluid() {
  initialize();
  const longName = "NewAccounts_TestSheetDest";
  myLog("info", "--- Testing Source/Destination Ingestion Pair (Fluent/Fluid Interface) ---");
  
  try {
    const target = getSheetInstance(longName);
    if (!target) {
      throw new Error(`Registry Failure: Configuration for '${longName}' was not found.`);
    }
    
    myLog("info", "Executing pipeline in UPDATE mode via fluent interface withUpdateMode().execute()...");
    const result = target.withUpdateMode().execute();
    myLog("info", "SUCCESS: Fluent Ingestion complete. Result: %s", JSON.stringify(result));
  } catch (e) {
    myLog("error", "Fluent Ingestion Test FAILED: %s", e.message);
  }
}

/**
 * Test Case: Tuya Locks - Set/Enroll Temporary PINs
 * Reads pending bookings from the temporary bookings sheet and registers temporary PINs.
 */
function test_Tuya_SetTemporaryKeys() {
  initialize();
  myLog("info", "--- Testing Tuya Locks: Set/Enroll Temporary PINs ---");
  
  try {
    const issuedTable = getSheetInstance("Keys_IssuedPINS");
    if (!issuedTable) {
      throw new Error("Registry Failure: Keys_IssuedPINS configuration not found.");
    }
    
    myLog("info", "Enrolling temporary keys via issueTempPINs()...");
    issuedTable.issueTempPINs();
    myLog("info", "SUCCESS: Temporary keys enrollment executed successfully.");
  } catch (e) {
    myLog("error", "Temporary keys enrollment FAILED: %s", e.message);
  }
}

/**
 * Test Case: Tuya Locks - List Permanent (Issued) and Temporary PINs
 * Retrieves local sheet records and queries Tuya Cloud API directly.
 */
function test_Tuya_ListPins() {
  initialize();
  myLog("info", "--- Testing Tuya Locks: List Permanent (Issued) and Temporary PINs ---");
  
  try {
    const issuedTable = getSheetInstance("Keys_IssuedPINS");
    const tempTable = getSheetInstance("Keys_TuyaTempPINS");
    
    if (!issuedTable || !tempTable) {
      throw new Error("Registry Failure: Required Tuya PIN sheet configurations not found.");
    }
    
    // 1. List Permanent (Issued) PINs recorded in sheet
    myLog("info", "1. Permanent / Issued PINs logged in local sheet:");
    issuedTable.getWindow().forEach((row, idx) => {
      const obj = issuedTable.getRowObjectByOffset(idx);
      myLog("info", "  - Name: %s | Appt: %s | Effective: %s | Invalid: %s | Issued: %s", 
        obj.name, obj.appointment_time, obj.effective_time, obj.invalid_time, obj.Issued);
    });
    
    // 2. List Temporary PINs synced in sheet
    myLog("info", "2. Temporary PINs recorded in local sheet:");
    tempTable.getWindow().forEach((row, idx) => {
      const obj = tempTable.getRowObjectByOffset(idx);
      myLog("info", "  - ID: %s | Status: %s | Effective: %s | Invalid: %s", 
        obj.id, obj.delivery_status, obj.effective_time, obj.invalid_time);
    });
    
    // 3. Query Cloud API: Get Temporary PIN status from Tuya Cloud
    myLog("info", "3. Querying Tuya Cloud API for active temporary PINs...");
    const cloudPins = tempTable.getTempPINS();
    myLog("info", "  - Cloud Temporary PINs Count: %d", cloudPins.length);
    cloudPins.forEach((pin, idx) => {
      myLog("info", "    [%d] ID: %s | Name: %s | Phase: %s | Effective: %s | Invalid: %s",
        idx, pin.id, pin.name, pin.phase, new Date(pin.effective_time * 1000), new Date(pin.invalid_time * 1000));
    });
    
    // 4. Query Cloud API: Get Device status from Tuya Cloud
    myLog("info", "4. Querying Tuya Cloud API for Door Lock device status...");
    const statusRes = tempTable.getDeviceStatus();
    myLog("info", "  - Device Status Result: %s", JSON.stringify(statusRes));
    
  } catch (e) {
    myLog("error", "List PINs Test FAILED: %s", e.message);
  }
}

/**
 * Test Case: Tuya Locks - Synchronize and Orchestrate lock status/logs with Calendar
 */
function test_Tuya_SyncWithLock() {
  initialize();
  myLog("info", "--- Testing Tuya Locks: Orchestrated Lock/Calendar Sync ---");
  
  try {
    myLog("info", "Executing orchestrated sync via updatePINSFromCalendar()...");
    updatePINSFromCalendar();
    myLog("info", "SUCCESS: Full Calendar & Lock synchronization complete.");
  } catch (e) {
    myLog("error", "Sync with lock FAILED: %s", e.message);
  }
}

/**
 * Test Case: Setmore-to-Tuya End-to-End Flow Test
 * Syncs the Setmore calendar, identifies a newly created appointment,
 * and pushes it through the Tuya enrollment process.
 */
function test_SetmoreToTuyaFlow() {
  initialize();
  myLog("info", "--- Starting Setmore to Tuya Integration Flow Test ---");
  
  try {
    // Step 1: Sync Setmore bookings
    myLog("info", "Step 1: Syncing calendar from Setmore API...");
    const calendarTable = getSheetInstance("Keys_SetmoreBookings");
    if (!calendarTable) {
      throw new Error("Calendar table (Keys_SetmoreBookings) not found in registry.");
    }
    const syncStats = calendarTable.sync();
    myLog("info", "Step 1 complete. Calendar sync stats: %s", JSON.stringify(syncStats));
    
    // Step 2: Process bookings pipeline
    myLog("info", "Step 2: Processing bookings pipeline...");
    const tempBookingsTable = getSheetInstance("Keys_TemporaryBookings");
    if (tempBookingsTable && typeof tempBookingsTable.execute === 'function') {
      tempBookingsTable.execute();
    }
    
    // Step 3: Issue Tuya PINs
    myLog("info", "Step 3: Enrolling new bookings as temporary PINs in Tuya...");
    const issuedTable = getSheetInstance("Keys_IssuedPINS");
    if (!issuedTable) {
      throw new Error("Issued PINs table (Keys_IssuedPINS) not found in registry.");
    }
    issuedTable.issueTempPINs();
    
    // Step 4: List the issued PINs to confirm the new one is present
    myLog("info", "Step 4: Querying Issued PINs sheet to verify enrollment:");
    const lastRowIdx = issuedTable.getLastRowIndex();
    if (lastRowIdx >= issuedTable.firstDataRowIndex) {
      const window = issuedTable.getWindow();
      myLog("info", "Total Issued PINs: %d", window.length);
      if (window.length > 0) {
        const lastRowObj = issuedTable.getRowObjectByOffset(window.length - 1);
        myLog("info", "  Latest Issued PIN -> Name: %s | Appt: %s | ID: %s | Issued: %s",
          lastRowObj.name, lastRowObj.appointment_time, lastRowObj.id, lastRowObj.Issued);
      }
    } else {
      myLog("warn", "No PINs found in Issued PINs sheet.");
    }
    
    myLog("info", "SUCCESS: Setmore to Tuya flow test finished.");
  } catch (e) {
    myLog("error", "Flow test FAILED: %s", e.message);
  }
}

/**
 * Test Case: Inject a Mock Appointment directly into Setmore Bookings and issue a PIN
 * Use this to test the Tuya Lock registration logic offline without waiting for Setmore API.
 */
function test_Tuya_InjectMockAppointment() {
  initialize();
  myLog("info", "--- Injecting Mock Appointment to Test Tuya ---");
  
  try {
    const setmoreTable = getSheetInstance("Keys_SetmoreBookings");
    if (!setmoreTable) {
      throw new Error("Setmore Bookings sheet (Keys_SetmoreBookings) not found.");
    }
    
    myLog("info", "Physical labels in Keys_SetmoreBookings: %s", JSON.stringify(setmoreTable.getLabels()));
    
    const tempBookings = getSheetInstance("Keys_TemporaryBookings");
    if (!tempBookings) {
      throw new Error("Temporary Bookings sheet (Keys_TemporaryBookings) not found.");
    }
    
    // Create a mock booking for a test customer (valid for tomorrow)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    
    const mockEmail = "test_guest_" + Math.floor(Math.random() * 1000) + "@domain.com";
    const mockPin = "99887766"; // Raw test PIN
    const encryptedPin = CryptoUtils.encrypt(mockPin);
    
    myLog("info", "Mocking booking -> Email: %s | Raw PIN: %s | Encrypted: %s | Date: %s", 
      mockEmail, mockPin, encryptedPin, tomorrow);
      
    // Append the mock row to the Setmore Bookings source sheet
    const labels = setmoreTable.getLabels();
    const cols = setmoreTable.getSymbolicOffsets();
    const mockRow = new Array(labels.length).fill("");
    mockRow[cols.key] = "mock_key_" + Math.floor(Math.random() * 100000);
    mockRow[cols.start] = tomorrow;
    mockRow[cols.end] = new Date(tomorrow.getTime() + 3600 * 1000); // 1 hour duration
    mockRow[cols.duration] = 60;
    mockRow[cols.email] = mockEmail;
    mockRow[cols.comment] = "Mock Test Booking";
    mockRow[cols.customer] = "Mock Test Guest";
    mockRow[cols.encryptedPin] = encryptedPin;
    
    setmoreTable.sheet.appendRow(mockRow);
    setmoreTable.clearCache();
    myLog("info", "Mock booking appended to Keys_SetmoreBookings sheet.");
    
    // Flush Sheet writes and force recalculation of the Keys_TemporaryBookings formula
    SpreadsheetApp.flush();
    tempBookings.clearCache();
    
    // Run Tuya issuance
    myLog("info", "Triggering issueTempPINs()...");
    const issuedTable = getSheetInstance("Keys_IssuedPINS");
    issuedTable.issueTempPINs();
    
    myLog("info", "SUCCESS: Mock appointment processed by Tuya lock.");
  } catch (e) {
    myLog("error", "Mock injection test FAILED: %s", e.message);
  }
}

/**
 * Test Case: Test the DECODE_PIN User Defined Function (UDF)
 * Verifies encryption/decryption of a mock PIN value and a range/array of values.
 */
function test_DECODE_PIN_UDF() {
  initialize();
  myLog("info", "--- Testing DECODE_PIN Custom Function (UDF) ---");
  
  try {
    const mockPin = "12345678";
    myLog("info", "Original PIN: %s", mockPin);
    
    // Encrypt using CryptoUtils
    const encrypted = CryptoUtils.encrypt(mockPin);
    myLog("info", "Encrypted PIN (base64): %s", encrypted);
    
    // Decrypt using UDF
    const decrypted = DECODE_PIN(encrypted);
    myLog("info", "Decrypted PIN via UDF: %s", decrypted);
    
    if (decrypted !== mockPin) {
      throw new Error(`Single value assertion failed: expected "${mockPin}", but got "${decrypted}"`);
    }
    myLog("info", "Single value decryption test passed.");
    
    // Test with array (range representation)
    const arrayInput = [[encrypted], [""], [encrypted]];
    const arrayOutput = DECODE_PIN(arrayInput);
    
    myLog("info", "Range output: %s", JSON.stringify(arrayOutput));
    
    if (arrayOutput[0][0] !== mockPin || arrayOutput[1][0] !== "" || arrayOutput[2][0] !== mockPin) {
      throw new Error(`Range assertion failed. Expected [["${mockPin}"], [""], ["${mockPin}"]], but got ${JSON.stringify(arrayOutput)}`);
    }
    myLog("info", "Range / Array decryption test passed.");
    myLog("info", "SUCCESS: DECODE_PIN UDF test passed.");
  } catch (e) {
    myLog("error", "DECODE_PIN test FAILED: %s", e.message);
  }
}

