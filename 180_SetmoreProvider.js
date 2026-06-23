"use strict";

/**
 * gitCode_Redesign - SetmoreProvider (Level 5)
 * Concrete calendar table implementation for Setmore appointments sync.
 * Extends CalendarTable to fetch bookings and encrypt customer cell phone numbers for Tuya temp PINs.
 * Uses Symbolic Column Mapping to map fetched data to sheet columns dynamically.
 */
class SetmoreProvider extends CalendarTable {
  constructor(ss, longName, config = {}) {
    super(ss, longName, config);

    // Resolve Setmore specific parameters (Constructor Option -> Registry Property -> CONFIG_CONSTANTS default)
    this.refreshToken = config.refreshToken || this.getProperty("refreshToken") || CONFIG_CONSTANTS.SETMORE_REFRESH_TOKEN;
    this.staffName = config.staffName || this.getProperty("staffName") || CONFIG_CONSTANTS.SETMORE_STAFF_NAME;
    this.tuyaPINLength = Number(config.tuyaPINLength !== undefined ? config.tuyaPINLength : (this.getProperty("tuyaPINLength") !== null ? this.getProperty("tuyaPINLength") : CONFIG_CONSTANTS.TUYA_PIN_LENGTH));

    this.accessToken = this.getSetmoreAccessToken();
    this.staffKey = this.getStaffKeyByName(this.staffName);
  }

  /**
   * Transforms appointments fetched from Setmore API into 2D matrix matching the sheet's columns.
   * Utilizes the Symbolic Column Mapping system.
   */
  getAppointments() {
    const rawAppointments = this.fetchAppointments();
    const labels = this.getLabels();

    return rawAppointments.reduce((appointments, appointment) => {
      const c = appointment.customer || {};
      const customerName = `${c.first_name || 'New'} ${c.last_name || 'Customer'}`.trim();
      try {
        const lastDigits = String(c.cell_phone || "").replace(/[^0-9]/g, "").slice(-this.tuyaPINLength);
        myLog("trace", "SetmoreProvider: cell %s, lastDigits %s", String(c.cell_phone), lastDigits);

        const row = new Array(labels.length);

        // Populate standard columns using resolved symbolic offsets
        row[this.column[this.getProperty("Key")]] = appointment.key;
        row[this.column.start] = new Date(appointment.start_time);
        row[this.column.end] = new Date(appointment.end_time);
        row[this.column.duration] = appointment.duration;
        row[this.column.email] = c.email_id || "No Email";
        row[this.column.comment] = appointment.comment || "";
        row[this.column.customer] = customerName;
        row[this.column.encryptedpin] = lastDigits ? CryptoUtils.encrypt(lastDigits) : "";

        // Fill any empty cells with empty string to prevent write issues
        for (let i = 0; i < row.length; i++) {
          if (row[i] === undefined) row[i] = "";
        }

        appointments.push(row);
      } catch (e) {
        myLog("error", `Error processing appointment ${appointment.key}: ${e.message}`);
      }
      return appointments;
    }, []);
  }

  /**
   * AUTHENTICATION: Manages Setmore OAuth2 Token
   */
  getSetmoreAccessToken(force = false) {
    const cachedToken = getProp('SETMORE_ACCESS_TOKEN');
    const expiry = getProp('TOKEN_EXPIRY');
    const now = new Date().getTime();
    if (!force && cachedToken && expiry && (now < (parseInt(expiry) - 60000))) {
      return cachedToken;
    }

    const url = `https://developer.setmore.com/api/v1/o/oauth2/token?refreshToken=${this.refreshToken}`;
    try {
      const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
      const json = JSON.parse(response.getContentText());
      if (json.data && json.data.token) {
        const token = json.data.token.access_token;
        setProp('SETMORE_ACCESS_TOKEN', token);
        setProp('TOKEN_EXPIRY', (now + (7199 * 1000)).toString());  // 7199 seconds = 1 hour 59 minutes 59 seconds        
        return token;
      }
    } catch (e) {
      myLog("error", "Token Refresh Error: " + e.message);
    }
    return null;
  }

  /**
   * STAFF IDENTIFICATION
   */
  getStaffKeyByName(targetName) {
    if (!this.accessToken) {
      myLog("warn", "SetmoreProvider: No access token available to look up staff.");
      return null;
    }
    const url = `https://developer.setmore.com/api/v1/bookingapi/staffs`;
    try {
      const resp = UrlFetchApp.fetch(url, { headers: { 'Authorization': `Bearer ${this.accessToken}` } });
      const json = JSON.parse(resp.getContentText());
      if (json.data && json.data.staffs) {
        const found = json.data.staffs.find(s => s.first_name.includes(targetName));
        return found ? found.key : null;
      }
    } catch (e) {
      myLog("error", "SetmoreProvider: Failed to retrieve staff key: " + e.message);
    }
    return null;
  }

  /**
   * APPOINTMENT RETRIEVAL
   */
  fetchAppointments() {
    if (!this.staffKey) {
      myLog("warn", "SetmoreProvider: Cannot fetch appointments without staff key.");
      return [];
    }
    const startStr = Utilities.formatDate(this.past, "GMT", "dd-MM-yyyy");
    const endStr = Utilities.formatDate(this.future, "GMT", "dd-MM-yyyy");
    const url = `https://developer.setmore.com/api/v1/bookingapi/appointments?startDate=${startStr}&endDate=${endStr}&staff_key=${this.staffKey}&customerDetails=true`;
    try {
      const response = UrlFetchApp.fetch(url, { headers: { 'Authorization': `Bearer ${this.accessToken}` } });
      const json = JSON.parse(response.getContentText());
      return (json.data && json.data.appointments) ? json.data.appointments : [];
    } catch (e) {
      myLog("error", "SetmoreProvider: Failed to fetch appointments from Setmore API: " + e.message);
      return [];
    }
  }
}

// Register with globals (both renamed and legacy names)
globals.tableMap['SetmoreProvider'] = SetmoreProvider;
globals.tableMap['SetmoreCalendarTable'] = SetmoreProvider;
