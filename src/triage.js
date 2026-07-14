#!/usr/bin/env node
/**
 * Regression Diff Triage Agent
 *
 * Takes two Newman JSON reporter exports (before / after a code change),
 * diffs the outcomes per request, and classifies each broken test into
 * a root cause bucket so a QA engineer doesn't have to read every log
 * by hand.
 *
 * Categories:
 *   - auth_failure      : previously-200 request now 401/403 on an
 *                         auth-related endpoint
 *   - endpoint_down     : previously-200 request now 4xx/5xx
 *   - schema_change     : status unchanged, but an assertion about a
 *                         response field/shape now fails
 *   - flaky             : the same request appears multiple times in
 *                         the after run with inconsistent outcomes
 *   - logic_bug         : status unchanged, an assertion fails, and it
 *                         is not a schema-shape assertion (silent
 *                         correctness regression)
 *
 * Usage: node src/triage.js <before.json> <after.json>
 */

const fs = require('fs');

function loadReport(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw.run.executions.map((exec) => ({
    name: exec.item.name,
    statusCode: exec.response ? exec.response.code : null,
    assertions: (exec.assertions || []).map((a) => ({
      name: a.assertion,
      passed: !a.error,
      errorMessage: a.error ? a.error.message : null
    }))
  }));
}

function groupByName(executions) {
  const map = new Map();
  for (const exec of executions) {
    if (!map.has(exec.name)) map.set(exec.name, []);
    map.get(exec.name).push(exec);
  }
  return map;
}

function isAuthRelated(name) {
  return /login|auth|token|credential/i.test(name);
}

function isSchemaAssertion(assertion) {
  return /property|field|shape|schema/i.test(assertion.name || '') ||
    /property|field|shape|schema/i.test(assertion.errorMessage || '');
}

function classify(name, beforeExecs, afterExecs) {
  const beforeStatuses = new Set(beforeExecs.map((e) => e.statusCode));
  const afterStatuses = afterExecs.map((e) => e.statusCode);
  const uniqueAfterStatuses = new Set(afterStatuses);

  const beforeAllPassed = beforeExecs.every((e) => e.assertions.every((a) => a.passed));
  const afterAnyFailed = afterExecs.some((e) => e.assertions.some((a) => !a.passed));
  const afterAnyStatusFail = afterExecs.some((e) => e.statusCode >= 400);

  if (beforeAllPassed && !afterAnyFailed && !afterAnyStatusFail) {
    return null; // still healthy, nothing to report
  }

  // Flaky: after run has multiple executions of the same request with
  // inconsistent status codes (some healthy, some not).
  if (afterExecs.length > 1 && uniqueAfterStatuses.size > 1) {
    return {
      category: 'flaky',
      severity: 'medium',
      detail: `Inconsistent results across ${afterExecs.length} repeated calls: statuses seen = [${[...uniqueAfterStatuses].join(', ')}]`
    };
  }

  const wasHealthy = [...beforeStatuses].every((s) => s < 400);
  const nowUnhealthy = afterStatuses.some((s) => s >= 400);

  if (wasHealthy && nowUnhealthy) {
    const badStatus = afterStatuses.find((s) => s >= 400);
    if ((badStatus === 401 || badStatus === 403) && isAuthRelated(name)) {
      return {
        category: 'auth_failure',
        severity: 'high',
        detail: `Request that previously succeeded now returns ${badStatus} on an auth-related endpoint. Likely a credential, token, or permission regression.`
      };
    }
    return {
      category: 'endpoint_down',
      severity: 'high',
      detail: `Request that previously returned ${[...beforeStatuses].join('/')} now returns ${badStatus}. Endpoint or upstream dependency likely broken.`
    };
  }

  // Status codes unchanged (still healthy), but an assertion regressed.
  if (afterAnyFailed) {
    const failedAssertions = afterExecs
      .flatMap((e) => e.assertions)
      .filter((a) => !a.passed);
    const schemaRelated = failedAssertions.some(isSchemaAssertion);

    if (schemaRelated) {
      return {
        category: 'schema_change',
        severity: 'high',
        detail: `Response status is unchanged, but a field/shape assertion now fails: "${failedAssertions[0].errorMessage}". Likely a response schema change (renamed/removed field).`
      };
    }

    return {
      category: 'logic_bug',
      severity: 'high',
      detail: `Response status is unchanged (still 200), but a business-logic assertion now fails: "${failedAssertions[0].errorMessage}". Silent correctness regression — no error code, so this would be missed by status-code-only monitoring.`
    };
  }

  return {
    category: 'unknown',
    severity: 'medium',
    detail: 'Behavior changed but did not match a known failure pattern. Needs manual review.'
  };
}

function main() {
  const [, , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('Usage: node src/triage.js <before.json> <after.json>');
    process.exit(1);
  }

  const beforeExecs = groupByName(loadReport(beforePath));
  const afterExecs = groupByName(loadReport(afterPath));

  const results = [];
  for (const [name, afterList] of afterExecs.entries()) {
    const beforeList = beforeExecs.get(name) || [];
    const classification = classify(name, beforeList, afterList);
    if (classification) {
      results.push({ name, ...classification });
    }
  }

  const bySeverityOrder = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => bySeverityOrder[a.severity] - bySeverityOrder[b.severity]);

  const grouped = {};
  for (const r of results) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  }

  printReport(grouped, results.length);
}

function printReport(grouped, totalFailures) {
  const categoryLabels = {
    auth_failure: 'Auth Failures',
    endpoint_down: 'Endpoint Down',
    schema_change: 'Schema Changes',
    flaky: 'Flaky Tests',
    logic_bug: 'Logic Bugs (Silent Regressions)',
    unknown: 'Unclassified'
  };

  console.log('\n=== Regression Diff Triage Report ===\n');
  console.log(`Total broken/flagged tests: ${totalFailures}\n`);

  for (const [category, items] of Object.entries(grouped)) {
    console.log(`## ${categoryLabels[category] || category} (${items.length})`);
    for (const item of items) {
      console.log(`  - [${item.severity.toUpperCase()}] ${item.name}`);
      console.log(`    ${item.detail}`);
    }
    console.log('');
  }

  console.log('=== End of Report ===\n');
}

if (require.main === module) {
  main();
}

module.exports = { loadReport, groupByName, classify };
