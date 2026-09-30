
const firebaseConfig = {
  apiKey: "AIzaSyA9eTDnW2HK5yPOPTPFpJaTQ-QNvMDqGM",
  authDomain: "newagent-8678e.firebaseapp.com",
  databaseURL: "https://newagent-8678e.firebaseio.com",
  projectId: "newagent-8678e",
  storageBucket: "newagent-8678e.firebasestorage.app",
  messagingSenderId: "704368176818",
  appId: "1:704368176818:web:15b9c1e46d3fe5aeec23ab"
};
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

window.toggleDNC = function(clientId) {
    if (typeof firebase === 'undefined') return;
    const isCurrentlyDNC = !!state.dncList[clientId];
    firebase.database().ref('dncList/' + clientId).set(!isCurrentlyDNC);
};


const EVENT_MAPPINGS = {
  "Conditions & Statistic Management Seminar": [
    "conditions & statistics management seminar",
    "conditions & statistic management seminar",
    "conditions & statistic management seminar - dr.",
    "conditions & statistic management seminar – om",
    "conditions & statistic management seminar: om"
  ],
  "DSO Summit": ["dso summit"],
  "Financial Planning & Profitability Seminar": [
    "financial planning & profitability seminar",
    "financial planning & profitability seminar - dr.",
    "financial planning & profitability seminar – om"
  ],
  "Get Out of Network Blueprint": ["get out of network blueprint"],
  "Management Tools & Troubleshooting Seminar": [
    "management tools & troubleshooting seminar",
    "management tools & troubleshooting seminar - dr.",
    "management tools & troubleshooting seminar – om"
  ],
  "Marketing Seminar": ["marketing seminar"],
  "New Patient Workshop": ["new patient workshop"],
  "OM Bootcamp": ["om bootcamp"],
  "Organizing Board & Teambuilding Seminar": [
    "organizing board & teambuilding seminar",
    "organizing board & teambuilding seminar - dr.",
    "organizing board & teambuilding seminar – om"
  ],
  "Owner's Conference": ["owner's conference"],
  "Sales Seminar A": ["sales seminar a", "sales seminar a - in person only"],
  "Sales Seminar B": ["sales seminar b", "sales seminar b - in person only"],
  "Sales Seminar C": ["sales seminar c", "sales seminar c - in person only"],
  "Sales Team Bootcamp": ["sales team bootcamp"],
  "Scheduling for Production Seminar": ["scheduling for production seminar"],
  "The Goals & Strategic Planning Workshop": ["the goals & strategic planning workshop", "goals & strategic planning workshop"]
};

function itemMatchesSeminar(item, seminar) {
  if (!seminar || seminar === 'ALL' || seminar === 'All Events') return false;
  if (typeof EVENT_MAPPINGS === 'undefined' || !EVENT_MAPPINGS[seminar]) return false;
  const raw = typeof item === 'string'
    ? item
    : (item && (item['Item Name'] || item['Services'] || item.itemName || item.services || '')) || '';
  const itemName = String(raw).replace(/\uFFFD/g, 'fi').toLowerCase().trim();
  if (!itemName) return false;
  const variants = EVENT_MAPPINGS[seminar];
  return variants.some(v => itemName.includes(v));
}

function findMatchingSeminar(item) {
  if (typeof EVENT_MAPPINGS === 'undefined') return null;
  for (const seminar in EVENT_MAPPINGS) {
    if (itemMatchesSeminar(item, seminar)) {
      return seminar;
    }
  }
  return null;
}


/**
 * MGE Training Scheduling & Triage Hub - Auditor Workflow Redesign
 */

const state = {
  dncList: {},
  clients: new Map(),
  selectedClientId: null,
  activeBucket: 'PENDING_SCHEDULE',
  searchQuery: '',
  courseQuery: '',
  consultantFilter: '',
  triageData: JSON.parse(localStorage.getItem('mge_triage_audit_v4') || '{}')
};

// === CHROMELESS POPUP WINDOW HELPER ===
window.openCleanWindow = function(url, title = 'NetSuitePopup') {
  if (!url || url === 'N/A') return;
  const w = 1280;
  const h = 880;
  const left = Math.max(0, (window.screen.width - w) / 2);
  const top = Math.max(0, (window.screen.height - h) / 2);
  const features = `toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,width=${w},height=${h},top=${top},left=${left}`;
  window.open(url, title, features);
};

// === RFC 4180 COMPLIANT CSV PARSER ===
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  const parseRow = (rowText) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < rowText.length; i++) {
      const char = rowText[i];
      const nextChar = rowText[i + 1];
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = parseRow(lines[0]);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === headers.length) {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = row[idx];
      });
      records.push(obj);
    }
  }
  return records;
}

// === DATA CLEANING ===
function cleanString(str) {
  if (!str) return '';
  let s = str.trim();
  // Strip common NetSuite export prefixes using a regex
  s = s.replace(/^(Name |Customer ID \d+ |Company Name |Email 2 |Email |Work Phone \d? |Home Phone |Cell Phone \d |Cell \d Name |Address |Position\/Post |Contact )/i, '').trim();
  return s;
}

// === DATASET SOURCES ===
// Preferred: encrypted files in data/enc/ (pushed nightly by the Chrome extension).
// Fallback 1: plaintext ./data/*.csv (local copies only; they are gitignored).
// Fallback 2: drag-and-drop (or "Load files") of plaintext .csv or encrypted .csv.enc files.
const DATASETS = {
  clients:  { file: 'clients_directory.csv',   signature: ['Client ID', 'Doctor Name'] },
  contacts: { file: 'contacts_directory.csv',  signature: ['Contact Internal ID', 'Parent Client ID'] },
  pdf:      { file: 'pdf_directory.csv',       signature: ['Client Internal ID', 'Month / Dates'] },
  backlog:  { file: 'unscheduled_backlog.csv', signature: ['Client ID', 'Item Name', 'Completion Status'] }
};
const PASS_KEY = 'mge_passphrase';
state.rawTexts = { clients: '', contacts: '', pdf: '', backlog: '' };

const stripBom = (t) => (t || '').replace(/^\uFEFF/, '');

function detectDataset(text, fileName) {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] || '';
  const headers = firstLine.split(',').map(h => h.replace(/^"|"$/g, '').trim());
  // Most specific first (backlog also has "Client ID").
  for (const key of ['backlog', 'pdf', 'contacts', 'clients']) {
    if (DATASETS[key].signature.every(h => headers.includes(h))) return key;
  }
  const n = (fileName || '').toLowerCase();
  for (const key of Object.keys(DATASETS)) if (n.startsWith(DATASETS[key].file.replace('.csv', ''))) return key;
  return null;
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.text() : null;
  } catch (e) { return null; }
}

function promptPassphraseModal(message) {
  return new Promise((resolve) => {
    // If in test environment where window.prompt is mocked (non-native function):
    if (typeof window.prompt === 'function' && !window.prompt.toString().includes('[native code]')) {
      const p = window.prompt(message);
      return resolve({ pass: p, remember: false });
    }
    const modal = document.getElementById('passphrase-modal');
    if (!modal) {
      const p = typeof window.prompt === 'function' ? window.prompt(message) : null;
      return resolve({ pass: p, remember: false });
    }
    const msgEl = document.getElementById('passphrase-prompt-message');
    const input = document.getElementById('passphrase-input');
    const cb = document.getElementById('remember-me-checkbox');
    const form = document.getElementById('passphrase-form');

    if (msgEl) msgEl.textContent = message;
    if (input) input.value = '';
    if (cb) cb.checked = false;

    modal.style.display = 'flex';
    if (input) input.focus();

    const onSubmit = (e) => {
      e.preventDefault();
      cleanup();
      modal.style.display = 'none';
      resolve({ pass: input ? input.value : '', remember: cb ? cb.checked : false });
    };

    function cleanup() {
      form.removeEventListener('submit', onSubmit);
    }
    form.addEventListener('submit', onSubmit);
  });
}

function forgetPassphrase() {
  localStorage.removeItem(PASS_KEY);
  sessionStorage.removeItem(PASS_KEY);
  if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
    try { window.location.reload(); } catch (e) {}
  }
}
window.mgeForgetPassphrase = forgetPassphrase;

// Ask for the team passphrase; read localStorage first, then sessionStorage.
async function getPassphrase(sampleEnc) {
  let pass = localStorage.getItem(PASS_KEY) || sessionStorage.getItem(PASS_KEY);
  if (pass) {
    try {
      await MGECrypto.decryptToText(sampleEnc, pass);
      return pass;
    } catch (e) {
      localStorage.removeItem(PASS_KEY);
      sessionStorage.removeItem(PASS_KEY);
      pass = null;
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const msg = attempt === 0
      ? 'Enter the team passphrase to unlock client data:'
      : 'Wrong passphrase. Try again:';
    const res = await promptPassphraseModal(msg);
    if (!res || !res.pass) return null;
    pass = res.pass;
    try {
      await MGECrypto.decryptToText(sampleEnc, pass);
      if (res.remember) {
        localStorage.setItem(PASS_KEY, pass);
        sessionStorage.removeItem(PASS_KEY);
      } else {
        sessionStorage.setItem(PASS_KEY, pass);
        localStorage.removeItem(PASS_KEY);
      }
      return pass;
    } catch (e) {
      localStorage.removeItem(PASS_KEY);
      sessionStorage.removeItem(PASS_KEY);
      pass = null;
    }
  }
  return null;
}

async function loadDatasets() {
  const texts = { clients: '', contacts: '', pdf: '', backlog: '' };
  const encs = {};
  await Promise.all(Object.keys(DATASETS).map(async key => {
    const t = await fetchText(`./data/enc/${DATASETS[key].file}.enc`);
    if (t && typeof MGECrypto !== 'undefined' && MGECrypto.isEncrypted(t)) encs[key] = JSON.parse(t);
  }));
  const encKeys = Object.keys(encs);
  if (encKeys.length) {
    const pass = await getPassphrase(encs[encKeys[0]]);
    if (pass) {
      await Promise.all(encKeys.map(async key => {
        try { texts[key] = await MGECrypto.decryptToText(encs[key], pass); }
        catch (e) { console.warn('Could not decrypt', key, e.message); }
      }));
    }
  }
  // Local plaintext fallback for anything still missing (not present on the public site).
  await Promise.all(Object.keys(DATASETS).map(async key => {
    if (texts[key]) return;
    const t = await fetchText(`./data/${DATASETS[key].file}`);
    if (t && detectDataset(t) === key) texts[key] = t;
  }));
  return texts;
}

async function loadRunStatus() {
  const el = document.getElementById('data-updated');
  if (!el) return;
  const t = await fetchText('./data/enc/last_run.json');
  if (!t) { el.textContent = ''; return; }
  try {
    const st = JSON.parse(t);
    const when = new Date(st.timestamp || st.finishedAt);
    const stamp = isNaN(when) ? '' : when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const isOk = st.status ? st.status === 'success' : !!st.ok;
    const fileTimes = Object.values(st.files || {}).map(f => new Date(f.updatedAt)).filter(d => !isNaN(d));
    const newest = fileTimes.length ? new Date(Math.max(...fileTimes)) : null;
    const newestStr = newest ? newest.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : stamp;
    el.textContent = isOk ? `Data updated ${stamp}` : `Last scrape failed ${stamp}${st.files ? ` · data from ${newestStr}` : ''}`;
    el.className = 'data-updated ' + (isOk ? 'ok' : 'stale');
    if (st.clients !== undefined && st.pending !== undefined) {
      el.title = `Clients: ${st.clients}, Pending: ${st.pending}`;
    } else {
      el.title = `Rows: ${Object.entries(st.files || {}).map(([n, f]) => `${n} ${f.rows}`).join(', ')}`;
    }
  } catch (e) { el.textContent = ''; }
}

// Manual fallback: drop (or pick) CSV / .csv.enc files; they replace the matching dataset.
async function loadFiles(files) {
  const list = Array.from(files || []);
  let pass = null;
  for (const f of list) {
    let text = await f.text();
    if (MGECrypto.isEncrypted(text)) {
      if (!pass) pass = await getPassphrase(JSON.parse(text));
      if (!pass) continue;
      try { text = await MGECrypto.decryptToText(text, pass); } catch (e) { alert(`Could not decrypt ${f.name}`); continue; }
    }
    const key = detectDataset(text, f.name);
    if (!key) { alert(`Not a recognised MGE CSV: ${f.name}`); continue; }
    state.rawTexts[key] = text;
  }
  buildFromTexts(state.rawTexts);
}
window.mgeLoadFiles = loadFiles;

function setupDropZone() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; overlay && overlay.classList.add('show'); });
  window.addEventListener('dragleave', e => { depth = Math.max(0, depth - 1); if (!depth && overlay) overlay.classList.remove('show'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; overlay && overlay.classList.remove('show');
    if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });
  const input = document.getElementById('file-input');
  document.getElementById('btn-load')?.addEventListener('click', () => input && input.click());
  input?.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
}

// === BOOTSTRAP: INGEST DATASETS ===
async function initApp() {
  setupEventListeners();
  setupDropZone();
  loadRunStatus();

  // Listen for DNC updates in real time
  if (typeof firebase !== 'undefined') {
      firebase.database().ref('dncList').on('value', (snapshot) => {
          state.dncList = snapshot.val() || {};
          renderClientList();
          if (state.selectedClientId && state.clients.has(state.selectedClientId)) {
              selectClient(state.selectedClientId);
          }
      });
  }

  const texts = await loadDatasets();
  state.rawTexts = texts;
  if (!texts.clients) {
    const listPane = document.getElementById('client-list');
    if (listPane) listPane.innerHTML = `<div class="empty-state"><p>No data loaded.</p><p class="empty-subtext">Reload and enter the team passphrase, or drag the CSV / .csv.enc files onto this page.</p></div>`;
    return;
  }
  buildFromTexts(texts);
}

function buildFromTexts(texts) {
  const statusEl = document.getElementById('load-status');
  try {
    const clientsData = parseCSV(stripBom(texts.clients));
    const contactsData = parseCSV(stripBom(texts.contacts));
    const pdfData = parseCSV(stripBom(texts.pdf));
    const backlogData = parseCSV(stripBom(texts.backlog));

    state.clients.clear();

    // 1. Build Client Index
    clientsData.forEach(c => {
      const id = String(c['Client ID']).trim();
      state.clients.set(id, {
        clientId: id,
        doctorName: cleanString(c['Doctor Name']),
        customerId: cleanString(c['Customer ID']),
        companyName: cleanString(c['Company Name']),
        isIndividual: c['Is Individual'],
        accountStatus: c['Account Status'],
        salesRep: c['Sales Rep'],
        consultant: c['Consultant'],
        doctorEmail: cleanString(c['Doctor Email']),
        altEmail: cleanString(c['Alt Email']),
        workPhone: cleanString(c['Work Phone']),
        cell1Number: cleanString(c['Cell Phone 1']),
        defaultAddress: cleanString(c['Default Address']),
        clientUrl: c['Client URL'],
        dashboardUrl: c['Dashboard URL'],
        contacts: [],
        pdfRecords: [],
        backlogItems: []
      });
    });

    // 2. Attach Contacts
    contactsData.forEach(contact => {
      const parentId = String(contact['Parent Client ID']).trim();
      if (state.clients.has(parentId)) {
        contact['Contact Name'] = cleanString(contact['Contact Name']);
        contact['Primary Email'] = cleanString(contact['Primary Email']);
        contact['Cell Phone 1'] = cleanString(contact['Cell Phone 1']);
        contact['Position / Post'] = cleanString(contact['Position / Post']);
        state.clients.get(parentId).contacts.push(contact);
      }
    });

    // 3. Attach PDF Records
    pdfData.forEach(pdf => {
      const clientId = String(pdf['Client Internal ID']).trim();
      if (state.clients.has(clientId)) {
        state.clients.get(clientId).pdfRecords.push(pdf);
      }
    });

    // 4. Attach Backlog Items
    const excludedItems = [
      "Additional Year for All-Inclusive 3 Year Program",
      "Materials for All-Inclusive 3 Year Program",
      "3rd Year of All-Inclusive 3 Year Program",
      "2nd Year of All-Inclusive 3 Year Program",
      "1st Year of All-Inclusive 3 Year Program",
      "Extra Attendee for Owners Conference",
      "Money Left on Account",
      "Get Out of Network Blueprint",
      "5th Year of All-Inclusive 5 Year Program",
      "4th Year of All-Inclusive 5 Year Program",
      "Unlimited MGE Services Part 1",
      "Unlimited MGE Services Part 2",
      "Unlimited MGE Services Part 3",
      "4th Year of All-Inclusive 4 Year Program",
      "9th Year of All-Inclusive 10 Year Program",
      "8th Year of All-Inclusive 10 Year Program",
      "7th Year of All-Inclusive 10 Year Program",
      "6th Year of All-Inclusive 10 Year Program",
      "10th Year of All-Inclusive 10 Year Program",
      "3rd Year of All-Inclusive 4 Year Program"
    ];

    backlogData.forEach(item => {
      const itemName = (item['Item Name'] || '').trim();
      if (excludedItems.includes(itemName)) {
        return; // Skip special items that don't need scheduling
      }
      
      const clientId = String(item['Client ID']).trim();
      if (state.clients.has(clientId)) {
        const amountStr = item['Amount'] || '0';
        item.numericAmount = parseFloat(amountStr.replace(/[^0-9.-]+/g, '')) || 0;
        state.clients.get(clientId).backlogItems.push(item);
      }
    });

    processClientBuckets();
    populateFilterDropdowns();

    if (statusEl) {
      statusEl.innerText = `Ready`;
      statusEl.className = 'badge badge-ready';
    }

    renderAll();

  } catch (err) {
    console.error('Initialization error:', err);
    if (statusEl) {
      statusEl.innerText = 'Load Failed';
      statusEl.className = 'badge badge-error';
    }
  }
}

// === LOGIC: CROSS-REFERENCE & BUCKET CLASSIFICATION ===
function processClientBuckets() {
  if (typeof MGEBuckets !== 'undefined' && MGEBuckets.classifyClient) {
    state.clients.forEach(client => MGEBuckets.classifyClient(client));
    return;
  }
  state.clients.forEach(client => {
    client.pdfRecords.sort((a, b) => b['Month / Dates'].localeCompare(a['Month / Dates']));
    
    // Check if client has *any* valid dates scheduled in PDF
    const hasDates = client.pdfRecords.some(pdf => {
      const dates = (pdf['Month / Dates'] || '').toUpperCase().trim();
      return dates !== 'NO DATES' && dates !== 'NO DATE' && dates !== 'N/A' && dates.length > 0;
    });

    client.pdfStatus = hasDates ? 'Has Dates' : 'No Dates';

    client.backlogItems.forEach(item => {
      item.isExpired = (item['Memo'] || '').toUpperCase().includes('EXPIRED');
      
      const itemName = (item['Item Name'] || '').toLowerCase().trim();
      const isCompleted = (item['Completion Status'] || '').toUpperCase() === 'COMPLETED';
      
      const isScheduledInPdf = client.pdfRecords.some(pdf => {
        let services = ((pdf['Location'] || '') + ' | ' + (pdf['Services'] || '') + ' | ' + (pdf['Month / Dates'] || '') + ' | ' + (pdf['Hours / Days'] || '')).toLowerCase();
        
        // Fix NetSuite PDF export ligature corruptions
        services = services.replace(/\uFFFD/g, 'fi');
        
        services = services.replace(/, courseroom/g, '')
                           .replace(/courseroom/g, '')
                           .replace(/, online/g, '')
                           .replace(/online/g, '')
                           .replace(/livestream/g, '');

        let normItem = itemName.replace(/- in person only/g, '').replace(/livestream/g, '').trim();

        let matched = false;
        
        // 1. Direct match
        if (services.includes(normItem)) {
            matched = true;
        }

        // 2. Cross-reference Event Mappings
        if (!matched && typeof EVENT_MAPPINGS !== 'undefined') {
            for (const title in EVENT_MAPPINGS) {
                const variants = EVENT_MAPPINGS[title];
                // Does this backlog item belong to this Event Group?
                if (variants.some(v => v.includes(itemName) || itemName.includes(v))) {
                    // Does the PDF contain ANY variant of this Event Group?
                    if (variants.some(v => services.includes(v.replace(/- in person only/g, '').replace(/livestream/g, '').trim()))) {
                        matched = true;
                        break;
                    }
                }
            }
        }

        if (matched) {
           if (itemName.includes('seminar')) {
               const hasSuffixMarker = itemName.match(/[-–:]/);
               const isDr = itemName.includes('dr.');
               const isInPerson = itemName.includes('in person');
               
               if (hasSuffixMarker && !isDr && !isInPerson) {
                   return false;
               }
           }
           return true;
        }
        return false;
      });
      
      item.isScheduled = isCompleted || isScheduledInPdf;
    });

    const activePendingItems = client.backlogItems.filter(item => !item.isScheduled && !item.isExpired);
    client.pendingItemsCount = activePendingItems.length;
    client.pendingAmount = activePendingItems.reduce((sum, item) => sum + item.numericAmount, 0);

    if (client.pendingItemsCount === 0) {
      client.bucket = 'PROGRAM_COMPLETE';
    } else if (hasDates) {
      client.bucket = 'SCHEDULE_INCOMPLETE';
    } else {
      client.bucket = 'PENDING_SCHEDULE';
    }
    client.backlogStatus = client.pendingItemsCount === 0 ? 'No Paid Items' : 'Items pending for Schedule';
  });
}

function getFilteredClients() {
  const query = (state.searchQuery || '').toLowerCase();
  const course = (state.courseQuery || '').toLowerCase();
  const consultant = state.consultantFilter || 'ALL';
  const expiredFilter = state.expiredFilter || 'ALL';
  const eventFilter = state.eventFilter || 'ALL';
  const statusFilter = state.statusFilter || 'ALL';

  return Array.from(state.clients.values()).filter(c => {
    const bucketMatch = c.bucket === state.activeBucket;
    
    const nameMatch = !query || c.doctorName.toLowerCase().includes(query) || 
                      (c.companyName || '').toLowerCase().includes(query) ||
                      (c.workPhone || '').includes(query) || 
                      (c.doctorEmail || '').toLowerCase().includes(query);
                      
    const courseMatch = !course || c.backlogItems.some(item => (item['Item Name']||'').toLowerCase().includes(course));
    const consultantMatch = !consultant || consultant === 'ALL' || consultant === '' || c.consultant === consultant;
    
    let expiredMatch = true;
    if (expiredFilter === 'has_expired') {
      expiredMatch = c.backlogItems.some(i => i.isExpired);
    } else if (expiredFilter === 'no_expired') {
      expiredMatch = !c.backlogItems.some(i => i.isExpired);
    }

    let eventMatch = true;
    if (eventFilter !== 'ALL' && typeof EVENT_MAPPINGS !== 'undefined' && EVENT_MAPPINGS[eventFilter]) {
      eventMatch = c.backlogItems.some(item => {
        if (statusFilter === 'pending' && (item.isScheduled || item.isExpired)) return false;
        if (statusFilter === 'scheduled' && !item.isScheduled) return false;
        return itemMatchesSeminar(item, eventFilter);
      });
    } else if (statusFilter !== 'ALL') {
      // If no specific event is selected, just filter by whether they have ANY items of this status
      eventMatch = c.backlogItems.some(item => {
        if (statusFilter === 'pending') return !item.isScheduled && !item.isExpired;
        if (statusFilter === 'scheduled') return item.isScheduled;
        return true;
      });
    }

    return bucketMatch && nameMatch && courseMatch && consultantMatch && expiredMatch && eventMatch;
  });
}

// === RENDER METHODS ===
function renderAll() {
  renderBucketCounts();
  renderKPIs();
  renderClientList();
  if (state.selectedClientId && state.clients.has(state.selectedClientId)) {
      selectClient(state.selectedClientId);
  }
}

function renderBucketCounts() {
  let pending = 0, incomplete = 0, complete = 0;

  state.clients.forEach(c => {
    if (c.bucket === 'PENDING_SCHEDULE') pending++;
    else if (c.bucket === 'SCHEDULE_INCOMPLETE') incomplete++;
    else if (c.bucket === 'PROGRAM_COMPLETE') complete++;
  });

  document.getElementById('b-count-pending').innerText = pending;
  document.getElementById('b-count-incomplete').innerText = incomplete;
  document.getElementById('b-count-complete').innerText = complete;
  document.getElementById('b-count-all').innerText = state.clients.size;
}

function renderKPIs() {
  const filtered = getFilteredClients();
  const totalValPending = filtered.filter(c => c.bucket === 'PENDING_SCHEDULE').reduce((sum, c) => sum + c.pendingAmount, 0);
  const totalValIncomplete = filtered.filter(c => c.bucket === 'SCHEDULE_INCOMPLETE').reduce((sum, c) => sum + c.pendingAmount, 0);
  const totalComplete = Array.from(state.clients.values()).filter(c => c.bucket === 'PROGRAM_COMPLETE').length;

  document.getElementById('kpi-pending-val').innerText = `$${totalValPending.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  document.getElementById('kpi-incomplete-val').innerText = `$${totalValIncomplete.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  document.getElementById('kpi-clients-count').innerText = filtered.length.toLocaleString();
  document.getElementById('kpi-complete-count').innerText = totalComplete.toLocaleString();
}

function renderClientList() {
  const listPane = document.getElementById('client-list');
  const filtered = getFilteredClients();

  if (filtered.length === 0) {
    listPane.innerHTML = `<div class="empty-state"><p>No clients found.</p></div>`;
    return;
  }

  listPane.innerHTML = filtered.map(c => `
    <div class="client-card ${state.selectedClientId === c.clientId ? 'active' : ''} ${state.dncList[c.clientId] ? 'dnc-card' : ''}" data-id="${c.clientId}">
      <span class="card-name">${c.doctorName || `Client ${c.clientId}`} ${state.dncList[c.clientId] ? '<span style="font-size:10px; background:rgba(239, 68, 68, 0.2); color:rgb(248, 113, 113); padding:2px 6px; border-radius:4px; margin-left:8px; font-weight:bold;">DNC</span>' : ''}</span>
      <div class="card-meta" style="margin-top: 8px;">
        <span style="font-weight: 600; color: var(--text-primary);">${c.pendingItemsCount} Items Pending</span>
        <span style="font-weight: 700; color: var(--text-primary);">$${c.pendingAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
      </div>
    </div>
  `).join('');

  if (filtered.length > 0 && !filtered.some(c => c.clientId === state.selectedClientId)) {
    selectClient(filtered[0].clientId);
  }
}

// === DETAIL VIEW ===
function selectClient(clientId) {
  state.selectedClientId = clientId;
  document.querySelectorAll('.client-card').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-id') === clientId);
  });

  const client = state.clients.get(clientId);
  if (!client) return;

  const detailPane = document.getElementById('client-detail');
  const tr = state.triageData[clientId] || { status: 'To Contact', note: '' };

  const renderRow = (label, value) => {
    if (!value || value === 'N/A' || value === '') return '';
    return `
      <div class="info-row">
        <div class="info-label">${label}</div>
        <div class="info-value">${value}</div>
      </div>
    `;
  };

  const renderAction = (label, url) => {
    if (!url || url === 'N/A' || url === '') return '';
    return `
      <div class="info-row">
        <div class="info-label">${label}</div>
        <div class="info-value">
          <button class="link-btn" onclick="openCleanWindow('${url}')">⧉ Open in Popup</button>
        </div>
      </div>
    `;
  };

  const ownerContacts = client.contacts.filter(c => (c['Position / Post'] || '').toLowerCase().includes('doctor - owner') || (c['Position / Post'] || '').toLowerCase().includes('owner'));
  const pdfLink = client.pdfRecords.length > 0 ? client.pdfRecords[0]['PDF Schedule URL'] : '';


  let displayItems = client.backlogItems;
  if (state.statusFilter === 'pending') {
      displayItems = displayItems.filter(item => !item.isScheduled && !item.isExpired);
  } else if (state.statusFilter === 'scheduled') {
      displayItems = displayItems.filter(item => item.isScheduled);
  }
  if (state.expiredFilter === 'has_expired') {
      displayItems = displayItems.filter(item => item.isExpired);
  } else if (state.expiredFilter === 'no_expired') {
      displayItems = displayItems.filter(item => !item.isExpired);
  }
  if (state.courseQuery) {
      const cq = state.courseQuery.toLowerCase();
      displayItems = displayItems.filter(item => (item['Item Name'] || '').toLowerCase().includes(cq));
  }
  if (state.eventFilter && state.eventFilter !== 'ALL' && typeof EVENT_MAPPINGS !== 'undefined' && EVENT_MAPPINGS[state.eventFilter]) {
      displayItems = displayItems.filter(item => itemMatchesSeminar(item, state.eventFilter));
  }

  detailPane.innerHTML = `
    <div class="detail-pane-content">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        
        <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.5px; display:flex; align-items:center; gap:12px;">
          ${client.doctorName || `Client ${client.clientId}`}
          <button onclick="toggleDNC('${client.clientId}')" style="background:${state.dncList[client.clientId] ? 'rgba(239, 68, 68, 0.2)' : 'var(--glass-bg)'}; color:${state.dncList[client.clientId] ? 'rgb(248, 113, 113)' : 'var(--text-secondary)'}; border:1px solid ${state.dncList[client.clientId] ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255,255,255,0.1)'}; padding:4px 12px; border-radius:12px; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.2s;">
             ${state.dncList[client.clientId] ? '🚫 DO NOT CALL' : 'MARK AS DNC'}
          </button>
        </h2>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">
          Pending: $${client.pendingAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </div>
      </div>

      <!-- Identity & Links -->
      <div class="glass-card card-client">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="field-label">Linked Client Master</span>
          <span class="pill">${client.bucket.replace('_', ' ')}</span>
        </div>
        <div class="field-value" style="font-weight:600; font-size:14px; margin-top:3px;">${client.doctorName}</div>
        
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px;">
          <div><div class="field-label">Consultant</div><div class="field-value">${client.consultant || '-'}</div></div>
          <div><div class="field-label">Account Status</div><div class="field-value">${client.accountStatus || '-'}</div></div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px;">
          <div><div class="field-label">Work Phone</div><div class="field-value">${client.workPhone ? `<a href="tel:${client.workPhone}">${client.workPhone}</a>` : '-'}</div></div>
          <div><div class="field-label">Primary Email</div><div class="field-value" style="color:var(--accent-blue);">${client.doctorEmail ? `<a href="mailto:${client.doctorEmail}">${client.doctorEmail}</a>` : '-'}</div></div>
        </div>

        <div style="display:flex; gap:8px; margin-top:12px;">
          ${client.clientUrl ? `<button class="btn" onclick="openCleanWindow('${client.clientUrl}')">Open Master Client File ↗</button>` : ''}
          ${client.dashboardUrl ? `<button class="btn" onclick="openCleanWindow('${client.dashboardUrl}')">NetSuite Dashboard ↗</button>` : ''}
        </div>
      </div>

      <!-- PDF Schedule -->
      <div class="glass-card card-schedule">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <div class="field-label">Schedule 2020 PDF Status</div>
            <div class="field-value" style="font-size:13px; font-weight:700; margin-top:2px;">${client.pdfStatus}</div>
          </div>
          <span class="pill pill-id">ID: ${client.clientId}</span>
        </div>
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(255, 255, 255, 0.08);">
          <button class="btn btn-solid" style="width:100%;" ${!pdfLink ? 'disabled' : ''} onclick="openCleanWindow('${pdfLink}')">
            📄 Print Schedule 2020 (PDF) ↗
          </button>
        </div>
      </div>

      <!-- Contacts Directory -->
      ${ownerContacts.length > 0 ? ownerContacts.map(oc => `
        <div class="glass-card card-contact">
          <div class="field-label">Linked Contact File</div>
          <div class="field-value" style="font-size:14px; font-weight:700; margin-top:3px;">${oc['Contact Name']}</div>
          
          <div class="field-label" style="margin-top:8px;">Position / Post</div>
          <div class="field-value" style="color:rgb(228, 228, 231);">${oc['Position / Post'] || '-'}</div>
          
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:8px;">
            <div><div class="field-label">Direct Cell</div><div class="field-value">${oc['Cell Phone 1'] ? `<a href="tel:${oc['Cell Phone 1']}">${oc['Cell Phone 1']}</a>` : '-'}</div></div>
            <div><div class="field-label">Contact Email</div><div class="field-value" style="color:var(--accent-blue);">${oc['Primary Email'] ? `<a href="mailto:${oc['Primary Email']}">${oc['Primary Email']}</a>` : '-'}</div></div>
          </div>

          <div style="margin-top:12px;">
            <button class="btn" ${!oc['Contact Direct URL'] ? 'disabled' : ''} onclick="openCleanWindow('${oc['Contact Direct URL']}')">Open Contact File ↗</button>
          </div>
        </div>
      `).join('') : ''}

      <!-- Ledger -->
      <div class="glass-card">
        <div class="field-label" style="margin-bottom:8px;">Training Ledger (${displayItems.length} items)</div>
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Item Name</th>
              <th>Memo</th>
              <th>Status</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${displayItems.length === 0 ? '<tr><td colspan="4" style="color:var(--text-secondary);">No backlog items.</td></tr>' : ''}
            ${displayItems.map(item => `
              <tr>
                <td style="color:var(--text-primary); font-weight:500;">${item['Item Name']}</td>
                <td style="color:var(--text-secondary); font-size:12px;">${item['Memo'] || '-'}</td>
                <td>
                  ${item.isScheduled 
                    ? '<span class="pill pill-scheduled">Scheduled</span>' 
                    : item.isExpired
                      ? '<span class="pill pill-expired">Expired</span>'
                      : '<span class="pill pill-pending">Pending</span>'}
                </td>
                <td style="${(!item.isScheduled && !item.isExpired) ? 'color: var(--text-primary); font-weight: 700;' : 'color: var(--text-secondary);'}">
                  ${item.numericAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function saveTriage(clientId, status, note) {
  state.triageData[clientId] = { status, note, timestamp: new Date().toISOString() };
  localStorage.setItem('mge_triage_audit_v4', JSON.stringify(state.triageData));
}

// === CONTROLS & LISTENERS ===
function populateFilterDropdowns() {
  const consultants = new Set();
  state.clients.forEach(c => {
    if (c.consultant && c.consultant !== 'Unassigned') consultants.add(c.consultant);
  });

  const select = document.getElementById('filter-consultant');
  if (!select) return;
  select.innerHTML = '<option value="">All Consultants</option>';
  Array.from(consultants).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.innerText = name;
    select.appendChild(opt);
  });
}

function setupEventListeners() {
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      const target = e.target.closest('.segment-btn');
      target.classList.add('active');
      state.activeBucket = target.getAttribute('data-bucket');
      renderAll();
    });
  });

  document.getElementById('filter-search')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderAll();
  });

  document.getElementById('filter-course')?.addEventListener('input', (e) => {
    state.courseQuery = e.target.value.trim();
    renderAll();
  });

  document.getElementById('filter-consultant')?.addEventListener('change', (e) => {
    state.consultantFilter = e.target.value;
    renderAll();
  });

  document.getElementById('filter-expired')?.addEventListener('change', (e) => {
    state.expiredFilter = e.target.value;
    renderAll();
  });

  document.getElementById('filter-event')?.addEventListener('change', (e) => {
    state.eventFilter = e.target.value;
    renderAll();
  });

  document.getElementById('filter-status')?.addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    renderAll();
  });

  document.getElementById('client-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('.client-card');
    if (card) selectClient(card.getAttribute('data-id'));
  });

  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
  document.getElementById('btn-forget-passphrase')?.addEventListener('click', forgetPassphrase);
}

function formatScheduledDates(pdfRecords, selectedSeminar) {
  if (!Array.isArray(pdfRecords)) return '';
  const seminar = selectedSeminar !== undefined ? selectedSeminar : getSelectedSeminar();
  const isAllEvents = !seminar || seminar === 'ALL' || seminar === 'All Events';

  const dates = [];
  pdfRecords.forEach(pdf => {
    const d = (pdf && (pdf['Month / Dates'] != null ? pdf['Month / Dates'] : pdf.monthDates) != null
      ? String(pdf['Month / Dates'] != null ? pdf['Month / Dates'] : pdf.monthDates)
      : '').trim();
    const upper = d.toUpperCase();
    if (!upper || upper === 'NO DATES' || upper === 'NO DATE' || upper === 'N/A') {
      return;
    }

    if (isAllEvents) {
      const matched = findMatchingSeminar(pdf);
      if (matched) {
        dates.push(`${matched}: ${d}`);
      }
    } else {
      if (itemMatchesSeminar(pdf, seminar)) {
        dates.push(d);
      }
    }
  });

  return [...new Set(dates)].join(' | ');
}

function getSelectedSeminar() {
  const el = typeof document !== 'undefined' ? document.getElementById('filter-event') : null;
  if (!el) return 'All Events';
  if (el.value === 'ALL') return 'All Events';
  const opt = el.selectedIndex >= 0 && el.options ? el.options[el.selectedIndex] : null;
  return (opt ? (opt.text || opt.textContent) : el.value) || 'All Events';
}

function getExportFileName(seminar) {
  if (!seminar || seminar === 'All Events' || seminar === 'ALL') {
    return 'Triage_Export.csv';
  }
  const clean = seminar.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean || clean === 'All_Events' || clean === 'ALL') {
    return 'Triage_Export.csv';
  }
  return `Triage_Export_${clean}.csv`;
}

function exportCSV() {
  const clients = getFilteredClients();
  const seminar = getSelectedSeminar();
  const seminarStr = `"${seminar.replace(/"/g, '""')}"`;
  let csvContent = "Client Name,Company Name,Email,Phone,Pending Items,Pending Amount,Scheduled Dates,Seminar\n";
  
  clients.forEach(c => {
    let name = c.doctorName || '';
    name = name.replace(/^Name\s+/i, '');
    let company = c.companyName || '';
    company = company.replace(/^Company Name\s+/i, '');
    
    let allEmails = [c.doctorEmail, c.altEmail, ...(c.contacts || []).map(ct => ct['Primary Email'])];
    allEmails = allEmails.filter(e => e && e.trim() !== '' && e.toLowerCase() !== 'none');
    allEmails = allEmails.map(e => e.replace(/^Email\s+\d*\s*/i, '').trim());
    const uniqueEmails = [...new Set(allEmails)].join(' | ');

    let allPhones = [c.workPhone, c.cell1Number, ...(c.contacts || []).map(ct => ct['Cell Phone 1'])];
    allPhones = allPhones.filter(p => p && p.trim() !== '' && p.toLowerCase() !== 'none');
    allPhones = allPhones.map(p => p.replace(/^(Work Phone\s*\d*|Cell Phone\s*\d*|Home Phone|Private Phone)\s*/i, '').replace(/dntcall/i, '').trim());
    const uniquePhones = [...new Set(allPhones)].join(' | ');

    const scheduledDates = formatScheduledDates(c.pdfRecords, seminar);
    const datesStr = `"${scheduledDates.replace(/"/g, '""')}"`;

    const nameStr = `"${name.replace(/"/g, '""')}"`;
    const compStr = `"${company.replace(/"/g, '""')}"`;
    const emailStr = `"${uniqueEmails.replace(/"/g, '""')}"`;
    const phoneStr = `"${uniquePhones.replace(/"/g, '""')}"`;
    const items = c.pendingItemsCount != null ? c.pendingItemsCount : 0;
    const amount = c.pendingAmount != null ? c.pendingAmount : 0;
    
    csvContent += `${nameStr},${compStr},${emailStr},${phoneStr},${items},${amount},${datesStr},${seminarStr}\n`;
  });
  
  const fileName = getExportFileName(seminar);
  if (typeof Blob !== 'undefined' && typeof document !== 'undefined') {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') ? URL.createObjectURL(blob) : '';
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  return { csvContent, fileName };
}

if (typeof window !== 'undefined') {
  window.EVENT_MAPPINGS = EVENT_MAPPINGS;
  window.itemMatchesSeminar = itemMatchesSeminar;
  window.findMatchingSeminar = findMatchingSeminar;
  window.formatScheduledDates = formatScheduledDates;
  window.getSelectedSeminar = getSelectedSeminar;
  window.getExportFileName = getExportFileName;
  window.exportCSV = exportCSV;
}

window.addEventListener('DOMContentLoaded', initApp);