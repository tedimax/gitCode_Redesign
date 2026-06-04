"use strict";

/**
 * gitCode_Redesign - CalendarTable (Level 4)
 * Base class for all external calendar/appointments ingestion tables.
 * Extends UpdateTable to handle syncing appointment records.
 */
class CalendarTable extends UpdateTable {
  constructor(ss, longName, config = {}) {
    super(ss, longName, config);
    const day2Millisecond = 24 * 60 * 60 * 1000;
    
    // Resolve past/future bounds using config, table properties, or CONFIG_CONSTANTS fallbacks
    const pastDays = Number(config.past !== undefined ? config.past : (this.getProperty("past") !== null ? this.getProperty("past") : CONFIG_CONSTANTS.SETMORE_PAST));
    const futureDays = Number(config.future !== undefined ? config.future : (this.getProperty("future") !== null ? this.getProperty("future") : CONFIG_CONSTANTS.SETMORE_FUTURE));
    
    this.appointments = [];
    this.today = new Date();
    this.today.setHours(0, 0, 0, 0);
    this.now = this.today.getTime();
    this.past = new Date(this.now + (pastDays * day2Millisecond));
    this.future = new Date(this.now + (futureDays * day2Millisecond));
  }

  /**
   * Abstract Method: Must return a 2D matrix matching the table's schema.
   * @returns {any[][]}
   */
  getAppointments() {
    throw new Error("Method 'getAppointments()' must be implemented by subclass.");
  }

  /**
   * Preparation Hook: Returns appointments data.
   * Called by execute() natively.
   */
  prepare() {
    myLog("info", "CalendarTable: Preparing appointments for %s...", this.longName);
    this.appointments = this.getAppointments();
    return this.appointments;
  }

  /**
   * Orchestrates calendar syncing.
   * Uses execute() from UpdateTable.
   */
  sync() {
    return this.execute();
  }
}

// Register with globals
globals.tableMap['CalendarTable'] = CalendarTable;
