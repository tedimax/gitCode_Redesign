"use strict";

/**
 * gitCode_Redesign - TuyaTable (Level 4)
 * Physical table subclass for interfacing with Tuya locks, logging, and PIN management.
 * Integrates natively with the redesigned Sheet, Table, and UpdateTable APIs.
 */
class TuyaTable extends UpdateTable {
  constructor(ss, longName, config = {}) {
    super(ss, longName, config);
    this.accessToken = this.getAccessToken();
    this.cols = this.getSymbolicOffsets() || {};
    
    // Dynamically resolve id offset from the Registry's "Key" property
    const keyHeader = this.getProperty("Key") || "id";
    this.cols.id = this.getColOffset(keyHeader);
    
    // Validate required columns based on sheet role
    let requiredKeys = [];
    if (this.longName === "Keys_IssuedPINS") {
      requiredKeys = ['id', 'encryptedPin', 'name', 'appointmentTime', 'effectiveTime', 'invalidTime', 'issued'];
    } else if (this.longName === "Keys_TuyaTempPINS") {
      requiredKeys = ['id', 'effectiveTime', 'invalidTime', 'deliveryStatus', 'phase'];
    } else if (this.longName === "Keys_TuyaLogs") {
      requiredKeys = ['id', 'updateTime'];
    }
    
    requiredKeys.forEach(k => {
      if (this.cols[k] === undefined || this.cols[k] === -1) {
        const label = k === 'id' ? keyHeader : TABLE_COLUMN_MAP[this.longName][k];
        throw new Error(`TuyaTable [${this.longName}]: Required column "${label}" is missing from sheet.`);
      }
    });
  }

  /**
   * Helper to construct a local key-to-row-object cache using native Table methods.
   * Replaces the legacy windowObject proxy.
   */
  _buildRowObjectCache() {
    return this.getWindow().reduce((cache, row, offset) => {
      const key = this.getRowKey(row, this.firstDataRowIndex + offset);
      if (key) {
        cache[key] = this.getRowObjectByOffset(offset);
      }
      return cache;
    }, {});
  }

  issueTempPINs() {
    const tempBookings = getSheetInstance("Keys_TemporaryBookings");
    const tempBookCols = tempBookings.getSymbolicOffsets() || {};
    
    if (tempBookCols.email === undefined || tempBookCols.email === -1 ||
        tempBookCols.encryptedPin === undefined || tempBookCols.encryptedPin === -1 ||
        tempBookCols.start === undefined || tempBookCols.start === -1) {
      throw new Error("TuyaTable: Missing mandatory columns [Email, EncryptedPIN, Start] in Keys_TemporaryBookings.");
    }

    const apptTimeCol = this.cols.appointmentTime;
    if (apptTimeCol === undefined || apptTimeCol === -1) {
      throw new Error(`TuyaTable: Required column "appointment_time" not found in ${this.longName}.`);
    }

    const issuedAppointmentTimes = new Set(
      this.getWindow()
        .map(row => row[apptTimeCol])
        .filter(time => time)
        .map(time => new Date(time).setSeconds(0, 0))
    );

    const filteredBookings = tempBookings.getWindow().filter(row =>
      row[tempBookCols.start] && !issuedAppointmentTimes.has(new Date(row[tempBookCols.start]).setSeconds(0, 0)));
      
    const newRows = filteredBookings.map(booking => {
      const appointment = {
        name: String(booking[tempBookCols.email] || "").substr(0, 20),
        pin: CryptoUtils.decrypt(booking[tempBookCols.encryptedPin]),
        appointmentTime: new Date(booking[tempBookCols.start])
      };
      const parms = this.enrollTemporaryPIN(appointment);
      return this.buildAccessLogRow(appointment, parms.payload, parms.results);
    });
    
    this.addRows(newRows);
  }

  issueNewPIN(appointment) {
    const parms = this.enrollTemporaryPIN(appointment);
    const row = this.buildAccessLogRow(appointment, parms.payload, parms.results);
    this.addRows(row);
    return parms.results;
  }

  enrollTemporaryPIN(appointment) {
    const { name, pin, appointmentTime } = appointment;
    const date = new Date(appointmentTime);
    date.setHours(0, 0, 0, 0);
    const start = Math.floor(date.getTime() / 1000) - CONFIG_CONSTANTS.ONE_DAY_IN_SECONDS;
    const end = Math.floor(date.getTime() / 1000) + CONFIG_CONSTANTS.TWO_DAYS_IN_SECONDS_MINUS_ONE;
    
    const ticketRes = this.makeTuyaApiRequest('POST', getProp('TUYA_PIN_REQUEST'));
    const decryptedTicketKey = this.decryptTuyaTicket(ticketRes.result.ticket_key);
    const finalPasswordHex = this.encryptPinWithTicket(pin, decryptedTicketKey);
    
    const payload = {
      "name": name,
      "password": finalPasswordHex,
      "password_type": "ticket",
      "ticket_id": ticketRes.result.ticket_id,
      "effective_time": start,
      "invalid_time": end,
      "type": 0
    };
    
    const results = this.makeTuyaApiRequest('POST', getProp('TUYA_TEMP_PIN'), payload);
    return { payload, results };
  }

  buildAccessLogRow(appointment, payload, results) {
    const { name, pin, appointmentTime } = appointment;
    const labels = this.getLabels();
    const row = new Array(labels.length);
    
    row.fill("");
    
    row[this.cols.id] = (results.result.id || results.result || "").toString();
    row[this.cols.encryptedPin] = CryptoUtils.encrypt(pin);
    row[this.cols.name] = name;
    row[this.cols.appointmentTime] = new Date(appointmentTime);
    row[this.cols.effectiveTime] = new Date(payload.effective_time * 1000);
    row[this.cols.invalidTime] = new Date(payload.invalid_time * 1000);
    row[this.cols.issued] = new Date();
    
    labels.forEach((columnLabel, offset) => {
      const isKnown = (offset === this.cols.id ||
                       offset === this.cols.encryptedPin ||
                       offset === this.cols.name ||
                       offset === this.cols.appointmentTime ||
                       offset === this.cols.effectiveTime ||
                       offset === this.cols.invalidTime ||
                       offset === this.cols.issued);
      if (!isKnown) {
        row[offset] = results[columnLabel] !== undefined ? results[columnLabel] : "";
      }
    });
    
    return row;
  }

  updateLockLogs() {
    const updateTimeKey = TABLE_COLUMN_MAP[this.longName].updateTime || "update_time";
    const accessLogs = this.getLockLogs().map(logRow => {
      Object.entries(logRow).forEach(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          Object.entries(value).map(([subKey, subVal]) => logRow[`${key}_${subKey}`] = subVal);
        } else {
          if (key === "update_time") {
            logRow[updateTimeKey] = new Date(value);
          } else {
            logRow[key] = value;
          }
        }
      });
      return logRow;
    });
    this.updateRows(accessLogs);
  }

  getLockLogs(pageNo = 1, pageSize = 20) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (86400 * 7); // Default to last 7 days

    const path = `/v1.0/devices/${getProp('TUYA_DEVICE_ID')}/door-lock/open-logs` +
      `?page_no=${pageNo}` +
      `&page_size=${pageSize}` +
      `&start_time=${start}` +
      `&end_time=${now}`;

    try {
      const results = this.makeTuyaApiRequest('GET', path);

      // If v1.0 fails with a parameter error, try v1.1 which is common for newer models
      if (!results.success && results.code === 1100) {
        const retryPath = path.replace('v1.0', 'v1.1');
        const retryResults = this.makeTuyaApiRequest('GET', retryPath);
        return (retryResults.result && retryResults.result.logs) ? retryResults.result.logs : [];
      }

      return (results.result && results.result.logs) ? results.result.logs : [];
    } catch (e) {
      myLog("error", "Failed to fetch lock logs: " + e.message);
      return [];
    }
  }

  updateTemporaryPINS() {
    const newRows = [];
    const currentInventory = this.getTempPINS();
    const inventoryIds = new Set();
    
    // Construct local key-to-row-object cache natively
    const windowObject = this._buildRowObjectCache();
    
    const idKey = TABLE_COLUMN_MAP[this.longName].id || "id";
    const phaseKey = TABLE_COLUMN_MAP[this.longName].phase || "phase";
    const deliveryStatusKey = TABLE_COLUMN_MAP[this.longName].deliveryStatus || "delivery_status";
    const effectiveTimeKey = TABLE_COLUMN_MAP[this.longName].effectiveTime || "effective_time";
    const invalidTimeKey = TABLE_COLUMN_MAP[this.longName].invalidTime || "invalid_time";
    
    currentInventory.forEach(lockRow => {
      myLog("trace", "TuyaTable: id %s, phase %s", lockRow.id, lockRow.phase);
      inventoryIds.add(String(lockRow.id));
      
      const processedRow = {};
      processedRow[idKey] = String(lockRow.id);
      processedRow[phaseKey] = lockRow.phase;
      processedRow[deliveryStatusKey] = CONFIG_CONSTANTS.TUYA_PHASES[lockRow.phase];
      
      if (lockRow.effective_time) {
        processedRow[effectiveTimeKey] = new Date(lockRow.effective_time * 1000);
      }
      if (lockRow.invalid_time) {
        processedRow[invalidTimeKey] = new Date(lockRow.invalid_time * 1000);
      }
      
      const exists = this.getHashKeyMap().has(String(lockRow.id).toLowerCase());
      if (exists) {
        newRows.push({ ...windowObject[lockRow.id], ...processedRow });
      } else {
        newRows.push(processedRow);
      }
    });
    
    this.updateRows(newRows);
    
    const now = new Date();
    const idsToDelete = [];
    this.getWindow().forEach((row, idx) => {
      const existingId = this.getRowKey(row, this.firstDataRowIndex + idx);
      if (!existingId) return;
      if (!inventoryIds.has(existingId)) {
        idsToDelete.push(existingId);
        return;
      }
      const expiryVal = row[this.cols.invalidTime];
      if (expiryVal && new Date(expiryVal) < now) {
        idsToDelete.push(existingId);
      }
    });
    
    if (idsToDelete.length > 0) {
      const offsetsToDelete = idsToDelete
        .map(id => {
          const offset = this.getRowOffset(id);
          return offset === undefined ? -1 : offset;
        })
        .filter(offset => offset !== -1)
        .sort((a, b) => b - a);          // Sort DESCENDING (highest index first)
        
      myLog("trace", "TuyaTable: Deleting rows at offsets: %j", offsetsToDelete);
      offsetsToDelete.forEach(offset => this.deleteRowByOffset(offset));
    }
  }

  getTempPINS() {
    const deviceId = getProp("TUYA_DEVICE_ID");
    const inventory = [];
    const tempRes = this.makeTuyaApiRequest('GET', `/v1.0/devices/${deviceId}/door-lock/temp-passwords`);
    if (tempRes.success && tempRes.result) {
      tempRes.result.forEach(row => {
        row.type = row.type || "Ticket";
        inventory.push(row);
      });
    }
    return inventory;
  }

  fetchPasswordStatus(cloudId) {
    const detailPath = getProp('TUYA_TEMP_PIN') + `/${cloudId}`;
    const result = this.makeTuyaApiRequest('GET', detailPath);
    return (result.success && result.result) ? result.result : null;
  }

  getDeviceStatus() {
    return this.makeTuyaApiRequest('GET', `/v1.0/devices/${getProp('TUYA_DEVICE_ID')}/status`);
  }

  pollForHardwareSuccess(cloudId, seconds) {
    const maxAttempts = Math.ceil(seconds / Number(getProp('TUYA_POLL_DURATION')));
    for (let i = 0; i < maxAttempts; i++) {
      Utilities.sleep(Number(getProp('TUYA_POLL_DURATION')));
      const detailPath = getProp('TUYA_TEMP_PIN') + `/${cloudId}`;
      const result = this.makeTuyaApiRequest('GET', detailPath);
      if (result.success && result.result) return result.result;
    }
    myLog("info", `⚠ Polling timed out for ID: ${cloudId}. Hardware may still be syncing.`);
    return false;
  }

  getAccessToken() {
    let token = getProp('TUYA_ACCESS_TOKEN');
    const expiryTime = getProp('TUYA_TOKEN_EXPIRY'); // Stores timestamp in ms
    const now = Date.now();
    
    if (!(token && expiryTime && (now < (parseInt(expiryTime) - 300000))) || getProp('TUYA_EXPIRY_OVERRIDE') === "TRUE") {
      const timestamp = now;
      const tuyaSigningString = getProp('TUYA_CLIENT_ID') + timestamp + 'GET\n' + getProp('SHA256_OF_NOTHING') + '\n\n' + getProp('TUYA_SIGN_URL');
      
      const options = {
        headers: {
          client_id: getProp('TUYA_CLIENT_ID'),
          sign: this.signTuyaRequest(tuyaSigningString),
          t: timestamp.toString(),
          sign_method: getProp('TUYA_SIGN_METHOD')
        }
      };
      
      const result = UrlFetchApp.fetch(getProp('TUYA_URL') + getProp('TUYA_SIGN_URL'), options);
      const data = JSON.parse(result.getContentText());
      if (!data.success)
        throw new Error('Tuya Auth Failed: ' + data.msg);
        
      token = data.result.access_token;
      const expireInMs = data.result.expire_time * 1000;
      setProp('TUYA_ACCESS_TOKEN', token);
      setProp('TUYA_TOKEN_EXPIRY', (now + expireInMs).toString());
    }
    return token;
  }

  signTuyaRequest(tuyaSigningString) {
    return Utilities.computeHmacSha256Signature(tuyaSigningString, getProp('TUYA_CLIENT_SECRET'))
      .map(b => (b & 0xFF).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  makeTuyaApiRequest(method, path, body = null) {
    const timestamp = Date.now().toString();
    const httpMethod = method.toUpperCase();
    const bodyHash = (body && Object.keys(body).length > 0 && httpMethod !== 'GET')
      ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(body))
        .map(b => (b & 0xFF).toString(16).padStart(2, '0'))
        .join('')
      : getProp('SHA256_OF_NOTHING');
      
    const pathParts = path.split('?');
    const urlPath = pathParts[0];
    const queryString = pathParts[1] || "";
    
    const sortedQueryString = queryString.split('&')
      .filter(param => param.length > 0)
      .sort()
      .join('&');
      
    const canonicalRequest = httpMethod + '\n' +
      bodyHash + '\n' +
      '\n' +
      urlPath + (sortedQueryString ? '?' + sortedQueryString : '');
      
    const tuyaSigningString = getProp('TUYA_CLIENT_ID') + this.accessToken + timestamp + canonicalRequest;
    
    const options = {
      method: httpMethod,
      headers: {
        'client_id': getProp('TUYA_CLIENT_ID'),
        'access_token': this.accessToken,
        'sign': this.signTuyaRequest(tuyaSigningString),
        't': timestamp,
        'sign_method': getProp('TUYA_SIGN_METHOD'),
        'Content-Type': 'application/json'
      },
      payload: (httpMethod === 'GET' || !body) ? null : JSON.stringify(body),
      muteHttpExceptions: true
    };
    
    const result = JSON.parse(UrlFetchApp.fetch(getProp('TUYA_URL') + path, options).getContentText());
    if (!result.success)
      throw new Error(`API Error [${path}]: ${result.msg} (Code: ${result.code})`);
    return result;
  }

  decryptTuyaTicket(tuyaEncryptedTicket) {
    const result = CryptoUtils.NativeAES.decryptHex(tuyaEncryptedTicket, getProp('TUYA_CLIENT_SECRET'));
    if (!result)
      throw new Error("Decryption resulted in an empty string. This usually means the Secret Key is incorrect for this Ticket.");
    return result;
  }

  encryptPinWithTicket(pin, decryptedTicketKey) {
    return CryptoUtils.NativeAES.toH(CryptoUtils.NativeAES.encrypt(pin, decryptedTicketKey)).toUpperCase();
  }

  // =========================================================================
  // BATCH MODIFICATION METHODS (NATIVE CONVERSION)
  // =========================================================================

  normaliseRows(newRows) {
    if (!newRows) return [];
    let rows = Array.isArray(newRows) ? newRows : [newRows];
    if (rows.length === 0) return [];
    
    // Wrapped if flat array
    if (typeof rows[0] !== 'object' || rows[0] === null) {
      rows = [rows];
    }
    
    const labels = this.getLabels();
    const map = TABLE_COLUMN_MAP[this.longName] || {};
    const labelToSymKey = {};
    for (const [symKey, label] of Object.entries(map)) {
      labelToSymKey[label.toLowerCase()] = symKey;
    }

    return rows.map(row => {
      if (Array.isArray(row)) return row;
      if (typeof row === 'object' && row !== null) {
        return labels.map((label, offset) => {
          const lowerLabel = label.toLowerCase();
          
          // 1. Try finding by symbolic key (e.g. row.effectiveTime)
          const symKey = labelToSymKey[lowerLabel];
          if (symKey !== undefined && row[symKey] !== undefined) {
            return row[symKey];
          }
          
          // 2. Try finding by literal label case-insensitively (e.g. row["effective_time"])
          const foundKey = Object.keys(row).find(k => k.toLowerCase() === lowerLabel);
          if (foundKey !== undefined) {
            return row[foundKey];
          }
          
          // 3. Try finding by symbolic key case-insensitively (e.g. row["effectivetime"])
          if (symKey !== undefined) {
            const symKeyLower = symKey.toLowerCase();
            const foundSymKey = Object.keys(row).find(k => k.toLowerCase() === symKeyLower);
            if (foundSymKey !== undefined) {
              return row[foundSymKey];
            }
          }
          
          return "";
        });
      }
      return row;
    });
  }

  addRows(newRows) {
    const normalised = this.normaliseRows(newRows);
    if (normalised.length > 0) {
      this._persistAdd(normalised);
      this.clearCache();
      this._isHashed = false;
    }
  }

  updateRows(newRows) {
    const normalised = this.normaliseRows(newRows);
    if (normalised.length > 0) {
      this._persistUpdate(normalised);
      this.clearCache();
      this._isHashed = false;
    }
  }

  deleteRowByOffset(rowOffset) {
    const physicalRow = this.firstDataRowIndex + rowOffset;
    if (this.sheet && physicalRow <= this.sheet.getLastRow()) {
      this.deleteRow(physicalRow);
      this.clearCache();
      this._isHashed = false;
    }
  }
}

// Register with globals
globals.tableMap['TuyaTable'] = TuyaTable;
