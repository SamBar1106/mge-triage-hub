# MGE Nightly NetSuite Scraper (Chrome extension, Manifest V3)

Runs inside your normal, logged-in Chrome. No remote debugging, no second login, no cloud browser.

- **Schedule:** `chrome.alarms`, staggered daily runs at 10:00 AM, 12:00 PM, and 4:00 PM local time (defaults, configurable in Settings). 10:00 AM always runs; 12:00 PM and 4:00 PM check GitHub and skip if a successful run already completed today. Plus **Run now** in the popup and on the options page.
- **Progress tracking:** popup shows real-time progress bars and status for each scraper (Client list, PDF schedules, Unscheduled backlog, plus Upload).
- **Pipeline:** it opens the Active Client List saved search in a background tab, then runs:
  1. `scrapers/clientList.js` (NEW): writes `clients_directory.csv` rows. Columns are found by header text, pagination is followed, and IDs are de-duplicated.
  2. `scrapers/pdfSchedule.js`: port of `Scrapers_fixtures/Contact PDF scraper x2.js`. Writes `pdf_directory.csv` and `doctor_owner_zero_dates_summary.csv`.
  3. `scrapers/backlog.js`: port of the Paid Uncompleted Items extractor. Writes `unscheduled_backlog.csv`.

  The PDF and backlog steps run in batches, and the tab is reloaded between batches, as the original "refresh and paste again" workflow did.
- **Output:** each CSV is encrypted (AES-GCM-256, key from PBKDF2-SHA256 with 250k iterations, a random salt and IV per file, gzip before encryption). It is then pushed with the GitHub Contents API to `data/enc/<name>.csv.enc`. `data/enc/last_run.json` gets timestamps and row counts only.
- **Secrets:** the GitHub token and the team passphrase live only in `chrome.storage.local` of this Chrome profile.
- **Safety:** a dataset is not uploaded if it is empty or shrank below 50% of the previous run, and the last good file stays in place.

Setup: see `docs/SETUP-GUIDE.md`. Offline tests: `tests/` (`npm test`).
