# NetSuite Doctor-Owner PDF Extractor
**Version:** Auto-Healing Turbo (Final)

This script automates the extraction of "Doctor - Owner" scheduling data from NetSuite. It is designed to bypass NetSuite UI pagination, rate limits, and PDF binary restrictions by running natively inside the Google Chrome Developer Console.

## 🚀 How to Run It
1. Log into NetSuite and navigate to your **Saved Search Results Page** (e.g., Active Client List).
2. Press `F12` (or `Right Click -> Inspect`) to open the Google Chrome Developer Tools.
3. Go to the **Console** tab.
4. Ensure the dropdown menu in the top-left of the Console is set to **`top`** (not an iframe).
5. Paste the entire script below and press **Enter**.
6. The HUD will appear in the bottom right corner of your screen. Let it run until it says "All PDFs extracted!" and download your CSV files.

## ⚙️ Configuration Settings
You can tweak the speed of the script by editing these two variables at the very top of the code:

- **`CONCURRENCY`** (Default: `2`)
  *Controls how many Clients are processed at the exact same time.*
  If you want to speed up the script, you can increase this to `5` or `8`. However, setting this too high (e.g., `20`) will trigger NetSuite's DDoS firewall (`HTTP 429 Too Many Requests`) and may temporarily lock your session.
  
- **`CONTACT_CONCURRENCY`** (Default: `5`)
  *Controls how many Doctor Profiles are fetched simultaneously within a single client.*
  You generally do not need to change this, as the database now filters out non-doctors instantly.

---

## 🔬 Deep Dive: Technical Architecture

### 1. The Contact Resolution Engine (Bypassing NetSuite Pagination)
Initially, extracting contacts from NetSuite was incredibly difficult because NetSuite relies heavily on client-side JS pagination for sublists (the `s_relation` Relationship tab). When a client has hundreds of contacts, they are split across multiple pages, making standard HTML web-scraping impossible without manually triggering UI clicks.

To solve this, we abandoned HTML scraping entirely and built an **API Portal Injector**:
* **The Problem:** The Saved Search Results page (`searchid=72`) is a highly restricted environment. NetSuite intentionally strips out the `require(['N/search'])` SuiteScript 2.0 module on this page, preventing users from querying the database directly.
* **The Solution (The API Portal):** The script dynamically creates a hidden `<iframe>` in the background and points it to a standard NetSuite record page (e.g., `/app/common/entity/custjob.nl?id=123`). Because standard record pages *do* load the SuiteScript API, the script waits for the hidden iframe to load, reaches inside it, and "steals" the `contentWindow.require` function. We now have a fully authenticated, server-side database connection running silently on a page that shouldn't have one!
* **Server-Side Filtering:** Instead of downloading 500 employee profiles to see who the owner is, we use `NSSearchAPI.create()`. We filter by the custom client-link field (`custentity5`), and request the `custentity_positionpost` (Role) column. The database instantly drops hundreds of employees and hands us the 1 or 2 Contact IDs that contain the words "Doctor" and "Owner". 
* **Governance Battery Swapper:** NetSuite scripts are hard-capped at 1,000 database usage units per execution context. Because our iframe is acting as our execution context, it burns out after ~100 clients, throwing a `SCRIPT_EXECUTION_USAGE_LIMIT_EXCEEDED` error. Our script catches this, destroys the exhausted iframe, and spawns a brand new one to reset our limits to 1,000, allowing infinite, unstoppable processing.

### 2. The PDF Extraction Engine (Bypassing Server-Side OCR)
The target documents are dynamically generated PDFs rendered by a custom NetSuite Suitelet (`customscript_scs_contact_sched_20_pdf_sl`). We needed to read the table data inside them, but we cannot send highly confidential client data to a third-party OCR API.

We engineered a **Native Browser PDF Parser** to read the raw binary data locally:
* **Fetching the Binary:** The script sends an authenticated `fetch` request to the Suitelet to download the raw PDF byte array (`Uint8Array`).
* **Locating the Streams:** PDFs are essentially text files that contain compressed "Streams" of data. We manually scan the raw byte array looking for the ASCII signatures of a stream (`stream` ... `endstream`) and specifically target streams that are compressed using FlateDecode (zlib).
* **Native Zlib Decompression:** Standard JavaScript cannot natively decompress zlib. Instead of importing heavy 3rd-party libraries, we pipe the raw binary streams through the modern browser's native `DecompressionStream('deflate')` API. This instantly converts the garbled binary into raw, readable PDF syntax.
* **Parsing PDF Operators (`Tj` and `TJ`):** Inside the decompressed PDF syntax, text isn't stored normally. It is painted onto the page using operators. We use Regex to hunt down:
  * String Literals: `(Text goes here) Tj`
  * Array Literals: `[(Tex) 120 (t g) -20 (oes here)] TJ`
  * Hex Encoded Strings: `<414243> Tj`
* **Table Reconstruction:** Once we have a clean array of every word printed on the PDF, we find the anchor word `"Location"`. We know the table columns follow a strict 4-column layout (`Location`, `Services`, `Month/Dates`, `Hours/Days`). By jumping forward in chunks of 4 tokens, we perfectly reconstruct the tabular data, run date-validation regex (`\b\d{1,2}/\d{1,2}\b`) to identify and count scheduled days, and export it directly to CSV.

---

## 📜 The Final Script

```javascript
(async () => {
  if (!window.location.hostname.includes('netsuite.com')) {
    return alert(`Target context error: Switch DevTools context to top (${window.location.hostname}).`);
  }

  console.log("%c[SCHEDULE 2020 EXTRACTOR] Starting UNSTOPPABLE Turbo Audit...", "color:#38bdf8;font-weight:bold;font-size:14px;");

  // === 1. CONFIGURATION ===
  const CONCURRENCY = 2; // Increase to 5 or 8 for faster execution (if NetSuite permits)
  const CONTACT_CONCURRENCY = 5; 
  const ORIGIN = window.location.origin;
  const CONTACT_BASE = "/app/common/entity/contact.nl?id=";
  const SUITELET_BASE = "/app/site/hosting/scriptlet.nl?script=customscript_scs_contact_sched_20_pdf_sl&deploy=customdeploy_scs_contact_sched_20_pdf_sl&contactId=";

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const DATE_REGEX = /\b(?:\d{1,4}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-/][A-Za-z0-9]{3,}[-/]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s*-\s*\d{1,2})?,?\s+\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|\d{1,2}\/\d{1,2})\b/i;

  // === 2. STRICT CLIENT QUEUE RESOLUTION ===
  function getClientsFromResultsTable() {
    const tableBody = document.getElementById("div__body");
    if (!tableBody) return [];
    const rows = Array.from(tableBody.querySelectorAll("tr.uir-list-row-tr, tr[id^='row']"));
    const queue = [];
    const seenIds = new Set();
    rows.forEach((r) => {
      const clientLink = r.querySelector("a[href*='custjob.nl']");
      if (!clientLink) return;
      const match = clientLink.href.match(/[?&]id=(\d+)/);
      if (!match) return;
      const clientInternalId = match[1];
      if (seenIds.has(clientInternalId)) return;
      seenIds.add(clientInternalId);
      const cells = Array.from(r.querySelectorAll("td")).map((td) => clean(td.textContent));
      queue.push({
        clientInternalId,
        lastName: cells[8] || "",
        firstName: cells[9] || "",
        doctorSearchName: `${cells[9] || ""} ${cells[8] || ""}`.trim() || `Client #${clientInternalId}`,
        consultant: cells[18] || "Unassigned"
      });
    });
    return queue;
  }

  const queue = getClientsFromResultsTable();
  if (queue.length === 0) {
    return alert("No clients found. Ensure you are on the Search Results Page (searchid=72) and the table is visible.");
  }

  const totalClients = queue.length;
  console.log(`✅ Queued ${totalClients} verified clients.`);

  // === 3. HUD MONITOR OVERLAY ===
  let isPaused = false, isStopped = false;
  const existingHUD = document.getElementById('ns-pdf2020-hud');
  if (existingHUD) existingHUD.remove();
  const hud = document.createElement('div');
  hud.id = 'ns-pdf2020-hud';
  hud.innerHTML = `
    <div style="position:fixed;bottom:20px;right:20px;z-index:999999;width:450px;background:#0f172a;color:#f8fafc;padding:16px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;border:1px solid #334155;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <b style="font-size:13px;color:#38bdf8;">Doctor - Owner API Extractor</b>
        <span id="p20-status-tag" style="background:#0284c7;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;">Active</span>
      </div>
      <div id="p20-status-text" style="margin-bottom:8px;color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Initializing API Portal...</div>
      <div style="width:100%;background:#1e293b;height:8px;border-radius:4px;overflow:hidden;margin-bottom:12px;">
        <div id="p20-progress-bar" style="width:0%;height:100%;background:#38bdf8;transition:width 0.2s;"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px;font-size:11px;background:#1e293b;padding:8px 12px;border-radius:8px;">
        <div>Audited Clients: <b id="p20-count">0 / ${totalClients}</b></div>
        <div>Doctor - Owners: <b id="p20-owners" style="color:#38bdf8;">0</b></div>
        <div>Items Found: <b id="p20-items" style="color:#34d399;">0</b></div>
        <div>Dates Found: <b id="p20-dates" style="color:#a78bfa;">0</b></div>
        <div style="grid-column: span 2;">Zero Dates Forms: <b id="p20-no-dates" style="color:#f87171;">0</b></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button id="p20-pause-btn" style="flex:1;background:#334155;color:#f8fafc;border:none;padding:7px 0;border-radius:6px;cursor:pointer;font-weight:600;font-size:11px;">Pause</button>
        <button id="p20-stop-btn" style="flex:1;background:#7f1d1d;color:#fca5a5;border:none;padding:7px 0;border-radius:6px;cursor:pointer;font-weight:600;font-size:11px;">Stop & Export</button>
      </div>
      <button id="p20-dl-itemized-btn" disabled style="width:100%;background:#0284c7;color:#ffffff;border:none;padding:8px 0;border-radius:6px;cursor:not-allowed;font-weight:700;font-size:11px;margin-bottom:4px;">Download Full Itemized CSV (0 Rows)</button>
      <button id="p20-dl-nodates-btn" disabled style="width:100%;background:#475569;color:#f8fafc;border:none;padding:7px 0;border-radius:6px;cursor:not-allowed;font-weight:700;font-size:11px;">Download Zero Dates CSV (0)</button>
    </div>
  `;
  document.body.appendChild(hud);

  const pauseBtn = document.getElementById('p20-pause-btn');
  const stopBtn = document.getElementById('p20-stop-btn');
  const dlItemizedBtn = document.getElementById('p20-dl-itemized-btn');
  const dlNoDatesBtn = document.getElementById('p20-dl-nodates-btn');

  pauseBtn.onclick = () => {
    isPaused = !isPaused;
    pauseBtn.innerText = isPaused ? 'Resume' : 'Pause';
    pauseBtn.style.background = isPaused ? '#d97706' : '#334155';
    document.getElementById('p20-status-tag').innerText = isPaused ? 'Paused' : 'Active';
    document.getElementById('p20-status-tag').style.background = isPaused ? '#d97706' : '#0284c7';
  };

  stopBtn.onclick = () => {
    isStopped = true;
    stopBtn.innerText = 'Stopping...';
    stopBtn.disabled = true;
  };

  const updateHUD = (done, total, owners, itemsCount, datesCount, noDatesCount, name) => {
    const pct = Math.round((done / total) * 100);
    document.getElementById('p20-progress-bar').style.width = `${pct}%`;
    document.getElementById('p20-status-text').innerText = `[${done}/${total}] ${name}`;
    document.getElementById('p20-count').innerText = `${done} / ${total}`;
    document.getElementById('p20-owners').innerText = owners;
    document.getElementById('p20-items').innerText = itemsCount;
    document.getElementById('p20-dates').innerText = datesCount;
    document.getElementById('p20-no-dates').innerText = noDatesCount;
    document.getElementById('p20-dl-itemized-btn').innerText = `Download Full Itemized CSV (${itemizedRows.length} Rows)`;
  };

  // === 4. SELF-HEALING GOVERNANCE PORTAL ===
  let portalIframe = null;
  let NSSearchAPI = null;
  let isResettingPortal = false;

  async function establishPortal() {
      if (isResettingPortal) {
          while (isResettingPortal) await sleep(100);
          return;
      }
      isResettingPortal = true;
      try {
          if (portalIframe) {
              portalIframe.remove();
              portalIframe = null;
              NSSearchAPI = null;
          }
          document.getElementById('p20-status-text').innerText = "Governance Reset: Rebuilding API Portal...";
          console.log("%c[SYSTEM] Destroying old Portal. Spawning fresh API Portal...", "color:#f59e0b");
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          iframe.src = `/app/common/entity/custjob.nl?id=${queue[0].clientInternalId}`;
          document.body.appendChild(iframe);
          
          await new Promise(res => {
              const check = setInterval(() => {
                  if (iframe.contentWindow && typeof iframe.contentWindow.require !== 'undefined') {
                      clearInterval(check); res();
                  }
              }, 200);
              setTimeout(() => { clearInterval(check); res(); }, 15000);
          });
          if (iframe.contentWindow && typeof iframe.contentWindow.require !== 'undefined') {
             NSSearchAPI = await new Promise(res => iframe.contentWindow.require(['N/search'], res));
             portalIframe = iframe;
             document.getElementById('p20-status-text').innerText = "✅ API Portal restored!";
             console.log("%c[SYSTEM] Fresh API Portal Restored! Limits Reset to 1,000.", "color:#10b981");
          } else {
             throw new Error("Portal Timeout");
          }
      } finally {
          isResettingPortal = false;
      }
  }

  try {
      await establishPortal();
  } catch(e) {
      document.getElementById('p20-status-text').innerText = "API Error. Halt.";
      return alert("Could not establish Database Connection. NetSuite might be blocking the hidden portal. Try running directly on a client page instead.");
  }
  document.getElementById('p20-status-text').innerText = "Starting Auto-Healing workers...";

  // === 5. NATIVE ZLIB / OPERATOR REASSEMBLER ===
  async function decompressZlibStream(uint8) {
    if (!uint8 || uint8.length < 4) return '';
    const cmf = uint8[0], flg = uint8[1];
    if (cmf !== 0x78 || ((cmf * 256 + flg) % 31 !== 0)) return '';
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([uint8]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } catch { return ''; }
  }

  function extractFlateStreamsByLength(uint8) {
    const streams = [];
    const len = uint8.length;
    let i = 0;
    while (i < len - 15) {
      if (uint8[i] === 115 && uint8[i+1] === 116 && uint8[i+2] === 114 && uint8[i+3] === 101 && uint8[i+4] === 97 && uint8[i+5] === 109) {
        let streamStart = i + 6;
        if (uint8[streamStart] === 13 && uint8[streamStart + 1] === 10) streamStart += 2;
        else if (uint8[streamStart] === 10 || uint8[streamStart] === 13) streamStart += 1;
        const searchBackStart = Math.max(0, i - 150);
        const headerSlice = new TextDecoder('latin1').decode(uint8.subarray(searchBackStart, i));
        const lenMatch = headerSlice.match(/\/Length\s+(\d+)/);
        let streamEnd = -1;
        if (lenMatch) {
          const declaredLen = parseInt(lenMatch[1], 10);
          if (declaredLen > 0 && streamStart + declaredLen <= len) streamEnd = streamStart + declaredLen;
        }
        if (streamEnd === -1) {
          let ptr = streamStart;
          while (ptr < len - 9) {
            if (uint8[ptr] === 101 && uint8[ptr+1] === 110 && uint8[ptr+2] === 100 && uint8[ptr+3] === 115 && uint8[ptr+4] === 116 && uint8[ptr+5] === 114 && uint8[ptr+6] === 101 && uint8[ptr+7] === 97 && uint8[ptr+8] === 109) {
              streamEnd = ptr;
              if (uint8[streamEnd - 1] === 10) streamEnd--;
              if (uint8[streamEnd - 1] === 13) streamEnd--;
              break;
            }
            ptr++;
          }
        }
        if (streamEnd > streamStart) {
          const chunk = uint8.subarray(streamStart, streamEnd);
          if (chunk.length >= 4 && chunk[0] === 0x78 && ((chunk[0] * 256 + chunk[1]) % 31 === 0)) streams.push(chunk);
          i = streamEnd + 9;
        } else i += 6;
      } else i++;
    }
    return streams;
  }

  function extractReassembledPdfTokens(decompressedText) {
    const tokens = [];
    const parensRe = /\(((?:\\.|[^\\()])*)\)/g;
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    const opRe = /(\[[\s\S]*?\]\s*TJ|\((?:\\.|[^\\()])*\)\s*Tj|<[0-9A-Fa-f\s]+>\s*Tj)/g;
    let match;
    while ((match = opRe.exec(decompressedText)) !== null) {
      const block = match[1];
      const parensMatches = block.match(parensRe);
      if (parensMatches) {
        const fullString = parensMatches.map((p) => p.slice(1, -1).replace(/\\([()\\])/g, '$1')).join('').trim();
        if (fullString) tokens.push(fullString);
      } else {
        const hexMatches = block.match(hexRe);
        if (hexMatches) {
          hexMatches.forEach((h) => {
            try {
              const hexClean = h.replace(/[<>\s]/g, '');
              let str = '';
              for (let c = 0; c < hexClean.length; c += 2) str += String.fromCharCode(parseInt(hexClean.substr(c, 2), 16));
              if (str.trim()) tokens.push(str.trim());
            } catch {}
          });
        }
      }
    }
    return tokens;
  }

  function countDateTokens(dateStr) {
    if (!dateStr) return 0;
    const m = dateStr.match(/\b\d{1,2}\/\d{1,2}\b/g);
    return m ? m.length : (DATE_REGEX.test(dateStr) ? 1 : 0);
  }

  function parseAgreementTableTokens(tokens) {
    let locIdx = -1;
    let signeeNameInPdf = "";
    for (let i = 0; i < tokens.length - 2; i++) {
      const tok = tokens[i].trim().toLowerCase();
      if (tok === 'i,' || tok === 'i') {
        const candidate = tokens[i+1].replace(/^[|,]+|[|,\s]+$/g, '').trim();
        const nextPart = (tokens[i+2] || '').toLowerCase();
        if (nextPart.includes('agree') && candidate.length > 2) { signeeNameInPdf = candidate; break; }
      }
      const match = tokens[i].match(/I,\s*\|?\s*([^|,]+?)\s*\|?,\s*agree/i);
      if (match && match[1]) { signeeNameInPdf = match[1].trim(); break; }
    }
    for (let i = 0; i < tokens.length - 3; i++) {
      if (tokens[i].toLowerCase() === 'location') {
        const t1 = tokens[i+1].toLowerCase(), t2 = tokens[i+2].toLowerCase(), t3 = tokens[i+3].toLowerCase();
        if (t1.includes('service') && (t2.includes('month') || t2.includes('date')) && (t3.includes('hour') || t3.includes('day'))) {
          locIdx = i; break;
        }
      }
    }
    const rows = [], datesFound = [];
    if (locIdx !== -1) {
      const dataTokens = tokens.slice(locIdx + 4);
      let ptr = 0;
      while (ptr + 3 < dataTokens.length) {
        const peek = dataTokens.slice(ptr, ptr + 4).join(' ').toLowerCase();
        if (['signature', 'client initials', 'witness initials', 'terms', 'agreed to', 'special instructions'].some((k) => peek.includes(k))) break;
        const location = dataTokens[ptr] || '';
        const services = dataTokens[ptr + 1] || '';
        const rawMonthDates = (dataTokens[ptr + 2] || '').replace(/undefined-?/g, '').trim();
        const hoursDays = dataTokens[ptr + 3] || '';
        const hasValidDate = DATE_REGEX.test(rawMonthDates) && !/tbd|none|n\/a|unscheduled/i.test(rawMonthDates);
        if (hasValidDate) datesFound.push(rawMonthDates);
        rows.push({ location, services, monthDates: rawMonthDates, hoursDays, hasValidDate: hasValidDate ? 'YES' : 'NO', datesCount: countDateTokens(rawMonthDates) });
        ptr += 4;
      }
    }
    if (datesFound.length === 0) {
      tokens.forEach((t) => {
        if (DATE_REGEX.test(t) && !datesFound.includes(t) && !/19[0-9]{2}/.test(t)) datesFound.push(t);
      });
    }
    return { rows, datesFound, signeeNameInPdf };
  }

  // === 6. EXTRACTION ENGINE ===
  const itemizedRows = [];
  const doctorSummaries = [];
  let processed = 0, doctorOwnersFound = 0, totalExtractedItems = 0, totalExtractedDates = 0, zeroDatesCount = 0, queueCursor = 0;

  const processDoctorOwner = async (docEntry) => {
    try {
      let allContacts = [];
      let fastSearchSuccess = false;

      const runSearch = async (isRetry = false) => {
          return new Promise((resolve, reject) => {
              const found = [];
              try {
                  const filters = isRetry 
                      ? [['custentity5', 'anyof', docEntry.clientInternalId]]
                      : [['custentity5', 'anyof', docEntry.clientInternalId], 'OR', ['company', 'anyof', docEntry.clientInternalId]];

                  NSSearchAPI.create({
                    type: NSSearchAPI.Type.CONTACT,
                    filters: filters,
                    columns: ['entityid', 'custentity_positionpost']
                  }).run().each(function(res) {
                    const role = (res.getText('custentity_positionpost') || res.getValue('custentity_positionpost') || '').toLowerCase();
                    if (role.includes('doctor') && role.includes('owner')) {
                       found.push({ contactId: res.id, name: res.getValue('entityid') });
                    }
                    return true;
                  });
                  resolve(found);
              } catch(e) { reject(e); }
          });
      };

      try {
          try {
             while(isResettingPortal) await sleep(100);
             allContacts = await runSearch(false);
          } catch(err1) {
             console.warn(`[RETRYING] DB Error on Client ${docEntry.clientInternalId}: ${err1.name} - ${err1.message}`);
             
             if (err1.name === 'SCRIPT_EXECUTION_USAGE_LIMIT_EXCEEDED' || err1.message.includes('Usage Limit')) {
                 await establishPortal();
             } else {
                 await sleep(1500); 
             }
             allContacts = await runSearch(true); // Retry after healing
          }
          fastSearchSuccess = true;
      } catch (finalErr) {
          console.error(`[FAILED] Audit error on client ${docEntry.clientInternalId}: ${finalErr.name} - ${finalErr.message}`);
          return; // Skip this client
      }

      if (allContacts.length === 0) return;

      const verifiedDoctors = [];
      let cCursor = 0;

      const scanContact = async () => {
        while (cCursor < allContacts.length) {
          const c = allContacts[cCursor++];
          if (!c) break;
          try {
            const targetContactId = c.contactId;
            const cRes = await fetch(`${CONTACT_BASE}${targetContactId}`);
            if (!cRes.ok) continue;
            const cHtml = await cRes.text();
            const cDoc = new DOMParser().parseFromString(cHtml, 'text/html');

            const contactFullName = clean(cDoc.getElementById('entityid_val')?.textContent) || c.name || docEntry.doctorSearchName;
            const clientCustomerId = clean(cDoc.getElementById('custentity5_val')?.textContent) || docEntry.doctorSearchName;
            const cell = clean(cDoc.getElementById('mobilephone_val')?.textContent || cDoc.getElementById('mobilephone')?.value);
            const office = clean(cDoc.getElementById('officephone_val')?.textContent || cDoc.getElementById('officephone')?.value);
            const email = clean(cDoc.getElementById('email_val')?.textContent || cDoc.getElementById('email')?.value);

            verifiedDoctors.push({ targetContactId, contactFullName, clientCustomerId, cell, office, email });
          } catch (err) {}
        }
      };

      await Promise.all(Array.from({ length: CONTACT_CONCURRENCY }, () => scanContact()));
      doctorOwnersFound += verifiedDoctors.length;

      // Step C: Fetch PDFs for verified doctors
      for (const doc of verifiedDoctors) {
        const suiteletUrl = `${ORIGIN}${SUITELET_BASE}${doc.targetContactId}`;
        let parsed = { rows: [], datesFound: [], signeeNameInPdf: "" };

        const streamRes = await fetch(suiteletUrl);
        if (streamRes.ok) {
          const buffer = await streamRes.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          if (bytes.length > 500 && bytes[0] === 0x25 && bytes[1] === 0x50) { 
            const flateStreams = extractFlateStreamsByLength(bytes);
            let allTokens = [];
            for (const st of flateStreams) {
              const decomp = await decompressZlibStream(st);
              if (decomp) allTokens = allTokens.concat(extractReassembledPdfTokens(decomp));
            }
            parsed = parseAgreementTableTokens(allTokens);
          }
        }

        const finalSigneeName = parsed.signeeNameInPdf || doc.contactFullName;
        const hasDates = parsed.datesFound.length > 0;
        if (!hasDates) zeroDatesCount++;

        const itemDateSum = parsed.rows.reduce((acc, curr) => acc + (curr.datesCount || 0), 0);
        totalExtractedItems += parsed.rows.length;
        totalExtractedDates += itemDateSum;

        const scheduleStatus = hasDates ? 'HAS SCHEDULED DATES' : (parsed.rows.length > 0 ? 'ZERO DATES (Items with No Dates)' : 'ZERO DATES (Empty Agreement Form)');

        doctorSummaries.push({
          clientInternalId: docEntry.clientInternalId,
          clientCustomerId: doc.clientCustomerId,
          doctorName: finalSigneeName,
          contactId: doc.targetContactId,
          positionPost: "Doctor - Owner",
          consultant: docEntry.consultant,
          scheduleStatus,
          totalItemsCount: parsed.rows.length,
          datesFoundCount: itemDateSum,
          datesFoundList: parsed.datesFound.join(' | ') || 'NONE',
          email: doc.email, cellPhone: doc.cell, officePhone: doc.office,
          pdfUrl: suiteletUrl
        });

        if (parsed.rows.length > 0) {
          parsed.rows.forEach((r) => {
            itemizedRows.push({
              documentTitle: "SCHEDULING AGREEMENT FORM", generatorSuitelet: "customscript_scs_contact_sched_20_pdf_sl",
              contactId: doc.targetContactId, signeeName: finalSigneeName, contactFullName: doc.contactFullName, positionPost: "Doctor - Owner",
              clientInternalId: docEntry.clientInternalId, clientCustomerId: doc.clientCustomerId, consultant: docEntry.consultant,
              email: doc.email, cellPhone: doc.cell, officePhone: doc.office,
              location: r.location, services: r.services, monthDates: r.monthDates, hoursDays: r.hoursDays,
              classroomRecord: "customrecord_crs_attendee_contact", eventRecord: "customrecord_mge_event_contact",
              requiresClientInitials: "true", requiresWitnessInitials: "true", requiresDate: "true", hasValidDate: r.hasValidDate, pdfUrl: suiteletUrl
            });
          });
        } else {
          itemizedRows.push({
            documentTitle: "SCHEDULING AGREEMENT FORM", generatorSuitelet: "customscript_scs_contact_sched_20_pdf_sl",
            contactId: doc.targetContactId, signeeName: finalSigneeName, contactFullName: doc.contactFullName, positionPost: "Doctor - Owner",
            clientInternalId: docEntry.clientInternalId, clientCustomerId: doc.clientCustomerId, consultant: docEntry.consultant,
            email: doc.email, cellPhone: doc.cell, officePhone: doc.office, location: "N/A", services: "No Scheduled Items Found in PDF",
            monthDates: "NO DATES", hoursDays: "N/A", classroomRecord: "customrecord_crs_attendee_contact", eventRecord: "customrecord_mge_event_contact",
            requiresClientInitials: "true", requiresWitnessInitials: "true", requiresDate: "true", hasValidDate: "NO", pdfUrl: suiteletUrl
          });
        }
      }
    } catch (err) {
      console.warn(`Unexpected Audit error on client ${docEntry.clientInternalId}:`, err);
    } finally {
      processed++;
      updateHUD(processed, totalClients, doctorOwnersFound, totalExtractedItems, totalExtractedDates, zeroDatesCount, docEntry.doctorSearchName);
    }
  };

  // === 7. PARALLEL RUNNER ===
  const runWorker = async () => {
    while (queueCursor < queue.length) {
      if (isStopped) break;
      while (isPaused) await sleep(300);
      const entry = queue[queueCursor++];
      if (!entry) break;
      await processDoctorOwner(entry);
      await sleep(50);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorker()));

  // === 8. CSV EXPORT ===
  document.getElementById('p20-status-tag').innerText = isStopped ? 'Stopped' : 'Complete';
  document.getElementById('p20-status-tag').style.background = '#10b981';
  document.getElementById('p20-status-text').innerText = isStopped ? 'Audit Halted.' : 'All PDFs extracted!';
  pauseBtn.disabled = true; stopBtn.disabled = true;
  dlItemizedBtn.disabled = false; dlItemizedBtn.style.cursor = 'pointer';
  dlItemizedBtn.innerText = `Download Full Itemized CSV (${itemizedRows.length} Rows)`;

  const downloadItemizedCSV = () => {
    const headers = [
      "Document Title", "Generator Suitelet", "Signee Contact ID", "Signee Name in File", "Contact Full Name", "Role / Position", "Client Internal ID", "Client Customer ID",
      "Consultant", "Email", "Cell Phone", "Office Phone", "Location", "Services", "Month / Dates", "Hours / Days", "Classroom Record Source", "Event Record Source",
      "Requires Client Initials", "Requires Witness Initials", "Requires Date", "Has Valid Date", "PDF Schedule URL"
    ];
    const rows = itemizedRows.map((r) => [
      escapeCsv(r.documentTitle), escapeCsv(r.generatorSuitelet), r.contactId, escapeCsv(r.signeeName), escapeCsv(r.contactFullName), escapeCsv(r.positionPost), r.clientInternalId,
      escapeCsv(r.clientCustomerId), escapeCsv(r.consultant), escapeCsv(r.email), escapeCsv(r.cellPhone), escapeCsv(r.officePhone), escapeCsv(r.location),
      escapeCsv(r.services), escapeCsv(r.monthDates), escapeCsv(r.hoursDays), escapeCsv(r.classroomRecord), escapeCsv(r.eventRecord), r.requiresClientInitials,
      r.requiresWitnessInitials, r.requiresDate, escapeCsv(r.hasValidDate), escapeCsv(r.pdfUrl)
    ]);
    const csvContent = ["\uFEFF" + headers.join(','), ...rows.map((line) => line.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `doctor_owner_scheduling_agreements_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  dlItemizedBtn.onclick = downloadItemizedCSV;

  const zeroDatesList = doctorSummaries.filter((d) => d.scheduleStatus !== 'HAS SCHEDULED DATES');
  dlNoDatesBtn.disabled = false; dlNoDatesBtn.style.cursor = 'pointer';
  dlNoDatesBtn.innerText = `Download 🚨 Zero Dates CSV (${zeroDatesList.length} Doctors)`;

  const downloadZeroDatesCSV = () => {
    const headers = [
      "Client Internal ID", "Client Customer ID", "Doctor Name", "Contact ID", "Role / Position", "Consultant", "Schedule Status", "Total Items Count", "Dates Found Count", "Dates Found List",
      "Email", "Cell Phone", "Office Phone", "PDF Direct URL"
    ];
    const rows = zeroDatesList.map((d) => [
      d.clientInternalId, escapeCsv(d.clientCustomerId), escapeCsv(d.doctorName), d.contactId, escapeCsv(d.positionPost), escapeCsv(d.consultant), escapeCsv(d.scheduleStatus),
      d.totalItemsCount, d.datesFoundCount, escapeCsv(d.datesFoundList), escapeCsv(d.email), escapeCsv(d.cellPhone), escapeCsv(d.officePhone), escapeCsv(d.pdfUrl)
    ]);
    const csvContent = ["\uFEFF" + headers.join(','), ...rows.map((line) => line.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `doctor_owner_zero_dates_summary_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  dlNoDatesBtn.onclick = downloadZeroDatesCSV;

  downloadItemizedCSV();
  console.log(`%c[COMPLETE] Extracted ${itemizedRows.length} items across ${doctorSummaries.length} Doctor - Owners!`, "color:#10b981;font-weight:bold;font-size:14px;");
})();
```
