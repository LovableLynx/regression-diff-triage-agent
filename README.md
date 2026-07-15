# Regression Diff Triage Agent

A CLI tool that diagnoses **why** API regression tests broke — not just that they broke.

Built for [OpenAI Build Week](https://openai.devpost.com/) (Developer Tools track), using **GPT-5.6** via **Codex**.

## In one sentence

When software breaks after an update, this tool reads through all the error messages and tells you *why* things broke — instead of a human reading every single error one by one.

## The problem

When a QA suite goes from green to red after a code change, someone has to read every failing test log and figure out the root cause before they can even start fixing it. A 50-test regression run with 10 failures means 10 manual investigations and most of those failures fall into a handful of repeating patterns (a renamed field, a broken endpoint, an auth change, a flaky test, a silent logic bug) that a human re-diagnoses from scratch every single time.

This is a real, recurring cost in QA work not a hypothetical. It's the kind of triage I've done manually across API regression suites (Postman/Newman-based) in QA roles at Vettika AI Recruiter and OHealth.

## What it does

Feed it two Newman (Postman CLI) JSON test reports — a "before" run and an "after" run against the same collection and it diffs the outcomes per request, then classifies each broken test into one of six root-cause categories:

| Category | What it means |
|---|---|
| `auth_failure` | A previously-working request now fails auth (401/403) |
| `endpoint_down` | A previously-200 request now returns 4xx/5xx |
| `schema_change` | Status is unchanged, but a response field/shape assertion now fails |
| `rate_limit_regression` | A request now returns 429s, or is significantly slower than before |
| `flaky` | The same request gives inconsistent results across repeated calls |
| `logic_bug` | Status is unchanged (still 200), but a business-logic assertion fails — a silent correctness regression that status-code monitoring alone would miss |

Output is a prioritized, human-readable report grouped by category and severity — turning "read 50 failure logs" into "read one triage summary."

## How Codex was used

This project's classification engine (`src/triage.js`) was built collaboratively with me and extended using **Codex CLI running GPT-5.6**. Codex was used to:

- Add the sixth failure category (`rate_limit_regression`) to the existing classifier, following the established pattern (category/severity/detail return shape) without touching the five categories already in place.
- Add a corresponding mock API endpoint (`GET /books/:id/reviews`) and Postman assertion to demonstrate the new category end-to-end.
- Independently verify its own change — running the full Newman before/after cycle, confirming all 6 categories classified correctly, and confirming the original 5 categories were untouched before handing control back.

The `git` history in this repo shows the `before codex` checkpoint commit and the subsequent Codex-driven commit as two distinct points, so the diff is inspectable.

## Setup

Requires Node.js (v18+) and npm.

```bash
git clone https://github.com/LovableLynx/regression-diff-triage-agent.git
cd regression-diff-triage-agent
npm install
```

## Running the demo

This runs a mock "Bookstore API," captures a healthy ("before") Newman test run, injects five categories of regressions plus a rate-limit regression, captures the "after" run, and triages the diff.

**Terminal 1** — start the mock API and leave it running:
```bash
node mock-api/server.js
```

**Terminal 2** — run the before/after cycle and triage:
```bash
npx newman run collections/bookstore.postman_collection.json -e collections/env.postman_environment.json -r json --reporter-json-export fixtures/before.json

node mock-api/inject-failures.js

npx newman run collections/bookstore.postman_collection.json -e collections/env.postman_environment.json -r json --reporter-json-export fixtures/after.json

node src/triage.js fixtures/before.json fixtures/after.json
```

You should see a report with 6 findings: one each of `auth_failure`, `schema_change`, `endpoint_down`, `rate_limit_regression`, `logic_bug`, and `flaky`.

## Project structure

```
mock-api/          Mock "Bookstore" REST API + failure-injection script
collections/       Postman collection + environment used to exercise the API
src/triage.js       The classification engine — the core of the project
fixtures/           Sample before/after Newman JSON reports
```

## Why this design

- **Synthetic, not confidential data.** The demo uses a generic mock bookstore API rather than real employer data, so the classifier's behavior is fully reproducible and inspectable by judges without any confidentiality concerns.
- **Deterministic failure injection.** Each demo run injects the same five failure types (plus rate-limiting) in a controlled way, so the classifier's accuracy can be verified precisely rather than hoping real-world data happens to contain good examples.
- **Newman-native.** Newman is Postman's official CLI test runner and a common tool in real QA pipelines — this integrates with an existing workflow rather than inventing a new one.
