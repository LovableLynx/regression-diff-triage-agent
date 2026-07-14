/**
 * Flips the running mock API from "before" (healthy) to "after"
 * (regressed) mode by writing state.json directly. Run this between
 * the before and after Newman runs.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'state.json');

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { mode: 'before', flakyCallCount: {} };

state.mode = 'after';
state.flakyCallCount = {}; // reset flaky counters for a clean demo run

fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log('Mock API switched to AFTER (regressed) mode.');
