/*
 * PORT of Scrapers_fixtures/Contact PDF scraper x2.js ("Doctor - Owner API Extractor").
 * Extraction logic (N/search portal, contact fetch, Schedule 2020 PDF zlib/operator reassembly,
 * agreement-table parsing, row/summary objects) is copied VERBATIM from the original.
 * Changes: no HUD/alerts/downloads; the queue is passed in (built by the header-based client
 * scraper instead of fixed td indexes, which fixes the off-by-one); processes one chunk per call
 * and RETURNS the rows so the extension can reload the tab between chunks (fresh API portal +
 * memory) and build the CSVs with the original headers.
 * Must run in the page's MAIN world (needs the NetSuite iframe's require()).
 * queue items: { clientInternalId, lastName, firstName, doctorSearchName, consultant }
 */
async function scrapePdfSchedulesChunk(queue, opts) {
  opts = opts || {};
  if (!queue || !queue.length) return { ok: true, itemizedRows: [], doctorSummaries: [], processed: 0 };
  window.__MGE_STOP = false;
  let isPaused = false, isStopped = false;
  const hudText = (t) => { try { window.__MGE_STATUS = t; } catch (e) {} };
  const updateHUD = () => {};
  const totalClients = queue.length;

  const CONCURRENCY = 2; 
  const CONTACT_CONCURRENCY = 5; 
  const ORIGIN = window.location.origin;
  const CONTACT_BASE = "/app/common/entity/contact.nl?id=";
  const SUITELET_BASE = "/app/site/hosting/scriptlet.nl?script=customscript_scs_contact_sched_20_pdf_sl&deploy=customdeploy_scs_contact_sched_20_pdf_sl&contactId=";

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const DATE_REGEX = /\b(?:\d{1,4}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-/][A-Za-z0-9]{3,}[-/]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s*-\s*\d{1,2})?,?\s+\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|\d{1,2}\/\d{1,2})\b/i;

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
          hudText("Governance Reset: Rebuilding API Portal...");
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
             hudText("✅ API Portal restored!");
             console.log("%c[SYSTEM] Fresh API Portal Restored! Limits Reset to 1,000.", "color:#10b981");
          } else {
             throw new Error("Portal Timeout");
          }
      } finally {
          isResettingPortal = false;
      }
  }

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


  try {
    await establishPortal();
  } catch (e) {
    return { ok: false, error: 'PORTAL_FAILED', itemizedRows: [], doctorSummaries: [], processed: 0 };
  }

  // === 7. PARALLEL RUNNER ===
  const runWorker = async () => {
    while (queueCursor < queue.length) {
      if (isStopped || window.__MGE_STOP === true) break;
      while (isPaused) await sleep(300);
      const entry = queue[queueCursor++];
      if (!entry) break;
      await processDoctorOwner(entry);
      await sleep(50);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorker()));

  try { if (portalIframe) portalIframe.remove(); } catch (e) {}
  return { ok: true, itemizedRows, doctorSummaries, processed, stopped: window.__MGE_STOP === true };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { scrapePdfSchedulesChunk };
