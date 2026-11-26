'use strict';

// Pricing parameters (NWP-PRICE stories). Status tags as in src/types/engine/params.js:
// SOURCED, PARAM (team must confirm), ESTIMATE, UNSOURCED.

module.exports = Object.freeze({
  // A device is flagged for manual review when every one of its synchronized pricing rows has failed this
  // many consecutive sync cycles (all its distributors unavailable for three cycles).
  MANUAL_REVIEW_THRESHOLD: 3,   // SOURCED (manuscript, Automated pricing updates item 5)
});