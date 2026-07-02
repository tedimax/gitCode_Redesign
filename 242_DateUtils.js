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
   * Converts a range string (hh:mm AM - hh:mm PM) to ISO Time Range (HH:mm:ss - HH:mm:ss).
   */
  toISOTimeRange(val) {
    try {
      if (!val) return "";
      const parts = String(val).split("-").map(p => p.trim());
      if (parts.length === 2) {
        // Use a version of toISOTime that doesn't split again
        const start = this._toTemporalPlainTime(parts[0]).toString();
        const end = this._toTemporalPlainTime(parts[1]).toString();
        return `${start} - ${end}`;
      }
      return this.toISOTime(val);
    } catch (e) {
      myLog("error", "Error converting to ISO Time Range: %s", val);
      return String(val);
    }
  },

  /**
   * Internal bridge to Temporal.PlainDate
   */
  _toTemporalPlainDate(val) {
    if (val === null || val === undefined || val === "") return null;
    if (val instanceof Temporal.PlainDate) return val;
    
    let d = val;
    if (typeof d === 'string' && d.trim() !== "") {
      d = d.trim();
      // Natively parse DD/MM/YYYY or DD/MM/YYYY HH:mm:ss to prevent standard JS MM/DD/YYYY locale bugs
      const slashMatch = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (slashMatch) {
        return Temporal.PlainDate.from({
          year: Number(slashMatch[3]),
          month: Number(slashMatch[2]),
          day: Number(slashMatch[1])
        });
      }
      
      const dashMatch = d.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{2}):(\d{2}):(\d{2}))?/);
      if (dashMatch) {
        return Temporal.PlainDate.from({
          year: Number(dashMatch[1]),
          month: Number(dashMatch[2]),
          day: Number(dashMatch[3])
        });
      }

      // Aggressive Clean: Fix common non-standard formats (e.g. 081600 -> 08:16:00)
      const cleaned = d.replace(/(\d{2})(\d{2})(\d{2}) (GMT|UTC)/, "$1:$2:$3 $4");
      d = new Date(cleaned);
    }

    if (typeof d === 'number') {
      // Excel/Google Sheets serial date value (Dec 30 1899 epoch)
      const dateObj = new Date((d - 25569) * 86400 * 1000);
      if (!isNaN(dateObj.getTime())) {
        d = dateObj;
      }
    }

    const isDateObject = d instanceof Date || (d && typeof d.getTime === 'function' && !isNaN(d.getTime()));
    if (isDateObject) {
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
    if (val === null || val === undefined || val === "") return null;
    if (val instanceof Temporal.PlainDateTime) return val;
    
    let d = val;
    if (typeof d === 'string' && d.trim() !== "") {
      d = d.trim();
      // Natively parse DD/MM/YYYY HH:mm:ss or DD/MM/YYYY to prevent standard JS MM/DD/YYYY locale bugs
      const slashMatch = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (slashMatch) {
        return Temporal.PlainDateTime.from({
          year: Number(slashMatch[3]),
          month: Number(slashMatch[2]),
          day: Number(slashMatch[1]),
          hour: Number(slashMatch[4] || 0),
          minute: Number(slashMatch[5] || 0),
          second: Number(slashMatch[6] || 0)
        });
      }

      const dashMatch = d.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{2}):(\d{2}):(\d{2}))?/);
      if (dashMatch) {
        return Temporal.PlainDateTime.from({
          year: Number(dashMatch[1]),
          month: Number(dashMatch[2]),
          day: Number(dashMatch[3]),
          hour: Number(dashMatch[4] || 0),
          minute: Number(dashMatch[5] || 0),
          second: Number(dashMatch[6] || 0)
        });
      }

      // Aggressive Clean: Fix common non-standard formats (e.g. 081600 -> 08:16:00)
      const cleaned = d.replace(/(\d{2})(\d{2})(\d{2}) (GMT|UTC)/, "$1:$2:$3 $4");
      d = new Date(cleaned);
    }

    const isDateObject = d instanceof Date || (d && typeof d.getTime === 'function' && !isNaN(d.getTime()));
    if (isDateObject) {
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
    if (val === null || val === undefined || val === "") return null;
    if (val instanceof Temporal.PlainTime) return val;
    
    let d = val;
    if (typeof d === 'string' && d.trim() !== "") {
      // 0. Handle strings with dates and times (e.g. "30/12/1899 09:44:18") by taking the time portion
      const parts = d.trim().split(/\s+/);
      const timePart = parts.find(p => p.includes(":"));
      if (timePart) {
        d = timePart;
      }

      // 1. Handle ranges (09:30 AM - 01:00 PM) -> Take the start
      if (d.includes("-")) d = d.split("-")[0].trim();

      // 2. Try native Date parsing for AM/PM support
      const dateParse = new Date(`2000-01-01 ${d}`);
      if (!isNaN(dateParse.getTime())) {
        d = dateParse;
      }
    }

    if (typeof d === 'number') {
      // Excel/Google Sheets fractional day time value
      const totalSeconds = Math.round(d * 86400);
      const hours = Math.floor(totalSeconds / 3600) % 24;
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const iso = String(hours).padStart(2, '0') + ':' +
        String(minutes).padStart(2, '0') + ':' +
        String(seconds).padStart(2, '0');
      return Temporal.PlainTime.from(iso);
    }

    const isDateObject = d instanceof Date || (d && typeof d.getTime === 'function' && !isNaN(d.getTime()));
    if (isDateObject) {
      const iso = String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      return Temporal.PlainTime.from(iso);
    }

    // Final Fallback: Attempt direct Temporal conversion
    return Temporal.PlainTime.from(String(val).split("-")[0].trim());
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
      const multiplier = Math.max(1, Number(unit) || 1);
      
      let current = startDate;
      const duration = {};
      
      // Map interval to Temporal property - robust case-insensitive substring matching
      const intervalKey = String(interval).toLowerCase().trim();
      if (intervalKey.includes('day') || intervalKey.includes('daily') || intervalKey === 'd') {
        duration.days = multiplier;
      } else if (intervalKey.includes('week') || intervalKey.includes('weekly') || intervalKey === 'w') {
        duration.weeks = multiplier;
      } else if (intervalKey.includes('month') || intervalKey.includes('monthly') || intervalKey === 'm') {
        duration.months = multiplier;
      } else if (intervalKey.includes('year') || intervalKey.includes('yearly') || intervalKey === 'y') {
        duration.years = multiplier;
      } else {
        myLog("warn", "DateUtils: Unknown repeat interval value '%s'. Defaulting to daily.", interval);
        duration.days = multiplier;
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
    if (d.month >= 4) {
      return `${String(d.year).slice(-2)}-${String(d.year + 1).slice(-2)}`;
    } else {
      return `${String(d.year - 1).slice(-2)}-${String(d.year).slice(-2)}`;
    }
  },

  /**
   * Calculates the starting year of the Financial Year for a given date.
   * Logic: April 1st start. (e.g. 2024-01-01 -> "2023", 2024-04-01 -> "2024")
   */
  getFYStartYear(val) {
    if (!val) return null;
    try {
      const d = this._toTemporalPlainDate(val);
      return String(d.month >= 4 ? d.year : d.year - 1);
    } catch (e) {
      return null;
    }
  },

  /**
   * Thunking Layer: Final conversion for writing back to Google Sheets.
   * Toggles between native JS Date (for formatting) and ISO String (for speed).
   * Controlled by CONFIG_CONSTANTS.USE_NATIVE_DATES_FOR_SHEET.
   */
  toEgressDate(isoStr, type = "Date") {
    if (!isoStr) return "";
    if (CONFIG_CONSTANTS.USE_NATIVE_DATES_FOR_SHEET) {
      try {
        const cleanType = String(type || "Date").trim();
        if (cleanType === "Time") {
          // Plain time values (e.g. "09:44:18") should be returned as strings.
          // Writing time as a string allows Google Sheets to parse it natively,
          // avoiding all timezone/leap-year/BST shifts that occur with pre-1900 Date objects.
          return String(isoStr).split("T").pop().split("Z")[0];
        }
        
        // Date or DateTime values should be created as local Dates to avoid timezone shifts in Google Sheets
        const parts = String(isoStr).split("T");
        const dateParts = parts[0].split("-").map(Number);
        if (dateParts.length === 3 && !dateParts.some(isNaN)) {
          if (parts[1]) {
            const timeParts = parts[1].split("Z")[0].split(":");
            const hrs = parseInt(timeParts[0], 10) || 0;
            const mins = parseInt(timeParts[1], 10) || 0;
            const secs = parseInt(timeParts[2], 10) || 0;
            return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], hrs, mins, secs);
          }
          return new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
        }
      } catch (e) {
        // Fallback
      }
      const d = new Date(isoStr);
      return isNaN(d.getTime()) ? isoStr : d;
    }
    return isoStr;
  },

  /**
   * Extracts a 4-digit year string from various formats (Date, String, Number).
   * Returns null if the input is not a valid year.
   */
  parseYear(val) {
    if (val instanceof Date) return String(val.getFullYear());
    if (val instanceof Temporal.PlainDate) return String(val.year);
    
    const yearStr = StringUtils.sanitizeName(val);
    if (!yearStr) return null;

    const year = yearStr.split(".")[0].replace(/,/g, "");
    return (year.length === 4) ? year : null;
  }
};
