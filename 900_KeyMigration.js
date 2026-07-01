"use strict";

/**
 * gitCode_Redesign - One-Time Key Migration Utility
 * Standardizes primary keys to the Prefix#YYYYMMDD.SS_hash format.
 * Automatically cascades updates to NewAccounts_Corrections and Reconciliation_Groups.
 */

var KeyMigration = {
  /**
   * Main entry point to perform the key migration across the entire spreadsheet system.
   */
  migrateAllPrimaryKeys() {
    myLog("info", "🔑 Starting System-wide Primary Key Upgrade (Option B)...");
    
    // Ensure system is fully initialized
    if (typeof initialize === "function") {
      initialize();
    }
    
    // Master translation map: legacyKey (lowercase) -> newUpgradedKey
    const legacyToNewKeyMap = new Map();
    
    // 1. Identify all sheets in the configuration
    const sheetsTable = globals.sheetsObj;
    if (!sheetsTable) {
      throw new Error("Bootstrap Failure: NewAccounts_Sheets registry not loaded. Cannot run migration.");
    }
    
    sheetsTable.fetch(sheetsTable.firstDataRowIndex);
    const registryRows = sheetsTable.getWindow();
    const longNameCol = sheetsTable.column.longname;
    
    const targetLongNames = registryRows.map(row => String(row[longNameCol] || "").trim()).filter(Boolean);
    
    // =========================================================================
    // EXPLICIT AND COMPREHENSIVE LIST OF ALL TARGET SHEETS TO MIGRATE/UPDATE
    // =========================================================================
    
    // 1. PHASE 1: Sheets with definitive primary keys to be upgraded
    const approvedPhase1Sheets = [
      "Ledgers_Transactions",
      "Ledgers_Assets",
      "Ledgers_Bank",
      "Ledgers_Cash",
      "Ledgers_Bookings",
      "Ledgers_BookingPayments",
      "Ledgers_SquareTransactions",
      "Ledgers_SquareDeposits",
      "Ledgers_SquareFees",
      "Ledgers_SquarePayments",
      "ManualEntry_Ledger",
      "ManualEntry_Holdings",
      "ManualEntry_Cashbox",
      "ManualEntry_BadDebts",
      "NewAccounts_TestSheetDest",
      "TestSheetSource"
    ];
    
    // 2. PHASE 2 & 3: Reference/Mapping sheets to be updated in sync
    const approvedReferenceSheets = [
      "Reconciliation_Merged",      // Phase 1.5: Merged sheet keys translated via mapping to match source ledgers
      "Reconciliation_Groups",       // Phase 2: Updates reference key in PK column
      "NewAccounts_Corrections"     // Phase 3: Updates reference key in GlobalID column (SheetName@PK)
    ];

    // Filter down strictly to our explicit targets
    const activeTargets = [
      "Ledgers_Transactions",
      "Ledgers_Assets",
      "Ledgers_Bank",
      "Ledgers_Cash",
      "Ledgers_Bookings",
      "Ledgers_BookingPayments",
      "Ledgers_SquareTransactions",
      "Ledgers_SquareDeposits",
      "Ledgers_SquareFees",
      "Ledgers_SquarePayments",
      "ManualEntry_Ledger",
      "ManualEntry_Holdings",
      "ManualEntry_Cashbox",
      "NewAccounts_TestSheetSource",
      "NewAccounts_TestSheetDest",
      "TestSheetSource",
      "TestSheetDest"
    ];
    
    myLog("info", "Registry configured with %d candidate sheets for primary key migration.", activeTargets.length);

    // --- PHASE 1: MIGRATE DEFINITIVE OWN PRIMARY KEYS ---
    for (const longName of activeTargets) {
      try {
        let table;
        try {
          table = Utils.getSheetInstance(longName);
        } catch (e) {
          // Fallback direct instantiation to bypass Registry lookup error
          // If no prefix is present (e.g. TestSheetSource), default to the "NewAccounts" spreadsheet
          const ssName = longName.includes("_") ? longName.split("_")[0] : "NewAccounts";
          const ssid = globals.ssMap.get(ssName) || globals.defaultSSID;
          const ss = (ssid === globals.defaultSSID) ? SpreadsheetApp.getActiveSpreadsheet() : SpreadsheetApp.openById(ssid);
          
          const sheetName = longName.includes("_") ? longName.split("_")[1] : longName;
          
          myLog("info", "Attempting direct instantiation for '%s' (Spreadsheet: '%s', Tab: '%s').", longName, ssName, sheetName);
          
          // Verify if the physical sheet tab actually exists in the file
          if (!ss.getSheetByName(sheetName)) {
            myLog("warning", "Physical sheet tab '%s' not found in spreadsheet '%s'. Skipping longName '%s'.", sheetName, ssName, longName);
            continue;
          }
          
          table = new Table(ss, longName, {
            sheetname: sheetName,
            firstrow: 2,
            labelrow: 1,
            key: "PK",
            datefield: "Date"
          });
        }
        
        if (!table) {
          myLog("trace", "Sheet %s is not currently loaded or supported. Skipping.", longName);
          continue;
        }
        
        table.withoutValidation(); // Disable row validations to load unmigrated data
        table.fetch(table.firstDataRowIndex);
        const rows = table.getWindow();
        if (rows.length === 0) {
          myLog("trace", "Sheet %s is empty. Skipping.", longName);
          continue;
        }
        
        const keyFieldName = table.getProperty("Key") || "PK";
        const dateFieldName = table.getProperty("DateField") || "Date";
        
        const pkColIdx = table.column[keyFieldName.toLowerCase()];
        const dateColIdx = table.column[dateFieldName.toLowerCase()];
        
        if (pkColIdx === undefined || dateColIdx === undefined) {
          myLog("trace", "Sheet %s lacks PK (%s) or Date (%s) columns. Skipping own PK migration.", 
            longName, pkColIdx !== undefined ? "YES" : "NO", dateColIdx !== undefined ? "YES" : "NO");
          continue;
        }
        
        myLog("info", "Processing primary keys for sheet: %s...", longName);
        
        // Group row offsets by compact date
        const dateGroups = new Map(); // compactDate -> Array<rowOffset>
        rows.forEach((row, rowOffset) => {
          const pkVal = row[pkColIdx];
          const dateVal = row[dateColIdx];
          if (!pkVal || !dateVal) return;
          
          const compactDate = DateUtils.toCompactDate(dateVal);
          if (!compactDate) return;
          
          if (!dateGroups.has(compactDate)) {
            dateGroups.set(compactDate, []);
          }
          dateGroups.get(compactDate).push(rowOffset);
        });
        
        let writeCount = 0;
        const newPkList = rows.map(r => [r[pkColIdx]]); // Prepared 2D array for batch write
        
        // Generate new keys within date groups to compute sequential offsets
        dateGroups.forEach((offsets, compactDate) => {
          offsets.forEach((rowOffset, seqIdx) => {
            const originalPk = String(rows[rowOffset][pkColIdx]).trim();
            if (!originalPk) return;
            
            // Parse existing key to extract prefix and random hash
            const hashIdx = originalPk.indexOf("#");
            if (hashIdx === -1) return;
            
            const prefix = originalPk.substring(0, hashIdx);
            const rhs = originalPk.substring(hashIdx + 1);
            
            // Extract original hash (everything after the underscore)
            const underscoreIdx = rhs.lastIndexOf("_");
            const hashPart = underscoreIdx !== -1 ? rhs.substring(underscoreIdx + 1) : rhs;
            
            // If the hash had a hyphen (e.g. from our temporary run like _05-hash), strip it
            const hyphenIdx = hashPart.indexOf("-");
            const cleanHash = hyphenIdx !== -1 ? hashPart.substring(hyphenIdx + 1) : hashPart;
            
            // Build upgraded Prefix#YYYYMMDD.SSS_hash key
            const pad = String(seqIdx).padStart(3, '0');
            const upgradedPk = `${prefix}#${compactDate}.${pad}_${cleanHash}`;
            
            // Store translation mapping
            legacyToNewKeyMap.set(originalPk.toLowerCase(), upgradedPk);
            
            // Update local memory and output buffer
            rows[rowOffset][pkColIdx] = upgradedPk;
            newPkList[rowOffset] = [upgradedPk];
            writeCount++;
          });
        });
        
        // Batch write new PKs to the sheet
        if (writeCount > 0) {
          const pkRange = table.sheet.getRange(table.firstDataRowIndex, pkColIdx + 1, rows.length, 1);
          pkRange.setValues(newPkList);
          myLog("info", "Successfully upgraded %d keys in %s", writeCount, longName);
        }
        
      } catch (err) {
        myLog("error", "Failed to migrate sheet %s: %s", longName, err.message);
      }
    }
    
    // --- FLUSH AND PROCEED WITH CASCADE TRANSLATIONS ---
    SpreadsheetApp.flush();
    
    // --- PHASE 1.5: MIGRATE RECONCILIATION_MERGED REFERENCES ---
    try {
      const mergedTable = Utils.getSheetInstance("Reconciliation_Merged");
      if (mergedTable) {
        myLog("info", "Processing reference migrations in Reconciliation_Merged...");
        mergedTable.withoutValidation();
        mergedTable.fetch(mergedTable.firstDataRowIndex);
        const rows = mergedTable.getWindow();
        
        const keyFieldName = mergedTable.getProperty("Key") || "PK";
        const pkColIdx = mergedTable.column[keyFieldName.toLowerCase()];
        
        if (pkColIdx !== undefined && rows.length > 0) {
          let updatedCount = 0;
          const updatedPks = rows.map(r => [r[pkColIdx]]);
          
          rows.forEach((row, rowOffset) => {
            const currentPk = String(row[pkColIdx] || "").trim();
            if (!currentPk) return;
            
            const upgraded = legacyToNewKeyMap.get(currentPk.toLowerCase());
            if (upgraded) {
              updatedPks[rowOffset] = [upgraded];
              updatedCount++;
            }
          });
          
          if (updatedCount > 0) {
            const pkRange = mergedTable.sheet.getRange(mergedTable.firstDataRowIndex, pkColIdx + 1, rows.length, 1);
            pkRange.setValues(updatedPks);
            myLog("info", "Successfully updated %d primary keys in Reconciliation_Merged from translation map.", updatedCount);
          }
        }
      }
    } catch (err) {
      myLog("error", "Failed to migrate Reconciliation_Merged: %s", err.message);
    }
    
    // --- PHASE 2: MIGRATE RECONCILIATION_GROUPS REFERENCES ---
    try {
      const groupsTable = Utils.getSheetInstance("Reconciliation_Groups");
      if (groupsTable) {
        myLog("info", "Processing reference migrations in Reconciliation_Groups...");
        groupsTable.withoutValidation();
        groupsTable.fetch(groupsTable.firstDataRowIndex);
        const rows = groupsTable.getWindow();
        
        const pkColIdx = groupsTable.column.pk;
        if (pkColIdx !== undefined && rows.length > 0) {
          let updatedCount = 0;
          const updatedPks = rows.map(r => [r[pkColIdx]]);
          
          rows.forEach((row, rowOffset) => {
            const currentPk = String(row[pkColIdx] || "").trim();
            if (!currentPk) return;
            
            const upgraded = legacyToNewKeyMap.get(currentPk.toLowerCase());
            if (upgraded) {
              updatedPks[rowOffset] = [upgraded];
              updatedCount++;
            }
          });
          
          if (updatedCount > 0) {
            const pkRange = groupsTable.sheet.getRange(groupsTable.firstDataRowIndex, pkColIdx + 1, rows.length, 1);
            pkRange.setValues(updatedPks);
            myLog("info", "Successfully updated %d primary key references in Reconciliation_Groups.", updatedCount);
          }
        }
      }
    } catch (err) {
      myLog("error", "Failed to migrate Reconciliation_Groups: %s", err.message);
    }
    
    // --- PHASE 3: MIGRATE NEWACCOUNTS_CORRECTIONS ---
    try {
      const correctionsTable = globals.correctionsObj;
      if (correctionsTable) {
        myLog("info", "Processing cascading migrations in NewAccounts_Corrections...");
        correctionsTable.withoutValidation();
        correctionsTable.fetch(correctionsTable.firstDataRowIndex);
        const rows = correctionsTable.getWindow();
        
        const globalIdColIdx = correctionsTable.column.globalid;
        if (globalIdColIdx !== undefined && rows.length > 0) {
          let updatedCount = 0;
          const updatedGlobalIds = rows.map(r => [r[globalIdColIdx]]);
          
          rows.forEach((row, rowOffset) => {
            const globalId = String(row[globalIdColIdx] || "").trim();
            if (!globalId) return;
            
            // Format: SheetName@PK
            const parts = globalId.split("@");
            if (parts.length === 2) {
              const sheetName = parts[0];
              const legacyPk = parts[1];
              
              const upgradedPk = legacyToNewKeyMap.get(legacyPk.toLowerCase());
              if (upgradedPk) {
                const newGlobalId = `${sheetName}@${upgradedPk}`;
                updatedGlobalIds[rowOffset] = [newGlobalId];
                updatedCount++;
              }
            }
          });
          
          if (updatedCount > 0) {
            const globalIdRange = correctionsTable.sheet.getRange(correctionsTable.firstDataRowIndex, globalIdColIdx + 1, rows.length, 1);
            globalIdRange.setValues(updatedGlobalIds);
            myLog("info", "Successfully upgraded %d GlobalID rows in NewAccounts_Corrections.", updatedCount);
          }
        }
      }
    } catch (err) {
      myLog("error", "Failed to migrate NewAccounts_Corrections: %s", err.message);
    }
    
    // --- PHASE 4: MIGRATE MANUALENTRY_BADDEBTS REFERENCES ---
    try {
      const badDebtsTable = Utils.getSheetInstance("ManualEntry_BadDebts");
      if (badDebtsTable) {
        myLog("info", "Processing reference migrations in ManualEntry_BadDebts...");
        badDebtsTable.withoutValidation();
        badDebtsTable.fetch(badDebtsTable.firstDataRowIndex);
        const rows = badDebtsTable.getWindow();
        
        const pkColIdx = badDebtsTable.column.pk;
        if (pkColIdx !== undefined && rows.length > 0) {
          let updatedCount = 0;
          const updatedPks = rows.map(r => [r[pkColIdx]]);
          
          rows.forEach((row, rowOffset) => {
            const currentPk = String(row[pkColIdx] || "").trim();
            if (!currentPk) return;
            
            const upgraded = legacyToNewKeyMap.get(currentPk.toLowerCase());
            if (upgraded) {
              updatedPks[rowOffset] = [upgraded];
              updatedCount++;
            }
          });
          
          if (updatedCount > 0) {
            const pkRange = badDebtsTable.sheet.getRange(badDebtsTable.firstDataRowIndex, pkColIdx + 1, rows.length, 1);
            pkRange.setValues(updatedPks);
            myLog("info", "Successfully updated %d primary key references in ManualEntry_BadDebts.", updatedCount);
          }
        }
      }
    } catch (err) {
      myLog("error", "Failed to migrate ManualEntry_BadDebts: %s", err.message);
    }
    
    // Flush changes
    SpreadsheetApp.flush();
    myLog("info", "🏆 Primary Key Upgrade and Reference Migration completed successfully!");
  }
};

// Expose on vh namespace
if (typeof vh === "undefined") {
  var vh = {};
}
vh.migrateAllPrimaryKeys = function() {
  KeyMigration.migrateAllPrimaryKeys();
};

/**
 * Top-level Google Apps Script entry point.
 * This will show up directly in the GAS Editor function dropdown menu.
 */
function runPrimaryKeyMigration() {
  vh.migrateAllPrimaryKeys();
}

