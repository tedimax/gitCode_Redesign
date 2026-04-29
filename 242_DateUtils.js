"use strict";

/**
 * gitCode_Redesign - Date & Temporal Utilities
 * Provides functional wrappers for date manipulation using the Temporal API.
 */
const DateUtils = {

  /**
   * Converts various input formats to an ISO Date String (YYYY-MM-DD).
   */
  toISODate(val) {
    try {
      if (!val) return "";
      const plainDate = this._toTemporalPlainDate(val);
      return plainDate.toString();
    } catch (e) {
      myLog("error", "Error converting to ISO Date: %s", val);
      return "";
    }
  },

  /**
   * Converts various input formats to an ISO DateTime String.
   */
  toISODateTime(val) {
    try {
      if (!val) return "";
      const plainDateTime = this._toTemporalPlainDateTime(val);
      return plainDateTime.toString();
    } catch (e) {
      myLog("error", "Error converting to ISO DateTime: %s", val);
      return "";
    }
  },

  /**
   * Converts various input formats to an ISO Time String.
   */
  toISOTime(val) {
    try {
      if (!val) return "";
      const plainTime = this._toTemporalPlainTime(val);
      return plainTime.toString();
    } catch (e) {
      myLog("error", "Error converting to ISO Time: %s", val);
      return "";
    }
  },

  /**
   * Internal bridge to Temporal.PlainDate
   */
  _toTemporalPlainDate(val) {
    if (val instanceof Temporal.PlainDate) return val;
    
    let d = val;
    if (!(d instanceof Date) && typeof d === 'string') {
      // Aggressive Clean: Fix common non-standard formats (e.g. 081600 -> 08:16:00)
      const cleaned = d.replace(/(\d{2})(\d{2})(\d{2}) (GMT|UTC)/, "$1:$2:$3 $4");
      d = new Date(cleaned);
    }

    if (d instanceof Date && !isNaN(d.getTime())) {
      const iso = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      return Temporal.PlainDate.from(iso);
    }
    return Temporal.PlainDate.from(String(val));
  },

  /**
   * Internal bridge to Temporal.PlainDateTime
   */
  _toTemporalPlainDateTime(val) {
    if (val instanceof Temporal.PlainDateTime) return val;
    
    let d = val;
    if (!(d instanceof Date) && typeof d === 'string') {
      // Aggressive Clean: Fix common non-standard formats (e.g. 081600 -> 08:16:00)
      const cleaned = d.replace(/(\d{2})(\d{2})(\d{2}) (GMT|UTC)/, "$1:$2:$3 $4");
      d = new Date(cleaned);
    }

    if (d instanceof Date && !isNaN(d.getTime())) {
      const iso = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + 'T' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      return Temporal.PlainDateTime.from(iso);
    }
    return Temporal.PlainDateTime.from(String(val));
  },

  /**
   * Internal bridge to Temporal.PlainTime
   */
  _toTemporalPlainTime(val) {
    if (val instanceof Temporal.PlainTime) return val;
    if (val instanceof Date) {
      const iso = String(val.getHours()).padStart(2, '0') + ':' +
        String(val.getMinutes()).padStart(2, '0') + ':' +
        String(val.getSeconds()).padStart(2, '0');
      return Temporal.PlainTime.from(iso);
    }
  },

  /**
   * Converts a date to a compact string format (YYYYMMDD).
   * Used for generating unique Primary Keys.
   */
  toCompactDate(val) {
    if (!val) return "";
    const plainDate = this._toTemporalPlainDate(val);
    return plainDate.toString().replace(/-/g, "");
  },

  /**
   * Generates a series of dates between start and end based on frequency.
   * @param {string|Date} start - Generation start date.
   * @param {string|Date} end - Generation end date.
   * @param {string} interval - 'Daily', 'Weekly', 'Monthly', 'Yearly'.
   * @param {number} unit - The multiplier (e.g., 2 for 'Every 2 weeks').
   * @returns {Temporal.PlainDate[]} Array of dates.
   */
  getScheduledDates(start, end, interval, unit = 1) {
    const dates = [];
    if (!start || !end || !interval) return dates;

    try {
      const startDate = this._toTemporalPlainDate(start);
      const endDate = this._toTemporalPlainDate(end);
      const multiplier = Math.max(1, parseInt(unit, 10) || 1);
      
      let current = startDate;
      const duration = {};
      
      // Map interval to Temporal property
      const intervalKey = String(interval).toLowerCase().trim();
      switch(intervalKey) {
        case 'daily':   duration.days = multiplier; break;
        case 'weekly':  duration.weeks = multiplier; break;
        case 'monthly': duration.months = multiplier; break;
        case 'yearly':  duration.years = multiplier; break;
        default:        duration.days = multiplier;
      }

      // Generation Loop
      while (Temporal.PlainDate.compare(current, endDate) <= 0) {
        dates.push(current);
        current = current.add(duration);
      }
    } catch (e) {
      myLog("error", "Failed to generate scheduled dates: %s", e.message);
    }

    return dates;
  },

  /**
   * Calculates the Financial Year string (e.g. "23-24") for a given date.
   * Logic: April 1st start.
   */
  toFY(val) {
    if (!val) return "";
    const d = this._toTemporalPlainDate(val);
    const year = d.year;
    const month = d.month;
    
    if (month >= 4) {
      return `${String(year).slice(-2)}-${String(year + 1).slice(-2)}`;
    } else {
      return `${String(year - 1).slice(-2)}-${String(year).slice(-2)}`;
    }
  },

  /**
   * Thunking Layer: Final conversion for writing back to Google Sheets.
   * Toggles between native JS Date (for formatting) and ISO String (for speed).
   * Controlled by CONFIG_CONSTANTS.USE_NATIVE_DATES_FOR_SHEET.
   */
  toEgressDate(isoStr) {
    if (!isoStr) return "";
    if (CONFIG_CONSTANTS.USE_NATIVE_DATES_FOR_SHEET) {
      // Return a native JS Date object (Slow, but allows sheet formatting)
      const d = new Date(isoStr);
      return isNaN(d.getTime()) ? isoStr : d;
    }
    // Return a plain ISO string (Fast, but sheets see it as Text)
    return isoStr;
  }
};
