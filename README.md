# Regression Diff Triage Agent

A CLI tool that diagnoses **why** API regression tests broke. Not just that they broke.

Built for [OpenAI Build Week](https://openai.devpost.com/) (Developer Tools track), using **GPT-5.6** via **Codex**.

## In one sentence

When software breaks after an update, this tool reads through all the error messages and tells you *why* things broke, instead of a human reading every single error one by one.

## The problem

When a QA suite goes from green to red after a code change, someone has to read every failing test log and figure out the root cause before they can even start fixing it. A 50-test regression run with 10 failures means 10 manual investigations, and most of those failures fall into a handful of repeating patterns (a renamed field, a broken endpoint, an auth change, a flaky test, a silent logic bug) that a human re-diagnoses from scratch every single time.

This is a real, recurring cost in QA work, not a hypothetical. It's the kind of triage I've done manually across API regression suites (Postman/Newman-based) in QA roles.

## What it does

**Important caveat up front:** classification quality for `logic_bug` and `schema_change` depends entirely on how good the `pm.test()` assertions in your source collection are. Vague or missing assertions mean vague or missing triage, this tool diffs what your tests actually check, it doesn't infer correctness on its own. See "Using your own Newman data" below for what makes a collection well-suited to this.

Feed it two Newman (Postman CLI) JSON test reports, a "before" run and an "after" run against the same collection, and it diffs the outcomes per request, then classifies each broken test into one of six root-cause categories:

| Category | What it means |
|---|---|
| `auth_failure` | A previously-working request now fails auth (401/403) |
| `endpoint_down` | A previously-200 request now returns 4xx/5xx |
| `schema_change` | Status is unchanged, but a response field/shape assertion now fails |
| `rate_limit_regression` | A request now returns 429s, or is significantly slower than before |
| `flaky` | The same request gives inconsistent results across repeated calls |
| `logic_bug` | Status is unchanged (still 200), but a business-logic assertion fails. A silent correctness regression that status-code monitoring alone would miss |

`flaky` detection requires the collection itself to call the same request more than once (the classifier compares outcomes across repeated calls of the same request within one run). If your collection only calls each request once, flakiness within a single run can't be detected, only true before/after regressions can. The bundled demo collection deliberately repeats one request three times to exercise this.

Output is a prioritized, human-readable report grouped by category and severity, turning "read 50 failure logs" into "read one triage summary."

## How Codex was used

This project's classification engine (`src/triage.js`) is a **rule-based diff classifier**, not an LLM-inference system, it compares Newman JSON reports using explicit heuristics (status codes, response times, assertion text patterns). Codex, running GPT-5.6, was used throughout development to extend and harden this rules engine. Specifically, Codex:

- Added the sixth failure category (`rate_limit_regression`), following the established pattern (category/severity/detail return shape) without touching the categories already in place.
- Added a corresponding mock API endpoint (`GET /books/:id/reviews`) and Postman assertion to demonstrate the new category end-to-end.
- Hardened the classifier against real bugs found during independent testing against messy, real-world Newman data: null/missing response handling, vacuous-truth on unbaselined new tests, unhandled malformed JSON, a classification-ordering bug that mislabeled genuine regressions as merely "flaky," and a name-collision bug in how requests were matched between runs.
- Made the severity model signal-based (how many executions failed, how severe a slowdown was) instead of hardcoded, and added a secondary auth-detection signal from response body content in addition to test names.
- Added a `test/triage.test.js` unit test suite (10 tests) covering these behaviors.
- Built the `triage:run` interactive command, letting anyone point the tool at their own Postman collection and environment file, without touching the demo fixtures.
- Independently verified every change: running the full Newman before/after cycle after each fix, confirming existing categories stayed correct, and I re-verified each result myself in a separate terminal before committing.

The `git` history in this repo shows the `before codex` checkpoint commit and each subsequent Codex-driven commit as distinct points, so every change is inspectable.

## Setup

Requires Node.js (v18+) and npm.

```bash
git clone https://github.com/LovableLynx/regression-diff-triage-agent.git
cd regression-diff-triage-agent
npm install
```

## Running the demo

This runs a mock "Bookstore API," captures a healthy ("before") Newman test run, injects five categories of regressions plus a rate-limit regression, captures the "after" run, and triages the diff.

**Terminal 1**: start the mock API and leave it running:
```bash
node mock-api/server.js
```

**Terminal 2**: run the before/after cycle and triage:
```bash
npx newman run collections/bookstore.postman_collection.json -e collections/env.postman_environment.json -r json --reporter-json-export fixtures/before.json

node mock-api/inject-failures.js

npx newman run collections/bookstore.postman_collection.json -e collections/env.postman_environment.json -r json --reporter-json-export fixtures/after.json

node src/triage.js fixtures/before.json fixtures/after.json
```

You should see a report with 6 findings across 5 categories: `auth_failure`, `schema_change`, `endpoint_down` (2, one complete outage and one intermittent), `rate_limit_regression`, and `logic_bug`. Severity is signal-based: a full outage is HIGH, an intermittent one is MEDIUM.

## Recent improvements

This classifier went through three rounds of independent review and hardening after the initial build:

- Null/missing responses (network failures, timeouts) are now correctly flagged instead of silently passing as healthy.
- A test with no baseline in the "before" run is now labeled `new_test_no_baseline` instead of being misreported as a regression.
- Bad file paths or malformed Newman JSON now produce a clear CLI error instead of a raw stack trace.
- A request that goes from consistently healthy to a genuine failure now prioritizes the real root cause (e.g. `endpoint_down`) over a generic "flaky" label, while still noting when results were intermittent.
- Requests are matched between runs using Newman's stable item ID when available, so collections with duplicate request names classify correctly.
- Severity now reflects actual signal (how many executions failed, how severe a slowdown was) instead of being hardcoded to "high" everywhere.
- Auth-failure detection now also checks the failed response body for auth-related terms, not just the test name, which is documented as a known heuristic tradeoff in the code.
- Added a test suite (`npm test`) covering these behaviors.

## Project structure

```
mock-api/            Mock "Bookstore" REST API + failure-injection script
collections/         Postman collection + environment used to exercise the API
src/triage.js        The classification engine, the core of the project
src/run-triage.js     Interactive runner for testing your own Postman collection end to end
fixtures/             Sample before/after Newman JSON reports (demo data only, not overwritten by src/run-triage.js)
test/triage.test.js   Unit tests for the classifier (run with `npm test`)
```

## Using your own Newman data

The demo above uses synthetic data for reproducibility, but the classifier works on any Newman JSON report pair. To get meaningful results from your own collection, your data needs:

**Required:**
- Real `pm.test()` assertions on each request (an empty `assertions` array gives the classifier nothing to compare)
- A genuinely healthy "before" run. Every request in "before" should reflect the system actually working, not a run that's already failing for unrelated reasons (e.g. missing credentials). The classifier can only detect what changed relative to "before," so a broken baseline produces `unclassified` results, not useful ones
- Single-value status assertions (e.g. `pm.response.code === 200`) or Chai's multi-value form (e.g. `expect([200, 401]).to.include(status)`). Both are supported

**Will produce noisy or unreliable results:**
- Collections with shared, mutating state across requests (e.g. "create X" then "delete X" then "get X, not found") run twice back-to-back, the second run's "before" state differs from what the test expects, which looks like a false regression
- Suites gated behind multiple user roles (e.g. talent/employer/admin) where you only have credentials for one role. Untested roles will show as `unclassified` since there's no healthy baseline to compare against for them

In short: point it at an isolated, idempotent collection with real assertions and valid credentials for every role it exercises, and it will classify accurately, including on real production or staging APIs, not just the bundled demo.

## Why this design

- **Synthetic, not confidential data.** The demo uses a generic mock bookstore API rather than real employer data, so the classifier's behavior is fully reproducible and inspectable by judges without any confidentiality concerns.
- **Deterministic failure injection.** Each demo run injects the same five failure types (plus rate-limiting) in a controlled way, so the classifier's accuracy can be verified precisely rather than hoping real-world data happens to contain good examples.
- **Newman-native.** Newman is Postman's official CLI test runner and a common tool in real QA pipelines. This integrates with an existing workflow rather than inventing a new one.

This project was built entirely within the Build Week Submission Period (July 13-21, 2026).
