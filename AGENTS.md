# AGENTS.md

**Rule #1: If `ANTIGRAVITY_ALERT.md` exists in the repo root, read it first and help fix the failing scraper before anything else.**

## Repo notes for coding agents
- Static dashboard: `index.html`, `js/app.js`. Data is **encrypted** in `data/enc/*.csv.enc` (see `js/mge-crypto.js`).
- Nightly scraper: Chrome extension in `extension/` (`background.js` pipeline; `scrapers/` = clientList, pdfSchedule, backlog).
- Tests: `cd tests && npm install && npm test` (`tests/run-tests.js`, offline, jsdom).
- Alerts: `.github/workflows/scraper-notify.yml` opens or closes `scraper-failure` issues and writes or removes `ANTIGRAVITY_ALERT.md`.
- **Never commit client data**: no plaintext `data/*.csv`, no saved NetSuite pages (`scrapers/fixtures/*.html`), no tokens or passphrases. The repo is public.
