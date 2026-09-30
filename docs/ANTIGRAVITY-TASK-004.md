# Antigravity Task 004: Instruction doc for a free Google Cloud e2-micro VM that runs the NetSuite scraper

Branch: `feature/gcp-vm-instructions`. Separate from task 003. Commit and push to THIS branch only. Do NOT merge.
Output: ONE new file, `docs/GCP-VM-SETUP.md`. Do not change any code. Do not create any cloud resources.
Rules (AGENTS.md): no client data, credentials, tokens or passphrases in the repo. Use placeholders like `<NETSUITE_EMAIL>`.

Audience: Samuel. He's technical, uses an Intel Mac (no Homebrew; use official installers), and wants exact commands to paste, one step at a time, with what each should print.

## Important context (address honestly in the doc)
- Today the scraper is a Chrome MV3 extension (`extension/`) that relies on a logged-in Chrome session on a Windows PC. There is NO standalone Python scraper yet. The doc must say so plainly, and include a section "What must be built first": a headless port (recommended: Python + Playwright/Chromium) that reuses the same NetSuite URLs and saved search 72, logic in `extension/scrapers/` and `extension/lib/buckets.js`, the same AES-GCM encryption format as `extension/lib/crypto.js`, and the same `data/enc/*.enc` + `last_run.json` outputs. Mark this as a separate future task.
- e2-micro has 1 GB RAM. Include creating a 2 GB swap file so headless Chromium can run.
- NetSuite login: dedicated account, password login, and 2FA. Verify from Oracle's official NetSuite docs and state what is actually possible: 2FA requirements for the role, "trust this device" duration limits, and Login IP address restrictions (which need a fixed IP). Recommend the sanctioned route as the preferred option: NetSuite token-based authentication (TBA/OAuth) with SuiteTalk REST or a RESTlet or SuiteQL, instead of password scraping. Keep the headless login as a fallback. Never tell Samuel to disable 2FA.
- IP vs cost conflict: no static IP (it costs money). But an ephemeral external IP changes if the VM is stopped or recreated, which breaks a NetSuite IP whitelist. Explain this trade-off, and how to keep the ephemeral IP stable (don't stop the VM; reboots keep it). Verify from Google's current official pricing and free-tier pages whether an in-use external IPv4 on the free e2-micro is billed, and state the real number with a link. Don't just claim $0.

## Sections the doc must cover, each with exact commands (gcloud CLI + Cloud Console alternative)
1. Google Cloud account/project creation, billing account (needed even for the free tier), budget alert at $1, enable the Compute Engine API. Install the gcloud CLI on an Intel Mac from the official installer.
2. Create an e2-micro in us-central1 (or us-east1 / us-west1), with a 30 GB standard persistent disk (the free-tier limit), no static IP, and a minimal service account with no extra scopes.
3. OS: Debian 12 (recommended) or Ubuntu 24.04 LTS, and why.
4. SSH (`gcloud compute ssh`), `apt update && apt upgrade`, unattended-upgrades, Python 3 + venv + pip, create a non-root `mge` user, and the firewall (no inbound except SSH, which can be locked to IAP).
5. Get the code: `git clone` over HTTPS with a fine-grained token (only this repo, Contents: Read and write) stored in a git credential file with chmod 600, or a deploy key.
6. Secrets: `/etc/mge/scraper.env` owned by `mge`, chmod 600, loaded by systemd `EnvironmentFile=`, holding the NetSuite account, GitHub token and team passphrase. Optionally use Google Secret Manager (note its free-tier limits). Never put secrets in code, cron lines or shell history (use `read -s`).
7. NetSuite trusted device / IP: exactly what to click, per the verified docs, and the limits.
8. Scheduling: a systemd service + timer for 10:00, 12:00 and 16:00 America/Chicago (`timedatectl set-timezone America/Chicago`), with skip-if-already-succeeded-today logic matching task 003 (read `data/enc/last_run.json` from GitHub first). Include `systemctl list-timers` and `journalctl` checks, plus log rotation.
9. Persistence: the VM pushes encrypted outputs + `last_run.json` to `main` in `data/enc/` exactly as the extension does, so the dashboard and the email workflow keep working unchanged. Only encrypted files and counts go to GitHub. Note that the Windows PC and the VM should not both run on the same schedule (pick one, or disable the extension's alarms).
10. Cost table: e2-micro, disk, egress (1 GB/month free, North America), external IP, and snapshots (not free), with official links. Expected total, with a clear warning that a static IP, a larger machine, or a region outside the free list costs money.
Also: a troubleshooting table, how to update the code (`git pull` + restart the timer), and how to shut everything down and delete it so billing stops.

## Done when
- `docs/GCP-VM-SETUP.md` exists and covers all of the above, with official source links for every pricing/NetSuite claim.
- No secrets or client data are in the diff.
- Commit, push to `feature/gcp-vm-instructions`, and do NOT merge. In the final message, list the sections and any open questions for Samuel.
