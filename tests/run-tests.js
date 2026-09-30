/* MGE verification harness. Prints only counts / pass-fail — never client values. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const FIX = path.join(ROOT, 'scrapers', 'fixtures');
const rd = (p) => fs.readFileSync(p, 'utf8');
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail || '' }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }
function skip(name, why) { results.push({ name, ok: true, skipped: true }); console.log(`SKIP  ${name}  — ${why}`); }
const findFixture = (...names) => names.map((n) => path.join(FIX, n)).find((p) => fs.existsSync(p));

const MGECsv = require(path.join(EXT, 'lib/csv.js'));
const MGECrypto = require(path.join(EXT, 'lib/crypto.js'));

// The web app's own parser, extracted verbatim from js/app.js.
const appSrc = rd(path.join(ROOT, 'js/app.js'));
const parseSrc = appSrc.slice(appSrc.indexOf('function parseCSV'), appSrc.indexOf('// === DATA CLEANING'));
const parseCSV = new Function(parseSrc + '\nreturn parseCSV;')();
const physicalRows = (t) => t.split(/\r?\n/).filter((l) => l.trim().length).length - 1;

const LABELS = /^(Company Name|Work Phone|Email( \d)?|Phone|Name|Customer ID|Home Phone|Cell Phone( \d)?|Address|Status|Consultant|Position\/Post)$/i;
const PHONE = /^(\+?1[\s.-]?)?(\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}/;

function newWindow(html, url, extra) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.sendTo(console, { omitJSDOMErrors: true });
  const dom = new JSDOM(html, Object.assign({ url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole }, extra || {}));
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true });
  // jsdom has no innerText; the app writes counts with innerText.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; }, set(v) { this.textContent = v; } });
  for (const k of ['CompressionStream', 'DecompressionStream', 'ReadableStream', 'Response', 'TextEncoder', 'TextDecoder']) w[k] = globalThis[k];
  return { dom, w };
}

async function main() {
  // ---------------- 1. Manifest / source lint ----------------
  const manifest = JSON.parse(rd(path.join(EXT, 'manifest.json')));
  check('manifest: MV3', manifest.manifest_version === 3);
  check('manifest: alarms+storage+scripting perms', ['alarms', 'storage', 'scripting'].every((p) => manifest.permissions.includes(p)));
  check('manifest: NetSuite + GitHub host permissions', ['https://*.netsuite.com/*', 'https://*.app.netsuite.com/*', 'https://api.github.com/*'].every((h) => manifest.host_permissions.includes(h)));
  const refs = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  const bg = rd(path.join(EXT, 'background.js'));
  (bg.match(/importScripts\(([^)]*)\)/)[1].match(/'([^']+)'/g) || []).forEach((s) => refs.push(s.replace(/'/g, '')));
  ['popup.html', 'options.html'].forEach((h) => (rd(path.join(EXT, h)).match(/(?:src|href)="([^"]+)"/g) || []).forEach((m) => refs.push(m.split('"')[1])));
  const missing = refs.filter((r) => !fs.existsSync(path.join(EXT, r)));
  check('manifest: all referenced files exist', missing.length === 0, `${refs.length} refs, ${missing.length} missing`);
  const jsFiles = execSync(`find "${EXT}" "${ROOT}/js" -name '*.js'`).toString().trim().split('\n');
  let syntaxErr = 0; jsFiles.forEach((f) => { try { execSync(`node --check "${f}"`, { stdio: 'pipe' }); } catch (e) { syntaxErr++; } });
  check('all extension/app JS parses (node --check)', syntaxErr === 0, `${jsFiles.length} files`);
  const tracked = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean);
  const secretHits = tracked.filter((f) => !/\.(png|enc)$/.test(f) && fs.existsSync(path.join(ROOT, f)) && /(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,})/.test(rd(path.join(ROOT, f))));
  check('no GitHub tokens in tracked files', secretHits.length === 0);
  check('crypto lib identical in extension and app', rd(path.join(EXT, 'lib/crypto.js')) === rd(path.join(ROOT, 'js/mge-crypto.js')));
  check('buckets lib identical in extension and app', rd(path.join(EXT, 'lib/buckets.js')) === rd(path.join(ROOT, 'js/mge-buckets.js')));
  const trackedPlain = tracked.filter((f) => /^data\/[^/]+\.csv$/.test(f) || /fixtures\/.*\.html?$/i.test(f));
  check('no plaintext data CSV / saved NetSuite HTML tracked', trackedPlain.length === 0, `${trackedPlain.length} tracked`);

  // ---------------- 2. Client scraper on the saved Active Client List page ----------------
  const scraperSrc = rd(path.join(EXT, 'scrapers/clientList.js'));
  const acl = findFixture('active-client-list.html', 'Active Client List.html');
  let clientOut = null;
  if (!acl) skip('client scraper vs saved Active Client List page', 'fixture not present in scrapers/fixtures/ (it is gitignored)');
  else {
    const html = rd(acl);
    const { w } = newWindow(html, 'https://3940793.app.netsuite.com/app/common/search/searchresults.nl?searchid=72');
    let fetchCalls = 0; w.fetch = async () => { fetchCalls++; return { ok: false }; };
    w.eval(scraperSrc);
    const out = await w.scrapeActiveClientList({});
    clientOut = out;
    // independent expectation: distinct custjob ids among result rows
    const expectIds = new Set(Array.from(w.document.querySelectorAll("#div__body tr.uir-list-row-tr, #div__body tr[id^='row']"))
      .map((r) => { const a = r.querySelector("a[href*='custjob.nl']"); const m = a && a.getAttribute('href').match(/[?&]id=(\d+)/); return m && m[1]; }).filter(Boolean));
    check('fixture: scraper ok', out.ok, `pages=${out.meta && out.meta.pages}, missingColumns=${out.meta && out.meta.missingColumns.length}`);
    check('fixture: headers exactly as specified', JSON.stringify(out.headers) === JSON.stringify(MGECsv.CLIENT_HEADERS), out.headers.join(' | '));
    check('fixture: row count == distinct client ids on page', out.rows.length === expectIds.size, `${out.rows.length} rows / ${expectIds.size} ids`);
    check('fixture: every row has cell count == header count', out.rows.every((r) => r.length === out.headers.length));
    const col = (h) => out.rows.map((r) => r[out.headers.indexOf(h)]);
    const ids = col('Client ID');
    check('fixture: Client ID numeric & unique', ids.every((x) => /^\d+$/.test(x)) && new Set(ids).size === ids.length);
    const emails = col('Doctor Email'); const nE = emails.filter(Boolean).length;
    check('fixture: Doctor Email is an email or blank', emails.every((e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), `${nE} filled / ${emails.length}`);
    const phones = col('Work Phone'); const nP = phones.filter(Boolean).length;
    const phoneOk = phones.filter((p) => !p || PHONE.test(p)).length;
    check('fixture: Work Phone looks like a phone (or blank)', phoneOk / phones.length > 0.97, `${nP} filled, ${phoneOk}/${phones.length} phone-shaped or blank`);
    const cons = col('Consultant');
    const hdrIdx = Array.from(w.document.querySelector('tr.uir-list-headerrow').querySelectorAll('td')).findIndex((td) => td.textContent.trim() === 'Consultant');
    const rawFilled = Array.from(w.document.querySelectorAll("#div__body tr.uir-list-row-tr, #div__body tr[id^='row']")).filter((r) => (r.querySelectorAll('td')[hdrIdx].textContent || '').trim()).length;
    check('fixture: Consultant == page "Consultant" column (not country/phone)', cons.filter(Boolean).length === rawFilled && !cons.some((c) => /^(United States|Canada)$/.test(c) || PHONE.test(c)), `${cons.filter(Boolean).length} filled (page column has ${rawFilled} non-blank), ${new Set(cons.filter(Boolean)).size} distinct`);
    const status = new Set(col('Account Status'));
    check('fixture: Account Status clean enum (no "Status " prefix)', ![...status].some((s) => /^Status /.test(s)), `${status.size} distinct value(s)`);
    check('fixture: Doctor Name filled', col('Doctor Name').every(Boolean));
    check('fixture: URLs well-formed', col('Client URL').every((u, i) => u === `https://3940793.app.netsuite.com/app/common/entity/custjob.nl?id=${ids[i]}`) &&
      col('Dashboard URL').every((u, i) => u === `https://3940793.app.netsuite.com/app/center/card.nl?sc=-69&entityid=${ids[i]}`));
    const allCells = out.rows.flat();
    check('fixture: no newlines / label placeholders in any field', !allCells.some((c) => /[\r\n]/.test(c) || LABELS.test(c) || /^Work Phone /.test(c)));
    check('fixture: queue built for PDF/backlog scrapers', out.queue.length === out.rows.length && out.queue.every((q) => q.clientId && q.name && q.consultant));
    check('fixture: no pagination requests on single-page fixture', fetchCalls === 0, `${fetchCalls} fetches`);
    // Compare with the previous clients_directory.csv if it exists locally (counts only).
    const prevPath = path.join(ROOT, 'data/clients_directory.csv');
    if (fs.existsSync(prevPath)) {
      const prev = parseCSV(rd(prevPath));
      const byId = new Map(prev.map((r) => [r['Client ID'], r]));
      const overlap = ids.filter((id) => byId.has(id)).length;
      let emailSame = 0, emailBoth = 0;
      out.rows.forEach((r) => { const p = byId.get(r[0]); if (!p) return; const pe = (p['Doctor Email'] || '').replace(/^Email\s*/, '').trim().toLowerCase(); if (pe && r[4]) { emailBoth++; if (pe === r[4].toLowerCase()) emailSame++; } });
      check('fixture vs old clients_directory.csv: ID overlap', overlap / ids.length > 0.95, `${overlap}/${ids.length} ids also in old file (old file has ${prev.length})`);
      check('fixture vs old clients_directory.csv: email agreement', emailBoth && emailSame / emailBoth > 0.95, `${emailSame}/${emailBoth} match`);
    }
  }

  // ---------------- 3. Synthetic page: shifted columns, placeholders, quoting, pagination ----------------
  {
    const hdr = ['Edit | View', 'Status', 'Consultant', 'Email', 'Phone', 'First Name', 'Last Name', 'Billing City', 'Billing Country'];
    const row = (id, cells, extraLead) => `<tr class="uir-list-row-tr">${extraLead ? '<td>x</td>' : ''}<td><a href="/app/common/entity/custjob.nl?id=${id}&e=T">Edit</a></td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    const page = (rows, seg) => `<html><body>${seg || ''}<table id="div__body"><tr class="uir-list-headerrow">${hdr.map((h) => `<td>${h}</td>`).join('')}</tr>${rows}</table></body></html>`;
    const segSel = '<select name="segment"><option value="1" selected>1-3</option><option value="4">4-5</option></select>';
    const p1 = page(
      row(101, ['CLIENT: Active', 'Alpha Consultant', '<a href="mailto:a@example.com">a@example.com</a>', '555-111-2222', 'Ann', 'Able', 'Town', 'United States']) +
      row(102, ['CLIENT: Active', 'Beta, "B"', 'Email', 'Work Phone', 'Bob', 'Baker\nJr', 'City, X', 'Canada'], true) + // extra leading td (off-by-one), placeholders, newline, quote, comma
      row(103, ['CLIENT: Active', '', '', '', 'Cy', 'Cole', '', '']), segSel);
    const p2 = page(row(104, ['CLIENT: Active', 'Delta', 'd@example.com', '(555) 333-4444', 'Di', 'Dunn', '', '']) +
      row(101, ['CLIENT: Active', 'Alpha Consultant', 'a@example.com', '555-111-2222', 'Ann', 'Able', '', '']), segSel);
    const { w } = newWindow(p1, 'https://1234.app.netsuite.com/app/common/search/searchresults.nl?searchid=72');
    const fetched = [];
    w.fetch = async (u) => { fetched.push(u); return { ok: true, text: async () => p2 }; };
    w.eval(scraperSrc);
    const out = await w.scrapeActiveClientList({});
    const get = (id, h) => out.rows.find((r) => r[0] === String(id))[out.headers.indexOf(h)];
    check('synthetic: pagination followed + de-duplicated', out.meta.pages === 2 && out.rows.length === 4 && fetched.length === 1 && /segment=4/.test(fetched[0]), `pages=${out.meta.pages} rows=${out.rows.length}`);
    check('synthetic: columns found by header text (reordered header)', get(101, 'Consultant') === 'Alpha Consultant' && get(101, 'Doctor Email') === 'a@example.com' && get(101, 'Work Phone') === '555-111-2222' && get(101, 'Doctor Name') === 'Ann Able');
    check('synthetic: off-by-one row (extra leading cell) realigned', get(102, 'Consultant') === 'Beta, "B"' && get(102, 'Account Status') === 'CLIENT: Active');
    check('synthetic: label placeholders blanked', get(102, 'Doctor Email') === '' && get(102, 'Work Phone') === '');
    check('synthetic: newline in a cell collapsed', get(102, 'Doctor Name') === 'Bob Baker Jr');
    const csv = MGECsv.clientsCsv(out.rows);
    const parsed = parseCSV(csv.replace(/^\uFEFF/, ''));
    check('synthetic: CSV quoting survives the app parser', parsed.length === 4 && parsed.find((r) => r['Client ID'] === '102')['Consultant'] === 'Beta, "B"');
    check('synthetic: missing consultant -> queue "Unassigned"', out.queue.find((q) => q.clientId === '103').consultant === 'Unassigned');
  }

  // ---------------- 4. CSV builders (all four outputs) -> app parser ----------------
  {
    const tricky = 'a, "b"\nc';
    const pdfItem = { documentTitle: 'SCHEDULING AGREEMENT FORM', contactId: 1, clientInternalId: 2, services: tricky, monthDates: '3/5-3/7', hasValidDate: 'YES' };
    const back = { clientId: 5, clientName: tricky, itemName: 'Sales Seminar A', memo: 'x', amount: '1,234.00', completionStatus: 'UNCOMPLETED' };
    const sums = [{ clientInternalId: 2, scheduleStatus: 'HAS SCHEDULED DATES' }, { clientInternalId: 3, scheduleStatus: 'ZERO DATES (Empty Agreement Form)' }];
    const outs = { pdf: MGECsv.pdfCsv([pdfItem, pdfItem]), backlog: MGECsv.backlogCsv([back, back, back]), zero: MGECsv.zeroDatesCsv(sums) };
    const p = (t) => parseCSV(t.replace(/^\uFEFF/, ''));
    check('csv: pdf_directory headers == original scraper headers', rd(path.join(ROOT, 'Scrapers_fixtures/Contact PDF scraper x2.js')).includes(MGECsv.PDF_HEADERS.map((h) => `"${h}"`).slice(0, 8).join(', ')));
    check('csv: pdf rows load in app parser', p(outs.pdf).length === 2 && p(outs.pdf)[0]['Services'] === 'a, "b" c');
    check('csv: backlog rows load in app parser', p(outs.backlog).length === 3 && p(outs.backlog)[0]['Amount'] === '1,234.00');
    check('csv: zero-dates summary filters HAS SCHEDULED DATES', p(outs.zero).length === 1);
    check('csv: ends with newline (no glued rows when concatenated)', /\r\n$/.test(outs.backlog));
  }

  // ---------------- 5. Crypto round trip ----------------
  const pass = 'test passphrase ' + Math.random();
  {
    const sample = clientOut ? MGECsv.clientsCsv(clientOut.rows) : MGECsv.clientsCsv([['1', 'A B', 'C', 'S', 'e@x.co', '555-111-2222', '', 'u', 'v']]);
    const e1 = await MGECrypto.encryptText(sample, pass, 'clients_directory.csv');
    const e2 = await MGECrypto.encryptText(sample, pass, 'clients_directory.csv');
    const back = await MGECrypto.decryptToText(JSON.stringify(e1), pass);
    check('crypto: encrypt -> decrypt round trip identical (BOM stripped)', back === sample.replace(/^\uFEFF/, ''), `${sample.length} chars -> ${JSON.stringify(e1).length} bytes JSON (gzip=${e1.z})`);
    check('crypto: fresh salt + IV per file', e1.salt !== e2.salt && e1.iv !== e2.iv && e1.ct !== e2.ct);
    check('crypto: AES-GCM-256 / PBKDF2-SHA256 metadata', e1.alg === 'AES-GCM-256' && e1.kdf === 'PBKDF2-SHA256' && e1.iter >= 200000);
    let wrong = false; try { await MGECrypto.decryptToText(e1, 'nope'); } catch (e) { wrong = e.message === 'BAD_PASSPHRASE'; }
    check('crypto: wrong passphrase rejected', wrong);
    const t = Object.assign({}, e1, { name: 'pdf_directory.csv' }); let swapped = false; try { await MGECrypto.decryptToText(t, pass); } catch (e) { swapped = true; }
    check('crypto: renamed/swapped file rejected (AAD)', swapped);
    const cipherHasPlain = clientOut && clientOut.rows.slice(0, 20).some((r) => JSON.stringify(e1).includes(r[1]));
    check('crypto: ciphertext contains no plaintext names', !cipherHasPlain);
    const rows = parseCSV(back);
    check('crypto: decrypted CSV -> app parser loads every row', rows.length === physicalRows(back), `${rows.length} rows`);
  }

  // ---------------- 6. Backlog scraper port vs saved Dashboard page ----------------
  const dash = findFixture('dashboard.html', 'Dash board .html');
  if (!dash) skip('backlog scraper vs saved Dashboard page', 'fixture not present');
  else {
    const dashHtml = rd(dash);
    // independent expectation from the fixture table
    const dd = new JSDOM(dashHtml).window.document;
    const expected = Array.from(dd.getElementById('neg1061__tab').querySelectorAll('tr')).slice(1).filter((tr) => {
      const c = tr.querySelectorAll('td'); if (c.length <= 6) return false;
      const t = (i) => (c[i].textContent || '').replace(/\s+/g, ' ').trim();
      const amt = parseFloat(t(4).replace(/[^0-9.-]+/g, '') || '0');
      return t(1) && t(1).toLowerCase() !== 'item' && !t(6) && amt > 0;
    }).length;
    class Loader extends ResourceLoader { fetch(url) { return Promise.resolve(Buffer.from(/card\.nl/.test(url) ? dashHtml : '')); } }
    const { w } = newWindow('<html><body></body></html>', 'https://3940793.app.netsuite.com/app/common/search/searchresults.nl?searchid=72', { resources: new Loader() });
    patchIframes(w);
    w.eval(rd(path.join(EXT, 'scrapers/backlog.js')));
    const clients = [{ clientId: '1', name: 'Test One', email: 't1@example.com', consultant: 'C1' }, { clientId: '2', name: 'Test Two', email: 't2@example.com', consultant: 'C2' }];
    const t0 = Date.now();
    const out = await w.scrapeBacklogChunk(clients, {});
    const ok = out.rows.length === expected * 2;
    check('backlog port: rows extracted == independent count x clients', ok, `${out.rows.length} rows (expected ${expected} x 2), ${Date.now() - t0} ms`);
    check('backlog port: Email/Consultant come from queue (no phone/country shift)', out.rows.every((r) => r.email.includes('@') && /^C\d$/.test(r.consultant)));
    check('backlog port: formats (D-Mon-YYYY dates, numeric amount, UNCOMPLETED)', out.rows.every((r) => /^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/.test(r.datePurchased) && /^[\d,]+\.\d{2}$/.test(r.amount) && r.completionStatus === 'UNCOMPLETED'));
    const csv = MGECsv.backlogCsv(out.rows);
    check('backlog port: CSV loads fully in app parser', parseCSV(csv.replace(/^\uFEFF/, '')).length === out.rows.length);
    w.close();
  }

  // ---------------- 7. PDF scraper port smoke test (synthetic NetSuite API + synthetic PDF) ----------------
  {
    const { w } = newWindow('<html><body></body></html>', 'https://1234.app.netsuite.com/app/common/search/searchresults.nl?searchid=72',
      { resources: new (class extends ResourceLoader { fetch() { return Promise.resolve(Buffer.from('<html><body></body></html>')); } })() });
    const fakeSearch = { Type: { CONTACT: 'contact' }, create: () => ({ run: () => ({ each: (cb) => { cb({ id: '9001', getText: () => 'Doctor - Owner', getValue: (k) => (k === 'entityid' ? 'Test Doctor' : 'Doctor - Owner') }); cb({ id: '9002', getText: () => 'Office Manager', getValue: () => 'x' }); } }) }) };
    patchIframes(w, (cw) => { cw.require = (mods, cb) => cb(fakeSearch); });
    const ops = ['I,', 'Test Doctor', 'agree to the following', 'Location', 'Services', 'Month / Dates', 'Hours / Days',
      'Florida', 'Sales Seminar A', '3/5-3/7', '3 days', 'Digital', 'Marketing Seminar', 'TBD', '1 days', 'Signature', 'Client Initials', 'Witness Initials', 'Date']
      .map((t) => `(${t}) Tj`).join('\n');
    const deflated = zlib.deflateSync(Buffer.from(`BT\n${ops}\nET`));
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%' + 'x'.repeat(600) + '\n1 0 obj\n<</Length ' + deflated.length + ' /Filter /FlateDecode>>\nstream\n'), deflated, Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
    const contactHtml = '<html><body><span id="entityid_val">Test Doctor</span><span id="custentity5_val">Test Client</span><span id="email_val">doc@example.com</span><span id="mobilephone_val">555-000-1111</span></body></html>';
    w.fetch = async (u) => (/contact\.nl/.test(u) ? new Response(contactHtml) : /scriptlet\.nl/.test(u) ? new Response(pdf) : new Response('', { status: 404 }));
    w.Blob = globalThis.Blob;
    w.eval(rd(path.join(EXT, 'scrapers/pdfSchedule.js')));
    const out = await w.scrapePdfSchedulesChunk([{ clientInternalId: '77', lastName: 'Doctor', firstName: 'Test', doctorSearchName: 'Test Doctor', consultant: 'C1' }], {});
    check('pdf port: runs end-to-end with portal + contact + PDF parsing', out.ok && out.processed === 1, `ok=${out.ok} processed=${out.processed}`);
    check('pdf port: only Doctor-Owner contacts, 2 schedule rows parsed', out.doctorSummaries.length === 1 && out.itemizedRows.length === 2);
    const r = out.itemizedRows;
    check('pdf port: row fields (location/services/dates/hasValidDate)', r[0] && r[0].location === 'Florida' && r[0].services === 'Sales Seminar A' && r[0].monthDates === '3/5-3/7' && r[0].hasValidDate === 'YES' && r[1].hasValidDate === 'NO');
    check('pdf port: signee from PDF, contact email, suitelet URL', r[0] && r[0].signeeName === 'Test Doctor' && r[0].email === 'doc@example.com' && /contactId=9001$/.test(r[0].pdfUrl));
    const csv = parseCSV(MGECsv.pdfCsv(out.itemizedRows).replace(/^\uFEFF/, ''));
    check('pdf port: CSV loads in app parser with original headers', csv.length === 2 && csv[0]['Client Internal ID'] === '77' && csv[0]['Month / Dates'] === '3/5-3/7');
    w.close();
  }

  // ---------------- 8. App end-to-end: encrypted files -> passphrase prompt -> decrypt -> parser -> buckets ----------------
  {
    const names = ['clients_directory.csv', 'contacts_directory.csv', 'pdf_directory.csv', 'unscheduled_backlog.csv'];
    const encDir = path.join(ROOT, 'data/enc');
    const passFile = process.env.MGE_PASSPHRASE_FILE;
    let files = {}, appPass = pass, source;
    if (passFile && fs.existsSync(passFile) && names.every((n) => fs.existsSync(path.join(encDir, n + '.enc')))) {
      appPass = rd(passFile).trim(); source = 'committed data/enc/*.enc';
      names.forEach((n) => { files[n + '.enc'] = rd(path.join(encDir, n + '.enc')); });
      if (fs.existsSync(path.join(encDir, 'last_run.json'))) files['last_run.json'] = rd(path.join(encDir, 'last_run.json'));
    } else {
      source = 'freshly encrypted test data';
      const plain = {};
      names.forEach((n) => { const p = path.join(ROOT, 'data', n); if (fs.existsSync(p)) plain[n] = rd(p); });
      if (!plain['clients_directory.csv']) plain['clients_directory.csv'] = clientOut ? MGECsv.clientsCsv(clientOut.rows) : MGECsv.clientsCsv([['1', 'A B', 'C', 'S', 'e@x.co', '', '', '', '']]);
      if (!plain['contacts_directory.csv']) plain['contacts_directory.csv'] = '"Contact Internal ID","Parent Client ID","Contact Name","Primary Email","Cell Phone 1","Position / Post"\r\n';
      if (!plain['pdf_directory.csv']) plain['pdf_directory.csv'] = MGECsv.pdfCsv([{ documentTitle: 'SCHEDULING AGREEMENT', contactId: '1', clientInternalId: '1', services: 'Sales Seminar A', monthDates: '3/5-3/7', hasValidDate: 'YES' }]);
      if (!plain['unscheduled_backlog.csv']) plain['unscheduled_backlog.csv'] = MGECsv.backlogCsv([{ clientId: '1', clientName: 'A B', itemName: 'Sales Seminar A', memo: '', amount: '100.00', completionStatus: 'COMPLETED' }]);
      for (const n of Object.keys(plain)) files[n + '.enc'] = JSON.stringify(await MGECrypto.encryptText(plain[n], pass, n));
      files['last_run.json'] = JSON.stringify({ timestamp: new Date().toISOString(), status: 'success', clients: 1, pending: 0, contacts: 0, pdf: 0, backlog: 0 });
    }
    // Expected counts: decrypt independently in Node and run the app parser.
    const expected = {};
    for (const n of names) if (files[n + '.enc']) expected[n] = parseCSV(await MGECrypto.decryptToText(files[n + '.enc'], appPass));
    const indexHtml = rd(path.join(ROOT, 'index.html')).replace(/<script[\s\S]*?<\/script>/g, '');
    const { w } = newWindow(indexHtml, 'https://sambar1106.github.io/mge-triage-hub/');
    const served = [];
    w.fetch = async (u) => {
      const f = String(u).split('?')[0].replace(/^\.\//, '');
      served.push(f);
      const key = f.startsWith('data/enc/') ? f.slice(9) : null;
      if (key && files[key]) return { ok: true, text: async () => files[key] };
      return { ok: false, status: 404, text: async () => '' };
    };
    let prompts = 0; const answers = ['definitely wrong', appPass];
    w.prompt = (q) => { const a = answers[Math.min(prompts++, answers.length - 1)]; if (process.env.MGE_DEBUG) console.log('DEBUG prompt', prompts, q.slice(0, 20), a === appPass ? 'correct' : 'wrong', new Error().stack.split('\n').slice(2, 4).join(' / ').replace(/\s+/g, ' ').slice(0, 200)); return a; };
    w.alert = () => {};
    w.eval(rd(path.join(ROOT, 'js/mge-crypto.js')));
    w.eval(rd(path.join(ROOT, 'js/mge-buckets.js')));
    w.eval(rd(path.join(ROOT, 'js/app.js')) + '\n;window.__state = state;');
    // app.js starts itself on DOMContentLoaded (exactly like the browser); only call initApp if that already fired.
    if (w.document.readyState === 'loading') {
      await new Promise((res) => w.document.addEventListener('DOMContentLoaded', () => setTimeout(res, 0)));
      for (let i = 0; i < 600 && w.eval('__state.clients.size') === 0; i++) await new Promise((r) => setTimeout(r, 50));
    } else await w.initApp();
    const size = w.eval('__state.clients.size');
    if (process.env.MGE_DEBUG) console.log('DEBUG prompts', prompts, 'allEl', !!w.document.getElementById('b-count-all'), JSON.stringify(w.document.getElementById('b-count-all') && w.document.getElementById('b-count-all').textContent), 'listHTMLlen', w.document.getElementById('client-list').innerHTML.length);
    const clientIds = new Set(expected['clients_directory.csv'].map((r) => String(r['Client ID']).trim()));
    check(`app e2e (${source}): all clients loaded`, size === clientIds.size, `${size} clients`);
    check('app e2e: wrong passphrase re-prompts, correct one accepted & kept in sessionStorage', prompts === 2 && w.sessionStorage.getItem('mge_passphrase') === appPass);
    const attachedBacklog = w.eval('Array.from(__state.clients.values()).reduce((s,c)=>s+c.backlogItems.length,0)');
    const attachedPdf = w.eval('Array.from(__state.clients.values()).reduce((s,c)=>s+c.pdfRecords.length,0)');
    if (expected['unscheduled_backlog.csv']) check('app e2e: backlog rows attached', attachedBacklog > 0, `${attachedBacklog} items attached of ${expected['unscheduled_backlog.csv'].length} parsed (excluded program items are skipped by design)`);
    if (expected['pdf_directory.csv']) check('app e2e: PDF rows attached', attachedPdf > 0, `${attachedPdf} of ${expected['pdf_directory.csv'].length}`);
    const b = ['pending', 'incomplete', 'complete', 'all'].map((k) => Number(w.document.getElementById('b-count-' + k).textContent));
    check('app e2e: bucket counts rendered and sum to total', b[3] === size && b[0] + b[1] + b[2] === size, `pending=${b[0]} incomplete=${b[1]} complete=${b[2]} all=${b[3]}`);
    await new Promise((r) => setTimeout(r, 50));
    check('app e2e: "Data updated" stamp shown', /^(Data updated|Last scrape failed)/.test(w.document.getElementById('data-updated').textContent));
    check('app e2e: no plaintext data/*.csv requested once encrypted data loaded', !served.some((f) => /^data\/[^/]+\.csv$/.test(f) && files[f.slice(5) + '.enc']));
    // Drag-and-drop fallback: drop an encrypted and a plaintext file.
    const firstEnc = files['clients_directory.csv.enc'];
    const plainSmall = MGECsv.clientsCsv([['990001', 'Drop Test', 'C', 'S', '', '', '', '', '']]);
    await w.mgeLoadFiles([{ name: 'clients_directory.csv.enc', text: async () => firstEnc }]);
    check('drop fallback: encrypted .csv.enc accepted', w.eval('__state.clients.size') === size);
    await w.mgeLoadFiles([{ name: 'whatever.csv', text: async () => plainSmall }]);
    check('drop fallback: plaintext CSV detected by headers and loaded', w.eval('__state.clients.size') === 1);
    w.close();
  }

  // ---------------- 8b. Remember-me store & forget logic ----------------
  {
    const indexHtml = rd(path.join(ROOT, 'index.html'));
    const { w } = newWindow(indexHtml, 'http://localhost:8080/index.html');
    const appPass = 'team-passphrase-123';
    const encSample = await MGECrypto.encryptText('some,data', appPass, 'clients_directory.csv');

    w.eval(rd(path.join(ROOT, 'js/mge-crypto.js')));
    w.eval(rd(path.join(ROOT, 'js/app.js')));

    // 1. Saved passphrase in localStorage is preferred and unlocks data without prompt
    w.localStorage.setItem('mge_passphrase', appPass);
    let pCount = 0;
    w.prompt = () => { pCount++; return appPass; };
    const pass1 = await w.eval(`getPassphrase(${JSON.stringify(encSample)})`);
    check('remember-me: saved passphrase in localStorage unlocks without prompting', pass1 === appPass && pCount === 0);

    // 2. Invalid saved passphrase is removed from both localStorage and sessionStorage
    w.localStorage.setItem('mge_passphrase', 'wrong-pass');
    w.sessionStorage.setItem('mge_passphrase', 'wrong-pass');
    w.prompt = () => null; // cancel prompt
    const pass2 = await w.eval(`getPassphrase(${JSON.stringify(encSample)})`);
    check('remember-me: invalid saved passphrase removed from both localStorage and sessionStorage',
      pass2 === null && w.localStorage.getItem('mge_passphrase') === null && w.sessionStorage.getItem('mge_passphrase') === null);

    // 3. User checks remember me -> saved to localStorage
    const modalInput = w.document.getElementById('passphrase-input');
    const modalCb = w.document.getElementById('remember-me-checkbox');
    const modalForm = w.document.getElementById('passphrase-form');
    delete w.prompt;
    const promptPromise = w.eval(`getPassphrase(${JSON.stringify(encSample)})`);
    await new Promise((r) => setTimeout(r, 10));
    modalInput.value = appPass;
    modalCb.checked = true;
    modalForm.dispatchEvent(new w.Event('submit'));
    const pass3 = await promptPromise;
    check('remember-me: checking remember me saves passphrase to localStorage',
      pass3 === appPass && w.localStorage.getItem('mge_passphrase') === appPass);

    // 4. Forget saved passphrase clears both stores
    w.sessionStorage.setItem('mge_passphrase', appPass);
    try { Object.defineProperty(w.location, 'reload', { value: () => {}, configurable: true, writable: true }); } catch (e) {}
    w.mgeForgetPassphrase();
    check('remember-me: forgetPassphrase clears both localStorage and sessionStorage',
      w.localStorage.getItem('mge_passphrase') === null && w.sessionStorage.getItem('mge_passphrase') === null);

    w.close();
  }

  // ---------------- 9. Scheduling helper & 3 staggered runs defaults ----------------
  {
    global.importScripts = () => {}; global.chrome = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => ({ addListener() {} }) }) });
    const { nextRunTime, getNextScheduledRun, migrateSettings, checkAlreadySucceededToday } = require(path.join(EXT, 'background.js'));
    const at = (s) => new Date(s);
    check('schedule: before 10:00 -> same day 10:00', new Date(nextRunTime(10, 0, at('2026-09-28T09:30:00'))).getHours() === 10 && new Date(nextRunTime(10, 0, at('2026-09-28T09:30:00'))).getDate() === 28);
    check('schedule: after 10:00 -> next day 10:00', new Date(nextRunTime(10, 0, at('2026-09-28T10:00:01'))).getDate() === 29);
    check('schedule: background.js defaults to 10:00, 12:00, 16:00', /runTimes:\s*\[\s*'10:00',\s*'12:00',\s*'16:00'\s*\]/.test(rd(path.join(EXT, 'background.js'))));
    check('schedule: options.js defaults to 10:00, 12:00, 16:00', /runTimes:\s*\[\s*'10:00',\s*'12:00',\s*'16:00'\s*\]/.test(rd(path.join(EXT, 'options.js'))));
    check('schedule: task.xml runs at 09:55, 11:55, 15:55',
      /<StartBoundary>2026-01-01T09:55:00<\/StartBoundary>[\s\S]*<StartBoundary>2026-01-01T11:55:00<\/StartBoundary>[\s\S]*<StartBoundary>2026-01-01T15:55:00<\/StartBoundary>/.test(rd(path.join(ROOT, 'scripts/windows/MGE-Ensure-Chrome.task.xml'))));
    check('schedule: Register-MGEChromeTask.ps1 defaults to 09:55, 11:55, 15:55',
      /Times\s*=\s*@\('09:55',\s*'11:55',\s*'15:55'\)/.test(rd(path.join(ROOT, 'scripts/windows/Register-MGEChromeTask.ps1'))));

    // Three-time scheduling: getNextScheduledRun
    const defaultTimes = ['10:00', '12:00', '16:00'];
    const r1 = new Date(getNextScheduledRun(defaultTimes, at('2026-09-28T09:30:00')));
    check('schedule 3-run: before 10:00 -> today 10:00', r1.getHours() === 10 && r1.getMinutes() === 0 && r1.getDate() === 28);
    const r2 = new Date(getNextScheduledRun(defaultTimes, at('2026-09-28T10:30:00')));
    check('schedule 3-run: between 10:00 and 12:00 -> today 12:00', r2.getHours() === 12 && r2.getMinutes() === 0 && r2.getDate() === 28);
    const r3 = new Date(getNextScheduledRun(defaultTimes, at('2026-09-28T12:30:00')));
    check('schedule 3-run: between 12:00 and 16:00 -> today 16:00', r3.getHours() === 16 && r3.getMinutes() === 0 && r3.getDate() === 28);
    const r4 = new Date(getNextScheduledRun(defaultTimes, at('2026-09-28T16:30:00')));
    check('schedule 3-run: after 16:00 -> tomorrow 10:00', r4.getHours() === 10 && r4.getMinutes() === 0 && r4.getDate() === 29);

    // Settings migration
    const m1 = migrateSettings({ runHour: 9, runMinute: 15 });
    check('settings migration: old runHour/runMinute migrated to runTimes', Array.isArray(m1.runTimes) && m1.runTimes[0] === '09:15' && m1.runTimes[1] === '12:00' && m1.runTimes[2] === '16:00');
    const m2 = migrateSettings({});
    check('settings migration: empty settings gets 3 default runTimes', Array.isArray(m2.runTimes) && m2.runTimes[0] === '10:00' && m2.runTimes[1] === '12:00' && m2.runTimes[2] === '16:00');
    const m3 = migrateSettings({ runTimes: ['08:00', '13:00', '17:00'] });
    check('settings migration: existing runTimes preserved', m3.runTimes[0] === '08:00' && m3.runTimes[1] === '13:00' && m3.runTimes[2] === '17:00');

    // Skip-if-succeeded-today check
    const mockS = { ghOwner: 'SamBar1106', ghRepo: 'mge-triage-hub', ghBranch: 'main', ghToken: 'tok', encDir: 'data/enc' };
    const todayChicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

    // 1. Success today -> skip (returns true)
    const fetchSuccessToday = async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'success', timestamp: `${todayChicago}T10:05:00-05:00` })
    });
    const skip1 = await checkAlreadySucceededToday(mockS, new Date(), fetchSuccessToday);
    check('skip check: success today -> skip (true)', skip1 === true);

    // 2. Failure today -> run (returns false)
    const fetchFailureToday = async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'failure', timestamp: `${todayChicago}T10:05:00-05:00` })
    });
    const skip2 = await checkAlreadySucceededToday(mockS, new Date(), fetchFailureToday);
    check('skip check: failure today -> run (false)', skip2 === false);

    // 3. Success yesterday -> run (returns false)
    const fetchSuccessYesterday = async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'success', timestamp: '2026-01-01T10:05:00-05:00' })
    });
    const skip3 = await checkAlreadySucceededToday(mockS, new Date(), fetchSuccessYesterday);
    check('skip check: success yesterday -> run (false)', skip3 === false);

    // 4. Fetch error -> run (returns false)
    const fetchError = async () => { throw new Error('Network error'); };
    const skip4 = await checkAlreadySucceededToday(mockS, new Date(), fetchError);
    check('skip check: fetch error -> run (false)', skip4 === false);

    const fetchNotFound = async () => ({ ok: false, status: 404 });
    const skip5 = await checkAlreadySucceededToday(mockS, new Date(), fetchNotFound);
    check('skip check: 404 response -> run (false)', skip5 === false);
  }

  // ---------------- 10. Client bucketing logic & committed data 354 pending ----------------
  {
    const MGEBuckets = require(path.join(EXT, 'lib/buckets.js'));
    check('buckets: module exports computeBuckets and classifyClient', typeof MGEBuckets.computeBuckets === 'function' && typeof MGEBuckets.classifyClient === 'function');

    // Synthetic classification test: 1 pending, 1 incomplete, 1 complete
    const synthClients = [
      { clientId: '1', doctorName: 'Doc One', consultant: 'C1', accountStatus: 'Active' },
      { clientId: '2', doctorName: 'Doc Two', consultant: 'C2', accountStatus: 'Active' },
      { clientId: '3', doctorName: 'Doc Three', consultant: 'C3', accountStatus: 'Active' }
    ];
    const synthPdf = [
      { clientInternalId: '1', monthDates: '3/5-3/7', services: 'Sales Seminar A', location: 'FL' },
      { clientInternalId: '2', monthDates: 'NO DATES', services: 'None', location: 'FL' }
    ];
    const synthBacklog = [
      { clientId: '1', itemName: 'Marketing Seminar', amount: '100', completionStatus: 'UNCOMPLETED' }, // Client 1 has dates, but uncompleted item -> SCHEDULE_INCOMPLETE
      { clientId: '2', itemName: 'Marketing Seminar', amount: '200', completionStatus: 'UNCOMPLETED' }, // Client 2 has no valid dates, uncompleted item -> PENDING_SCHEDULE
      { clientId: '3', itemName: 'Sales Seminar A', amount: '300', completionStatus: 'COMPLETED' }      // Client 3 has completed items -> PROGRAM_COMPLETE
    ];
    const synthRes = MGEBuckets.computeBuckets({ clients: synthClients, pdf: synthPdf, backlog: synthBacklog });
    check('buckets: synthetic classification', synthRes.pending === 1 && synthRes.incomplete === 1 && synthRes.complete === 1,
      `pending=${synthRes.pending} incomplete=${synthRes.incomplete} complete=${synthRes.complete}`);

    // Verify 354 pending count on the committed data
    let committedPending = null;
    let clientCount = 0;
    try {
      const opt = { maxBuffer: 50 * 1024 * 1024 };
      const clientsCsv = execSync('git show fe1d7c2:data/clients_directory.csv', opt).toString();
      const pdfCsv = execSync('git show fe1d7c2:data/pdf_directory.csv', opt).toString();
      const backlogCsv = execSync('git show fe1d7c2:data/unscheduled_backlog.csv', opt).toString();
      const contactsCsv = execSync('git show fe1d7c2:data/contacts_directory.csv', opt).toString();
      const res = MGEBuckets.computeBuckets({ clients: clientsCsv, pdf: pdfCsv, backlog: backlogCsv, contacts: contactsCsv });
      committedPending = res.pending;
      clientCount = res.clients;
    } catch (e) {
      // Fallback
    }
    check('buckets: pending count on committed data == 354', committedPending === 354, `pending=${committedPending} clients=${clientCount}`);
  }

  // ---------------- 11. Antigravity / GitHub failure-alert workflow logic ----------------
  {
    const notify = require(path.join(ROOT, '.github/scripts/scraper-notify.js'));
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mge-notify-'));
    fs.mkdirSync(path.join(tmp, 'data/enc'), { recursive: true });
    const writeStatus = (o) => fs.writeFileSync(path.join(tmp, 'data/enc/last_run.json'), JSON.stringify(o));
    const issues = []; const calls = [];
    const fakeFetch = async (url, init) => {
      const u = new URL(url); const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, ''); const m = init.method; const body = init.body ? JSON.parse(init.body) : null;
      calls.push(`${m} ${p}`);
      const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
      if (m === 'POST' && p === '/labels') return res(422, {});
      if (m === 'GET' && p === '/issues') return res(200, issues.filter((i) => i.state === 'open'));
      if (m === 'POST' && p === '/issues') { const i = { number: issues.length + 1, title: body.title, state: 'open', comments: 0, html_url: `https://github.com/x/y/issues/${issues.length + 1}`, body: body.body }; issues.push(i); return res(201, i); }
      let mm;
      if (m === 'POST' && (mm = p.match(/^\/issues\/(\d+)\/comments$/))) { issues[mm[1] - 1].comments++; issues[mm[1] - 1].lastComment = body.body; return res(201, {}); }
      if (m === 'PATCH' && (mm = p.match(/^\/issues\/(\d+)$/))) { issues[mm[1] - 1].state = body.state; return res(200, {}); }
      return res(404, {});
    };
    const base = { root: tmp, fetch: fakeFetch, repo: 'x/y', token: 't', log: () => {} };
    const alertFile = path.join(tmp, 'ANTIGRAVITY_ALERT.md');
    const t1 = new Date('2026-09-29T07:10:00Z'); // 2:10 AM CDT
    writeStatus({ ok: false, finishedAt: t1.toISOString(), errors: ['NOT_LOGGED_IN', 'oops jane@example.com 555-123-4567 https://x.y/z'] });
    let r = await notify.run({ ...base, event: 'push', now: t1 });
    const md1 = fs.existsSync(alertFile) ? rd(alertFile) : '';
    check('notify: failure -> issue created with Chicago-date title + label', r.decision === 'alert' && issues.length === 1 && issues[0].title === 'MGE scraper failed 2026-09-29');
    check('notify: failure -> ANTIGRAVITY_ALERT.md written with time, error, issue link, files, test cmd',
      /2:10 AM CDT/.test(md1) && md1.includes('NOT_LOGGED_IN') && md1.includes(issues[0].html_url) && md1.includes('extension/scrapers/') && md1.includes('extension/background.js') && md1.includes('tests/run-tests.js'));
    check('notify: no email/phone/URL leaks into alert or issue', !/@example\.com|555-123-4567|x\.y\/z/.test(md1 + issues[0].body));
    r = await notify.run({ ...base, event: 'push', now: new Date('2026-09-29T08:00:00Z') });
    check('notify: second failure same Chicago day -> comment, not a new issue', issues.length === 1 && issues[0].comments === 1);
    writeStatus({ ok: true, finishedAt: new Date('2026-09-29T09:00:00Z').toISOString(), errors: [] });
    r = await notify.run({ ...base, event: 'push', now: new Date('2026-09-29T09:00:00Z') });
    check('notify: success -> alert file deleted + issue closed with comment', !fs.existsSync(alertFile) && issues[0].state === 'closed' && /succeeded/.test(issues[0].lastComment) && r.closed === 1);
    // 5 PM fallback: last run was yesterday
    r = await notify.run({ ...base, event: 'schedule', now: new Date('2026-09-30T22:00:00Z') }); // 5 PM CDT
    check('notify: 5 PM fallback with no run today -> NO_RUN_TODAY issue + alert file', r.decision === 'alert' && issues.length === 2 && issues[1].title === 'MGE scraper failed 2026-09-30' && rd(alertFile).includes('NO_RUN_TODAY'));
    const n = calls.length;
    r = await notify.run({ ...base, event: 'schedule', now: new Date('2026-09-30T23:00:00Z') }); // 6 PM CDT -> other cron entry
    check('notify: DST twin cron at 6 PM Chicago is skipped', r.decision === 'skip' && calls.length === n);
    writeStatus({ ok: true, finishedAt: new Date('2026-09-30T07:30:00Z').toISOString(), errors: [] });
    fs.unlinkSync(alertFile); const before = issues.length;
    r = await notify.run({ ...base, event: 'schedule', now: new Date('2026-09-30T22:00:00Z') });
    check('notify: 5 PM fallback with a good run today -> noop', r.decision === 'noop' && issues.length === before && !fs.existsSync(alertFile));

    // Test new status file schema
    writeStatus({ status: 'failure', timestamp: '2026-09-29T10:05:00-05:00', error: 'NOT_LOGGED_IN' });
    r = await notify.run({ ...base, event: 'push', now: new Date('2026-09-29T15:05:00Z') });
    check('notify: new status schema failure recognized', r.decision === 'alert');
    writeStatus({ status: 'success', timestamp: '2026-09-29T10:30:00-05:00' });
    r = await notify.run({ ...base, event: 'push', now: new Date('2026-09-29T15:30:00Z') });
    check('notify: new status schema success recognized', r.decision === 'resolve');

    const wf = rd([path.join(ROOT, '.github/workflows/scraper-notify.yml'), path.join(ROOT, 'scripts/github/scraper-notify.yml')].find((p) => fs.existsSync(p)));
    check('workflow: paths filter only last_run.json; issues+contents write perms', /paths:\s*\n\s*- data\/enc\/last_run\.json/.test(wf) && !/ANTIGRAVITY_ALERT\.md\s*\n\s*schedule/.test(wf) && /issues: write/.test(wf) && /contents: write/.test(wf));
    check('AGENTS.md has the Antigravity rule', /If `ANTIGRAVITY_ALERT\.md` exists.*read it first and help fix the failing scraper before anything else/.test(rd(path.join(ROOT, 'AGENTS.md'))));
  }

  // ---------------- 12. Email notifications & SMTP helper ----------------
  {
    const notify = require(path.join(ROOT, '.github/scripts/scraper-notify.js'));
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mge-email-'));
    fs.mkdirSync(path.join(tmp, 'data/enc'), { recursive: true });
    const writeStatus = (o) => fs.writeFileSync(path.join(tmp, 'data/enc/last_run.json'), JSON.stringify(o));

    // Test missing secret
    let missingSecretErr = false;
    try {
      await notify.runEmail({ root: tmp, password: '' });
    } catch (e) {
      missingSecretErr = e.message.includes('GMAIL_APP_PASSWORD secret is missing');
    }
    check('notify email: fails clearly when GMAIL_APP_PASSWORD is missing', missingSecretErr);

    const sentEmails = [];
    const fakeSmtp = async (params) => {
      sentEmails.push(params);
      return { ok: true };
    };

    // Test success email
    writeStatus({
      timestamp: '2026-09-29T10:15:00-05:00',
      status: 'success',
      clients: 748,
      pending: 354,
      contacts: 669,
      pdf: 2835,
      backlog: 14571
    });

    let res = await notify.runEmail({
      root: tmp,
      password: 'test_password',
      event: 'push',
      smtpSend: fakeSmtp
    });

    check('notify email: success email sent with correct subject',
      res.sent && sentEmails[0].subject === 'MGE scraper: SUCCESS - 748 clients / 354 pending');
    check('notify email: success body includes Chicago time, status, counts, and live site link',
      sentEmails[0].body.includes('Status: SUCCESS') &&
      sentEmails[0].body.includes('Clients: 748') &&
      sentEmails[0].body.includes('Pending: 354') &&
      sentEmails[0].body.includes('https://sambar1106.github.io/mge-triage-hub/'));
    check('notify email: recipient is samuelbarrios1106@gmail.com',
      sentEmails[0].to === 'samuelbarrios1106@gmail.com');

    // Test failure email
    writeStatus({
      timestamp: '2026-09-29T10:05:00-05:00',
      status: 'failure',
      clients: 0,
      pending: 0,
      error: 'NOT_LOGGED_IN'
    });

    res = await notify.runEmail({
      root: tmp,
      password: 'test_password',
      event: 'push',
      smtpSend: fakeSmtp
    });

    check('notify email: failure email sent with subject MGE scraper: FAILED',
      res.sent && sentEmails[1].subject === 'MGE scraper: FAILED');
    check('notify email: failure body includes error, status, and live site link',
      sentEmails[1].body.includes('Status: FAILED') &&
      sentEmails[1].body.includes('NOT_LOGGED_IN') &&
      sentEmails[1].body.includes('https://sambar1106.github.io/mge-triage-hub/'));

    // Test 5 PM no-run fallback
    res = await notify.runEmail({
      root: tmp,
      password: 'test_password',
      event: 'schedule',
      now: new Date('2026-09-30T22:00:00Z'), // 5 PM CDT
      smtpSend: fakeSmtp
    });

    check('notify email: 5 PM fallback sends FAILED email with NO_RUN_TODAY',
      res.sent && sentEmails[2].subject === 'MGE scraper: FAILED' && sentEmails[2].body.includes('NO_RUN_TODAY'));

    // Test DST twin skip (6 PM Chicago)
    const countBefore = sentEmails.length;
    res = await notify.runEmail({
      root: tmp,
      password: 'test_password',
      event: 'schedule',
      now: new Date('2026-09-30T23:00:00Z'), // 6 PM CDT
      smtpSend: fakeSmtp
    });
    check('notify email: DST twin at 6 PM is skipped', !res.sent && sentEmails.length === countBefore);

    // Test pending null in email
    writeStatus({
      timestamp: '2026-09-29T10:15:00-05:00',
      status: 'failure',
      clients: 748,
      pending: null,
      error: 'PDF_FAILED_AT:40'
    });
    const nullPendingRes = await notify.runEmail({
      root: tmp,
      password: 'test_password',
      event: 'push',
      smtpSend: fakeSmtp
    });
    check('notify email: pending null formatted as unknown in email',
      nullPendingRes.sent && sentEmails[sentEmails.length - 1].body.includes('- Pending: unknown'));

    // Test SMTP protocol conversation with a mock TLS socket
    const EventEmitter = require('events');
    const sentCommands = [];
    const rawDataPayloads = [];
    class MockTlsSocket extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
        setTimeout(() => this.emit('data', '220 smtp.gmail.com ESMTP ready\r\n'), 5);
      }
      setTimeout() {}
      setEncoding() {}
      write(data) {
        sentCommands.push(data.trim());
        if (data.includes('Subject:')) {
          rawDataPayloads.push(data);
        }
        if (data.startsWith('EHLO')) {
          setTimeout(() => this.emit('data', '250-smtp.gmail.com at your service\r\n250 AUTH LOGIN\r\n'), 5);
        } else if (data.startsWith('AUTH LOGIN')) {
          setTimeout(() => this.emit('data', '334 VXNlcm5hbWU6\r\n'), 5);
        } else if (sentCommands.length === 3) {
          setTimeout(() => this.emit('data', '334 UGFzc3dvcmQ6\r\n'), 5);
        } else if (sentCommands.length === 4) {
          setTimeout(() => this.emit('data', '235 2.7.0 Accepted\r\n'), 5);
        } else if (data.startsWith('MAIL FROM:')) {
          setTimeout(() => this.emit('data', '250 2.1.0 OK\r\n'), 5);
        } else if (data.startsWith('RCPT TO:')) {
          setTimeout(() => this.emit('data', '250 2.1.5 OK\r\n'), 5);
        } else if (data.startsWith('DATA')) {
          setTimeout(() => this.emit('data', '354 Go ahead\r\n'), 5);
        } else if (data.trim().endsWith('.')) {
          setTimeout(() => this.emit('data', '250 2.0.0 OK message queued\r\n'), 5);
        } else if (data.startsWith('QUIT')) {
          setTimeout(() => this.emit('close'), 5);
        }
      }
      end() { this.emit('close'); }
      destroy() { this.destroyed = true; }
    }

    const smtpRes = await notify.sendSmtpEmail({
      host: 'smtp.gmail.com',
      port: 465,
      user: 'testuser@gmail.com',
      pass: 'secret_app_pw',
      to: 'recipient@example.com',
      from: 'testuser@gmail.com',
      subject: 'Test Subject',
      body: 'Test Body\n.dotted line\nThird line',
      tlsConnect: () => new MockTlsSocket()
    });

    check('notify smtp: full handshake completed (EHLO, AUTH, MAIL, RCPT, DATA, QUIT)',
      smtpRes.ok &&
      sentCommands.some((c) => c.startsWith('EHLO')) &&
      sentCommands.some((c) => c.startsWith('AUTH LOGIN')) &&
      sentCommands.some((c) => c === Buffer.from('testuser@gmail.com').toString('base64')) &&
      sentCommands.some((c) => c === Buffer.from('secret_app_pw').toString('base64')) &&
      sentCommands.some((c) => c.startsWith('MAIL FROM:<testuser@gmail.com>')) &&
      sentCommands.some((c) => c.startsWith('RCPT TO:<recipient@example.com>')) &&
      sentCommands.some((c) => c.includes('Subject: Test Subject')));

    // Test CRLF and dot stuffing in DATA message
    const payload = rawDataPayloads[0] || '';
    const payloadLines = payload.split('\r\n');
    check('notify smtp: DATA payload uses CRLF and escapes lines starting with dot',
      payloadLines.includes('..dotted line') && !payload.match(/(?<!\r)\n/));

    // Test socket timeout
    let timeoutSet = null;
    class TimeoutTlsSocket extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
      }
      setTimeout(ms) {
        timeoutSet = ms;
      }
      setEncoding() {}
      write() {}
      destroy() { this.destroyed = true; }
    }
    const timeoutSocket = new TimeoutTlsSocket();
    const timeoutPromise = notify.sendSmtpEmail({
      host: 'smtp.gmail.com',
      port: 465,
      user: 'u@example.com',
      pass: 'p',
      to: 't@example.com',
      subject: 'sub',
      body: 'body',
      tlsConnect: () => timeoutSocket
    });
    timeoutSocket.emit('timeout');
    let timeoutFailedCleanly = false;
    try {
      await timeoutPromise;
    } catch (e) {
      timeoutFailedCleanly = e.message.includes('timed out after 30 seconds') && timeoutSocket.destroyed;
    }
    check('notify smtp: 30s socket timeout configured and rejects cleanly on stall', timeoutSet === 30000 && timeoutFailedCleanly);

    // Test password never logged
    const loggedMsgs = [];
    const origLog = console.log, origErr = console.error;
    const testSecret = 'SECRET_PASSWORD_XYZ_DO_NOT_LOG';
    console.log = (...args) => loggedMsgs.push(args.join(' '));
    console.error = (...args) => loggedMsgs.push(args.join(' '));
    try {
      await notify.runEmail({
        root: tmp,
        password: testSecret,
        event: 'push',
        smtpSend: fakeSmtp
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    check('notify email: password is never logged', !loggedMsgs.some(m => m.includes(testSecret)));

    // Check actionlint report
    try {
      execSync('actionlint .github/workflows/scraper-notify.yml', { cwd: ROOT });
      check('actionlint reports nothing on .github/workflows/scraper-notify.yml', true);
    } catch (e) {
      check('actionlint reports nothing on .github/workflows/scraper-notify.yml', false, e.message);
    }
  }

  // ---------------- 13. Popup status & partial runs ----------------
  {
    // Item 1: Popup status
    const popupHtml = rd(path.join(EXT, 'popup.html'));
    const { w } = newWindow(popupHtml, 'chrome-extension://dummy-id/popup.html');
    let mockStatus = {
      timestamp: '2026-09-28T19:49:09-05:00',
      status: 'success',
      clients: 748,
      pending: 354,
      contacts: null,
      pdf: 2835,
      backlog: 14571
    };
    w.chrome = {
      runtime: {
        sendMessage: async (m) => {
          if (m.type === 'status') return { lastStatus: mockStatus, nextRun: null, run: null };
          return {};
        },
        openOptionsPage: () => {}
      }
    };
    const popupJs = rd(path.join(EXT, 'popup.js'));
    w.eval(popupJs);
    await w.refresh();
    const okLines = Array.from(w.document.querySelectorAll('#summary .ok')).map((el) => el.textContent);
    const mutedLines = Array.from(w.document.querySelectorAll('#summary .muted')).map((el) => el.textContent);
    check('popup: success displays status SUCCESS, local time, and counts',
      okLines.some((l) => l.startsWith('Last run: SUCCESS at')) &&
      mutedLines.includes('Clients: 748') &&
      mutedLines.includes('Pending: 354') &&
      mutedLines.includes('PDF: 2835') &&
      mutedLines.includes('Backlog: 14571') &&
      !mutedLines.some((l) => l.startsWith('Contacts:')));

    // Popup failure with error
    mockStatus = {
      timestamp: '2026-09-28T19:49:09-05:00',
      status: 'failure',
      clients: 748,
      pending: null,
      contacts: null,
      pdf: 40,
      backlog: null,
      error: 'PDF_FAILED_AT:40'
    };
    await w.refresh();
    const badLines = Array.from(w.document.querySelectorAll('#summary .bad')).map((el) => el.textContent);
    const mutedLinesFail = Array.from(w.document.querySelectorAll('#summary .muted')).map((el) => el.textContent);
    check('popup: failure displays status FAILED, error, and pending unknown',
      badLines.some((l) => l.startsWith('Last run: FAILED at')) &&
      badLines.includes('PDF_FAILED_AT:40') &&
      mutedLinesFail.includes('Clients: 748') &&
      mutedLinesFail.includes('Pending: unknown') &&
      mutedLinesFail.includes('PDF: 40'));

    // Progress rows
    const mockRun = {
      phase: 'pdf',
      startedAt: '2026-09-28T10:00:00-05:00',
      progress: {
        clients: { status: 'Done', step: '748 clients (1 pages)', done: 1, total: 1, startedAt: '2026-09-28T10:00:00-05:00' },
        pdf: { status: 'Running', step: '40/748 clients', done: 40, total: 748, startedAt: '2026-09-28T10:01:00-05:00' },
        backlog: { status: 'Waiting', step: 'Waiting', done: 0, total: null, startedAt: null },
        upload: { status: 'Waiting', step: 'Waiting', done: 0, total: null, startedAt: null }
      }
    };
    w.chrome.runtime.sendMessage = async (m) => {
      if (m.type === 'status') return { lastStatus: mockStatus, nextRun: null, run: mockRun };
      return {};
    };
    await w.refresh();
    const pRows = Array.from(w.document.querySelectorAll('#progress .progress-row'));
    const names = pRows.map((r) => r.querySelector('.progress-name')?.textContent);
    const statuses = pRows.map((r) => r.querySelector('.progress-status')?.textContent);
    const hasProgressBars = pRows.every((r) => !!r.querySelector('progress'));
    check('popup: progress rows rendered for all scrapers with status and progress bars',
      names.includes('Client list') && names.includes('PDF schedules') && names.includes('Unscheduled backlog') && names.includes('Upload') &&
      statuses.includes('Done') && statuses.includes('Running') && statuses.includes('Waiting') && hasProgressBars);

    // Item 3: Partial runs in background.js
    const bg = require(path.join(EXT, 'background.js'));
    global.MGEBuckets = require(path.join(EXT, 'lib/buckets.js'));

    let mockStorage = {};
    global.chrome = {
      storage: {
        local: {
          get: async (keys) => {
            const res = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { res[k] = mockStorage[k]; });
            return res;
          },
          set: async (obj) => { Object.assign(mockStorage, obj); }
        }
      },
      alarms: { create() {}, clear() {}, get() {} },
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } }
    };

    // PDF_FAILED_AT failure
    mockStorage = {
      res_clients: { rows: Array(748).fill(['1', 'Doc', 'C1', 'Active', 'e@x.co', '123', 'addr']) },
      res_pdf_items: Array(40).fill({}),
      res_backlog: []
    };
    const failRun1 = {
      errors: ['PDF_FAILED_AT:40'],
      done: { clients: true }
    };
    const resFail1 = await bg.finishWithStatus(failRun1, true, { enableClients: true, enablePdf: true, enableBacklog: true }, false);
    check('partial runs: PDF_FAILED_AT produces failure, error set, and pending null',
      resFail1.status === 'failure' && resFail1.error === 'PDF_FAILED_AT:40' && resFail1.pending === null);

    // BACKLOG_FAILED_AT failure
    const failRun2 = {
      errors: ['BACKLOG_FAILED_AT:100'],
      done: { clients: true, pdf: true }
    };
    const resFail2 = await bg.finishWithStatus(failRun2, true, { enableClients: true, enablePdf: true, enableBacklog: true }, false);
    check('partial runs: BACKLOG_FAILED_AT produces failure, error set, and pending null',
      resFail2.status === 'failure' && resFail2.error === 'BACKLOG_FAILED_AT:100' && resFail2.pending === null);

    // Scraper turned off in settings is not a failure, but leaves count null and pending null
    mockStorage = {
      res_clients: { rows: Array(748).fill(['1', 'Doc', 'C1', 'Active', 'e@x.co', '123', 'addr']) },
      res_pdf_items: [],
      res_backlog: Array(100).fill({})
    };
    const disabledRun = {
      errors: [],
      done: { clients: true, backlog: true }
    };
    const resDisabled = await bg.finishWithStatus(disabledRun, true, { enableClients: true, enablePdf: false, enableBacklog: true }, false);
    check('partial runs: turned-off scraper is not failure, count is null, pending is null',
      resDisabled.status === 'success' && resDisabled.pdf === null && resDisabled.pending === null);

    // Contacts is never scraped: always null
    check('partial runs: contacts is always null', resDisabled.contacts === null && resFail1.contacts === null);

    // NOT_CONFIGURED failure must not report counts leftover from previous run
    mockStorage = {
      res_clients: { rows: Array(748).fill(['1', 'Doc', 'C1', 'Active', 'e@x.co', '123', 'addr']) },
      res_pdf_items: Array(2835).fill({}),
      res_backlog: Array(14571).fill({})
    };
    const notConfigRun = {
      errors: ['NOT_CONFIGURED']
    };
    const resNotConfig = await bg.finishWithStatus(notConfigRun, false, {}, false);
    check('partial runs: NOT_CONFIGURED does not report leftover counts',
      resNotConfig.status === 'failure' &&
      resNotConfig.error === 'NOT_CONFIGURED' &&
      resNotConfig.clients === null &&
      resNotConfig.pending === null &&
      resNotConfig.pdf === null &&
      resNotConfig.backlog === null &&
      resNotConfig.contacts === null);
  }

  // ---------------- 14. Dashboard CSV export & helpers (TASK-008) ----------------
  {
    const indexHtml = rd(path.join(ROOT, 'index.html')).replace(/<script[\s\S]*?<\/script>/g, '');
    const { w } = newWindow(indexHtml, 'https://sambar1106.github.io/mge-triage-hub/');
    w.fetch = async () => ({ ok: false, text: async () => '' });
    w.eval(rd(path.join(ROOT, 'js/mge-crypto.js')));
    w.eval(rd(path.join(ROOT, 'js/mge-buckets.js')));
    w.eval(rd(path.join(ROOT, 'js/app.js')) + '\n;window.__state = state;');

    const { formatScheduledDates, getExportFileName, getSelectedSeminar, exportCSV, itemMatchesSeminar, findMatchingSeminar } = w;

    // 1. formatScheduledDates tests
    check('export dates: empty / non-array returns blank',
      formatScheduledDates() === '' && formatScheduledDates([]) === '' && formatScheduledDates(null) === '');

    const invalidPdfRecords = [
      { 'Services': 'Sales Seminar A', 'Month / Dates': '' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': '   ' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'NO DATES' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'no dates' },
      { 'Services': 'Marketing Seminar', 'Month / Dates': 'NO DATE' },
      { 'Services': 'Marketing Seminar', 'Month / Dates': 'No Date' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'N/A' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'n/a' }
    ];
    check('export dates: ignores empty, NO DATES, NO DATE, N/A (case-insensitive)',
      formatScheduledDates(invalidPdfRecords, 'Sales Seminar A') === '' &&
      formatScheduledDates(invalidPdfRecords, 'All Events') === '');

    const mixedPdfRecords = [
      { 'Services': 'Sales Seminar A', 'Month / Dates': '10/12-10/14' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'NO DATES' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': '10/12-10/14' },
      { 'Services': 'Sales Seminar A - in person only', 'Month / Dates': '11/01-11/03' },
      { 'Services': 'Marketing Seminar', 'Month / Dates': '12/05-12/07' },
      { 'Services': 'Unknown Course', 'Month / Dates': '01/10-01/12' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': 'N/A' }
    ];
    check('export dates: filtered seminar returns only matching dates de-duplicated',
      formatScheduledDates(mixedPdfRecords, 'Sales Seminar A') === '10/12-10/14 | 11/01-11/03' &&
      formatScheduledDates(mixedPdfRecords, 'Marketing Seminar') === '12/05-12/07' &&
      formatScheduledDates(mixedPdfRecords, 'Owner\'s Conference') === '');

    check('export dates: All Events returns labeled dates omitting non-matching records',
      formatScheduledDates(mixedPdfRecords, 'All Events') === 'Sales Seminar A: 10/12-10/14 | Sales Seminar A: 11/01-11/03 | Marketing Seminar: 12/05-12/07');

    check('seminar matching: itemMatchesSeminar and findMatchingSeminar work correctly',
      itemMatchesSeminar({ 'Services': 'Sales Seminar A - in person only' }, 'Sales Seminar A') &&
      !itemMatchesSeminar({ 'Services': 'Marketing Seminar' }, 'Sales Seminar A') &&
      findMatchingSeminar({ 'Services': 'Sales Seminar A - in person only' }) === 'Sales Seminar A' &&
      findMatchingSeminar({ 'Services': 'Unknown Course' }) === null);

    // 2. getExportFileName tests
    check('export filename: All Events / empty / ALL gives Triage_Export.csv',
      getExportFileName('All Events') === 'Triage_Export.csv' &&
      getExportFileName('ALL') === 'Triage_Export.csv' &&
      getExportFileName('') === 'Triage_Export.csv' &&
      getExportFileName(null) === 'Triage_Export.csv');

    check('export filename: replaces non-alphanumerics and collapses repeated underscores',
      getExportFileName('Sales Seminar A') === 'Triage_Export_Sales_Seminar_A.csv' &&
      getExportFileName('Conditions & Statistic Management Seminar') === 'Triage_Export_Conditions_Statistic_Management_Seminar.csv' &&
      getExportFileName("Owner's Conference") === 'Triage_Export_Owner_s_Conference.csv' &&
      getExportFileName('Sales   Seminar   B') === 'Triage_Export_Sales_Seminar_B.csv');

    // 3. getSelectedSeminar tests
    const eventSel = w.document.getElementById('filter-event');
    eventSel.value = 'ALL';
    check('export seminar: default / ALL returns All Events',
      getSelectedSeminar() === 'All Events');

    eventSel.value = 'Sales Seminar A';
    check('export seminar: selected event returns option text',
      getSelectedSeminar() === 'Sales Seminar A');

    // 4. exportCSV integration test
    let downloadedName = null;
    let clicked = false;
    if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:mock-url';
    const origAppend = w.document.body.appendChild.bind(w.document.body);
    w.document.body.appendChild = function(el) {
      if (el && el.tagName === 'A') {
        downloadedName = el.getAttribute('download');
        el.click = () => { clicked = true; };
      }
      return origAppend(el);
    };

    w.__state.clients.clear();
    w.__state.activeBucket = 'ALL';
    w.__state.searchQuery = '';
    w.__state.courseQuery = '';
    w.__state.consultantFilter = '';
    w.__state.expiredFilter = '';
    w.__state.eventFilter = '';
    w.__state.statusFilter = '';

    w.__state.clients.set('101', {
      clientId: '101',
      doctorName: 'Dr. Jane Smith',
      companyName: 'Smith Dental "Care"',
      doctorEmail: 'drjane@smithdental.com',
      altEmail: '',
      workPhone: '555-123-4567',
      cell1Number: '',
      consultant: 'Assigned',
      accountStatus: 'Active',
      bucket: 'ALL',
      contacts: [],
      pdfRecords: [
        { 'Services': 'Sales Seminar A', 'Month / Dates': '12/01-12/03' },
        { 'Services': 'Marketing Seminar', 'Month / Dates': '11/15-11/17' },
        { 'Services': 'Sales Seminar A', 'Month / Dates': 'NO DATES' },
        { 'Services': 'Unrelated Course', 'Month / Dates': '09/01-09/03' }
      ],
      backlogItems: [
        { 'Item Name': 'Sales Seminar A', numericAmount: 2500 }
      ],
      pendingItemsCount: 2,
      pendingAmount: 2500
    });

    eventSel.value = 'Sales Seminar A';
    const exportResult = exportCSV();

    check('export csv: triggers anchor download with filtered filename',
      downloadedName === 'Triage_Export_Sales_Seminar_A.csv' && clicked);

    const lines = exportResult.csvContent.trim().split('\n');
    check('export csv: new header line matches specification',
      lines[0] === 'Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar');

    const parsedRows = parseCSV(exportResult.csvContent);
    check('export csv: row data contains scheduled dates and seminar properly quoted',
      parsedRows.length === 1 &&
      parsedRows[0]['Client Name'] === 'Dr. Jane Smith' &&
      parsedRows[0]['Company Name'] === 'Smith Dental "Care"' &&
      parsedRows[0]['Scheduled Dates'] === '12/01-12/03' &&
      parsedRows[0]['Seminar'] === 'Sales Seminar A' &&
      parsedRows[0]['Pending Items'] === '2' &&
      parsedRows[0]['Pending Amount'] === '2500');

    // Test All Events filename, seminar, and labeled scheduled dates
    eventSel.value = 'ALL';
    const exportAll = exportCSV();
    const parsedAll = parseCSV(exportAll.csvContent);
    check('export csv: All Events exports to Triage_Export.csv with Seminar "All Events" and labeled dates',
      downloadedName === 'Triage_Export.csv' &&
      parsedAll[0]['Seminar'] === 'All Events' &&
      parsedAll[0]['Scheduled Dates'] === 'Sales Seminar A: 12/01-12/03 | Marketing Seminar: 11/15-11/17');

    w.close();
  }

  // ---------------- 15. Active filter highlight, Livestream matching & Bucket renames (TASK-010) ----------------
  {
    const indexHtml = rd(path.join(ROOT, 'index.html')).replace(/<script[\s\S]*?<\/script>/g, '');
    const { w } = newWindow(indexHtml, 'https://sambar1106.github.io/mge-triage-hub/');
    w.fetch = async () => ({ ok: false, text: async () => '' });
    w.eval(rd(path.join(ROOT, 'js/mge-crypto.js')));
    w.eval(rd(path.join(ROOT, 'js/mge-buckets.js')));
    w.eval(rd(path.join(ROOT, 'js/app.js')) + '\n;window.__state = state;');

    const {
      itemMatchesSeminar,
      findMatchingSeminar,
      formatScheduledDates,
      updateFilterHighlights
    } = w;

    // 1. Bucket label rename checks (display text only)
    const btnPending = w.document.querySelector('.segment-btn[data-bucket="PENDING_SCHEDULE"]');
    const btnIncomplete = w.document.querySelector('.segment-btn[data-bucket="SCHEDULE_INCOMPLETE"]');
    check('bucket renames: PENDING_SCHEDULE button displays "Not Scheduled"',
      btnPending && btnPending.textContent.includes('Not Scheduled') && !btnPending.textContent.includes('Pending for Schedule'));
    check('bucket renames: SCHEDULE_INCOMPLETE button displays "Schedule Not Complete"',
      btnIncomplete && btnIncomplete.textContent.includes('Schedule Not Complete') && !btnIncomplete.textContent.includes('Schedule Incomplete'));

    const kpiPendingBox = w.document.getElementById('kpi-pending-val')?.closest('.mini-kpi');
    const kpiIncompleteBox = w.document.getElementById('kpi-incomplete-val')?.closest('.mini-kpi');
    check('bucket renames: mini-KPI labels and tooltips updated',
      kpiPendingBox?.getAttribute('title') === 'Not Scheduled Value' &&
      kpiPendingBox?.querySelector('.mini-kpi-label')?.textContent.trim() === 'Not Scheduled' &&
      kpiIncompleteBox?.getAttribute('title') === 'Schedule Not Complete Value' &&
      kpiIncompleteBox?.querySelector('.mini-kpi-label')?.textContent.trim() === 'Not Complete');

    // 2. Active filter highlight checks
    const filterSearch = w.document.getElementById('filter-search');
    const filterCourse = w.document.getElementById('filter-course');
    const filterStatus = w.document.getElementById('filter-status');
    const filterEvent = w.document.getElementById('filter-event');
    const filterConsultant = w.document.getElementById('filter-consultant');
    const filterExpired = w.document.getElementById('filter-expired');

    updateFilterHighlights();
    const allControls = [filterSearch, filterCourse, filterStatus, filterEvent, filterConsultant, filterExpired];
    check('active filters: default state has no filter-active class',
      allControls.every(el => el && !el.classList.contains('filter-active')));

    // Input changes trigger highlight
    filterSearch.value = 'Dr. Smith';
    filterSearch.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('active filters: non-empty search input receives filter-active',
      filterSearch.classList.contains('filter-active'));

    filterSearch.value = '';
    filterSearch.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('active filters: cleared search input removes filter-active',
      !filterSearch.classList.contains('filter-active'));

    filterCourse.value = 'Sales';
    filterCourse.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('active filters: non-empty course input receives filter-active',
      filterCourse.classList.contains('filter-active'));

    filterCourse.value = '   ';
    filterCourse.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('active filters: whitespace-only course input removes filter-active',
      !filterCourse.classList.contains('filter-active'));

    // Select dropdown changes trigger highlight
    filterEvent.value = 'Sales Seminar A';
    filterEvent.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: selected event dropdown receives filter-active',
      filterEvent.classList.contains('filter-active'));

    filterEvent.value = 'ALL';
    filterEvent.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: reset event dropdown removes filter-active',
      !filterEvent.classList.contains('filter-active'));

    filterStatus.value = 'pending';
    filterStatus.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: selected status dropdown receives filter-active',
      filterStatus.classList.contains('filter-active'));

    filterStatus.value = 'ALL';
    filterStatus.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: reset status dropdown removes filter-active',
      !filterStatus.classList.contains('filter-active'));

    filterExpired.value = 'has_expired';
    filterExpired.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: selected expired dropdown receives filter-active',
      filterExpired.classList.contains('filter-active'));

    filterExpired.value = 'ALL';
    filterExpired.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('active filters: reset expired dropdown removes filter-active',
      !filterExpired.classList.contains('filter-active'));

    // 3. Livestream matching checks
    check('livestream matching: itemMatchesSeminar matches various Livestream separators',
      itemMatchesSeminar({ 'Services': 'Sales Seminar A Livestream' }, 'Sales Seminar A') &&
      itemMatchesSeminar({ 'Services': 'Sales Seminar A - Livestream' }, 'Sales Seminar A') &&
      itemMatchesSeminar({ 'Services': 'Sales Seminar A – Livestream' }, 'Sales Seminar A') &&
      itemMatchesSeminar({ 'Services': 'Sales Seminar A: Livestream' }, 'Sales Seminar A') &&
      itemMatchesSeminar({ 'Services': 'Sales Seminar A : Livestream' }, 'Sales Seminar A') &&
      itemMatchesSeminar({ 'Services': 'Sales Seminar A' }, 'Sales Seminar A') &&
      !itemMatchesSeminar({ 'Services': 'Sales Seminar A - Livestream' }, 'Marketing Seminar'));

    check('livestream matching: findMatchingSeminar identifies seminar from livestream record',
      findMatchingSeminar({ 'Services': 'Sales Seminar A - Livestream' }) === 'Sales Seminar A' &&
      findMatchingSeminar({ 'Services': 'Marketing Seminar Livestream' }) === 'Marketing Seminar' &&
      findMatchingSeminar({ 'Services': 'Conditions & Statistic Management Seminar – Livestream' }) === 'Conditions & Statistic Management Seminar');

    // 4. Export dates with Livestream label
    const lsRecords = [
      { 'Services': 'Sales Seminar A - Livestream', 'Month / Dates': '10/05' },
      { 'Services': 'Sales Seminar A', 'Month / Dates': '11/12' },
      { 'Services': 'Marketing Seminar Livestream', 'Month / Dates': '12/01' },
      { 'Services': 'Sales Seminar A - Livestream', 'Month / Dates': '10/05' } // duplicate date
    ];

    check('export dates: livestream dates marked with " (Livestream)" and de-duplicated',
      formatScheduledDates(lsRecords, 'Sales Seminar A') === '10/05 (Livestream) | 11/12' &&
      formatScheduledDates(lsRecords, 'Marketing Seminar') === '12/01 (Livestream)');

    check('export dates: All Events marks livestream dates with seminar label and "(Livestream)"',
      formatScheduledDates(lsRecords, 'All Events') === 'Sales Seminar A: 10/05 (Livestream) | Sales Seminar A: 11/12 | Marketing Seminar: 12/01 (Livestream)');

    // 5. Bucket classification invariance test
    const MGEBuckets = require(path.join(EXT, 'lib/buckets.js'));
    const testClients = [
      { clientId: '1', doctorName: 'Doc A', consultant: 'C1', accountStatus: 'Active' },
      { clientId: '2', doctorName: 'Doc B', consultant: 'C2', accountStatus: 'Active' }
    ];
    const testBacklog = [
      { clientId: '1', itemName: 'Sales Seminar A', amount: '1000', completionStatus: 'UNCOMPLETED' },
      { clientId: '2', itemName: 'Sales Seminar A', amount: '1000', completionStatus: 'UNCOMPLETED' }
    ];
    const pdfStandard = [
      { clientInternalId: '1', monthDates: '10/05-10/07', services: 'Sales Seminar A', location: 'FL' },
      { clientInternalId: '2', monthDates: 'NO DATES', services: 'None', location: 'FL' }
    ];
    const pdfLivestream = [
      { clientInternalId: '1', monthDates: '10/05-10/07', services: 'Sales Seminar A - Livestream', location: 'FL' },
      { clientInternalId: '2', monthDates: 'NO DATES', services: 'None', location: 'FL' }
    ];

    const resStandard = MGEBuckets.computeBuckets({ clients: testClients, pdf: pdfStandard, backlog: testBacklog });
    const resLivestream = MGEBuckets.computeBuckets({ clients: testClients, pdf: pdfLivestream, backlog: testBacklog });

    check('bucket invariance: classification identical with and without livestream variants',
      resStandard.pending === resLivestream.pending &&
      resStandard.incomplete === resLivestream.incomplete &&
      resStandard.complete === resLivestream.complete &&
      resLivestream.incomplete === 1 &&
      resLivestream.pending === 1);

    w.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (${results.filter((r) => r.skipped).length} skipped).`);
  process.exit(failed.length ? 1 : 0);
}

// jsdom lacks innerText and gives each iframe its own prototypes: patch lazily on access.
function patchIframes(w, onWindow) {
  const proto = w.HTMLIFrameElement.prototype;
  for (const prop of ['contentWindow', 'contentDocument']) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, { configurable: true, get() {
      const v = d.get.call(this);
      const cw = prop === 'contentWindow' ? v : v && v.defaultView;
      if (cw && cw.HTMLElement && !cw.__mgePatched) {
        Object.defineProperty(cw.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
        cw.__mgePatched = true;
        if (onWindow) onWindow(cw);
      }
      return v;
    } });
  }
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
