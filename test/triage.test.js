const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { classify, groupByName } = require('../src/triage');

function execution(statusCode, assertions = [{ passed: true }], options = {}) {
  return {
    statusCode,
    responseTime: options.responseTime ?? 10,
    responseBody: options.responseBody ?? null,
    assertions
  };
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

test('prefers endpoint_down over flaky for an intermittent failure after a healthy baseline', () => {
  const result = classify(
    'Get Orders',
    [execution(200), execution(200)],
    [execution(200), execution(500)]
  );

  assert.equal(result.category, 'endpoint_down');
  assert.equal(result.severity, 'medium');
  assert.match(result.detail, /intermittent/i);
});

test('keeps a complete endpoint outage at high severity', () => {
  const result = classify('Get Orders', [execution(200)], [execution(500)]);

  assert.equal(result.category, 'endpoint_down');
  assert.equal(result.severity, 'high');
});

test('downgrades partial schema failures and rate-limit regressions below 3x', () => {
  const schemaResult = classify(
    'Get Orders',
    [execution(200), execution(200)],
    [
      execution(200, [{ passed: false, name: 'Response schema', errorMessage: 'missing field' }]),
      execution(200)
    ]
  );
  const rateLimitResult = classify(
    'Get Orders',
    [execution(200, undefined, { responseTime: 100 })],
    [execution(200, undefined, { responseTime: 220 })]
  );

  assert.equal(schemaResult.category, 'schema_change');
  assert.equal(schemaResult.severity, 'medium');
  assert.equal(rateLimitResult.category, 'rate_limit_regression');
  assert.equal(rateLimitResult.severity, 'medium');
});

test('keeps a 3x rate-limit response-time regression at high severity', () => {
  const result = classify(
    'Get Orders',
    [execution(200, undefined, { responseTime: 100 })],
    [execution(200, undefined, { responseTime: 300 })]
  );

  assert.equal(result.category, 'rate_limit_regression');
  assert.equal(result.severity, 'high');
});

test('classifies an unchanged-status business-logic assertion failure as high-severity logic_bug', () => {
  const result = classify(
    'Get Book 3 availability',
    [execution(200)],
    [execution(200, [{ passed: false, name: 'Book is out of stock', errorMessage: 'expected true to deeply equal false' }])]
  );

  assert.equal(result.category, 'logic_bug');
  assert.equal(result.severity, 'high');
  assert.match(result.detail, /expected true to deeply equal false/);
});

test('classifies universal schema assertion failures as high-severity schema_change', () => {
  const schemaFailure = {
    passed: false,
    name: 'Response has price property',
    errorMessage: "expected object to have property 'price'"
  };
  const result = classify(
    'Get Books',
    [execution(200), execution(200)],
    [execution(200, [schemaFailure]), execution(200, [schemaFailure])]
  );

  assert.equal(result.category, 'schema_change');
  assert.equal(result.severity, 'high');
  assert.match(result.detail, /expected object to have property 'price'/);
});

test('prefers endpoint_down for an intermittent status regression with assertion failures', () => {
  const result = classify(
    'Get Orders',
    [execution(200), execution(200)],
    [
      execution(200),
      execution(500, [{ passed: false, name: 'Response is valid', errorMessage: 'expected false to equal true' }])
    ]
  );

  // A previously healthy 5xx is a specific root-cause signal, so it wins
  // over the competing assertion failure and intermittent-status signals.
  assert.equal(result.category, 'endpoint_down');
  assert.equal(result.severity, 'medium');
  assert.match(result.detail, /intermittent/i);
});

test('prefers rate_limit_regression over a simultaneous schema assertion failure', () => {
  const result = classify(
    'Get Orders',
    [execution(200, undefined, { responseTime: 100 })],
    [execution(200, [{ passed: false, name: 'Response schema', errorMessage: 'expected object to have property price' }], { responseTime: 300 })]
  );

  // Rate-limit/performance detection precedes assertion classification, and
  // classify() returns one primary category for each request.
  assert.equal(result.category, 'rate_limit_regression');
  assert.equal(result.severity, 'high');
});

test('uses a failed response body as an additional auth signal', () => {
  const result = classify(
    'Protected resource',
    [execution(200)],
    [execution(401, undefined, { responseBody: '{"error":"unauthorized session"}' })]
  );

  assert.equal(result.category, 'auth_failure');
  assert.equal(result.severity, 'high');
});

test('groups duplicate request names by Newman item ID when available', () => {
  const groups = groupByName([
    { id: 'admin-login', name: 'Login', statusCode: 200 },
    { id: 'customer-login', name: 'Login', statusCode: 401 },
    { id: null, name: 'Health check', statusCode: 200 }
  ]);

  assert.equal(groups.size, 3);
  assert.equal(groups.get('admin-login')[0].statusCode, 200);
  assert.equal(groups.get('customer-login')[0].statusCode, 401);
  assert.equal(groups.get('Health check')[0].statusCode, 200);
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

test('prints an actionable CLI error for syntactically invalid report JSON', (t) => {
  const root = path.resolve(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-invalid-report-'));
  const invalidReport = path.join(tempDir, 'invalid.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(invalidReport, '{not valid json');

  const result = spawnSync(
    process.execPath,
    ['src/triage.js', invalidReport, 'fixtures/after.json'],
    { cwd: root, encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to load Newman report/);
  assert.doesNotMatch(result.stderr, /\bat \S+ \(/);
});

test('reports an after-only request as new_test_no_baseline through the CLI pipeline', (t) => {
  const root = path.resolve(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-new-test-'));
  const beforeReport = path.join(tempDir, 'before.json');
  const afterReport = path.join(tempDir, 'after.json');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(beforeReport, JSON.stringify({ run: { executions: [] } }));
  fs.writeFileSync(afterReport, JSON.stringify({
    run: {
      executions: [{
        item: { id: 'new-request', name: 'New Request' },
        response: { code: 500, responseTime: 10 },
        assertions: []
      }]
    }
  }));

  const result = spawnSync(
    process.execPath,
    ['src/triage.js', beforeReport, afterReport],
    { cwd: root, encoding: 'utf8' }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /New Tests Without a Baseline \(1\)/);
  assert.match(result.stdout, /New Request/);
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
  assert.match(result.stdout, /Endpoint Down \(2\)/);
  assert.doesNotMatch(result.stdout, /Flaky Tests/);
});
