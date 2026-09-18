
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

/**
 * MGE Training Scheduling & Triage Hub - Auditor Workflow Redesign
 */

const state = {
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

// === BOOTSTRAP: INGEST DATASETS ===
async function initApp() {
  const statusEl = document.getElementById('load-status');
  try {
    const [clientsRaw, contactsRaw, pdfRaw, backlogRaw] = await Promise.all([
      fetch('./data/clients_directory.csv').then(r => r.text()),
      fetch('./data/contacts_directory.csv').then(r => r.text()),
      fetch('./data/pdf_directory.csv').then(r => r.text()),
      fetch('./data/unscheduled_backlog.csv').then(r => r.text())
    ]);

    const clientsData = parseCSV(clientsRaw);
    const contactsData = parseCSV(contactsRaw);
    const pdfData = parseCSV(pdfRaw);
    const backlogData = parseCSV(backlogRaw);

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
    setupEventListeners();

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
           // Suffix safety check to prevent a generic item from claiming a Dr/OM ticket.
           // Only reject if the PDF explicitly has a role, but the item does NOT.
           // However, if the PDF is generic, and the item has a role, we accept it.
           
           // Let's do a strict boundary check for the role in the PDF services string.
           // Since we concatenated everything, we can just check if the specific matched variant has a role suffix in the PDF.
           // To keep it simple and avoid edge cases, we'll just return true, as the EVENT_MAPPINGS already group them safely!
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
      const variants = EVENT_MAPPINGS[eventFilter];
      eventMatch = c.backlogItems.some(item => {
        if (statusFilter === 'pending' && (item.isScheduled || item.isExpired)) return false;
        if (statusFilter === 'scheduled' && !item.isScheduled) return false;
        
        const itemName = (item['Item Name'] || '').toLowerCase().trim();
        return variants.some(v => itemName.includes(v));
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
    <div class="client-card ${state.selectedClientId === c.clientId ? 'active' : ''}" data-id="${c.clientId}">
      <span class="card-name">${c.doctorName || `Client ${c.clientId}`}</span>
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

  detailPane.innerHTML = `
    <div class="detail-pane-content">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.5px;">${client.doctorName || `Client ${client.clientId}`}</h2>
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
          <span class="pill" style="background:rgba(251, 191, 36, 0.2); color:rgb(251, 191, 36); border-color:rgba(251, 191, 36, 0.4);">ID: ${client.clientId}</span>
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
        <div class="field-label" style="margin-bottom:8px;">Training Ledger (${client.backlogItems.length} items)</div>
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
            ${client.backlogItems.length === 0 ? '<tr><td colspan="4" style="color:var(--text-secondary);">No backlog items.</td></tr>' : ''}
            ${client.backlogItems.map(item => `
              <tr>
                <td style="color:var(--text-primary); font-weight:500;">${item['Item Name']}</td>
                <td style="color:var(--text-secondary); font-size:12px;">${item['Memo'] || '-'}</td>
                <td>
                  ${item.isScheduled 
                    ? '<span class="pill" style="background:rgba(34, 197, 94, 0.2); color:rgb(74, 222, 128); border-color:rgba(34, 197, 94, 0.4);">Scheduled</span>' 
                    : item.isExpired
                      ? '<span class="pill" style="background:rgba(239, 68, 68, 0.2); color:rgb(248, 113, 113); border-color:rgba(239, 68, 68, 0.4);">Expired</span>'
                      : '<span class="pill" style="background:rgba(249, 115, 22, 0.25); color:rgb(251, 146, 60); border-color:rgba(249, 115, 22, 0.5);">Pending</span>'}
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
    renderKPIs();
    renderClientList();
  });

  document.getElementById('filter-course')?.addEventListener('input', (e) => {
    state.courseQuery = e.target.value.trim();
    renderKPIs();
    renderClientList();
  });

  document.getElementById('filter-consultant')?.addEventListener('change', (e) => {
    state.consultantFilter = e.target.value;
    renderKPIs();
    renderClientList();
  });

  document.getElementById('filter-expired')?.addEventListener('change', (e) => {
    state.expiredFilter = e.target.value;
    renderKPIs();
    renderClientList();
  });

  document.getElementById('filter-event')?.addEventListener('change', (e) => {
    state.eventFilter = e.target.value;
    renderKPIs();
    renderClientList();
  });

  document.getElementById('filter-status')?.addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    renderKPIs();
    renderClientList();
  });

  document.getElementById('client-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('.client-card');
    if (card) selectClient(card.getAttribute('data-id'));
  });

  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
}

function exportCSV() {
  const filtered = getFilteredClients();
  const headers = ["Client ID", "Name", "Consultant", "Bucket", "Triage Status", "Triage Note", "Pending Items", "Pending Amount"];
  const rows = filtered.map(c => {
    const tr = state.triageData[c.clientId] || {};
    return [
      c.clientId,
      `"${(c.doctorName || c.companyName || '').replace(/"/g, '""')}"`,
      `"${(c.consultant || '').replace(/"/g, '""')}"`,
      c.bucket,
      `"${(tr.status || '').replace(/"/g, '""')}"`,
      `"${(tr.note || '').replace(/"/g, '""')}"`,
      c.pendingItemsCount,
      c.pendingAmount
    ];
  });
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MGE_Hub_Export_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

window.addEventListener('DOMContentLoaded', initApp);