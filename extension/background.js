/* MGE Nightly NetSuite Scraper - service worker (classic). */
importScripts('lib/crypto.js', 'lib/csv.js', 'lib/github.js', 'lib/buckets.js',
  'scrapers/clientList.js', 'scrapers/pdfSchedule.js', 'scrapers/backlog.js');

const DEFAULTS = {
  nsOrigin: 'https://3940793.app.netsuite.com',
  searchId: '72',
  ghOwner: 'SamBar1106', ghRepo: 'mge-triage-hub', ghBranch: 'main', ghToken: '',
  passphrase: '', encDir: 'data/enc',
  runTimes: ['10:00', '12:00', '16:00'],
  enableClients: true, enablePdf: true, enableBacklog: true,
  pdfChunk: 40, backlogBatch: 100,
  minRowRatio: 0.5 // refuse to upload a dataset that shrank below 50% of the previous good run
};
const ALARM_PREFIX = 'mge-run-';
const ALARM_WATCHDOG = 'mge-watchdog';
const PHASES = ['clients', 'pdf', 'backlog', 'upload'];
let active = false; // is a pipeline loop running in THIS service-worker instance?

// ---------- storage helpers ----------
const sget = (k) => chrome.storage.local.get(k);
const sset = (o) => chrome.storage.local.set(o);

function migrateSettings(settings) {
  if (!settings) return { runTimes: ['10:00', '12:00', '16:00'] };
  const s = Object.assign({}, settings);
  if (!Array.isArray(s.runTimes) || s.runTimes.length === 0) {
    if (s.runHour !== undefined && s.runMinute !== undefined) {
      const oldTime = `${String(s.runHour).padStart(2, '0')}:${String(s.runMinute).padStart(2, '0')}`;
      s.runTimes = [oldTime, '12:00', '16:00'];
    } else {
      s.runTimes = ['10:00', '12:00', '16:00'];
    }
  }
  while (s.runTimes.length < 3) {
    const defaults = ['10:00', '12:00', '16:00'];
    s.runTimes.push(defaults[s.runTimes.length]);
  }
  return s;
}

async function getSettings() {
  const { settings } = await sget('settings');
  const migrated = migrateSettings(settings);
  return Object.assign({}, DEFAULTS, migrated);
}
async function getRun() { const { run } = await sget('run'); return run || null; }
async function saveRun(run) { run.heartbeat = Date.now(); await sset({ run }); }
async function log(run, msg) {
  run.log = (run.log || []).concat(`${new Date().toLocaleTimeString()} ${msg}`).slice(-60);
  await saveRun(run);
}
const searchUrl = (s) => `${s.nsOrigin}/app/common/search/searchresults.nl?searchid=${encodeURIComponent(s.searchId)}`;

// ---------- scheduling ----------
function nextRunTime(h, m, now) {
  now = now || new Date();
  const t = new Date(now); t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function getNextScheduledRun(runTimes, now) {
  now = now || new Date();
  const times = (runTimes || ['10:00', '12:00', '16:00']).map((rt) => {
    const [h, m] = (rt || '10:00').split(':').map(Number);
    return nextRunTime(h, m, now);
  });
  return Math.min(...times);
}

async function scheduleDaily(force) {
  const s = await getSettings();
  const times = s.runTimes || ['10:00', '12:00', '16:00'];
  try { await chrome.alarms.clear('mge-daily'); } catch (e) {}

  let nextWhen = null;
  for (let i = 0; i < times.length; i++) {
    const name = `${ALARM_PREFIX}${i}`;
    const existing = await chrome.alarms.get(name);
    const [h, m] = times[i].split(':').map(Number);
    const when = nextRunTime(h, m);
    if (!existing || force) {
      await chrome.alarms.clear(name);
      await chrome.alarms.create(name, { when });
    }
    const sched = (!existing || force) ? when : existing.scheduledTime;
    if (nextWhen === null || sched < nextWhen) nextWhen = sched;
  }
  return nextWhen;
}
chrome.runtime.onInstalled.addListener(() => scheduleDaily(true));
chrome.runtime.onStartup.addListener(() => { scheduleDaily(false); resumeIfInterrupted(); });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name && a.name.startsWith(ALARM_PREFIX)) {
    const idx = Number(a.name.replace(ALARM_PREFIX, ''));
    await scheduleDaily(true);
    startRun(`schedule-${idx}`, { alarmIndex: idx });
  }
  if (a.name === ALARM_WATCHDOG) resumeIfInterrupted();
});

// ---------- tab helpers ----------
function waitForTab(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(fn); clearTimeout(t); resolve(ok); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    const t = setTimeout(() => finish(false), timeoutMs || 90000);
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}
async function openWorkTab(run, s) {
  if (run.tabId) {
    try { await chrome.tabs.get(run.tabId); return run.tabId; } catch (e) { run.tabId = null; }
  }
  let tab;
  try { tab = await chrome.tabs.create({ url: searchUrl(s), active: false }); }
  catch (e) { const w = await chrome.windows.create({ url: searchUrl(s), focused: false, state: 'minimized' }); tab = w.tabs[0]; }
  run.tabId = tab.id; run.createdTab = true;
  await saveRun(run);
  await waitForTab(tab.id);
  return tab.id;
}
async function gotoSearch(tabId, s) {
  await chrome.tabs.update(tabId, { url: searchUrl(s) });
  await new Promise((r) => setTimeout(r, 500));
  await waitForTab(tabId);
  await new Promise((r) => setTimeout(r, 1500));
}
async function exec(tabId, func, args, world) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [], world: world || 'MAIN' });
  if (!res) throw new Error('NO_RESULT');
  return res.result;
}
async function assertLoggedIn(tabId) {
  const probe = await exec(tabId, () => ({ host: location.host, path: location.pathname, table: !!document.getElementById('div__body') }), [], 'ISOLATED');
  if (!/netsuite\.com$/.test(probe.host) || /login/i.test(probe.path)) throw new Error('NOT_LOGGED_IN');
  if (!probe.table) throw new Error('NO_RESULTS_TABLE');
}

// ---------- keep-alive ----------
let keepAliveTimer = null;
function keepAlive(on) {
  if (on && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  if (!on && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ---------- pipeline ----------
// Retry a chunk once; fatal errors (logged out / stopped) propagate, others return null after 2 tries.
async function withRetry(fn) {
  for (let i = 0; i < 2; i++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e && e.message || e);
      if (m === 'NOT_LOGGED_IN' || m === 'STOPPED') throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return null;
}
async function checkAlreadySucceededToday(s, now, customFetch) {
  try {
    const doFetch = customFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) return false;
    const cfg = { owner: s.ghOwner, repo: s.ghRepo, branch: s.ghBranch || 'main', token: s.ghToken };
    const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
    const filePath = `${s.encDir || 'data/enc'}/last_run.json`;
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encPath(filePath)}?ref=${encodeURIComponent(cfg.branch)}`;
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    const r = await doFetch(url, { headers, cache: 'no-store' });
    if (!r || !r.ok) return false;
    const text = await r.text();
    let data;
    try {
      const j = JSON.parse(text);
      if (j && j.content && j.encoding === 'base64') {
        const decoded = (typeof atob !== 'undefined' ? atob : (b) => Buffer.from(b, 'base64').toString('utf8'))(j.content.replace(/\s+/g, ''));
        data = JSON.parse(decoded);
      } else {
        data = j;
      }
    } catch (e) {
      return false;
    }
    if (!data || data.status !== 'success' || !data.timestamp) return false;
    const tz = 'America/Chicago';
    const fmtDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const runDate = fmtDate(new Date(data.timestamp));
    const today = fmtDate(now || new Date());
    return runDate === today;
  } catch (e) {
    return false;
  }
}

async function startRun(trigger, opts) {
  opts = opts || {};
  const cur = await getRun();
  if (cur && PHASES.includes(cur.phase) && (active || Date.now() - (cur.heartbeat || 0) < 10 * 60000)) return { started: false, reason: 'ALREADY_RUNNING' };
  const s = await getSettings();

  const isStaggeredRetry = (opts.alarmIndex !== undefined && opts.alarmIndex > 0) || opts.checkSkip;
  if (isStaggeredRetry && trigger !== 'manual') {
    const alreadyDone = await checkAlreadySucceededToday(s);
    if (alreadyDone) {
      const existingRun = (await getRun()) || { log: [] };
      await log(existingRun, 'Skipped: already succeeded today');
      return { started: false, reason: 'ALREADY_SUCCEEDED_TODAY' };
    }
  }

  if (!s.ghToken || !s.passphrase) {
    await finishWithStatus({ id: Date.now(), startedAt: new Date().toISOString(), trigger, counts: {}, errors: ['NOT_CONFIGURED'] }, false, s, !!s.ghToken);
    return { started: false, reason: 'NOT_CONFIGURED' };
  }
  const progress = {
    clients: { status: s.enableClients ? 'Waiting' : 'Disabled', step: 'Waiting', done: 0, total: null, startedAt: null },
    pdf: { status: s.enablePdf ? 'Waiting' : 'Disabled', step: 'Waiting', done: 0, total: null, startedAt: null },
    backlog: { status: s.enableBacklog ? 'Waiting' : 'Disabled', step: 'Waiting', done: 0, total: null, startedAt: null },
    upload: { status: 'Waiting', step: 'Waiting', done: 0, total: null, startedAt: null }
  };
  const run = { id: Date.now(), trigger, startedAt: new Date().toISOString(), phase: 'clients', pdfCursor: 0, backlogCursor: 0, counts: {}, errors: [], done: {}, log: [], progress };
  await sset({ run, res_clients: null, res_queue: [], res_pdf_items: [], res_pdf_summ: [], res_backlog: [] });
  pipeline();
  return { started: true };
}

async function resumeIfInterrupted() {
  const run = await getRun();
  if (!run || !PHASES.includes(run.phase) || active) return;
  if (Date.now() - new Date(run.startedAt).getTime() > 8 * 3600000) {
    run.phase = 'failed';
    run.errors.push('TIMED_OUT');
    await saveRun(run);
    const s = await getSettings();
    await finishWithStatus(run, false, s, true);
    return;
  }
  pipeline();
}

async function pipeline() {
  if (active) return;
  active = true; keepAlive(true);
  chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 1 });
  const s = await getSettings();
  let run = await getRun();
  try {
    const tabId = await openWorkTab(run, s);

    if (run.phase === 'clients') {
      if (s.enableClients || s.enablePdf || s.enableBacklog) {
        run.progress = run.progress || {};
        run.progress.clients = {
          status: 'Running',
          startedAt: new Date().toISOString(),
          step: 'Scraping client list…',
          done: 0,
          total: null
        };
        await saveRun(run);

        await gotoSearch(tabId, s);
        await assertLoggedIn(tabId);
        const r = await exec(tabId, scrapeActiveClientList, [{ origin: s.nsOrigin }], 'ISOLATED');
        if (!r || !r.ok) {
          run.progress.clients.status = 'Failed';
          run.progress.clients.step = 'Scrape failed';
          throw new Error((r && r.error) || 'CLIENT_SCRAPE_FAILED');
        }
        if (r.meta.missingColumns.length) run.errors.push('MISSING_COLUMNS:' + r.meta.missingColumns.join('|'));
        await sset({ res_clients: { headers: r.headers, rows: r.rows }, res_queue: r.queue });
        run.counts.clients = r.rows.length; run.counts.pages = r.meta.pages; run.done.clients = true;
        run.progress.clients.status = 'Done';
        run.progress.clients.done = r.meta.pages;
        run.progress.clients.total = r.meta.pages;
        run.progress.clients.step = `${r.rows.length} clients (${r.meta.pages} pages)`;
        await log(run, `Client list: ${r.rows.length} clients (${r.meta.pages} page(s)).`);
      } else {
        if (run.progress && run.progress.clients) {
          run.progress.clients.status = 'Disabled';
          run.progress.clients.step = 'Disabled in settings';
        }
      }
      run.phase = 'pdf'; await saveRun(run);
    }

    const { res_queue: queue } = await sget('res_queue');
    const queueLen = (queue || []).length;

    if (run.phase === 'pdf') {
      run.progress = run.progress || {};
      if (s.enablePdf) {
        run.progress.pdf = {
          status: 'Running',
          startedAt: run.progress.pdf?.startedAt || new Date().toISOString(),
          done: run.pdfCursor,
          total: queueLen,
          step: `${run.pdfCursor}/${queueLen} clients`
        };
        await saveRun(run);

        while (run.pdfCursor < queue.length) {
          if ((await getRun()).stopRequested) throw new Error('STOPPED');
          const chunk = queue.slice(run.pdfCursor, run.pdfCursor + Number(s.pdfChunk)).map((q) => ({
            clientInternalId: q.clientId, lastName: q.lastName, firstName: q.firstName,
            doctorSearchName: `${q.firstName || ''} ${q.lastName || ''}`.trim() || `Client #${q.clientId}`,
            consultant: q.consultant || 'Unassigned'
          }));
          const r = await withRetry(async () => {
            await gotoSearch(tabId, s); await assertLoggedIn(tabId);
            const x = await exec(tabId, scrapePdfSchedulesChunk, [chunk, {}], 'MAIN');
            if (!x || !x.ok) throw new Error((x && x.error) || 'PDF_SCRAPE_FAILED');
            return x;
          });
          if (!r) {
            run.errors.push(`PDF_FAILED_AT:${run.pdfCursor}`);
            run.progress.pdf.status = 'Failed';
            run.progress.pdf.step = `Failed at client ${run.pdfCursor}`;
            await log(run, 'PDF scraper failed twice; skipping PDF upload.');
            break;
          }
          const cur = await sget(['res_pdf_items', 'res_pdf_summ']);
          await sset({ res_pdf_items: cur.res_pdf_items.concat(r.itemizedRows), res_pdf_summ: cur.res_pdf_summ.concat(r.doctorSummaries) });
          run.pdfCursor += chunk.length;
          run.progress.pdf.done = Math.min(run.pdfCursor, queueLen);
          run.progress.pdf.step = `${run.progress.pdf.done}/${queueLen} clients`;
          await log(run, `PDF schedules: ${run.pdfCursor}/${queue.length} clients.`);
          await saveRun(run);
        }
        if (run.pdfCursor >= queue.length) {
          run.done.pdf = true;
          run.progress.pdf.status = 'Done';
          run.progress.pdf.done = queueLen;
          run.progress.pdf.total = queueLen;
          run.progress.pdf.step = `${queueLen}/${queueLen} clients`;
        }
      } else {
        if (run.progress && run.progress.pdf) {
          run.progress.pdf.status = 'Disabled';
          run.progress.pdf.step = 'Disabled in settings';
        }
      }
      run.phase = 'backlog'; await saveRun(run);
    }

    if (run.phase === 'backlog') {
      run.progress = run.progress || {};
      if (s.enableBacklog) {
        const batchSize = Number(s.backlogBatch || 100);
        const totalBatches = Math.ceil(queueLen / batchSize);
        let batchesDone = Math.floor(run.backlogCursor / batchSize);
        run.progress.backlog = {
          status: 'Running',
          startedAt: run.progress.backlog?.startedAt || new Date().toISOString(),
          done: batchesDone,
          total: totalBatches,
          step: `${batchesDone}/${totalBatches} batches`
        };
        await saveRun(run);

        while (run.backlogCursor < queue.length) {
          if ((await getRun()).stopRequested) throw new Error('STOPPED');
          const chunk = queue.slice(run.backlogCursor, run.backlogCursor + batchSize)
            .map((q) => ({ clientId: q.clientId, name: q.name, email: q.email, consultant: q.consultant }));
          const r = await withRetry(async () => {
            await gotoSearch(tabId, s); await assertLoggedIn(tabId); // fresh page = fresh memory (replaces manual refresh)
            const x = await exec(tabId, scrapeBacklogChunk, [chunk, {}], 'MAIN');
            if (!x || !x.ok) throw new Error('BACKLOG_SCRAPE_FAILED');
            return x;
          });
          if (!r) {
            run.errors.push(`BACKLOG_FAILED_AT:${run.backlogCursor}`);
            run.progress.backlog.status = 'Failed';
            run.progress.backlog.step = `Failed at batch ${batchesDone + 1}`;
            await log(run, 'Backlog scraper failed twice; skipping backlog upload.');
            break;
          }
          const cur = await sget('res_backlog');
          await sset({ res_backlog: cur.res_backlog.concat(r.rows) });
          run.backlogCursor += chunk.length;
          batchesDone++;
          run.progress.backlog.done = Math.min(batchesDone, totalBatches);
          run.progress.backlog.step = `${run.progress.backlog.done}/${totalBatches} batches`;
          await log(run, `Backlog: ${run.backlogCursor}/${queue.length} clients.`);
          await saveRun(run);
        }
        if (run.backlogCursor >= queue.length) {
          run.done.backlog = true;
          run.progress.backlog.status = 'Done';
          run.progress.backlog.done = totalBatches;
          run.progress.backlog.total = totalBatches;
          run.progress.backlog.step = `${totalBatches}/${totalBatches} batches`;
        }
      } else {
        if (run.progress && run.progress.backlog) {
          run.progress.backlog.status = 'Disabled';
          run.progress.backlog.step = 'Disabled in settings';
        }
      }
      run.phase = 'upload'; await saveRun(run);
    }

    if (run.phase === 'upload') {
      await uploadAll(run, s);
      run.phase = 'done'; await saveRun(run);
      await finishWithStatus(run, true, s, true);
    }
  } catch (e) {
    run = (await getRun()) || run;
    const code = String((e && e.message) || e).slice(0, 60);
    run.errors.push(code); run.phase = 'failed';
    if (run.progress) {
      for (const p of PHASES) {
        if (run.progress[p]) {
          if (run.progress[p].status === 'Running') {
            run.progress[p].status = 'Failed';
            run.progress[p].step = code;
          } else if (run.progress[p].status === 'Waiting') {
            run.progress[p].status = 'Skipped';
            run.progress[p].step = 'Skipped';
          }
        }
      }
    }
    await saveRun(run);
    await finishWithStatus(run, false, s, true);
    notify('MGE scraper failed', code === 'NOT_LOGGED_IN' ? 'NetSuite is logged out. Log in to NetSuite in Chrome and press "Run now".' : `Error: ${code}`);
  } finally {
    try { if (run.createdTab && run.tabId) await chrome.tabs.remove(run.tabId); } catch (e) {}
    active = false; keepAlive(false);
    chrome.alarms.clear(ALARM_WATCHDOG);
  }
}

async function uploadAll(run, s) {
  run.progress = run.progress || {};
  const cfg = { owner: s.ghOwner, repo: s.ghRepo, branch: s.ghBranch, token: s.ghToken };
  const data = await sget(['res_clients', 'res_pdf_items', 'res_pdf_summ', 'res_backlog', 'prevCounts']);
  const prev = data.prevCounts || {};
  const files = [];
  if (run.done.clients && data.res_clients) files.push(['clients_directory.csv', MGECsv.clientsCsv(data.res_clients.rows), data.res_clients.rows.length]);
  if (run.done.pdf) {
    files.push(['pdf_directory.csv', MGECsv.pdfCsv(data.res_pdf_items), data.res_pdf_items.length]);
    const zero = data.res_pdf_summ.filter((d) => d.scheduleStatus !== 'HAS SCHEDULED DATES');
    files.push(['doctor_owner_zero_dates_summary.csv', MGECsv.zeroDatesCsv(data.res_pdf_summ), zero.length]);
  }
  if (run.done.backlog) files.push(['unscheduled_backlog.csv', MGECsv.backlogCsv(data.res_backlog), data.res_backlog.length]);
  run.files = {};
  const totalFiles = files.length;
  run.progress.upload = {
    status: 'Running',
    startedAt: new Date().toISOString(),
    done: 0,
    total: totalFiles,
    step: `0/${totalFiles} files`
  };
  await saveRun(run);

  let uploaded = 0;
  for (const [name, csv, rows] of files) {
    if (prev[name] && rows < prev[name] * s.minRowRatio) { run.errors.push(`SKIPPED_SHRUNK:${name}`); continue; }
    if (rows === 0 && name !== 'doctor_owner_zero_dates_summary.csv') { run.errors.push(`SKIPPED_EMPTY:${name}`); continue; }
    const enc = await MGECrypto.encryptText(csv, s.passphrase, name);
    const body = JSON.stringify(enc);
    await MGEGitHub.putFile(cfg, `${s.encDir}/${name}.enc`, body, `data: nightly encrypted refresh (${name})`);
    run.files[name] = { rows, bytes: body.length, updatedAt: new Date().toISOString() };
    prev[name] = rows;
    uploaded++;
    run.progress.upload.done = uploaded;
    run.progress.upload.step = `${uploaded}/${totalFiles} files`;
    await log(run, `Uploaded ${name}.enc (${rows} rows).`);
    await saveRun(run);
  }
  await sset({ prevCounts: prev });
  run.progress.upload.status = 'Done';
  run.progress.upload.done = totalFiles;
  run.progress.upload.total = totalFiles;
  run.progress.upload.step = `${totalFiles}/${totalFiles} files`;
  await saveRun(run);
}

function toIsoWithOffset(date) {
  date = date || new Date();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(tzOffset) / 60));
  const offsetMinutes = pad(Math.abs(tzOffset) % 60);
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}${sign}${offsetHours}:${offsetMinutes}`;
}

async function finishWithStatus(run, ok, s, push) {
  s = s || {};
  const isNotConfigured = Boolean(run && run.errors && run.errors.includes('NOT_CONFIGURED'));
  let data = {};
  if (!isNotConfigured) {
    data = await sget(['res_clients', 'res_pdf_items', 'res_pdf_summ', 'res_backlog']);
  }

  const enableClients = s.enableClients !== false;
  const enablePdf = s.enablePdf !== false;
  const enableBacklog = s.enableBacklog !== false;

  let clientsCount = null;
  let pdfCount = null;
  let backlogCount = null;
  const contactsCount = null; // Contacts is never scraped

  if (!isNotConfigured) {
    if (enableClients) {
      if (run && run.done && run.done.clients && data.res_clients && data.res_clients.rows) {
        clientsCount = data.res_clients.rows.length;
      } else if (data.res_clients && data.res_clients.rows) {
        clientsCount = data.res_clients.rows.length;
      } else if (run && run.counts && typeof run.counts.clients === 'number') {
        clientsCount = run.counts.clients;
      }
    }

    if (enablePdf) {
      if (run && run.done && run.done.pdf && data.res_pdf_items) {
        pdfCount = data.res_pdf_items.length;
      } else if (data.res_pdf_items && data.res_pdf_items.length > 0) {
        pdfCount = data.res_pdf_items.length;
      }
    }

    if (enableBacklog) {
      if (run && run.done && run.done.backlog && data.res_backlog) {
        backlogCount = data.res_backlog.length;
      } else if (data.res_backlog && data.res_backlog.length > 0) {
        backlogCount = data.res_backlog.length;
      }
    }
  }

  const errors = run && run.errors ? [...run.errors] : [];
  const hitPartialFail = errors.some((e) => e.startsWith('PDF_FAILED_AT') || e.startsWith('BACKLOG_FAILED_AT') || e.startsWith('SKIPPED'));
  const clientScraperFailed = enableClients && (!run || !run.done || !run.done.clients);
  const pdfScraperFailed = enablePdf && (!run || !run.done || !run.done.pdf);
  const backlogScraperFailed = enableBacklog && (!run || !run.done || !run.done.backlog);
  const anyEnabledFailed = clientScraperFailed || pdfScraperFailed || backlogScraperFailed;

  const isSuccess = Boolean(ok && !hitPartialFail && !anyEnabledFailed && errors.length === 0);

  let pendingCount = null;
  if (isSuccess && enableClients && enablePdf && enableBacklog && typeof MGEBuckets !== 'undefined' && data.res_clients && data.res_clients.rows) {
    try {
      const bucketRes = MGEBuckets.computeBuckets({
        clients: data.res_clients.rows.map((r) => ({
          clientId: r[0],
          doctorName: r[1],
          consultant: r[2],
          accountStatus: r[3],
          doctorEmail: r[4],
          workPhone: r[5],
          defaultAddress: r[6]
        })),
        pdf: data.res_pdf_items || [],
        backlog: data.res_backlog || []
      });
      pendingCount = bucketRes.pending;
      clientsCount = bucketRes.clients;
    } catch (e) {
      console.warn('Could not compute bucket pending count', e);
      pendingCount = null;
    }
  }

  const statusObj = {
    timestamp: toIsoWithOffset(new Date()),
    status: isSuccess ? 'success' : 'failure',
    clients: clientsCount,
    pending: pendingCount,
    contacts: contactsCount,
    pdf: pdfCount,
    backlog: backlogCount
  };

  if (!isSuccess) {
    if (errors.length > 0) {
      statusObj.error = errors[errors.length - 1];
    } else if (clientScraperFailed) {
      statusObj.error = 'CLIENT_SCRAPE_FAILED';
    } else if (pdfScraperFailed) {
      statusObj.error = 'PDF_SCRAPE_FAILED';
    } else if (backlogScraperFailed) {
      statusObj.error = 'BACKLOG_SCRAPE_FAILED';
    } else {
      statusObj.error = 'UNKNOWN_FAILURE';
    }
  }

  await sset({ lastStatus: statusObj });
  if (push && s.ghToken) {
    try {
      await MGEGitHub.putFile({ owner: s.ghOwner, repo: s.ghRepo, branch: s.ghBranch, token: s.ghToken },
        `${s.encDir}/last_run.json`, JSON.stringify(statusObj, null, 2) + '\n', `data: scraper status (${isSuccess ? 'success' : 'failure'})`);
      await sset({ lastPushedStatus: statusObj });
    } catch (e) {
      statusObj.status = 'failure';
      statusObj.error = 'STATUS_PUSH_FAILED';
      await sset({ lastStatus: statusObj });
    }
  }
  return statusObj;
}

function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }); } catch (e) {}
}

// ---------- messages from popup / options ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'runNow') return startRun('manual');
    if (msg.type === 'stop') {
      const run = await getRun();
      if (run) { run.stopRequested = true; await saveRun(run); if (run.tabId) exec(run.tabId, () => { window.__MGE_STOP = true; }, [], 'MAIN').catch(() => {}); }
      return { ok: true };
    }
    if (msg.type === 'status') {
      const { run, lastStatus } = await sget(['run', 'lastStatus']);
      const s = await getSettings();
      const nextRun = getNextScheduledRun(s.runTimes);
      return { run, lastStatus, nextRun, active };
    }
    if (msg.type === 'reschedule') return { nextRun: await scheduleDaily(true) };
    if (msg.type === 'testGitHub') {
      const s = await getSettings();
      return MGEGitHub.testAccess({ owner: s.ghOwner, repo: s.ghRepo, token: s.ghToken });
    }
    if (msg.type === 'testNetSuite') {
      const s = await getSettings();
      const tab = await chrome.tabs.create({ url: searchUrl(s), active: false });
      try {
        await waitForTab(tab.id); await new Promise((r) => setTimeout(r, 1500));
        await assertLoggedIn(tab.id);
        const r = await exec(tab.id, scrapeActiveClientList, [{ origin: s.nsOrigin }], 'ISOLATED');
        return r.ok ? { ok: true, clients: r.rows.length, pages: r.meta.pages, missingColumns: r.meta.missingColumns } : { ok: false, error: r.error };
      } catch (e) { return { ok: false, error: e.message }; }
      finally { chrome.tabs.remove(tab.id).catch(() => {}); }
    }
    return { ok: false, error: 'UNKNOWN' };
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

if (typeof module !== 'undefined' && module.exports) module.exports = { nextRunTime, getNextScheduledRun, migrateSettings, checkAlreadySucceededToday, toIsoWithOffset, finishWithStatus };

