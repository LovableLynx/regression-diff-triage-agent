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
 *   - rate_limit_regression : previously-fast, healthy request now
 *                         receives 429s or has a major latency increase
 *   - logic_bug         : status unchanged, an assertion fails, and it
 *                         is not a schema-shape assertion (silent
 *                         correctness regression)
 *
 * Usage: node src/triage.js <before.json> <after.json>
 */

const fs = require('fs');

function responseBody(response) {
  if (!response) return null;
  if (typeof response.body === 'string') return response.body;
  if (response.stream && Array.isArray(response.stream.data)) {
    return Buffer.from(response.stream.data).toString('utf8');
  }
  return null;
}

function loadReport(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw.run || !Array.isArray(raw.run.executions)) {
      throw new Error('expected a Newman JSON report with run.executions');
    }

    return raw.run.executions.map((exec) => ({
      id: exec.item.id || null,
      name: exec.item.name,
      statusCode: exec.response ? exec.response.code : null,
      responseTime: exec.response ? exec.response.responseTime : null,
      responseBody: responseBody(exec.response),
      assertions: (exec.assertions || []).map((a) => ({
        name: a.assertion,
        passed: !a.error,
        errorMessage: a.error ? a.error.message : null
      }))
    }));
  } catch (error) {
    throw new Error(`Unable to load Newman report "${filePath}": ${error.message}`);
  }
}

function groupByName(executions, stableItemIds = null) {
  const map = new Map();
  for (const exec of executions) {
    const key = exec.id && (!stableItemIds || stableItemIds.has(exec.id))
      ? exec.id
      : exec.name;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(exec);
  }
  return map;
}

function sharedItemIds(beforeReport, afterReport) {
  const beforeIds = new Set(beforeReport.map((exec) => exec.id).filter(Boolean));
  return new Set(afterReport
    .map((exec) => exec.id)
    .filter((id) => id && beforeIds.has(id)));
}

// This is a heuristic tradeoff: collection naming varies, so names alone
// cannot reliably identify auth flows. Failed response bodies add a signal.
function isAuthRelated(name, executions = []) {
  return /login|auth|token|credential/i.test(name) ||
    executions.some((exec) => executionFailed(exec) &&
      /token|credential|unauthorized|session/i.test(exec.responseBody || ''));
}

// This is a heuristic tradeoff: assertion text is not a formal schema
// contract and naming conventions vary across collections.
function isSchemaAssertion(assertion) {
  return /property|field|shape|schema/i.test(assertion.name || '') ||
    /property|field|shape|schema/i.test(assertion.errorMessage || '');
}

function isStatusCodeAssertion(assertion) {
  return /status/i.test(assertion.name || '') ||
    /expected\s+\d+\s+to\s+(?:deeply\s+)?equal\s+\d+/i.test(assertion.errorMessage || '');
}

function isResponseTimeAssertion(assertion) {
  return /response\s*time|latency|duration/i.test(assertion.name || '') ||
    /response\s*time|latency|duration/i.test(assertion.errorMessage || '');
}

function parseMultiValueStatusAssertion(errorMessage) {
  if (typeof errorMessage !== 'string') return null;

  const match = errorMessage.match(/expected\s*\[\s*([^\]]*?)\s*\]\s*to\s*include\s*(-?\d+)\b/i);
  if (!match) return null;

  const expectedStatuses = match[1].split(',').map((value) => value.trim());
  if (!expectedStatuses.length || expectedStatuses.some((value) => !/^\d+$/.test(value))) {
    return null;
  }

  return {
    expectedStatuses: expectedStatuses.map(Number),
    actualStatus: Number(match[2])
  };
}

function isHttpStatusCode(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

const MIN_RESPONSE_TIME_INCREASE_MS = 100;
const RESPONSE_TIME_MULTIPLIER = 2;
const SEVERE_RESPONSE_TIME_MULTIPLIER = 3;

function executionFailed(execution) {
  return execution.statusCode === null || execution.statusCode === undefined ||
    execution.statusCode >= 400 || (execution.assertions || []).some((assertion) => !assertion.passed);
}

function failureSeverity(afterExecs) {
  return afterExecs.every(executionFailed) ? 'high' : 'medium';
}

function averageResponseTime(executions) {
  const responseTimes = executions
    .map((e) => e.responseTime)
    .filter((responseTime) => Number.isFinite(responseTime));

  if (!responseTimes.length) return null;
  return responseTimes.reduce((total, responseTime) => total + responseTime, 0) / responseTimes.length;
}

function hasSignificantResponseTimeIncrease(beforeExecs, afterExecs) {
  const beforeAverage = averageResponseTime(beforeExecs);
  const afterAverage = averageResponseTime(afterExecs);

  return beforeAverage !== null && afterAverage !== null &&
    afterAverage >= beforeAverage * RESPONSE_TIME_MULTIPLIER &&
    afterAverage - beforeAverage >= MIN_RESPONSE_TIME_INCREASE_MS;
}

function hasSevereResponseTimeIncrease(beforeExecs, afterExecs) {
  const beforeAverage = averageResponseTime(beforeExecs);
  const afterAverage = averageResponseTime(afterExecs);

  return beforeAverage !== null && afterAverage !== null &&
    afterAverage >= beforeAverage * SEVERE_RESPONSE_TIME_MULTIPLIER;
}

function classify(name, beforeExecs, afterExecs) {
  const beforeStatuses = new Set(beforeExecs.map((e) => e.statusCode));
  const afterStatuses = afterExecs.map((e) => e.statusCode);
  const uniqueAfterStatuses = new Set(afterStatuses);

  if (beforeExecs.length === 0) {
    return [{
      category: 'new_test_no_baseline',
      severity: 'medium',
      detail: 'This test has no baseline in the before run; cannot classify as a regression.'
    }];
  }

  const beforeAllPassed = beforeExecs.every((e) => e.assertions.every((a) => a.passed));
  const afterAnyFailed = afterExecs.some((e) => e.assertions.some((a) => !a.passed));
  const afterHasNoResponse = afterExecs.some((e) => e.statusCode === null || e.statusCode === undefined);
  const afterAnyStatusFail = afterExecs.some((e) =>
    e.statusCode === null || e.statusCode === undefined || e.statusCode >= 400
  );
  const responseTimeRegressed = hasSignificantResponseTimeIncrease(beforeExecs, afterExecs);

  if (beforeAllPassed && !afterAnyFailed && !afterAnyStatusFail && !responseTimeRegressed) {
    return []; // still healthy, nothing to report
  }

  const findings = [];
  const addFinding = (finding) => {
    if (!findings.some((existing) => existing.category === finding.category)) {
      findings.push(finding);
    }
  };

  const wasHealthy = [...beforeStatuses].every((s) => Number.isFinite(s) && s < 400);
  const nowUnhealthy = afterStatuses.some((s) => s === null || s === undefined || s >= 400);
  const resultsAreIntermittent = afterExecs.length > 1 && uniqueAfterStatuses.size > 1;
  const failedExecutionCount = afterExecs.filter(executionFailed).length;
  const allAfterExecutionsFailed = failedExecutionCount === afterExecs.length;
  const intermittencyDetail = resultsAreIntermittent
    ? ` Results are intermittent: statuses seen = [${[...uniqueAfterStatuses].join(', ')}].`
    : !allAfterExecutionsFailed
      ? ` Results are intermittent: ${failedExecutionCount} of ${afterExecs.length} executions failed.`
      : '';

  if (wasHealthy && afterHasNoResponse) {
    addFinding({
      category: 'endpoint_down',
      severity: failureSeverity(afterExecs),
      detail: `Request that previously returned ${[...beforeStatuses].join('/')} had no response received. Endpoint, network, or upstream dependency may be unavailable.${intermittencyDetail}`
    });
  }

  // Rate limiting is deterministic throttling/performance degradation,
  // even when repeated calls expose both 200 and 429 responses.
  if (wasHealthy && (afterStatuses.includes(429) || responseTimeRegressed)) {
    const beforeAverage = averageResponseTime(beforeExecs);
    const afterAverage = averageResponseTime(afterExecs);

    if (afterStatuses.includes(429)) {
      addFinding({
        category: 'rate_limit_regression',
        severity: hasSevereResponseTimeIncrease(beforeExecs, afterExecs) ? 'high' : 'medium',
        detail: 'Request that previously succeeded now returns 429 (Too Many Requests). Likely a rate-limit or throttling regression.'
      });
    } else {
      addFinding({
        category: 'rate_limit_regression',
        severity: hasSevereResponseTimeIncrease(beforeExecs, afterExecs) ? 'high' : 'medium',
        detail: `Request remains successful but average response time increased from ${Math.round(beforeAverage)}ms to ${Math.round(afterAverage)}ms (at least ${RESPONSE_TIME_MULTIPLIER}x and ${MIN_RESPONSE_TIME_INCREASE_MS}ms slower). Likely throttling or a performance regression.`
      });
    }
  }

  if (wasHealthy && nowUnhealthy && !afterHasNoResponse && !afterStatuses.includes(429)) {
    const badStatus = afterStatuses.find((s) => s === null || s === undefined || s >= 400);
    if ((badStatus === 401 || badStatus === 403) && isAuthRelated(name, afterExecs)) {
      addFinding({
        category: 'auth_failure',
        severity: failureSeverity(afterExecs),
        detail: `Request that previously succeeded now returns ${badStatus} on an auth-related endpoint. Likely a credential, token, or permission regression.${intermittencyDetail}`
      });
    } else {
      addFinding({
        category: 'endpoint_down',
        severity: failureSeverity(afterExecs),
        detail: `Request that previously returned ${[...beforeStatuses].join('/')} now returns ${badStatus}. Endpoint or upstream dependency likely broken.${intermittencyDetail}`
      });
    }
  }

  // Flaky: after run has multiple executions with inconsistent statuses but
  // no status-based regression against a previously healthy baseline.
  if (resultsAreIntermittent && !wasHealthy) {
    addFinding({
      category: 'flaky',
      severity: 'medium',
      detail: `Inconsistent results across ${afterExecs.length} repeated calls: statuses seen = [${[...uniqueAfterStatuses].join(', ')}]`
    });
  }

  // Status codes unchanged (still healthy), but an assertion regressed.
  if (afterAnyFailed) {
    const failedAssertions = afterExecs
      .flatMap((e) => e.assertions)
      .filter((a) => !a.passed);
    const multiValueStatusFailure = failedAssertions
      .map((assertion) => ({ assertion, status: parseMultiValueStatusAssertion(assertion.errorMessage) }))
      .find(({ status }) => status && isHttpStatusCode(status.actualStatus));

    // Chai can express a status assertion as an allowed array of values.
    // Reclassify the unmatched actual status with the existing status categories.
    if (multiValueStatusFailure && wasHealthy) {
      const { actualStatus } = multiValueStatusFailure.status;

      if (actualStatus === 429) {
        addFinding({
          category: 'rate_limit_regression',
          severity: hasSevereResponseTimeIncrease(beforeExecs, afterExecs) ? 'high' : 'medium',
          detail: 'Request that previously succeeded now returns 429 (Too Many Requests). Likely a rate-limit or throttling regression.'
        });
      }

      if (actualStatus >= 400 && actualStatus !== 429) {
        if ((actualStatus === 401 || actualStatus === 403) && isAuthRelated(name, afterExecs)) {
          addFinding({
            category: 'auth_failure',
            severity: failureSeverity(afterExecs),
            detail: `Request that previously succeeded now returns ${actualStatus} on an auth-related endpoint. Likely a credential, token, or permission regression.`
          });
        } else {
          addFinding({
            category: 'endpoint_down',
            severity: failureSeverity(afterExecs),
            detail: `Request that previously returned ${[...beforeStatuses].join('/')} now returns ${actualStatus}. Endpoint or upstream dependency likely broken.`
          });
        }
      }
    }
    const schemaRelated = failedAssertions.some(isSchemaAssertion);
    const hasStatusFinding = findings.some((finding) =>
      finding.category === 'auth_failure' || finding.category === 'endpoint_down'
    );
    const hasRateLimitFinding = findings.some((finding) =>
      finding.category === 'rate_limit_regression'
    );
    const hasStatusAssertionFailure = failedAssertions.some(isStatusCodeAssertion);
    const hasResponseTimeAssertionFailure = failedAssertions.some(isResponseTimeAssertion);

    if (schemaRelated && !(hasStatusFinding && hasStatusAssertionFailure)) {
      addFinding({
        category: 'schema_change',
        severity: failureSeverity(afterExecs),
        detail: `Response status is unchanged, but a field/shape assertion now fails: "${failedAssertions[0].errorMessage}". Likely a response schema change (renamed/removed field).${intermittencyDetail}`
      });
    }

    if (!multiValueStatusFailure && !schemaRelated &&
      !(hasStatusFinding && hasStatusAssertionFailure) &&
      !(hasRateLimitFinding && hasResponseTimeAssertionFailure)) {
      addFinding({
        category: 'logic_bug',
        severity: 'high',
      detail: `Response status is unchanged (still 200), but a business-logic assertion now fails: "${failedAssertions[0].errorMessage}". Silent correctness regression — no error code, so this would be missed by status-code-only monitoring.`
      });
    }
  }

  if (!findings.length) {
    addFinding({
      category: 'unknown',
      severity: 'medium',
      detail: 'Behavior changed but did not match a known failure pattern. Needs manual review.'
    });
  }

  return findings;
}

function main() {
  const [, , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('Usage: node src/triage.js <before.json> <after.json>');
    process.exit(1);
  }

  let beforeReport;
  let afterReport;
  let beforeExecs;
  let afterExecs;
  try {
    beforeReport = loadReport(beforePath);
    afterReport = loadReport(afterPath);
    const stableIds = sharedItemIds(beforeReport, afterReport);
    beforeExecs = groupByName(beforeReport, stableIds);
    afterExecs = groupByName(afterReport, stableIds);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const results = [];
  for (const [key, afterList] of afterExecs.entries()) {
    const name = afterList[0].name;
    const beforeList = beforeExecs.get(key) || [];
    const findings = classify(name, beforeList, afterList);
    for (const finding of findings) {
      results.push({ name, ...finding });
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
    rate_limit_regression: 'Rate Limit Regressions',
    logic_bug: 'Logic Bugs (Silent Regressions)',
    new_test_no_baseline: 'New Tests Without a Baseline',
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
