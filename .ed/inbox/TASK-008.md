# TASK-008: Add Scheduled Dates and Seminar columns to the dashboard CSV export

Scope (files allowed): js/app.js, tests/run-tests.js; everything else is read-only.

Repo: SamBar1106/mge-triage-hub. File: js/app.js, function exportCSV() (the "Export" button, btn-export).

## Changes
1. Add a column "Scheduled Dates" at the end of each row: the client's PDF schedule dates from `client.pdfRecords[*]['Month / Dates']` (Print PDF data). Skip empty values and "NO DATES" / "NO DATE" / "N/A" (case-insensitive, same rule as the hasDates check). De-duplicate, keep the existing sort order, join with " | ". Blank if none.
2. Add a column "Seminar": the currently selected option text of `#filter-event` ("All Events" when the value is ALL). Same value on every row.
3. File name: `Triage_Export.csv` when All Events; otherwise `Triage_Export_<seminar>.csv` with non-alphanumerics replaced by "_" and repeated "_" collapsed (e.g. `Triage_Export_Sales_Seminar_A.csv`).
4. Quote both new fields the same way as the existing ones (RFC 4180, double internal quotes).
5. Keep existing columns and order unchanged; new header line:
   `Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar`

## Rules
- Only touch js/app.js (and tests/run-tests.js if you add a unit test for the date/filename helpers). No other files.
- Never commit client data, CSVs, tokens or passphrases.
- Shell commands are not available; keep the change small and self-evidently correct.
- Commit to this branch (ed/TASK-008). Do not merge.
