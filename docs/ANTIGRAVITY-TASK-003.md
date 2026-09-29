# Antigravity Task 003: Remember-me, per-scraper progress bars, 3 staggered runs

Branch: `feature/retries-remember-progress`. Commit and push to THIS branch only. Do NOT merge to main. Samuel reviews first.
Rules (see AGENTS.md): never commit plaintext client data, CSVs, NetSuite pages, tokens or passphrases. All times are America/Chicago.

## 1. Dashboard "Remember me" (js/app.js, index.html)
- On the passphrase prompt (`PASS_KEY = 'mge_passphrase'`, currently sessionStorage only), add a standard "Remember me on this computer" checkbox, unchecked by default.
- Checked: save the passphrase to `localStorage` (persists across tab closes and browser restarts). Unchecked: keep today's sessionStorage behavior.
- On load, read localStorage first, then sessionStorage. If a saved passphrase fails to decrypt, remove it from both and prompt again.
- Add a small visible "Forget saved passphrase" link/button that clears both stores and reloads.
- Under the checkbox show a short note: "Only on a computer you trust. Anyone who uses this browser profile can open the dashboard."

## 2. Extension popup: one progress bar per scraper (extension/popup.js, popup.html, ui.css, background.js)
- One row per scraper: Client list, PDF schedules, Unscheduled backlog, plus Upload. Each row shows the name, status (Waiting / Running / Done / Failed / Skipped / Disabled), the current step, a progress bar, and the time it started.
- background.js must record per-phase progress in the run state (e.g. `run.progress[phase] = { status, step, done, total, startedAt }`): clients = pages done / pages total, pdf = clients processed / total, backlog = batches done / total, upload = files uploaded / files total. Use an indeterminate bar when total is unknown.
- The popup refreshes while a run is going (poll storage every 1s or use chrome.storage.onChanged).
- Keep the existing last-run summary and the Run now button.

## 3. Three staggered runs: 10:00 AM, 12:00 PM, 4:00 PM
- extension/background.js and options: replace the single daily alarm with three alarms at 10:00, 12:00 and 16:00 (defaults; editable as three time fields in Settings; migrate old saved `runHour/runMinute` settings to the new three-time list).
- 10:00 always runs. At 12:00 and 16:00, FIRST fetch `data/enc/last_run.json` from GitHub (Contents API, no cache). If its `status` is `success` and its `timestamp` is today in America/Chicago, skip, log "Skipped: already succeeded today" and upload nothing. Otherwise run normally. If the fetch itself fails, run anyway.
- Manual "Run now" always runs.
- Windows scripts (scripts/windows/Register-MGEChromeTask.ps1, Ensure-ChromeRunning.ps1, MGE-Ensure-Chrome.task.xml): the "MGE - Ensure Chrome Running" task gets three daily triggers, at 9:55 AM, 11:55 AM and 3:55 PM, with wake timers kept. The register script prints all three times. Ensure-ChromeRunning.ps1 still only starts Chrome if it is closed. Update comments.
- .github/workflows/scraper-notify.yml and .github/scripts/scraper-notify.js: move the "no run today" fallback check from 11:00 AM to 5:00 PM Chicago (cron for both CDT and CST, with the script's hour guard set to 17). Keep the email-after-every-attempt behavior.

## 4. Docs
- Update docs/SETUP-GUIDE.md and extension/README.md for the three times, three wake-ups, 5 PM alert, remember-me checkbox and progress bars. Replace the "10:00" references.
- Add an "Updating an already-installed PC" section: download the new ZIP to C:\MGE (overwrite C:\MGE\mge-triage-hub-main), reload the extension at chrome://extensions, check that Settings shows 10:00 / 12:00 / 16:00 and Save, re-run Register-MGEChromeTask.ps1 (expect 3 times), then optionally tick Remember me on the dashboard.
- Note that Git is not installed on the boss PC, and include the PowerShell ZIP download command:
  `Invoke-WebRequest https://github.com/SamBar1106/mge-triage-hub/archive/refs/heads/main.zip -OutFile C:\MGE\mge.zip; Expand-Archive C:\MGE\mge.zip -DestinationPath C:\MGE -Force`

## Done when
- `node tests/run-tests.js` passes, with new tests for: the skip-if-succeeded-today check (success today = skip; failure today, success yesterday, or fetch error = run), the three-time scheduling and the migration of old settings, and the remember-me store/forget logic if testable.
- actionlint is clean on the workflow.
- No plaintext client data, tokens or passphrases are in the diff.
- Commit, push to `feature/retries-remember-progress`, and do NOT merge. In the final message, summarize the changes and paste the "Updating an already-installed PC" steps.
