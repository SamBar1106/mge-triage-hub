# mge-triage-hub

MGE Training Scheduling & Triage Hub (static site, GitHub Pages).

- `index.html`, `js/app.js`: the dashboard. It loads **encrypted** data from `data/enc/*.csv.enc`, asks once per browser session for the team passphrase, and decrypts in the browser. You can also drag CSV / `.csv.enc` files onto the page ("Load files").
- `extension/`: Chrome extension that scrapes NetSuite nightly and pushes the encrypted CSVs.
- `scripts/windows/`: one-time Task Scheduler setup that makes sure Chrome is open at 9:55 AM (for the 10:00 AM scrape; existing setups must reload the extension and re-run `Register-MGEChromeTask.ps1`).
- `docs/SETUP-GUIDE.md`: step-by-step setup and troubleshooting.
- `.github/workflows/scraper-notify.yml` + `AGENTS.md`: failure alerts (a `scraper-failure` issue and `ANTIGRAVITY_ALERT.md` for Antigravity/agents).
- `tests/`: offline verification harness (`cd tests && npm install && npm test`).

Plaintext client data (`data/*.csv`) and saved NetSuite pages (`scrapers/fixtures/*.html`) are gitignored and must never be committed.
