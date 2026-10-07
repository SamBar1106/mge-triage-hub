'use strict';

const { hubError } = require('./errors');

const REAL_BUCKETS = ['PENDING_SCHEDULE', 'SCHEDULE_INCOMPLETE', 'PROGRAM_COMPLETE'];
const BUCKET_MAP = {
  pending: 'PENDING_SCHEDULE',
  incomplete: 'SCHEDULE_INCOMPLETE',
  complete: 'PROGRAM_COMPLETE',
  all: 'ALL'
};

const NOT_IN_CLI = 'not available in CLI';

function events(sandbox) {
  return Object.keys(sandbox.window.EVENT_MAPPINGS || {});
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function closeEventNames(input, names) {
  const q = String(input || '').toLowerCase();
  const scored = names.map((name) => {
    const n = name.toLowerCase();
    let score = levenshtein(q, n);
    if (n.includes(q) || (q && n && q.includes(n))) score = Math.min(score, 2);
    const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (tokens.some((t) => n.includes(t))) score = Math.min(score, 3);
    return { name, score };
  });
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.filter((s) => s.score <= 4).slice(0, 5).map((s) => s.name);
}

function resolveEvent(input, names) {
  if (!input) return '';
  const exact = names.find((n) => n === input);
  if (exact) return exact;
  const folded = names.find((n) => n.toLowerCase() === String(input).toLowerCase());
  if (folded) return folded;
  const matches = closeEventNames(input, names);
  throw hubError(1, `unknown event "${input}". close matches: ${matches.length ? matches.join(', ') : 'none'}`);
}

function syncEventSelect(sandbox, eventName) {
  const el = sandbox.document.getElementById('filter-event');
  if (!eventName) {
    el.value = 'ALL';
    el.selectedIndex = 0;
    el.options = [{ value: 'ALL', text: 'All Events', textContent: 'All Events' }];
    return;
  }
  el.value = eventName;
  el.selectedIndex = 0;
  el.options = [{ value: eventName, text: eventName, textContent: eventName }];
}

function applyFilters(sandbox, opts) {
  const state = sandbox.__state;
  state.searchQuery = opts.search || '';
  state.courseQuery = opts.course || '';
  state.consultantFilter = opts.consultant || '';
  state.expiredFilter = opts.expired === 'has' ? 'has_expired' : opts.expired === 'no' ? 'no_expired' : 'ALL';
  state.eventFilter = opts.event || 'ALL';
  state.statusFilter = opts.itemStatus || 'ALL';
  syncEventSelect(sandbox, opts.event || '');
}

function splitCsvRecords(text) {
  const records = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.length) records.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length) records.push(cur);
  return records;
}

function clientsFor(sandbox, bucketKey) {
  const state = sandbox.__state;
  if (bucketKey === 'all') {
    // The page button sets activeBucket to "ALL", and getFilteredClients compares
    // that to c.bucket, so the button matches nobody. Union the three real buckets.
    const order = Array.from(state.clients.keys());
    const matched = new Map();
    REAL_BUCKETS.forEach((name) => {
      state.activeBucket = name;
      sandbox.getFilteredClients().forEach((c) => matched.set(c.clientId, c));
    });
    return order.filter((id) => matched.has(id)).map((id) => matched.get(id));
  }
  state.activeBucket = BUCKET_MAP[bucketKey];
  return sandbox.getFilteredClients();
}

function csvFor(sandbox, bucketKey, clients) {
  const state = sandbox.__state;
  if (bucketKey !== 'all') {
    state.activeBucket = BUCKET_MAP[bucketKey];
    return sandbox.exportCSV().csvContent;
  }
  const lineById = new Map();
  let header = 'Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar';
  REAL_BUCKETS.forEach((name) => {
    state.activeBucket = name;
    const ids = sandbox.getFilteredClients().map((c) => c.clientId);
    const records = splitCsvRecords(sandbox.exportCSV().csvContent);
    if (records[0]) header = records[0];
    ids.forEach((id, i) => { if (records[i + 1] != null) lineById.set(id, records[i + 1]); });
  });
  const body = [];
  clients.forEach((c) => { if (lineById.has(c.clientId)) body.push(lineById.get(c.clientId)); });
  if (!body.length) return header + '\n';
  return header + '\n' + body.join('\n') + '\n';
}

function zipRows(sandbox, clients, csvContent) {
  const parsed = sandbox.parseCSV(csvContent);
  if (parsed.length !== clients.length) throw hubError(1, 'export row mismatch');
  return parsed.map((row, i) => Object.assign({ clientId: clients[i].clientId }, row));
}

function cap(items, limit) {
  const shown = items.slice(0, limit);
  return { shown, more: items.length - shown.length, total: items.length };
}

function linesWithMore(lines, more) {
  const out = lines.slice();
  if (more > 0) out.push(more + ' more');
  return out;
}

function isOwnerContact(contact) {
  const post = (contact['Position / Post'] || '').toLowerCase();
  return post.includes('doctor - owner') || post.includes('owner');
}

function contactView(contact) {
  return {
    name: contact['Contact Name'] || '',
    position: contact['Position / Post'] || '',
    email: contact['Primary Email'] || '',
    cell: contact['Cell Phone 1'] || '',
    url: contact['Contact Direct URL'] || '',
    owner: isOwnerContact(contact)
  };
}

function orderedContacts(contacts) {
  const list = contacts || [];
  return list.filter(isOwnerContact).map(contactView).concat(list.filter((c) => !isOwnerContact(c)).map(contactView));
}

function backlogView(item) {
  return {
    itemName: item['Item Name'] || '',
    memo: item['Memo'] || '',
    amount: item.numericAmount || 0,
    completionStatus: item['Completion Status'] || '',
    isScheduled: !!item.isScheduled,
    isExpired: !!item.isExpired
  };
}

function itemLabel(item) {
  if (item.isScheduled) return 'scheduled';
  if (item.isExpired) return 'expired';
  return 'pending';
}

async function renderStatus(sandbox, lastRunText) {
  sandbox.fetch = async (url) => {
    if (lastRunText && String(url).includes('last_run.json')) {
      return { ok: true, text: async () => lastRunText };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const orig = sandbox.Date.prototype.toLocaleString;
  sandbox.Date.prototype.toLocaleString = function (locales, opts) {
    return orig.call(this, 'en-US', Object.assign({}, opts, { timeZone: 'America/Chicago' }));
  };
  try {
    await sandbox.loadRunStatus();
  } finally {
    sandbox.Date.prototype.toLocaleString = orig;
  }
  const el = sandbox.document.getElementById('data-updated');
  return {
    text: el.textContent || '',
    className: el.className || '',
    title: el.title || ''
  };
}

function textEl(sandbox, id) {
  return sandbox.document.getElementById(id).textContent || '';
}

function buildData(sandbox, texts) {
  try {
    sandbox.buildFromTexts(texts);
  } catch (e) {
    throw hubError(1, 'could not build hub data');
  }
  if (!sandbox.__state.clients || sandbox.__state.clients.size === 0) {
    throw hubError(1, 'no clients loaded');
  }
}

async function decryptTexts(sandbox, encFiles, passphrase) {
  const datasets = sandbox.__datasets;
  const texts = { clients: '', contacts: '', pdf: '', backlog: '' };
  await Promise.all(Object.keys(datasets).map(async (key) => {
    const name = datasets[key].file + '.enc';
    const raw = encFiles[name];
    if (raw == null) throw hubError(1, 'missing encrypted file ' + name);
    let obj;
    try { obj = JSON.parse(raw); } catch (e) {
      throw hubError(2, 'could not decrypt: wrong passphrase or tampered file');
    }
    try {
      texts[key] = await sandbox.MGECrypto.decryptToText(obj, passphrase);
    } catch (e) {
      throw hubError(2, 'could not decrypt: wrong passphrase or tampered file');
    }
  }));
  return texts;
}

async function execute(sandbox, opts, data) {
  const texts = await decryptTexts(sandbox, data.enc, opts.passphrase);
  buildData(sandbox, texts);
  if (opts.eventInput && (opts.command === 'list' || opts.command === 'schedule')) {
    opts.event = resolveEvent(opts.eventInput, events(sandbox));
  }

  switch (opts.command) {
    case 'status': return statusCommand(sandbox, data.lastRun);
    case 'buckets': return bucketsCommand(sandbox);
    case 'find': return findCommand(sandbox, opts);
    case 'client': return clientCommand(sandbox, opts);
    case 'list': return listCommand(sandbox, opts);
    case 'schedule': return scheduleCommand(sandbox, opts);
    case 'flags': return flagsCommand(sandbox, opts);
    case 'events': return eventsCommand(events(sandbox), opts);
    default: throw hubError(1, 'unknown command');
  }
}

async function statusCommand(sandbox, lastRunText) {
  const rendered = await renderStatus(sandbox, lastRunText);
  let run = null;
  if (lastRunText) {
    try { run = JSON.parse(lastRunText); } catch (e) { run = null; }
  }
  const payload = {
    command: 'status',
    text: rendered.text,
    className: rendered.className,
    title: rendered.title,
    run,
    dnc: NOT_IN_CLI,
    triage: NOT_IN_CLI
  };
  const lines = [rendered.text || 'no scrape status', 'dnc: ' + NOT_IN_CLI, 'triage: ' + NOT_IN_CLI];
  return { payload, lines };
}

function bucketsCommand(sandbox) {
  const counts = {
    pending: textEl(sandbox, 'b-count-pending'),
    incomplete: textEl(sandbox, 'b-count-incomplete'),
    complete: textEl(sandbox, 'b-count-complete'),
    total: textEl(sandbox, 'b-count-all')
  };
  const kpis = {
    pending: textEl(sandbox, 'kpi-pending-val'),
    incomplete: textEl(sandbox, 'kpi-incomplete-val'),
    clientsInView: textEl(sandbox, 'kpi-clients-count'),
    complete: textEl(sandbox, 'kpi-complete-count')
  };
  const payload = { command: 'buckets', counts, kpis };
  const lines = [
    'pending: ' + counts.pending,
    'incomplete: ' + counts.incomplete,
    'complete: ' + counts.complete,
    'total: ' + counts.total,
    'pending $: ' + kpis.pending,
    'incomplete $: ' + kpis.incomplete,
    'doctors in view: ' + kpis.clientsInView,
    'complete count: ' + kpis.complete
  ];
  return { payload, lines };
}

function findCommand(sandbox, opts) {
  applyFilters(sandbox, {
    search: opts.query,
    course: '',
    consultant: '',
    expired: '',
    event: '',
    itemStatus: ''
  });
  const hits = clientsFor(sandbox, 'all').map((c) => ({
    clientId: c.clientId,
    doctor: c.doctorName || '',
    company: c.companyName || '',
    bucket: c.bucket,
    consultant: c.consultant || '',
    pendingCount: c.pendingItemsCount,
    pendingAmount: c.pendingAmount,
    expiredCount: (c.backlogItems || []).filter((i) => i.isExpired).length,
    scheduledDates: sandbox.formatScheduledDates(c.pdfRecords, 'All Events')
  }));
  const view = cap(hits, opts.limit);
  const lines = view.shown.map((h) => [
    h.clientId,
    h.doctor,
    h.company,
    h.bucket,
    h.consultant,
    'pending ' + h.pendingCount + ' $' + h.pendingAmount,
    'expired ' + h.expiredCount,
    'dates: ' + (h.scheduledDates || '')
  ].join('  '));
  return {
    payload: { command: 'find', query: opts.query, count: hits.length, hits },
    lines: linesWithMore(lines, view.more)
  };
}

function clientCommand(sandbox, opts) {
  const client = sandbox.__state.clients.get(opts.clientId);
  if (!client) throw hubError(1, 'no such client');
  const contacts = orderedContacts(client.contacts);
  const backlog = (client.backlogItems || []).map(backlogView);
  const pdfUrl = client.pdfRecords && client.pdfRecords.length ? (client.pdfRecords[0]['PDF Schedule URL'] || '') : '';
  const payload = {
    command: 'client',
    clientId: client.clientId,
    doctor: client.doctorName || '',
    company: client.companyName || '',
    bucket: client.bucket,
    consultant: client.consultant || '',
    accountStatus: client.accountStatus || '',
    email: client.doctorEmail || '',
    phone: client.workPhone || '',
    pendingCount: client.pendingItemsCount,
    pendingAmount: client.pendingAmount,
    expiredCount: (client.backlogItems || []).filter((i) => i.isExpired).length,
    pdfStatus: client.pdfStatus || '',
    scheduledDates: sandbox.formatScheduledDates(client.pdfRecords, 'All Events'),
    pdfScheduleUrl: pdfUrl,
    clientUrl: client.clientUrl || '',
    dashboardUrl: client.dashboardUrl || '',
    contacts,
    backlog,
    dnc: NOT_IN_CLI,
    triage: NOT_IN_CLI
  };
  const contactViewRows = cap(contacts, opts.limit);
  const backlogViewRows = cap(backlog, opts.limit);
  const lines = [
    payload.clientId + '  ' + payload.doctor,
    'company: ' + payload.company,
    'bucket: ' + payload.bucket,
    'consultant: ' + payload.consultant,
    'account: ' + payload.accountStatus,
    'email: ' + payload.email,
    'phone: ' + payload.phone,
    'pending: ' + payload.pendingCount + ' $' + payload.pendingAmount,
    'expired: ' + payload.expiredCount,
    'pdf: ' + payload.pdfStatus,
    'dates: ' + (payload.scheduledDates || ''),
    'pdf url: ' + payload.pdfScheduleUrl,
    'client url: ' + payload.clientUrl,
    'dashboard url: ' + payload.dashboardUrl,
    'contacts:'
  ];
  contactViewRows.shown.forEach((c) => {
    lines.push('  ' + [c.name, c.position, c.email, c.cell].join(' | '));
  });
  if (contactViewRows.more) lines.push(contactViewRows.more + ' more');
  lines.push('backlog:');
  backlogViewRows.shown.forEach((item) => {
    lines.push('  ' + item.itemName + '  ' + itemLabel(item) + '  $' + item.amount + '  scheduled=' + item.isScheduled + ' expired=' + item.isExpired);
  });
  if (backlogViewRows.more) lines.push(backlogViewRows.more + ' more');
  lines.push('dnc: ' + NOT_IN_CLI);
  lines.push('triage: ' + NOT_IN_CLI);
  return { payload, lines };
}

function listCommand(sandbox, opts) {
  applyFilters(sandbox, opts);
  const clients = clientsFor(sandbox, opts.bucket);
  const csvContent = csvFor(sandbox, opts.bucket, clients);
  const rows = zipRows(sandbox, clients, csvContent);
  const fileName = sandbox.getExportFileName(sandbox.getSelectedSeminar());
  const view = cap(rows, opts.limit);
  const cols = ['clientId', 'Client Name', 'Company Name', 'Email', 'Phone', 'Pending Items', 'Pending Amount', 'Scheduled Dates', 'Seminar'];
  const lines = view.shown.map((row) => cols.map((c) => row[c] == null ? '' : row[c]).join(' | '));
  return {
    payload: { command: 'list', bucket: opts.bucket, count: rows.length, fileName, rows, csvContent },
    lines: linesWithMore(lines, view.more)
  };
}

function scheduleCommand(sandbox, opts) {
  const seminar = opts.event || 'All Events';
  const rows = [];
  sandbox.__state.clients.forEach((c) => {
    const dates = sandbox.formatScheduledDates(c.pdfRecords, seminar);
    if (dates) {
      rows.push({
        clientId: c.clientId,
        doctor: c.doctorName || '',
        company: c.companyName || '',
        dates
      });
    }
  });
  const view = cap(rows, opts.limit);
  const lines = view.shown.map((r) => r.clientId + '  ' + r.doctor + '  ' + r.dates);
  return {
    payload: { command: 'schedule', event: seminar, count: rows.length, rows },
    lines: linesWithMore(lines, view.more)
  };
}

function flagsCommand(sandbox, opts) {
  const all = Array.from(sandbox.__state.clients.values());
  const expired = all.filter((c) => (c.backlogItems || []).some((i) => i.isExpired)).map((c) => ({
    clientId: c.clientId,
    doctor: c.doctorName || '',
    company: c.companyName || '',
    bucket: c.bucket,
    expiredCount: c.backlogItems.filter((i) => i.isExpired).length,
    items: c.backlogItems.filter((i) => i.isExpired).map(backlogView)
  }));
  const pendingSchedule = all.filter((c) => c.bucket === 'PENDING_SCHEDULE')
    .slice()
    .sort((a, b) => b.pendingAmount - a.pendingAmount)
    .map((c) => ({
      clientId: c.clientId,
      doctor: c.doctorName || '',
      company: c.companyName || '',
      consultant: c.consultant || '',
      pendingCount: c.pendingItemsCount,
      pendingAmount: c.pendingAmount
    }));
  const scheduleIncomplete = all.filter((c) => c.bucket === 'SCHEDULE_INCOMPLETE').map((c) => ({
    clientId: c.clientId,
    doctor: c.doctorName || '',
    company: c.companyName || '',
    consultant: c.consultant || '',
    pendingItems: (c.backlogItems || []).filter((i) => !i.isScheduled && !i.isExpired).map(backlogView)
  }));
  const payload = { command: 'flags', expired, pendingSchedule, scheduleIncomplete };
  const exp = cap(expired, opts.limit);
  const pend = cap(pendingSchedule, opts.limit);
  const inc = cap(scheduleIncomplete, opts.limit);
  const lines = ['expired:'];
  exp.shown.forEach((c) => lines.push('  ' + c.clientId + '  ' + c.doctor + '  expired ' + c.expiredCount));
  if (exp.more) lines.push(exp.more + ' more');
  lines.push('pending by amount:');
  pend.shown.forEach((c) => lines.push('  ' + c.clientId + '  ' + c.doctor + '  $' + c.pendingAmount));
  if (pend.more) lines.push(pend.more + ' more');
  lines.push('incomplete:');
  inc.shown.forEach((c) => {
    const items = (c.pendingItems || []).map((i) => i.itemName + ' $' + i.amount).join('; ');
    lines.push('  ' + c.clientId + '  ' + c.doctor + '  ' + items);
  });
  if (inc.more) lines.push(inc.more + ' more');
  return { payload, lines };
}

function eventsCommand(names, opts) {
  const view = cap(names, opts.limit);
  return {
    payload: { command: 'events', events: names },
    lines: linesWithMore(view.shown, view.more)
  };
}

module.exports = {
  execute,
  resolveEvent,
  events,
  BUCKET_MAP,
  NOT_IN_CLI
};
