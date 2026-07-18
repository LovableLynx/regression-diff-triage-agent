const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { classify } = require('../src/triage');

function execution(statusCode, assertions = [{ passed: true }]) {
  return { statusCode, responseTime: 10, assertions };
}

test('classifies a missing response after a healthy baseline as endpoint_down', () => {
  const result = classify(
    'Get Orders',
    [execution(200)],
    [execution(null)]
  );

  assert.equal(result.category, 'endpoint_down');
  assert.match(result.detail, /no response received/i);
});

test('identifies an after-only request as a test with no baseline', () => {
  const result = classify('New Request', [], [execution(500)]);

  assert.equal(result.category, 'new_test_no_baseline');
  assert.match(result.detail, /no baseline/i);
});

test('prints an actionable CLI error for an unreadable report file', () => {
  const root = path.resolve(__dirname, '..');
  const result = spawnSync(
    process.execPath,
    ['src/triage.js', 'fixtures/does-not-exist.json', 'fixtures/after.json'],
    { cwd: root, encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to load Newman report "fixtures[\\/]does-not-exist\.json"/);
  assert.doesNotMatch(result.stderr, /\bat \S+ \(/);
});

test('the committed fixture pair still reports the original six findings', (t) => {
  const root = path.resolve(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-fixtures-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const fixture of ['before.json', 'after.json']) {
    const content = execFileSync('git', ['show', `HEAD:fixtures/${fixture}`], {
      cwd: root,
      encoding: 'utf8'
    });
    fs.writeFileSync(path.join(tempDir, fixture), content);
  }

  const result = spawnSync(
    process.execPath,
    ['src/triage.js', path.join(tempDir, 'before.json'), path.join(tempDir, 'after.json')],
    { cwd: root, encoding: 'utf8' }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Total broken\/flagged tests: 6/);
});
