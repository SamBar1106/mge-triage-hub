/*
 * Scraper failure alert for Antigravity (no notification API) + humans + email notifications.
 * Reads data/enc/last_run.json (timestamps / counts / error codes only - no client data) and:
 *  - FAILURE (push with status:failure / ok:false, or the 11 AM Chicago "no run today" fallback):
 *      open or comment on the GitHub issue "MGE scraper failed <Chicago date>" (label scraper-failure)
 *      and write ANTIGRAVITY_ALERT.md (committed by the workflow).
 *  - SUCCESS (push with status:success / ok:true): delete ANTIGRAVITY_ALERT.md and close open scraper-failure issues.
 *  - EMAIL (--email): sends notification email to samuelbarrios1106@gmail.com via Gmail SMTP.
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, EVENT_NAME (push|schedule|workflow_dispatch), FORCE_MODE (optional), GMAIL_APP_PASSWORD.
 * Exports run(), runEmail(), sendSmtpEmail for tests (inject fetch/now/root/smtpSend).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const TZ = 'America/Chicago';
const LABEL = 'scraper-failure';
const ALERT_FILE = 'ANTIGRAVITY_ALERT.md';
const LIVE_SITE_URL = 'https://sambar1106.github.io/mge-triage-hub/';
const EMAIL_RECIPIENT = 'samuelbarrios1106@gmail.com';

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
  const finished = status ? new Date(status.timestamp || status.finishedAt) : null;
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
    const isFailed = status.status ? status.status === 'failure' : status.ok === false;
    const isSuccess = status.status ? status.status === 'success' : status.ok === true;
    const rawErrors = status.error ? [status.error] : (status.errors || []);
    if (isFailed) {
      decision = 'alert';
      errors = sanitize(rawErrors);
      if (!errors.length) errors = ['UNKNOWN_FAILURE'];
    } else if (isSuccess) {
      decision = 'resolve';
    }
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

function sendSmtpEmail({ host = 'smtp.gmail.com', port = 465, user, pass, to, from, subject, body, tlsConnect = tls.connect }) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = tlsConnect({ host, port, minVersion: 'TLSv1.2', rejectUnauthorized: true });
    } catch (err) {
      return reject(new Error(`SMTP connection setup failed: ${err.message}`));
    }

    let buffer = '';
    let step = 0;
    let completed = false;

    socket.setEncoding('utf8');

    const send = (line) => {
      socket.write(line + '\r\n');
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const codeMatch = line.match(/^(\d{3})([ -])(.*)$/);
        if (!codeMatch) continue;
        const code = parseInt(codeMatch[1], 10);
        const isContinuation = codeMatch[2] === '-';
        if (isContinuation) continue;

        handleResponse(code, line);
      }
    });

    socket.on('error', (err) => {
      if (!completed) {
        completed = true;
        reject(new Error(`SMTP network error: ${err.message}`));
      }
    });

    socket.on('close', () => {
      if (!completed && step < 8) {
        completed = true;
        reject(new Error(`SMTP connection closed prematurely at step ${step}`));
      }
    });

    function fail(msg) {
      if (!completed) {
        completed = true;
        socket.destroy();
        reject(new Error(msg));
      }
    }

    function handleResponse(code, line) {
      switch (step) {
        case 0: // 220 greeting
          if (code !== 220) return fail(`Expected 220 greeting, got: ${line}`);
          step++;
          send('EHLO localhost');
          break;
        case 1: // 250 after EHLO
          if (code !== 250) return fail(`Expected 250 after EHLO, got: ${line}`);
          step++;
          send('AUTH LOGIN');
          break;
        case 2: // 334 username prompt
          if (code !== 334) return fail(`Expected 334 for AUTH LOGIN, got: ${line}`);
          step++;
          send(Buffer.from(user).toString('base64'));
          break;
        case 3: // 334 password prompt
          if (code !== 334) return fail(`Expected 334 for password, got: ${line}`);
          step++;
          send(Buffer.from(pass).toString('base64'));
          break;
        case 4: // 235 auth success
          if (code !== 235) return fail(`Authentication failed (code ${code}): check credentials`);
          step++;
          send(`MAIL FROM:<${from || user}>`);
          break;
        case 5: // 250 MAIL FROM
          if (code !== 250) return fail(`Expected 250 after MAIL FROM, got: ${line}`);
          step++;
          send(`RCPT TO:<${to}>`);
          break;
        case 6: // 250 RCPT TO
          if (code !== 250) return fail(`Expected 250 after RCPT TO, got: ${line}`);
          step++;
          send('DATA');
          break;
        case 7: // 354 DATA
          if (code !== 354) return fail(`Expected 354 after DATA, got: ${line}`);
          step++;
          const cleanBody = body.replace(/^\./gm, '..');
          const emailMessage = [
            `From: ${from || user}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            cleanBody,
            '.'
          ].join('\r\n');
          socket.write(emailMessage + '\r\n');
          break;
        case 8: // 250 after DATA
          if (code !== 250) return fail(`Expected 250 after message data, got: ${line}`);
          step++;
          completed = true;
          send('QUIT');
          socket.end();
          resolve({ ok: true });
          break;
      }
    }
  });
}

async function runEmail(opts) {
  opts = opts || {};
  const root = opts.root || process.cwd();
  const now = opts.now || new Date();
  const event = opts.event || process.env.EVENT_NAME || 'workflow_dispatch';
  const mode = opts.forceMode || process.env.FORCE_MODE || '';
  const log = opts.log || console.log;
  const pass = opts.password !== undefined ? opts.password : process.env.GMAIL_APP_PASSWORD;
  const recipient = opts.to || EMAIL_RECIPIENT;
  const sender = opts.user || EMAIL_RECIPIENT;
  const smtpSend = opts.smtpSend || sendSmtpEmail;

  if (!pass) {
    throw new Error('GMAIL_APP_PASSWORD secret is missing.');
  }

  const statusPath = path.join(root, 'data/enc/last_run.json');
  let status = null;
  try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch (e) { status = null; }
  const finished = status ? new Date(status.timestamp || status.finishedAt) : null;
  const today = chicagoDate(now);

  let shouldSend = false;
  let subject = '';
  let bodyLines = [];

  if (event === 'schedule' || mode === 'fallback') {
    if (mode !== 'fallback' && chicagoHour(now) !== 11) {
      log('Not 11 AM in Chicago; skipping email.');
      return { sent: false, reason: 'skipped_dst_twin' };
    }
    if (!finished || chicagoDate(finished) !== today) {
      shouldSend = true;
      const when = chicagoStamp(now);
      const errText = `NO_RUN_TODAY: no scraper run recorded for ${today} by 11 AM (last run: ${finished ? chicagoStamp(finished) : 'never'})`;
      subject = 'MGE scraper: FAILED';
      bodyLines = [
        `Time (America/Chicago): ${when}`,
        'Status: FAILED',
        '',
        `Error: ${errText}`,
        '',
        `Live site: ${LIVE_SITE_URL}`
      ];
    } else {
      log('Scraper already ran today; no fallback email needed.');
      return { sent: false, reason: 'already_ran_today' };
    }
  } else {
    // push or workflow_dispatch: send after every run
    if (!status) {
      shouldSend = true;
      const when = chicagoStamp(now);
      subject = 'MGE scraper: FAILED';
      bodyLines = [
        `Time (America/Chicago): ${when}`,
        'Status: FAILED',
        '',
        'Error: MISSING_STATUS_FILE (data/enc/last_run.json could not be read)',
        '',
        `Live site: ${LIVE_SITE_URL}`
      ];
    } else {
      const isSuccess = status.status ? status.status === 'success' : status.ok === true;
      const when = chicagoStamp(finished || now);
      const clients = status.clients !== undefined ? status.clients : (status.counts && status.counts.clients) || 0;
      const pending = status.pending !== undefined ? status.pending : 0;
      const contacts = status.contacts !== undefined ? status.contacts : (status.files && status.files['contacts_directory.csv'] && status.files['contacts_directory.csv'].rows) || 0;
      const pdf = status.pdf !== undefined ? status.pdf : (status.files && status.files['pdf_directory.csv'] && status.files['pdf_directory.csv'].rows) || 0;
      const backlog = status.backlog !== undefined ? status.backlog : (status.files && status.files['unscheduled_backlog.csv'] && status.files['unscheduled_backlog.csv'].rows) || 0;

      shouldSend = true;
      if (isSuccess) {
        subject = `MGE scraper: SUCCESS - ${clients} clients / ${pending} pending`;
        bodyLines = [
          `Time (America/Chicago): ${when}`,
          'Status: SUCCESS',
          '',
          'Counts:',
          `- Clients: ${clients}`,
          `- Pending: ${pending}`,
          `- Contacts: ${contacts}`,
          `- PDF: ${pdf}`,
          `- Backlog: ${backlog}`,
          '',
          `Live site: ${LIVE_SITE_URL}`
        ];
      } else {
        const rawErr = status.error || (status.errors && status.errors.length ? status.errors[status.errors.length - 1] : 'UNKNOWN_FAILURE');
        const err = sanitize(rawErr).join('\n') || 'UNKNOWN_FAILURE';
        subject = 'MGE scraper: FAILED';
        bodyLines = [
          `Time (America/Chicago): ${when}`,
          'Status: FAILED',
          '',
          `Error: ${err}`,
          '',
          'Counts:',
          `- Clients: ${clients}`,
          `- Pending: ${pending}`,
          `- Contacts: ${contacts}`,
          `- PDF: ${pdf}`,
          `- Backlog: ${backlog}`,
          '',
          `Live site: ${LIVE_SITE_URL}`
        ];
      }
    }
  }

  if (shouldSend) {
    const body = bodyLines.join('\n');
    log(`Sending email: ${subject}`);
    await smtpSend({
      host: 'smtp.gmail.com',
      port: 465,
      user: sender,
      pass,
      to: recipient,
      from: sender,
      subject,
      body,
      tlsConnect: opts.tlsConnect
    });
    log('Email sent successfully.');
    return { sent: true, subject, to: recipient, body };
  }

  return { sent: false };
}

module.exports = {
  run,
  runEmail,
  sendSmtpEmail,
  sanitize,
  chicagoDate,
  chicagoHour,
  chicagoStamp,
  LIVE_SITE_URL,
  EMAIL_RECIPIENT
};

if (require.main === module) {
  const isEmail = process.argv.includes('--email');
  const runner = isEmail ? runEmail : run;
  runner().then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      console.error(e.message);
      process.exit(1);
    }
  );
}
