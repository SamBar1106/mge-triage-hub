# mge-triage-hub

MGE Training Scheduling & Triage Hub (static site, GitHub Pages).

- `index.html`, `js/app.js`: the dashboard. It loads **encrypted** data from `data/enc/*.csv.enc`, asks once per browser session for the team passphrase, and decrypts in the browser. You can also drag CSV / `.csv.enc` files onto the page ("Load files").
- `extension/`: Chrome extension that scrapes NetSuite nightly and pushes the encrypted CSVs.
- `scripts/windows/`: one-time Task Scheduler setup that makes sure Chrome is open at 9:55 AM (for the 10:00 AM scrape; existing setups must reload the extension and re-run `Register-MGEChromeTask.ps1`).
- `docs/SETUP-GUIDE.md`: step-by-step setup and troubleshooting.
- `.github/workflows/scraper-notify.yml` + `AGENTS.md`: failure alerts (a `scraper-failure` issue and `ANTIGRAVITY_ALERT.md` for Antigravity/agents).
- `tests/`: offline verification harness (`cd tests && npm install && npm test`).

## MGE hub lookup (for agents)

`cli/mge-hub` answers hub questions on Node 18+ with no install and no browser. Put the team passphrase in a file and set `MGE_HUB_PASSPHRASE_FILE` (or pass `--passphrase-file`). The passphrase is also read from `MGE_HUB_PASSPHRASE`. It is never accepted as a command-line argument.

The cheap commands are `buckets`, `find "name, company, phone, or email"`, and `client CLIENT_ID`. `list` uses the page's pending-bucket filters. Add `--json` when you need to parse the result and `--limit 5` to keep the text short. `list --csv` prints the page export.

Encrypted files are downloaded from the public repo (or read with `--source-dir`) and decrypted in memory. DNC flags live in Firebase and triage notes live in browser localStorage. The CLI reports both as not available in the CLI.

Plaintext client data (`data/*.csv`) and saved NetSuite pages (`scrapers/fixtures/*.html`) are gitignored and must never be committed.
