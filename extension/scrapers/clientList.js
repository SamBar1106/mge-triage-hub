/*
 * NEW: Active Client List scraper (NetSuite saved search results page, e.g. searchresults.nl?searchid=72).
 * Self-contained: injected with chrome.scripting.executeScript({ func: scrapeActiveClientList }).
 * - Columns are located by HEADER TEXT (fixes the fixed-index off-by-one in the old scrapers).
 * - Follows pagination (segment <select> / next links) and de-duplicates by Client ID.
 * - Output rows are clients_directory.csv-compatible (see MGECsv.CLIENT_HEADERS), plus a "queue"
 *   used by the PDF and backlog scrapers (same fields the originals read from the table).
 * Returns { ok, headers, rows, queue, meta } or { ok:false, error }.
 */
async function scrapeActiveClientList(opts) {
  opts = opts || {};
  const origin = opts.origin || location.origin;
  const maxPages = opts.maxPages || 200;
  const HEADERS = ['Client ID', 'Doctor Name', 'Consultant', 'Account Status', 'Doctor Email',
    'Work Phone', 'Default Address', 'Client URL', 'Dashboard URL'];

  const clean = (s) => String(s || '').replace(/[\u00a0\s]+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();
  // Values that are just a NetSuite label / placeholder => blank.
  const PLACEHOLDER = /^(name|customer id|company name|email( \d)?|alt\.? email|work phone( \d)?|phone|home phone|cell phone( \d)?|address|position\/post|contact|status|consultant|n\/a|-? ?none ?-?|&nbsp;)$/i;
  const LABEL_PREFIX = /^(Email \d? ?|Work Phone \d? ?|Phone |Status |Consultant )(?=\S)/;
  const val = (s) => { let v = clean(s); if (PLACEHOLDER.test(v)) return ''; v = v.replace(LABEL_PREFIX, ''); return PLACEHOLDER.test(v) ? '' : v; };

  function headerCellsOf(doc) {
    const hr = doc.querySelector('#div__body tr.uir-list-headerrow') || doc.querySelector('tr.uir-list-headerrow') ||
      doc.getElementById('div__labtab');
    return hr ? Array.from(hr.querySelectorAll('td,th')) : [];
  }

  function parseDoc(doc) {
    const body = doc.getElementById('div__body');
    if (!body) return { error: 'NO_RESULTS_TABLE' };
    const hcells = headerCellsOf(doc);
    const headers = hcells.map((c) => norm(c.textContent));
    const find = (...names) => {
      for (const n of names) { const i = headers.indexOf(norm(n)); if (i >= 0) return i; }
      for (const n of names) { const i = headers.findIndex((h) => h.startsWith(norm(n))); if (i >= 0) return i; }
      return -1;
    };
    const col = {
      last: find('Last Name'), first: find('First Name'), name: find('Name', 'Client', 'Customer'),
      phone: find('Phone', 'Work Phone', 'Main Phone'), email: find('Email', 'E-mail'),
      b1: find('Billing Address 1'), b2: find('Billing Address 2'), city: find('Billing City'),
      state: find('Billing State/Province', 'Billing State'), zip: find('Billing Zip'), country: find('Billing Country'),
      consultant: find('Consultant'), status: find('Status', 'Account Status')
    };
    const required = ['last', 'first', 'email', 'phone', 'consultant', 'status'];
    const missing = required.filter((k) => col[k] < 0);

    const rows = Array.from(body.querySelectorAll("tr.uir-list-row-tr, tr[id^='row']"));
    const out = [];
    let offsetRows = 0;
    for (const r of rows) {
      const link = r.querySelector("a[href*='custjob.nl'], a[href*='customer.nl']");
      if (!link) continue;
      const m = (link.getAttribute('href') || '').match(/[?&]id=(\d+)/);
      if (!m) continue;
      const tds = Array.from(r.querySelectorAll('td'));
      // If the data row has more/fewer cells than the header row, assume the difference is at the
      // start (edit/select columns) and shift header indexes accordingly.
      const off = hcells.length ? tds.length - hcells.length : 0;
      if (off !== 0) offsetRows++;
      const get = (i) => (i < 0 ? '' : val(tds[i + off] ? tds[i + off].textContent : ''));
      let email = get(col.email);
      if (email && !email.includes('@')) email = '';
      if (!email) {
        const a = r.querySelector('a[href^="mailto:"]');
        if (a) email = clean(a.textContent) || clean((a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]);
        if (!email.includes('@')) email = '';
      }
      const first = get(col.first), last = get(col.last);
      const cityLine = [get(col.city), [get(col.state), get(col.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const address = [get(col.b1), get(col.b2), cityLine, get(col.country)].filter(Boolean).join(', ');
      out.push({
        clientId: m[1],
        firstName: first, lastName: last,
        doctorName: `${first} ${last}`.trim() || get(col.name),
        consultant: get(col.consultant), status: get(col.status),
        email, phone: get(col.phone), address
      });
    }
    return { rows: out, missing, headerCount: hcells.length, rowCells: rows[0] ? rows[0].querySelectorAll('td').length : 0, offsetRows };
  }

  function pageLinks(doc, baseHref) {
    const urls = [];
    const seg = doc.querySelector('select[name="segment"], select#segment, select[name$="_segment"]');
    if (seg) {
      for (const o of Array.from(seg.options || [])) {
        if (o.selected || !o.value) continue;
        try { const u = new URL(baseHref); u.searchParams.set(seg.name || 'segment', o.value); urls.push(u.href); } catch (e) {}
      }
    }
    doc.querySelectorAll('a[href*="segment="], a.uir-pagination-next, a[aria-label="Next page"]').forEach((a) => {
      try { urls.push(new URL(a.getAttribute('href'), baseHref).href); } catch (e) {}
    });
    return urls;
  }

  const first = parseDoc(document);
  if (first.error) return { ok: false, error: first.error };
  const all = first.rows.slice();
  const visited = new Set([location.href]);
  const todo = pageLinks(document, location.href);
  let pages = 1;
  while (todo.length && pages < maxPages) {
    const u = todo.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    try {
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) continue;
      const d = new DOMParser().parseFromString(await res.text(), 'text/html');
      const p = parseDoc(d);
      if (p.error) continue;
      pages++;
      all.push(...p.rows);
      pageLinks(d, u).forEach((x) => { if (!visited.has(x)) todo.push(x); });
    } catch (e) { /* skip page */ }
  }

  const seen = new Set();
  const uniq = all.filter((r) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true)));
  const rows = uniq.map((r) => [
    r.clientId, r.doctorName, r.consultant, r.status, r.email, r.phone, r.address,
    `${origin}/app/common/entity/custjob.nl?id=${r.clientId}`,
    `${origin}/app/center/card.nl?sc=-69&entityid=${r.clientId}`
  ]);
  const queue = uniq.map((r) => ({
    clientId: r.clientId, firstName: r.firstName, lastName: r.lastName,
    name: `${r.firstName} ${r.lastName}`.trim() || `Client #${r.clientId}`,
    email: r.email, consultant: r.consultant || 'Unassigned'
  }));
  return {
    ok: true, headers: HEADERS, rows, queue,
    meta: { pages, rawRows: all.length, rowCount: rows.length, missingColumns: first.missing,
      headerCount: first.headerCount, rowCells: first.rowCells, offsetRows: first.offsetRows }
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { scrapeActiveClientList };
