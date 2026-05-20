/**
 * Temporary Scratch Script to inspect Sheet registry configurations.
 */
function inspectConfig() {
  initialize();
  const sheets = ["Ledgers_SquarePayments", "Ledgers_SquareFees", "Ledgers_SquareDeposits", "Ledgers_SquareTransactions"];
  
  myLog("info", "=== Registry KeyPrefix Inspections ===");
  sheets.forEach(name => {
    try {
      const config = Registry.getSheetConfig(name);
      myLog("info", "Sheet: %s | KeyPrefix: '%s' | SSID: %s", 
        name, config.KeyPrefix || config.keyPrefix || "NULL", config.SSID);
    } catch (e) {
      myLog("error", "Error inspecting %s: %s", name, e.message);
    }
  });
}
