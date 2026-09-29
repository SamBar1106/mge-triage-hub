# MGE Nightly Scraper: Setup Guide (Windows + Chrome)

This guide sets up the office Windows computer so that **every night at 2:00 AM** Chrome collects the NetSuite data, locks (encrypts) it, and sends it to GitHub. The dashboard then shows fresh numbers every morning.

Setup takes about 20 minutes, once. After that, the only daily task is to **leave the computer on with Chrome and NetSuite logged in.**

---

## What you need

- The office Windows PC that is normally logged in to NetSuite in **Google Chrome**.
- A GitHub account with access to the repository `SamBar1106/mge-triage-hub`. Samuel owns it.
- The **team passphrase**. Samuel gives it to you privately; it is never emailed or put in GitHub. It must be exactly the same passphrase the team types into the dashboard.

---

## Step 1: Get the extension folder

Pick **one** of these:

**A. Easiest (no Git):**
1. Go to https://github.com/SamBar1106/mge-triage-hub
2. Click the green **Code** button, then **Download ZIP**.
3. Right-click the ZIP, choose **Extract All…**, and extract it to `C:\MGE\` (so you get `C:\MGE\mge-triage-hub-main\`).

**B. With Git (makes updates easy):**
1. Install Git from https://git-scm.com/download/win (accept the defaults).
2. Open **PowerShell** and run:
   ```powershell
   mkdir C:\MGE; cd C:\MGE
   git clone https://github.com/SamBar1106/mge-triage-hub.git
   ```
   To update later: `cd C:\MGE\mge-triage-hub; git pull`, then click the ↻ reload icon on the extension (Step 2).

> Keep this folder where it is. Chrome loads the extension from it, so if you delete or move it, the extension stops working.

## Step 2: Load the extension into Chrome

1. In Chrome, type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked**.
4. Select the **`extension`** folder inside the repo folder, for example `C:\MGE\mge-triage-hub-main\extension`.
5. "MGE Nightly NetSuite Scraper" appears. Click the puzzle-piece icon in the Chrome toolbar and **pin** it so its blue square icon is always visible.

> Use the **same Chrome profile** you use for NetSuite (the person icon at the top right). The extension relies on that profile's NetSuite login.

## Step 3: Create the GitHub token (the "key" that lets the extension upload)

1. Sign in at https://github.com. Click your photo (top right), then **Settings**.
2. At the bottom of the left menu: **Developer settings**, then **Personal access tokens**, then **Fine-grained tokens**, then **Generate new token**.
3. Fill in:
   - **Token name:** `MGE nightly scraper`
   - **Expiration:** 1 year. Put a reminder in your calendar to make a new one before it expires.
   - **Resource owner:** `SamBar1106`
   - **Repository access:** **Only select repositories**, then pick **`SamBar1106/mge-triage-hub`**.
   - **Permissions → Repository permissions → Contents: Read and write.**
     ("Metadata: Read-only" is switched on automatically. Leave it.)
     **Do not** turn on any other permission.
4. Click **Generate token** and **copy** the token (it starts with `github_pat_`). You will only see it once.

## Step 4: Enter the settings

1. Click the extension icon, then **Settings**. You can also right-click the icon and choose **Options**.
2. Check or fill in:
   - **Daily run time:** `02:00`
   - **NetSuite address:** `https://3940793.app.netsuite.com`. This is already filled in.
   - **Saved search ID:** `72`. This is the "Active Client List" search.
   - Leave all three scrapers ticked.
   - **GitHub:** owner `SamBar1106`, repository `mge-triage-hub`, branch `main`.
   - **Fine-grained token:** paste the token from Step 3.
   - **Team passphrase** and **Repeat passphrase:** the passphrase Samuel gave you.
3. Click **Save**. The page shows the next run time.
4. Click **Test GitHub token**. It should say *"Token works … write access OK."*
5. Make sure NetSuite is logged in, then click **Test NetSuite (count clients)**. It should say something like *"NetSuite OK: 749 clients found on 1 page(s)."*

The token and passphrase are stored only inside this Chrome profile on this computer. They are never uploaded.

## Step 5: Make sure Chrome is open at night (one-time PowerShell command)

The extension can only run while Chrome is open. This step adds a Windows scheduled task that opens Chrome at **1:55 AM** if it is closed. If Chrome is already open, the task does nothing.

1. Open the **Start** menu, type **PowerShell**, and open **Windows PowerShell**. Do **not** choose "Run as administrator"; the task must run as you.
2. Run the following, adjusting the folder name if yours is different:
   ```powershell
   cd C:\MGE\mge-triage-hub-main\scripts\windows
   powershell -ExecutionPolicy Bypass -File .\Register-MGEChromeTask.ps1
   ```
   It should print *"Registered 'MGE - Ensure Chrome Running' daily at 01:55 …"*.
3. Optional test: close Chrome, then run `Start-ScheduledTask -TaskName 'MGE - Ensure Chrome Running'`. Chrome should open.

- If you use a Chrome profile other than the first one, add `-ProfileDirectory "Profile 1"` (see `chrome://version`, "Profile Path").
- To remove the task: `.\Register-MGEChromeTask.ps1 -Unregister`
- Alternative: in Task Scheduler, use **Import Task…** with `MGE-Ensure-Chrome.task.xml`.

## Step 6: Keep the computer ready overnight

- **Stay signed in to Windows.** Locking the screen (Windows+L) is fine. **Do not sign out or shut down.**
- **Power settings:** open Start, then **Settings → System → Power & battery (or Power & sleep) → Screen and sleep**.
  - "When plugged in, put my device to sleep after": **Never** (recommended),
  - or leave sleep on. The setup script turns on *wake timers* so the 1:55 AM task can wake the PC. If it printed a warning, open Control Panel → Power Options → Change plan settings → Change advanced power settings → **Sleep → Allow wake timers → Enable**.
  - Laptops: keep them **plugged in** with the lid open, or set "When I close the lid" to *Do nothing*.
- **Chrome:** Settings → System → turn on **"Continue running background apps when Google Chrome is closed."**
- **NetSuite:** stay logged in. Leaving a NetSuite tab open is fine. If NetSuite logs you out overnight, the run stops safely, nothing is overwritten, and you'll see a notification in the morning.
- A full run (749 clients: client list, PDF schedules, unpaid items) can take **one to a few hours**. That is normal.

## Step 7: Where the data goes and how to check it

- The files are saved **encrypted** in GitHub at `data/enc/`:
  `clients_directory.csv.enc`, `pdf_directory.csv.enc`, `unscheduled_backlog.csv.enc`, `doctor_owner_zero_dates_summary.csv.enc`, plus `last_run.json`. `last_run.json` holds only times and row counts, no client data.
- GitHub Pages republishes the dashboard about **1 minute** after the upload.
- Open the dashboard at https://sambar1106.github.io/mge-triage-hub/ and enter the team passphrase when asked. It is asked once per browser session.
- Under the "Scheduling Hub" title, look for **"Data updated <date, time>"**:
  - green **"Data updated Sep 29, 2:47 AM"**: last night's run worked.
  - red **"Last scrape failed … · data from …"**: the dashboard is showing the last good data. See Troubleshooting.
- You can check the extension itself any time: click its icon to see the last run, the row counts, and the next scheduled run. Click **Run now** to run immediately.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Notification "NetSuite is logged out" / popup shows `NOT_LOGGED_IN` | Log in to NetSuite in this Chrome, then click the extension icon and **Run now**. |
| `NOT_CONFIGURED` | Open Settings and enter the token and passphrase, then **Save**. |
| `GH_PUT_401` / `GH_GET_401` | The token is wrong or expired. Make a new one (Step 3) and paste it in Settings. |
| `GH_PUT_403` / `GH_PUT_404` | The token doesn't have **Contents: Read and write** on `mge-triage-hub`, or the owner/repo name is wrong. |
| `NO_RESULTS_TABLE` / `MISSING_COLUMNS:…` | The "Active Client List" saved search (ID 72) was changed or renamed. Restore its columns: Last Name, First Name, Phone, Email, Consultant, Status and the Billing fields. Or put the new ID in Settings. |
| `SKIPPED_SHRUNK:…` / `SKIPPED_EMPTY:…` | Far fewer rows than last time, so the upload was skipped to protect the data. Check NetSuite, then **Run now**. |
| `PDF_FAILED_AT:n` / `BACKLOG_FAILED_AT:n` | NetSuite was slow or blocked the step twice. The other files were still uploaded. **Run now** later. |
| Nothing happened overnight | Was the PC asleep, signed out, or off? Is the "MGE - Ensure Chrome Running" task in Task Scheduler? Log: `%LOCALAPPDATA%\MGE\ensure-chrome.log`. |
| Dashboard keeps asking for the passphrase | It's the wrong passphrase. It must match the one saved in the extension's Settings. |
| Dashboard shows "No data loaded" | Reload and enter the passphrase. Or click **Load files** / drag the `.csv` or `.csv.enc` files onto the page. |
| Dashboard didn't change | Wait 1–2 minutes and press **Ctrl+F5**. Check the stamp and the extension popup. |

**Changing the passphrase:** change it in the extension's Settings **and** tell the team. The dashboard asks for one passphrase that must unlock all files. The contacts file (`contacts_directory.csv.enc`) is **not** produced by any scraper yet, so after a passphrase change someone must re-encrypt it. Run `node tests/encrypt-current-data.js <passphrase-file>` with the plaintext CSV in `data/`. Otherwise the contact cards will be empty.

---

## Privacy note (please read)

- The repository is **public**. The dashboard data is therefore now stored **only encrypted**, and the passphrase is never in GitHub.
- The old plaintext files were **removed from the current version** of the repo, and `.gitignore` now blocks them: `data/*.csv` and the saved NetSuite pages, which contained client data and NetSuite `_csrf` session tokens. Saved pages now live only on your computer in `scrapers/fixtures/`.
- **However, GitHub history still contains the old plaintext client data.** Anyone can still find it in older commits. Removing it requires rewriting the repository history (or moving to a fresh repository, ideally private) and then re-publishing the site. The Firebase settings in `js/app.js` also need rotating, and the Firebase database rules need locking down, because the "Do Not Call" list can currently be changed without logging in. **These steps are recommended but need Samuel's OK before anyone does them.**
- Don't save NetSuite pages or CSVs anywhere inside the repo folder except `scrapers/fixtures/` and `data/`, which are ignored.
