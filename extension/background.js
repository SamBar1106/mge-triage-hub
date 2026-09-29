/* MGE Nightly NetSuite Scraper - service worker (classic). */
importScripts('lib/crypto.js', 'lib/csv.js', 'lib/github.js', 'lib/buckets.js',
  'scrapers/clientList.js', 'scrapers/pdfSchedule.js', 'scrapers/backlog.js');

const DEFAULTS = {
  nsOrigin: 'https://3940793.app.netsuite.com',
  searchId: '72',
  ghOwner: 'SamBar1106', ghRepo: 'mge-triage-hub', ghBranch: 'main', ghToken: '',
  passphrase: '', encDir: 'data/enc',
  runHour: 10, runMinute: 0,
  enableClients: true, enablePdf: true, enableBacklog: true,
  pdfChunk: 40, backlogBatch: 100,
  minRowRatio: 0.5 // refuse to upload a dataset that shrank below 50% of the previous good run
};
const ALARM_DAILY = 'mge-daily';
const ALARM_WATCHDOG = 'mge-watchdog';
const PHASES = ['clients', 'pdf', 'backlog', 'upload'];
let active = false; // is a pipeline loop running in THIS service-worker instance?

// ---------- storage helpers ----------
const sget = (k) => chrome.storage.local.get(k);
const sset = (o) => chrome.storage.local.set(o);
async function getSettings() { const { settings } = await sget('settings'); return Object.assign({}, DEFAULTS, settings || {}); }
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
async function scheduleDaily(force) {
  const s = await getSettings();
  const existing = await chrome.alarms.get(ALARM_DAILY);
  // Keep an existing (possibly missed) alarm on browser start so Chrome can fire it; recreate on force.
  if (existing && !force) return existing.scheduledTime;
  await chrome.alarms.clear(ALARM_DAILY);
  const when = nextRunTime(Number(s.runHour), Number(s.runMinute));
  await chrome.alarms.create(ALARM_DAILY, { when });
  return when;
}
chrome.runtime.onInstalled.addListener(() => scheduleDaily(true));
chrome.runtime.onStartup.addListener(() => { scheduleDaily(false); resumeIfInterrupted(); });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_DAILY) { await scheduleDaily(true); startRun('schedule'); }
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
async function startRun(trigger) {
  const cur = await getRun();
  if (cur && PHASES.includes(cur.phase) && (active || Date.now() - (cur.heartbeat || 0) < 10 * 60000)) return { started: false, reason: 'ALREADY_RUNNING' };
  const s = await getSettings();
  if (!s.ghToken || !s.passphrase) {
    await finishWithStatus({ id: Date.now(), startedAt: new Date().toISOString(), trigger, counts: {}, errors: ['NOT_CONFIGURED'] }, false, s, !!s.ghToken);
    return { started: false, reason: 'NOT_CONFIGURED' };
  }
  const run = { id: Date.now(), trigger, startedAt: new Date().toISOString(), phase: 'clients', pdfCursor: 0, backlogCursor: 0, counts: {}, errors: [], done: {}, log: [] };
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
        await gotoSearch(tabId, s);
        await assertLoggedIn(tabId);
        const r = await exec(tabId, scrapeActiveClientList, [{ origin: s.nsOrigin }], 'ISOLATED');
        if (!r || !r.ok) throw new Error((r && r.error) || 'CLIENT_SCRAPE_FAILED');
        if (r.meta.missingColumns.length) run.errors.push('MISSING_COLUMNS:' + r.meta.missingColumns.join('|'));
        await sset({ res_clients: { headers: r.headers, rows: r.rows }, res_queue: r.queue });
        run.counts.clients = r.rows.length; run.counts.pages = r.meta.pages; run.done.clients = true;
        await log(run, `Client list: ${r.rows.length} clients (${r.meta.pages} page(s)).`);
      }
      run.phase = 'pdf'; await saveRun(run);
    }

    const { res_queue: queue } = await sget('res_queue');

    if (run.phase === 'pdf') {
      if (s.enablePdf) {
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
          if (!r) { run.errors.push(`PDF_FAILED_AT:${run.pdfCursor}`); await log(run, 'PDF scraper failed twice; skipping PDF upload.'); break; }
          const cur = await sget(['res_pdf_items', 'res_pdf_summ']);
          await sset({ res_pdf_items: cur.res_pdf_items.concat(r.itemizedRows), res_pdf_summ: cur.res_pdf_summ.concat(r.doctorSummaries) });
          run.pdfCursor += chunk.length;
          await log(run, `PDF schedules: ${run.pdfCursor}/${queue.length} clients.`);
        }
        if (run.pdfCursor >= queue.length) run.done.pdf = true;
      }
      run.phase = 'backlog'; await saveRun(run);
    }

    if (run.phase === 'backlog') {
      if (s.enableBacklog) {
        while (run.backlogCursor < queue.length) {
          if ((await getRun()).stopRequested) throw new Error('STOPPED');
          const chunk = queue.slice(run.backlogCursor, run.backlogCursor + Number(s.backlogBatch))
            .map((q) => ({ clientId: q.clientId, name: q.name, email: q.email, consultant: q.consultant }));
          const r = await withRetry(async () => {
            await gotoSearch(tabId, s); await assertLoggedIn(tabId); // fresh page = fresh memory (replaces manual refresh)
            const x = await exec(tabId, scrapeBacklogChunk, [chunk, {}], 'MAIN');
            if (!x || !x.ok) throw new Error('BACKLOG_SCRAPE_FAILED');
            return x;
          });
          if (!r) { run.errors.push(`BACKLOG_FAILED_AT:${run.backlogCursor}`); await log(run, 'Backlog scraper failed twice; skipping backlog upload.'); break; }
          const cur = await sget('res_backlog');
          await sset({ res_backlog: cur.res_backlog.concat(r.rows) });
          run.backlogCursor += chunk.length;
          await log(run, `Backlog: ${run.backlogCursor}/${queue.length} clients.`);
        }
        if (run.backlogCursor >= queue.length) run.done.backlog = true;
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
    run.errors.push(code); run.phase = 'failed'; await saveRun(run);
    await finishWithStatus(run, false, s, true);
    notify('MGE scraper failed', code === 'NOT_LOGGED_IN' ? 'NetSuite is logged out. Log in to NetSuite in Chrome and press "Run now".' : `Error: ${code}`);
  } finally {
    try { if (run.createdTab && run.tabId) await chrome.tabs.remove(run.tabId); } catch (e) {}
    active = false; keepAlive(false);
    chrome.alarms.clear(ALARM_WATCHDOG);
  }
}

async function uploadAll(run, s) {
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
  for (const [name, csv, rows] of files) {
    if (prev[name] && rows < prev[name] * s.minRowRatio) { run.errors.push(`SKIPPED_SHRUNK:${name}`); continue; }
    if (rows === 0 && name !== 'doctor_owner_zero_dates_summary.csv') { run.errors.push(`SKIPPED_EMPTY:${name}`); continue; }
    const enc = await MGECrypto.encryptText(csv, s.passphrase, name);
    const body = JSON.stringify(enc);
    await MGEGitHub.putFile(cfg, `${s.encDir}/${name}.enc`, body, `data: nightly encrypted refresh (${name})`);
    run.files[name] = { rows, bytes: body.length, updatedAt: new Date().toISOString() };
    prev[name] = rows;
    await log(run, `Uploaded ${name}.enc (${rows} rows).`);
  }
  await sset({ prevCounts: prev });
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
      const a = await chrome.alarms.get(ALARM_DAILY);
      return { run, lastStatus, nextRun: a ? a.scheduledTime : null, active };
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

if (typeof module !== 'undefined' && module.exports) module.exports = { nextRunTime, toIsoWithOffset, finishWithStatus };
