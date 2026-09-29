# Antigravity task 001: 10 AM schedule and email notifications

Work on branch `feature/antigravity-alert` (PR #2). Do not merge it. Samuel reviews first.

1. **Schedule:** move the run from 2:00 AM to 10:00 AM local.
   - The extension alarm in `extension/background.js` fires at 10:00.
   - The Windows keep-Chrome-open task in `scripts/windows/*.ps1` and `*.task.xml` runs at 9:55 AM.
   - Update `docs/SETUP-GUIDE.md` and `README.md`. A PC that's already set up must reload the extension and re-run `Register-MGEChromeTask.ps1`.
2. **Status file:** push `data/enc/last_run.json` after every run, whether it succeeds or fails, and also try to push it when a run fails early. It holds only:
   - an ISO timestamp with offset;
   - `status` (success or failure);
   - the `clients` count;
   - the `pending` count, computed with the same bucketing code as `js/app.js` (share the code; expect 354 on the current committed data, and add a test);
   - the other row counts;
   - `error` when the run failed.

   Never put client data in it.
3. **Email:** add the email step to `scripts/github/scraper-notify.yml` and `.github/scripts/scraper-notify.js`.
   - Send to samuelbarrios1106@gmail.com through Gmail SMTP (`smtp.gmail.com:465`, SSL), with user samuelbarrios1106@gmail.com and the password from the GitHub secret `GMAIL_APP_PASSWORD`.
   - Send one after every run. The subject is "MGE scraper: SUCCESS - N clients / M pending" or "MGE scraper: FAILED". The body has the Chicago time, status, counts, the error and the live site link.
   - Also send one for the 11 AM no-run fallback.
   - Use no third-party actions and never echo the secret. If the secret is missing, fail only the email step, clearly.
4. **Checks:** run `node tests/run-tests.js`. Everything must pass, and `actionlint` must report nothing.
5. **Workflow file:** leave the workflow parked at `scripts/github/scraper-notify.yml`. Samuel moves it to `.github/workflows/` himself.
