---
name: view-ir
description: Use ViewIR CLI to inspect accumulated browser UI observations and add new Playwright observations for UI test tasks.
---

# ViewIR Agent workflow

Use ViewIR as evidence about the rendered interface. The test case and its expected result remain authoritative for what to do and what to assert.

1. Read the test case and identify the page and current task yourself. ViewIR does not interpret test cases or navigate pages.
2. Ask the surrounding Playwright program to capture the current page as a `VIR1O` observation when one is not already available. The capture adapter is read-only.
3. Inspect the accumulated store with `view-ir inspect <store>` and request a focused projection with `view-ir context <store> --view latest --query "<short UI task phrase>"`.
4. Select a target using the current view's visible rendered placement, role, and name. Treat inferred hypotheses as possibilities, never as observed UI. Do not use an old observation's locator or coordinate as a guarantee.
5. After the surrounding program performs a test action, have it capture the resulting page with action context and pass the observation file to `view-ir ingest <store> <observation-file>`.
6. Re-read context after ingest before selecting a target in the changed state. Judge pass/fail from the test expectation, not from ViewIR.

Do not put form values, passwords, cookies, storage, or URL query/fragment data into ViewIR observations or query strings. Capture omits form values and sanitizes URLs by default. Preserve observed and inferred provenance when discussing evidence.

## Observation handoff

The Playwright integration writes a standalone `VIR1O` observation file. The Agent does not edit the store format directly; it invokes the CLI to validate, ingest, inspect, and project data.
