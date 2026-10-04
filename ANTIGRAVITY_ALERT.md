# ⚠️ ANTIGRAVITY ALERT: MGE nightly scraper failed

- **When (America/Chicago):** Oct 4, 2026, 3:00 PM CDT
- **Issue:** https://github.com/SamBar1106/mge-triage-hub/issues/13
- **Error:**

```
NOT_LOGGED_IN
```

## What to do (agents: do this before anything else)
1. Read the issue above and the error codes. Codes are defined in `extension/background.js` and `docs/SETUP-GUIDE.md` (Troubleshooting).
2. Likely files to fix:
   - `extension/scrapers/clientList.js`: Active Client List (NO_RESULTS_TABLE, MISSING_COLUMNS, row counts)
   - `extension/scrapers/pdfSchedule.js`: Doctor-Owner PDF schedules (PDF_FAILED_AT, PORTAL_FAILED)
   - `extension/scrapers/backlog.js`: paid uncompleted items (BACKLOG_FAILED_AT)
   - `extension/background.js`: pipeline, login check (NOT_LOGGED_IN), upload (GH_*), SKIPPED_* guards
   - `extension/lib/*.js`: CSV builder, encryption, GitHub upload
3. Test offline: `cd tests && npm install && npm test` (runs `tests/run-tests.js`). Saved NetSuite pages go in `scrapers/fixtures/` (gitignored; never commit them).
4. `NOT_LOGGED_IN` / `NO_RUN_TODAY` usually mean NetSuite logged out or the PC/Chrome was off: a human must log in and press **Run now**. No code change is needed.

_No client data is included here. This file is removed automatically after the next successful scraper run._
