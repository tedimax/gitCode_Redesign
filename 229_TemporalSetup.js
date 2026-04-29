"use strict";

(function(global) {
  try {
    if (typeof globalThis.Temporal !== 'undefined') {
      console.log("Temporal API is available globally.");
    } else if (typeof global.Temporal !== 'undefined') {
      console.log("Temporal API found on global object.");
    } else {
      console.error("Temporal API NOT found. Check if 228_TemporalPolyfill.js loaded correctly.");
    }

    if (typeof Date.prototype['toTemporalInstant'] === 'function') {
      console.log("Date.prototype.toTemporalInstant is available.");
    } else {
      console.warn("Date.prototype.toTemporalInstant is missing.");
    }
  } catch (e) {
    console.error("Error during Temporal initialization check: " + e.message);
  }
})(this);
