# TASK-009: Export "Scheduled Dates" = only the date(s) of the filtered seminar

Scope (files allowed): js/app.js, tests/run-tests.js; everything else is read-only.

Repo: SamBar1106/mge-triage-hub. Follow-up to TASK-008 (exportCSV in js/app.js).

## Change
Today the "Scheduled Dates" column lists ALL of a client's PDF dates. Samuel wants only the date for the item that matches the selected Events filter (#filter-event).
1. When a seminar is selected: "Scheduled Dates" = only the 'Month / Dates' of that client's pdfRecords whose item matches the selected seminar, using the SAME matching logic the Events filter already uses (EVENT_MAPPINGS and the existing filter code; reuse it, don't duplicate it). Skip NO DATES / NO DATE / N/A / empty. If several records match, de-duplicate and join with " | ". Blank if none.
2. When "All Events" is selected: one row per client (unchanged); "Scheduled Dates" lists each matched seminar's date labeled with the seminar name, e.g. "Sales Seminar A: <date> | Marketing Seminar: <date>". Records that match no seminar are left out.
3. Everything else from TASK-008 stays: columns/order, "Seminar" column, file naming, RFC 4180 quoting.
4. Add/adjust unit tests in tests/run-tests.js for both cases.

## Rules
- Never commit client data, CSVs, tokens or passphrases.
- Shell commands are not available; keep the change small and self-evidently correct.
- Commit to this branch (ed/TASK-009). Do not merge.
