/*
 * Scraper failure alert for Antigravity (no notification API) + humans.
 * Reads data/enc/last_run.json (timestamps / counts / error codes only - no client data) and:
 *  - FAILURE (push with ok:false, or the 11 AM Chicago "no run today" fallback):
 *      open or comment on the GitHub issue "MGE scraper failed <Chicago date>" (label scraper-failure)
 *      and write ANTIGRAVITY_ALERT.md (committed by the workflow).
 *  - SUCCESS (push with ok:true): delete ANTIGRAVITY_ALERT.md and close open scraper-failure issues.
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, EVENT_NAME (push|schedule|workflow_dispatch), FORCE_MODE (optional).
 * Exports run() for tests (inject fetch/now/root).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TZ = 'America/Chicago';
const LABEL = 'scraper-failure';
const ALERT_FILE = 'ANTIGRAVITY_ALERT.md';

const chicagoDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const chicagoHour = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(d));
const chicagoStamp = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);

// Error text must never carry client data: keep short codes, strip anything email/phone/URL-like.
function sanitize(errors) {
  return (Array.isArray(errors) ? errors : [String(errors || '')])
    .map((e) => String(e)
      .replace(/[^\s@]+@[^\s@]+/g, '[redacted]')
      .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/[^\w:|.\- ]/g, '')
      .slice(0, 80))
    .filter(Boolean)
    .slice(0, 10);
}

async function run(opts) {
  opts = opts || {};
  const root = opts.root || process.cwd();
  const now = opts.now || new Date();
  const doFetch = opts.fetch || fetch;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY;
  const token = opts.token || process.env.GITHUB_TOKEN;
  const event = opts.event || process.env.EVENT_NAME || 'workflow_dispatch';
  const log = opts.log || console.log;
  const api = async (method, url, body) => {
    const r = await doFetch(`https://api.github.com/repos/${repo}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok && r.status !== 422) throw new Error(`GitHub API ${method} ${url.split('?')[0]} -> ${r.status}`);
    return r.status === 204 ? null : r.json();
  };

  const statusPath = path.join(root, 'data/enc/last_run.json');
  let status = null;
  try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch (e) { status = null; }
  const finished = status && status.finishedAt ? new Date(status.finishedAt) : null;
  const today = chicagoDate(now);

  // ----- decide -----
  let decision = 'noop', errors = [], runTime = finished;
  const mode = opts.forceMode || process.env.FORCE_MODE || '';
  if (event === 'schedule' || mode === 'fallback') {
    // Two cron entries (16:00 and 17:00 UTC) cover CDT/CST; only act at 11 AM Chicago.
    if (mode !== 'fallback' && chicagoHour(now) !== 11) { log('Not 11 AM in Chicago; skipping.'); return { decision: 'skip' }; }
    if (!finished || chicagoDate(finished) !== today) {
      decision = 'alert'; runTime = now;
      errors = [`NO_RUN_TODAY: no scraper run recorded for ${today} by 11 AM (last run: ${finished ? chicagoStamp(finished) : 'never'})`];
    } // a failed run today was already alerted by the push trigger, so don't re-alert here.
  } else if (status) {
    if (status.ok === false) { decision = 'alert'; errors = sanitize(status.errors); if (!errors.length) errors = ['UNKNOWN_FAILURE']; }
    else if (status.ok === true) decision = 'resolve';
  }
  log(`Decision: ${decision}`);

  const alertPath = path.join(root, ALERT_FILE);
  if (decision === 'alert') {
    const when = chicagoStamp(runTime || now);
    const title = `MGE scraper failed ${today}`;
    const errText = errors.join('\n');
    // label (422 = already exists)
    await api('POST', '/labels', { name: LABEL, color: 'd73a4a', description: 'Nightly MGE NetSuite scraper failed' });
    const open = (await api('GET', `/issues?state=open&labels=${LABEL}&per_page=100`)) || [];
    let issue = open.find((i) => i.title === title && !i.pull_request);
    const body = `**Time (America/Chicago):** ${when}\n**Trigger:** ${event}${mode ? ` (${mode})` : ''}\n\n**Error:**\n\`\`\`\n${errText}\n\`\`\`\n\nSee \`${ALERT_FILE}\` in the repo root for where to look and how to test. This issue closes automatically after the next successful run.`;
    if (issue) await api('POST', `/issues/${issue.number}/comments`, { body });
    else issue = await api('POST', '/issues', { title, labels: [LABEL], body });
    const md = [
      '# ⚠️ ANTIGRAVITY ALERT: MGE nightly scraper failed',
      '',
      `- **When (America/Chicago):** ${when}`,
      `- **Issue:** ${issue.html_url}`,
      `- **Error:**`,
      '',
      '```',
      errText,
      '```',
      '',
      '## What to do (agents: do this before anything else)',
      '1. Read the issue above and the error codes. Codes are defined in `extension/background.js` and `docs/SETUP-GUIDE.md` (Troubleshooting).',
      '2. Likely files to fix:',
      '   - `extension/scrapers/clientList.js`: Active Client List (NO_RESULTS_TABLE, MISSING_COLUMNS, row counts)',
      '   - `extension/scrapers/pdfSchedule.js`: Doctor-Owner PDF schedules (PDF_FAILED_AT, PORTAL_FAILED)',
      '   - `extension/scrapers/backlog.js`: paid uncompleted items (BACKLOG_FAILED_AT)',
      '   - `extension/background.js`: pipeline, login check (NOT_LOGGED_IN), upload (GH_*), SKIPPED_* guards',
      '   - `extension/lib/*.js`: CSV builder, encryption, GitHub upload',
      '3. Test offline: `cd tests && npm install && npm test` (runs `tests/run-tests.js`). Saved NetSuite pages go in `scrapers/fixtures/` (gitignored; never commit them).',
      '4. `NOT_LOGGED_IN` / `NO_RUN_TODAY` usually mean NetSuite logged out or the PC/Chrome was off: a human must log in and press **Run now**. No code change is needed.',
      '',
      '_No client data is included here. This file is removed automatically after the next successful scraper run._',
      ''
    ].join('\n');
    fs.writeFileSync(alertPath, md);
    return { decision, issue: issue.number, title };
  }

  if (decision === 'resolve') {
    const had = fs.existsSync(alertPath);
    if (had) fs.unlinkSync(alertPath);
    const open = (await api('GET', `/issues?state=open&labels=${LABEL}&per_page=100`)) || [];
    const stamp = chicagoStamp(finished || now);
    for (const i of open.filter((x) => !x.pull_request)) {
      await api('POST', `/issues/${i.number}/comments`, { body: `✅ Scraper succeeded at ${stamp} (America/Chicago). Closing automatically.` });
      await api('PATCH', `/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
    }
    return { decision, removedAlert: had, closed: open.length };
  }
  return { decision };
}

module.exports = { run, sanitize, chicagoDate, chicagoHour, chicagoStamp };
if (require.main === module) run().then((r) => console.log(JSON.stringify(r)), (e) => { console.error(e.message); process.exit(1); });
