/* Offline CLI parity tests. Synthetic fixtures only. Never prints the passphrase. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'mge-hub');
const MGECrypto = require(path.join(ROOT, 'js', 'mge-crypto.js'));

const pass = 'throwaway-' + crypto.randomBytes(18).toString('hex');
const wrong = 'wrong-' + crypto.randomBytes(12).toString('hex');
const argvSecret = 'ARGV-SECRET-' + crypto.randomBytes(8).toString('hex');

const CLIENT_HEADERS = 'Client ID,Doctor Name,Customer ID,Company Name,Consultant,Sales Rep,Account Status,Is Individual,Doctor Email,Alt Email,Work Phone,Work Phone Note,Home Phone,Private Phone Note,Cell Phone 1,Cell 1 Name,Cell Phone 2,Cell 2 Name,Cell Phone 3,Cell 3 Name,All Phones (Titled),Default Address,Total User Notes,Latest Note Date,Latest Note Author,Latest Note Title,Latest Note Memo,Client URL,Dashboard URL'.split(',');
const CONTACT_HEADERS = 'Contact Internal ID,Contact Name,Parent Client ID,Position / Post,Primary Email,Alt Email,Main Phone,Office Phone,Home Phone,Cell Phone 1,Cell Phone 2,Cell Phone 3,Fax,Default Address,Global Subscription Status,Course Attendance Count,Course Attendance Items,Event Attendance Count,Event Attendance Items,Online Course Attendance Count,Online Course Attendance Items,Contact Direct URL'.split(',');
const PDF_HEADERS = 'Document Title,Generator Suitelet,Signee Contact ID,Signee Name in File,Contact Full Name,Role / Position,Client Internal ID,Client Customer ID,Consultant,Email,Cell Phone,Office Phone,Location,Services,Month / Dates,Hours / Days,Classroom Record Source,Event Record Source,Requires Client Initials,Requires Witness Initials,Requires Date,Has Valid Date,PDF Schedule URL'.split(',');
const BACKLOG_HEADERS = 'Client ID,Client Name,Email,Consultant,Item Name,Memo,Date Purchased,Amount,Date Started,Date Completed,Completion Status'.split(',');

const GOLDEN_PENDING_CSV = [
  'Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar',
  '"Dr. Test Alpha","Alpha Test Dental","alpha@example.com | pat.alpha@example.com | owner.alpha@example.com","555-0101 | 555-0112 | 555-0111",1,1500,"","All Events"',
  '"Dr. Test Delta","Delta Test Dental","delta@example.com | delta.alt@example.com","555-0104",1,4000,"","All Events"'
].join('\n') + '\n';

const GOLDEN_INCOMPLETE_LINE = '"Dr. Test Beta","Beta ""Test"" Dental","beta@example.com","555-0102",1,2200.5,"Sales Seminar A: 10/12-10/14","All Events"';
const GOLDEN_STATUS = 'Last scrape failed Oct 7, 9:00 AM \u00B7 data from Oct 6, 10:00 AM';

const results = [];
function check(name, cond, detail) {
  const safe = detail && !leaked(detail) ? '  — ' + detail : '';
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${safe}`);
}
function leaked(text) {
  const s = String(text || '');
  return s.includes(pass) || s.includes(wrong) || s.includes(argvSecret);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  rows.forEach((row) => lines.push(headers.map((h) => csvCell(row[h] || '')).join(',')));
  return lines.join('\n') + '\n';
}
function clientRow(fields) {
  return Object.assign({
    'Account Status': 'Active',
    'Is Individual': 'Yes',
    'Sales Rep': 'Rep Example'
  }, fields);
}

function buildTexts() {
  const clients = [
    clientRow({
      'Client ID': '1001', 'Doctor Name': 'Dr. Test Alpha', 'Customer ID': 'C-1001',
      'Company Name': 'Alpha Test Dental', 'Consultant': 'Casey Example',
      'Doctor Email': 'alpha@example.com', 'Work Phone': '555-0101',
      'Client URL': 'https://example.com/clients/1001', 'Dashboard URL': 'https://example.com/dashboards/1001'
    }),
    clientRow({
      'Client ID': '1002', 'Doctor Name': 'Dr. Test Beta', 'Customer ID': 'C-1002',
      'Company Name': 'Beta "Test" Dental', 'Consultant': 'Casey Example',
      'Doctor Email': 'beta@example.com', 'Work Phone': '555-0102',
      'Client URL': 'https://example.com/clients/1002', 'Dashboard URL': 'https://example.com/dashboards/1002'
    }),
    clientRow({
      'Client ID': '1003', 'Doctor Name': 'Dr. Test Gamma', 'Customer ID': 'C-1003',
      'Company Name': 'Gamma Test Clinic', 'Consultant': 'Drew Example',
      'Doctor Email': 'gamma@example.com', 'Work Phone': '555-0103',
      'Client URL': 'https://example.com/clients/1003', 'Dashboard URL': 'https://example.com/dashboards/1003'
    }),
    clientRow({
      'Client ID': '1004', 'Doctor Name': 'Dr. Test Delta', 'Customer ID': 'C-1004',
      'Company Name': 'Delta Test Dental', 'Consultant': 'Drew Example',
      'Doctor Email': 'delta@example.com', 'Alt Email': 'delta.alt@example.com', 'Work Phone': '555-0104',
      'Client URL': 'https://example.com/clients/1004', 'Dashboard URL': 'https://example.com/dashboards/1004'
    })
  ];
  const contacts = [
    {
      'Contact Internal ID': '501', 'Contact Name': 'Pat Example', 'Parent Client ID': '1001',
      'Position / Post': 'Office Manager', 'Primary Email': 'pat.alpha@example.com', 'Cell Phone 1': '555-0112',
      'Contact Direct URL': 'https://example.com/contacts/1001b'
    },
    {
      'Contact Internal ID': '502', 'Contact Name': 'Dr. Test Alpha', 'Parent Client ID': '1001',
      'Position / Post': 'Doctor - Owner', 'Primary Email': 'owner.alpha@example.com', 'Cell Phone 1': '555-0111',
      'Contact Direct URL': 'https://example.com/contacts/1001a'
    }
  ];
  const pdf = (fields) => Object.assign({
    'Document Title': 'SCHEDULING AGREEMENT FORM', 'Location': 'Example Hall', 'Hours / Days': '3 Days'
  }, fields);
  const pdfs = [
    pdf({ 'Client Internal ID': '1001', Services: 'Sales Seminar A', 'Month / Dates': 'NO DATES', 'Has Valid Date': 'NO', 'PDF Schedule URL': 'https://example.com/schedules/1001.pdf' }),
    pdf({ 'Client Internal ID': '1002', Services: 'Sales Seminar A', 'Month / Dates': '10/12-10/14', 'Has Valid Date': 'YES', 'PDF Schedule URL': 'https://example.com/schedules/1002.pdf' }),
    pdf({ 'Client Internal ID': '1003', Services: 'Marketing Seminar', 'Month / Dates': '3/5-3/7', 'Has Valid Date': 'YES', 'PDF Schedule URL': 'https://example.com/schedules/1003.pdf' }),
    pdf({ 'Client Internal ID': '1003', Services: 'Unknown Workshop Extra', 'Month / Dates': '1/2-1/3', 'Has Valid Date': 'YES', 'PDF Schedule URL': 'https://example.com/schedules/1003b.pdf' })
  ];
  const item = (fields) => Object.assign({ 'Date Purchased': '2026-01-15', 'Completion Status': 'UNCOMPLETED' }, fields);
  const backlog = [
    item({ 'Client ID': '1001', 'Client Name': 'Dr. Test Alpha', 'Item Name': 'Scheduling for Production Seminar', Memo: '', Amount: '1500.00' }),
    item({ 'Client ID': '1001', 'Client Name': 'Dr. Test Alpha', 'Item Name': 'Marketing Seminar', Memo: 'EXPIRED 2024', Amount: '800.00' }),
    item({ 'Client ID': '1001', 'Client Name': 'Dr. Test Alpha', 'Item Name': 'Sales Seminar A', Memo: '', Amount: '1200.00' }),
    item({ 'Client ID': '1001', 'Client Name': 'Dr. Test Alpha', 'Item Name': 'Money Left on Account', Memo: '', Amount: '50.00' }),
    item({ 'Client ID': '1002', 'Client Name': 'Dr. Test Beta', 'Item Name': 'Sales Seminar A', Memo: '', Amount: '2500.00' }),
    item({ 'Client ID': '1002', 'Client Name': 'Dr. Test Beta', 'Item Name': 'New Patient Workshop', Memo: '', Amount: '2200.50' }),
    item({ 'Client ID': '1002', 'Client Name': 'Dr. Test Beta', 'Item Name': 'Get Out of Network Blueprint', Memo: '', Amount: '75.00' }),
    item({ 'Client ID': '1003', 'Client Name': 'Dr. Test Gamma', 'Item Name': 'Marketing Seminar', Memo: '', Amount: '900.00', 'Completion Status': 'COMPLETED' }),
    item({ 'Client ID': '1004', 'Client Name': 'Dr. Test Delta', 'Item Name': 'OM Bootcamp', Memo: '', Amount: '4000.00' })
  ];
  return {
    'clients_directory.csv': toCsv(CLIENT_HEADERS, clients),
    'contacts_directory.csv': toCsv(CONTACT_HEADERS, contacts),
    'pdf_directory.csv': toCsv(PDF_HEADERS, pdfs),
    'unscheduled_backlog.csv': toCsv(BACKLOG_HEADERS, backlog)
  };
}

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((name) => {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

function newWindow(html) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.sendTo(console, { omitJSDOMErrors: true });
  const dom = new JSDOM(html, { url: 'https://sambar1106.github.io/mge-triage-hub/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent; },
    set(v) { this.textContent = v == null ? '' : String(v); }
  });
  ['CompressionStream', 'DecompressionStream', 'ReadableStream', 'Response', 'TextEncoder', 'TextDecoder'].forEach((k) => { w[k] = globalThis[k]; });
  return w;
}

async function loadPage(files) {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const w = newWindow(indexHtml);
  w.fetch = async (u) => {
    const f = String(u).split('?')[0].replace(/^\.\//, '');
    const key = f.startsWith('data/enc/') ? f.slice('data/enc/'.length) : null;
    if (key && files[key] != null) return { ok: true, text: async () => files[key] };
    return { ok: false, status: 404, text: async () => '' };
  };
  w.prompt = () => pass;
  w.alert = () => {};
  if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:mock-url';
  const origAppend = w.document.body.appendChild.bind(w.document.body);
  w.document.body.appendChild = function (el) {
    if (el && el.tagName === 'A') el.click = () => {};
    return origAppend(el);
  };
  w.eval(fs.readFileSync(path.join(ROOT, 'js/mge-crypto.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'js/mge-buckets.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8') + '\n;window.__state = state;');
  if (w.document.readyState === 'loading') {
    await new Promise((res) => w.document.addEventListener('DOMContentLoaded', () => setTimeout(res, 0)));
    for (let i = 0; i < 100 && w.__state.clients.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
  } else {
    await w.initApp();
  }
  return w;
}

const BUCKETS = { pending: 'PENDING_SCHEDULE', incomplete: 'SCHEDULE_INCOMPLETE', complete: 'PROGRAM_COMPLETE' };

function applyPage(w, opts) {
  const st = w.__state;
  st.searchQuery = opts.search || '';
  st.courseQuery = opts.course || '';
  st.consultantFilter = opts.consultant || '';
  st.expiredFilter = opts.expired === 'has' ? 'has_expired' : opts.expired === 'no' ? 'no_expired' : 'ALL';
  st.eventFilter = opts.event || 'ALL';
  st.statusFilter = opts.status || 'ALL';
  const el = w.document.getElementById('filter-event');
  el.value = opts.event || 'ALL';
}

function pageIds(w, opts) {
  applyPage(w, opts);
  const st = w.__state;
  const bucket = opts.bucket || 'pending';
  if (bucket === 'all') {
    const order = Array.from(st.clients.keys());
    const matched = new Set();
    Object.keys(BUCKETS).forEach((key) => {
      st.activeBucket = BUCKETS[key];
      w.getFilteredClients().forEach((c) => matched.add(c.clientId));
    });
    return order.filter((id) => matched.has(id));
  }
  st.activeBucket = BUCKETS[bucket];
  return w.getFilteredClients().map((c) => c.clientId);
}

function pageCsv(w, opts) {
  applyPage(w, opts);
  w.__state.activeBucket = BUCKETS[opts.bucket || 'pending'];
  return w.exportCSV().csvContent;
}

async function main() {
  ['errors.js', 'context.js', 'source.js', 'commands.js', 'mge-hub'].forEach((name) => {
    execSync(`node --check "${path.join(ROOT, 'cli', name)}"`, { stdio: 'pipe' });
  });
  check('cli sources parse', true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mge-hub-test-'));
  const srcDir = path.join(dir, 'enc');
  const cacheHome = path.join(dir, 'cache');
  const cacheOff = path.join(dir, 'cache-off');
  const passFile = path.join(dir, 'pass');
  const wrongFile = path.join(dir, 'wrong');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(passFile, pass + '\n', { mode: 0o600 });
  fs.writeFileSync(wrongFile, wrong + '\n', { mode: 0o600 });

  const texts = buildTexts();
  const files = {};
  for (const name of Object.keys(texts)) {
    const enc = await MGECrypto.encryptText(texts[name], pass, name);
    const body = JSON.stringify(enc);
    check('ciphertext has no fixture name ' + name, !body.includes('Dr. Test Alpha') && !body.includes(pass));
    fs.writeFileSync(path.join(srcDir, name + '.enc'), body);
    files[name + '.enc'] = body;
  }
  const lastRun = {
    timestamp: '2026-10-07T10:00:03-04:00',
    status: 'failure',
    error: 'NOT_LOGGED_IN',
    clients: null,
    pending: null,
    contacts: null,
    pdf: null,
    backlog: null,
    files: { 'clients_directory.csv': { rows: 4, updatedAt: '2026-10-06T15:00:00Z' } }
  };
  const lastRunText = JSON.stringify(lastRun);
  fs.writeFileSync(path.join(srcDir, 'last_run.json'), lastRunText);
  files['last_run.json'] = lastRunText;
  const srcNames = fs.readdirSync(srcDir);
  check('fixture dir has no plaintext csv', srcNames.every((n) => n.endsWith('.enc') || n === 'last_run.json'));

  let leaks = 0;
  function run(args, extraEnv) {
    const env = Object.assign({}, process.env);
    delete env.MGE_HUB_PASSPHRASE;
    delete env.MGE_HUB_PASSPHRASE_FILE;
    env.XDG_CACHE_HOME = cacheHome;
    if (extraEnv) Object.assign(env, extraEnv);
    const res = spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', env, timeout: 30000 });
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    if (leaked(stdout) || leaked(stderr)) leaks++;
    return { status: res.status, stdout, stderr };
  }
  const base = ['--source-dir', srcDir, '--passphrase-file', passFile];
  function hub(args, extraEnv) { return run(base.concat(args), extraEnv); }
  function asJson(args) {
    const res = hub(args.concat(['--json']));
    let data = null;
    try { data = JSON.parse(res.stdout); } catch (e) { data = null; }
    return { res, data };
  }

  const help = run(['--help']);
  check('help exits 0', help.status === 0 && /MGE_HUB_PASSPHRASE_FILE/.test(help.stdout));

  const missingPass = run(['--source-dir', srcDir, 'buckets']);
  check('missing passphrase exits 1', missingPass.status === 1 && /passphrase is required/.test(missingPass.stderr));

  const argv1 = run(base.concat(['--passphrase', argvSecret, 'buckets']));
  check('argv passphrase rejected', argv1.status === 1 && /must not be passed as an argument/.test(argv1.stderr));
  const argv2 = run(['--passphrase=' + argvSecret, 'events']);
  check('argv passphrase= rejected', argv2.status === 1 && /must not be passed as an argument/.test(argv2.stderr));

  const bad = hub(['buckets'], { MGE_HUB_PASSPHRASE_FILE: '', MGE_HUB_PASSPHRASE: '' });
  // file flag wins; the empty env overrides are after delete but file is on argv.
  check('passphrase file with one trailing newline unlocks', bad.status === 0);

  const wrongRun = run(['--source-dir', srcDir, '--passphrase-file', wrongFile, 'buckets']);
  check('wrong passphrase exits 2', wrongRun.status === 2 && wrongRun.stderr.trim() === 'could not decrypt: wrong passphrase or tampered file');
  for (const args of [['status'], ['buckets'], ['find', 'x'], ['client', '1001'], ['list'], ['schedule'], ['flags'], ['events']]) {
    const res = run(['--source-dir', srcDir, '--passphrase-file', wrongFile].concat(args));
    check('wrong passphrase on ' + args[0], res.status === 2 && !leaked(res.stdout + res.stderr));
  }

  const envOk = run(['--source-dir', srcDir, 'buckets'], { MGE_HUB_PASSPHRASE: pass + '\n' });
  check('env passphrase with one trailing newline works', envOk.status === 0 && /pending: 2/.test(envOk.stdout));
  const envFile = run(['--source-dir', srcDir, '--passphrase-file', passFile, 'events'], { MGE_HUB_PASSPHRASE: wrong });
  check('passphrase file beats a wrong env value', envFile.status === 0);

  const w = await loadPage(files);
  check('page loaded fixture clients', w.__state.clients.size === 4);
  const alpha = w.__state.clients.get('1001');
  const beta = w.__state.clients.get('1002');
  const gamma = w.__state.clients.get('1003');
  const delta = w.__state.clients.get('1004');
  check('golden alpha bucket', alpha.bucket === 'PENDING_SCHEDULE' && alpha.pendingItemsCount === 1 && alpha.pendingAmount === 1500 && alpha.backlogItems.length === 3);
  check('golden alpha excluded item dropped', !alpha.backlogItems.some((i) => i['Item Name'] === 'Money Left on Account'));
  check('golden alpha expired and scheduled flags',
    alpha.backlogItems.find((i) => i['Item Name'] === 'Marketing Seminar').isExpired === true &&
    alpha.backlogItems.find((i) => i['Item Name'] === 'Sales Seminar A').isScheduled === true &&
    alpha.backlogItems.find((i) => i['Item Name'] === 'Scheduling for Production Seminar').isScheduled === false);
  check('golden beta incomplete', beta.bucket === 'SCHEDULE_INCOMPLETE' && beta.pendingItemsCount === 1 && beta.pendingAmount === 2200.5);
  check('golden beta excluded blueprint dropped', !beta.backlogItems.some((i) => i['Item Name'] === 'Get Out of Network Blueprint'));
  check('golden gamma complete', gamma.bucket === 'PROGRAM_COMPLETE' && gamma.pendingItemsCount === 0 && w.formatScheduledDates(gamma.pdfRecords, 'All Events') === 'Marketing Seminar: 3/5-3/7');
  check('golden delta pending amount', delta.bucket === 'PENDING_SCHEDULE' && delta.pendingAmount === 4000);
  check('golden no-dates alpha schedule', w.formatScheduledDates(alpha.pdfRecords, 'All Events') === '');
  check('golden beta schedule', w.formatScheduledDates(beta.pdfRecords, 'All Events') === 'Sales Seminar A: 10/12-10/14');

  const pagePending = w.document.getElementById('b-count-pending').textContent;
  const pageIncomplete = w.document.getElementById('b-count-incomplete').textContent;
  const pageComplete = w.document.getElementById('b-count-complete').textContent;
  const pageAll = w.document.getElementById('b-count-all').textContent;
  const kpiPending = w.document.getElementById('kpi-pending-val').textContent;
  const kpiIncomplete = w.document.getElementById('kpi-incomplete-val').textContent;
  const kpiView = w.document.getElementById('kpi-clients-count').textContent;
  const kpiComplete = w.document.getElementById('kpi-complete-count').textContent;
  check('golden rendered counts', pagePending === '2' && pageIncomplete === '1' && pageComplete === '1' && pageAll === '4');
  check('golden rendered KPIs', kpiPending === '$5,500' && kpiIncomplete === '$0' && kpiView === '2' && kpiComplete === '1');

  const buckets = asJson(['buckets']);
  check('buckets json matches page elements', buckets.res.status === 0 && buckets.data &&
    buckets.data.counts.pending === pagePending &&
    buckets.data.counts.incomplete === pageIncomplete &&
    buckets.data.counts.complete === pageComplete &&
    buckets.data.counts.total === pageAll &&
    buckets.data.kpis.pending === kpiPending &&
    buckets.data.kpis.incomplete === kpiIncomplete &&
    buckets.data.kpis.clientsInView === kpiView &&
    buckets.data.kpis.complete === kpiComplete);
  const bucketsHuman = hub(['buckets']);
  check('buckets human is short', bucketsHuman.status === 0 && /pending: 2/.test(bucketsHuman.stdout) && /\$5,500/.test(bucketsHuman.stdout) && /\$0/.test(bucketsHuman.stdout));

  const status = asJson(['status']);
  check('status uses Chicago time from loadRunStatus', status.res.status === 0 && status.data &&
    status.data.text === GOLDEN_STATUS &&
    status.data.className === 'data-updated stale' &&
    status.data.title === 'Clients: null, Pending: null' &&
    status.data.run && status.data.run.error === 'NOT_LOGGED_IN' &&
    status.data.dnc === 'not available in CLI' &&
    status.data.triage === 'not available in CLI');

  const combos = [
    { name: 'pending', args: ['list'], opts: {} },
    { name: 'incomplete', args: ['list', '--bucket', 'incomplete'], opts: { bucket: 'incomplete' } },
    { name: 'complete', args: ['list', '--bucket', 'complete'], opts: { bucket: 'complete' } },
    { name: 'all', args: ['list', '--bucket', 'all'], opts: { bucket: 'all' } },
    { name: 'consultant', args: ['list', '--bucket', 'all', '--consultant', 'Casey Example'], opts: { bucket: 'all', consultant: 'Casey Example' } },
    { name: 'expired', args: ['list', '--bucket', 'all', '--expired', 'has'], opts: { bucket: 'all', expired: 'has' } },
    { name: 'course', args: ['list', '--bucket', 'all', '--course', 'workshop'], opts: { bucket: 'all', course: 'workshop' } },
    { name: 'phone', args: ['list', '--bucket', 'all', '--search', '555-0103'], opts: { bucket: 'all', search: '555-0103' } },
    { name: 'event scheduled', args: ['list', '--bucket', 'all', '--event', 'Sales Seminar A', '--status', 'scheduled'], opts: { bucket: 'all', event: 'Sales Seminar A', status: 'scheduled' } },
    { name: 'event case', args: ['list', '--bucket', 'pending', '--event', 'sales seminar a', '--status', 'scheduled'], opts: { bucket: 'pending', event: 'Sales Seminar A', status: 'scheduled' } },
    { name: 'workshop pending', args: ['list', '--bucket', 'incomplete', '--event', 'New Patient Workshop', '--status', 'pending'], opts: { bucket: 'incomplete', event: 'New Patient Workshop', status: 'pending' } }
  ];
  combos.forEach((combo) => {
    const got = asJson(combo.args);
    const expect = pageIds(w, combo.opts);
    const ids = got.data && got.data.rows ? got.data.rows.map((r) => r.clientId) : null;
    check('list ids ' + combo.name, got.res.status === 0 && JSON.stringify(ids) === JSON.stringify(expect), JSON.stringify(ids) + ' vs ' + JSON.stringify(expect));
  });
  check('golden list ids', JSON.stringify(pageIds(w, {})) === JSON.stringify(['1001', '1004']));
  check('golden all ids', JSON.stringify(pageIds(w, { bucket: 'all' })) === JSON.stringify(['1001', '1002', '1003', '1004']));
  check('golden expired id', JSON.stringify(pageIds(w, { bucket: 'all', expired: 'has' })) === JSON.stringify(['1001']));

  const csvPending = hub(['list', '--csv']);
  check('list --csv matches page export', csvPending.status === 0 && csvPending.stdout === pageCsv(w, {}));
  check('list --csv matches handwritten golden', csvPending.stdout === GOLDEN_PENDING_CSV);
  const csvIncomplete = hub(['list', '--bucket', 'incomplete', '--csv']);
  check('incomplete csv matches page', csvIncomplete.status === 0 && csvIncomplete.stdout === pageCsv(w, { bucket: 'incomplete' }));
  check('incomplete csv contains handwritten row', csvIncomplete.stdout.includes(GOLDEN_INCOMPLETE_LINE));
  const csvEvent = hub(['list', '--bucket', 'incomplete', '--event', 'Sales Seminar A', '--csv']);
  check('event csv matches page', csvEvent.status === 0 && csvEvent.stdout === pageCsv(w, { bucket: 'incomplete', event: 'Sales Seminar A' }));
  const csvAll = hub(['list', '--bucket', 'all', '--csv']);
  const lineById = {};
  ['pending', 'incomplete', 'complete'].forEach((bucket) => {
    const lines = pageCsv(w, { bucket }).replace(/\n$/, '').split('\n').slice(1);
    pageIds(w, { bucket }).forEach((id, i) => { lineById[id] = lines[i]; });
  });
  const allLines = csvAll.stdout.replace(/\n$/, '').split('\n');
  const expectLines = ['1001', '1002', '1003', '1004'].map((id) => lineById[id]);
  check('all-bucket csv rows are the page export lines in client order', csvAll.status === 0 &&
    allLines[0] === 'Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar' &&
    JSON.stringify(allLines.slice(1)) === JSON.stringify(expectLines));

  const limited = hub(['list', '--limit', '1']);
  check('human list limit', limited.status === 0 && /1001/.test(limited.stdout) && /1 more/.test(limited.stdout) && !/1004/.test(limited.stdout));

  const found = asJson(['find', 'Alpha']);
  check('find alpha', found.res.status === 0 && found.data.count === 1 && found.data.hits[0].clientId === '1001' &&
    found.data.hits[0].pendingCount === 1 && found.data.hits[0].pendingAmount === 1500 &&
    found.data.hits[0].expiredCount === 1 && found.data.hits[0].scheduledDates === '' &&
    found.data.hits[0].bucket === 'PENDING_SCHEDULE');
  const foundPhone = asJson(['find', '555-0102']);
  check('find phone across buckets', foundPhone.data && foundPhone.data.count === 1 && foundPhone.data.hits[0].clientId === '1002');
  const foundAll = asJson(['find', 'Test']);
  check('find Test json is complete', foundAll.data && foundAll.data.count === 4);
  const foundHuman = hub(['find', 'Test', '--limit', '1']);
  check('find human limit', /3 more/.test(foundHuman.stdout) && !/Dr\. Test Delta/.test(foundHuman.stdout));
  const foundList = asJson(['list', '--search', 'beta']);
  check('list search stays in the pending bucket', foundList.data && foundList.data.count === 0);

  const client = asJson(['client', '1001']);
  const c = client.data;
  check('client detail golden', client.res.status === 0 && c && c.clientId === '1001' && c.bucket === 'PENDING_SCHEDULE' &&
    c.pendingAmount === 1500 && c.expiredCount === 1 && c.pdfStatus === 'No Dates' &&
    c.scheduledDates === '' && c.pdfScheduleUrl === 'https://example.com/schedules/1001.pdf' &&
    c.clientUrl === 'https://example.com/clients/1001' && c.dashboardUrl === 'https://example.com/dashboards/1001' &&
    c.contacts.length === 2 && c.contacts[0].owner === true && c.contacts[0].name === 'Dr. Test Alpha' &&
    c.contacts[1].name === 'Pat Example' && c.contacts[1].owner === false &&
    c.backlog.length === 3 && c.backlog[1].isExpired === true && c.backlog[2].isScheduled === true &&
    c.dnc === 'not available in CLI' && c.triage === 'not available in CLI');
  const missingClient = hub(['client', '9999']);
  check('missing client exits 1', missingClient.status === 1 && /no such client/.test(missingClient.stderr));

  const sched = asJson(['schedule']);
  const pageDates = Array.from(w.__state.clients.values()).map((clientRow) => ({
    clientId: clientRow.clientId,
    dates: w.formatScheduledDates(clientRow.pdfRecords, 'All Events')
  })).filter((r) => r.dates);
  check('schedule matches formatScheduledDates', sched.data && JSON.stringify(sched.data.rows.map((r) => ({ clientId: r.clientId, dates: r.dates }))) === JSON.stringify(pageDates));
  check('schedule golden dates', sched.data && sched.data.rows.length === 2 && sched.data.rows[0].dates === 'Sales Seminar A: 10/12-10/14' && sched.data.rows[1].dates === 'Marketing Seminar: 3/5-3/7');
  const schedEvent = asJson(['schedule', '--event', 'Marketing Seminar']);
  check('schedule event date is unlabeled', schedEvent.data && schedEvent.data.count === 1 && schedEvent.data.rows[0].clientId === '1003' && schedEvent.data.rows[0].dates === '3/5-3/7');
  check('page agrees on marketing date', w.formatScheduledDates(gamma.pdfRecords, 'Marketing Seminar') === '3/5-3/7');

  const flags = asJson(['flags']);
  check('flags golden', flags.data &&
    flags.data.expired.map((r) => r.clientId).join() === '1001' &&
    flags.data.pendingSchedule.map((r) => r.clientId).join() === '1004,1001' &&
    flags.data.pendingSchedule[0].pendingAmount === 4000 &&
    flags.data.scheduleIncomplete.length === 1 &&
    flags.data.scheduleIncomplete[0].pendingItems.length === 1 &&
    flags.data.scheduleIncomplete[0].pendingItems[0].itemName === 'New Patient Workshop');

  const eventJson = asJson(['events']);
  const pageEvents = Object.keys(w.EVENT_MAPPINGS);
  check('events match page names', eventJson.data && JSON.stringify(eventJson.data.events) === JSON.stringify(pageEvents) && pageEvents.length === 16);
  const eventHuman = hub(['events']);
  check('events human is limited', /6 more/.test(eventHuman.stdout) && eventHuman.stdout.split('\n').filter(Boolean).length === 11);

  const unknown = hub(['list', '--event', 'Not A Real Seminar XYZ']);
  check('unknown event errors', unknown.status === 1 && /unknown event/.test(unknown.stderr) && /close matches:/.test(unknown.stderr));
  const typo = hub(['list', '--event', 'Sales Seminer A']);
  check('unknown event suggests a close name', typo.status === 1 && /Sales Seminar A/.test(typo.stderr));

  const week = hub(['schedule', '--week']);
  check('week view is refused', week.status === 1 && /not available/.test(week.stderr) && week.stdout === '');

  const off = run(['--no-cache', '--source-dir', srcDir, '--passphrase-file', passFile, 'buckets'], { XDG_CACHE_HOME: cacheOff });
  check('no-cache still answers', off.status === 0);
  check('no-cache writes nothing', !fs.existsSync(path.join(cacheOff, 'mge-hub')));

  const cacheRoot = path.join(cacheHome, 'mge-hub');
  const cacheFiles = walk(cacheRoot);
  check('cache dir is private', fs.existsSync(cacheRoot) && (fs.statSync(cacheRoot).mode & 0o777) === 0o700);
  check('cache keeps only encrypted files', cacheFiles.length > 0 && cacheFiles.every((p) => {
    const st = fs.statSync(p);
    const body = fs.readFileSync(p, 'utf8');
    return p.endsWith('.csv.enc') && (st.mode & 0o777) === 0o600 && !body.includes('Dr. Test Alpha') && !leaked(body) && /"ct"/.test(body);
  }));

  check('passphrase never appears in command output', leaks === 0);
  const dirty = execSync('git status --porcelain -- data extension scrapers Scrapers_fixtures .github .ed ANTIGRAVITY_ALERT.md js/app.js js/mge-crypto.js js/mge-buckets.js index.html', { cwd: ROOT }).toString().trim();
  check('page and read-only paths untouched', dirty === '');
  const csvAdded = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT }).toString().split('\n').filter((line) => /\.csv($|")/.test(line) && !/\.csv\.enc/.test(line));
  check('no plaintext csv added to the repo', csvAdded.length === 0);

  w.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  const msg = String(err && err.stack || err);
  console.error(leaked(msg) ? 'cli-hub test failed (details hidden)' : msg);
  process.exit(1);
});
