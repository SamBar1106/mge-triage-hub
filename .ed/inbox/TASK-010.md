# TASK-010: Active-filter highlight, Livestream included in seminar filter, bucket renames

Scope (files allowed): index.html, js/app.js, css/styles.css, tests/run-tests.js; everything else is read-only.

Repo: SamBar1106/mge-triage-hub (dashboard only; do NOT touch extension/ or js/mge-buckets.js / extension/lib/buckets.js).

## 1. Highlight active filters (light blue)
In the filter bar (`section.filter-bar`: #filter-search, #filter-course, #filter-status, #filter-event, #filter-consultant, #filter-expired), any control whose value differs from its default (non-empty text, or a select not on its first/default option) gets a light-blue highlight (e.g. class `filter-active`: light blue background such as #dbeafe or border/outline #60a5fa, readable text in the current theme). Update on input/change and after programmatic resets/loads.

## 2. Livestream is included when a seminar is selected
In the Print Schedule PDF data a seminar can appear as the plain name and also as "<seminar name> Livestream" (case-insensitive, may have separators like " - ", " – ", ":" before "Livestream"). Unscheduled backlog items only use the plain name.
- When a seminar is selected in #filter-event, matching must ALSO include its Livestream variant (e.g. "Sales Seminar A" also matches "Sales Seminar A Livestream", "Sales Seminar A - Livestream"). Implement generically in the existing EVENT_MAPPINGS matching (e.g. normalise by stripping a trailing livestream suffix before matching), not by hand-listing every variant.
- This applies to PDF schedule items and the item-list sections. The export's per-seminar "Scheduled Dates" (TASK-009) uses the same matching, so livestream dates are included; mark those dates with " (Livestream)", e.g. "10/05 (Livestream)".
- In the item-list sections, livestream PDF items may show a small "Livestream" tag.
- BUCKET CRITERIA MUST NOT CHANGE. Do not alter how clients are classified into PENDING_SCHEDULE / SCHEDULE_INCOMPLETE / PROGRAM_COMPLETE. This is filter/display only. Add a test that bucket results are identical with and without livestream variants present.

## 3. Rename bucket labels (display text only; keep data-bucket keys and internal constants)
- "Pending for Schedule" -> "Not Scheduled" (bucket button; also the "Pending" mini-KPI label -> "Not Scheduled" and any tooltip)
- "Schedule Incomplete" -> "Schedule Not Complete" (bucket button, mini-KPI label "Incomplete" -> "Not Complete", title tooltip)
Do not rename the "Pending Items" status filter option or the "Pending" item pill; those are about items, not buckets.

## Rules
- Never commit client data, CSVs, tokens or passphrases.
- Shell commands are not available; keep changes focused.
- Update/add tests in tests/run-tests.js for livestream matching and the export date label.
- Commit to this branch (ed/TASK-010). Do not merge.
