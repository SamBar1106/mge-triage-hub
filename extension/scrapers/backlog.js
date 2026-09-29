/*
 * PORT of the "NetSuite Paid Uncompleted Items Extractor" (Scrapers_fixtures/netsuite_uncompleted_items_extractor_docs.md).
 * The stable-state iframe loader and dashboard-portlet (neg1061__tab) extraction are copied VERBATIM.
 * Changes: no HUD/localStorage cursor/download; the extension passes one batch of clients per call
 * (default 100, same as BATCH_SIZE) and reloads the tab between batches, which replaces the manual
 * "refresh the page and paste again" step. The client queue now comes from the header-based client
 * scraper, so Email/Consultant are the real Email/Consultant columns (fixes the off-by-one that put
 * Phone/Billing Country into those columns).
 * clients items: { clientId, name, email, consultant }
 */
async function scrapeBacklogChunk(clients, opts) {
  opts = opts || {};
  const queue = clients || [];
  let cursor = 0;
  const currentBatchStart = 0;
  const currentBatchTarget = queue.length;
  const updateUI = () => {};

  const CONCURRENCY = 3;           
  const RENDER_TIMEOUT_MS = 15000; 
  const BATCH_SIZE = 100; // Hardcoded to 100 to absolutely prevent Chrome from crashing
  const DASHBOARD_BASE = "/app/center/card.nl?sc=-69&entityid=";

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

  // === 4. STABLE-STATE IFRAME LOADER ===
  const loadInFrame = (frame, url) => {
    return new Promise((resolve) => {
      frame.src = url;
      const start = Date.now();
      let lastRowCount = -1;
      let stableChecks = 0;

      const timer = setInterval(() => {
        try {
          const doc = frame.contentDocument || frame.contentWindow.document;
          if (doc && doc.readyState === 'complete') {
            const table = doc.getElementById('neg1061__tab');
            const text = doc.body ? doc.body.innerText : '';
            
            if (text.includes('No results found')) {
               clearInterval(timer);
               return resolve(doc);
            }

            if (table) {
                const rowCount = table.querySelectorAll('tr').length;
                if (rowCount > 1) {
                    if (rowCount === lastRowCount) {
                        stableChecks++;
                        if (stableChecks >= 4) { 
                            clearInterval(timer);
                            return resolve(doc);
                        }
                    } else {
                        lastRowCount = rowCount;
                        stableChecks = 0;
                    }
                }
            }

            if (Date.now() - start > RENDER_TIMEOUT_MS) {
              clearInterval(timer);
              resolve(doc);
            }
          }
        } catch (e) {
          if (Date.now() - start > RENDER_TIMEOUT_MS) {
            clearInterval(timer);
            resolve(null);
          }
        }
      }, 200);
    });
  };

  // === 5. DASHBOARD EXTRACTION ===
  let processedCount = 0;
  const uncompletedReport = [];
  const batchTotal = currentBatchTarget - currentBatchStart;

  const processClient = async (client) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:600px;height:400px;opacity:0;pointer-events:none;';
    document.body.appendChild(frame);

    try {
      const doc = await loadInFrame(frame, `${DASHBOARD_BASE}${client.clientId}`);
      if (!doc) return;

      const itemsTable = doc.getElementById('neg1061__tab');
      if (itemsTable) {
        const itemRows = Array.from(itemsTable.querySelectorAll('tr')).slice(1);
        for (const tr of itemRows) {
          const c = tr.querySelectorAll('td');
          if (c.length <= 6) continue;

          const itemName = clean(c[1]?.innerText);
          if (!itemName || itemName.toLowerCase() === 'item') continue;

          const dateCompleted = clean(c[6]?.innerText);
          if (dateCompleted && dateCompleted.length > 0) continue;

          const rawAmount = clean(c[4]?.innerText);
          const numericAmount = parseFloat(rawAmount.replace(/[^0-9.-]+/g, '') || '0');
          if (numericAmount <= 0) continue;

          const memo = clean(c[2]?.innerText);
          const datePurchased = clean(c[3]?.innerText);
          const dateStarted = clean(c[5]?.innerText);

          uncompletedReport.push({
            clientId: client.clientId,
            clientName: client.name,
            email: client.email,
            consultant: client.consultant,
            itemName: itemName,
            memo: memo,
            datePurchased: datePurchased,
            amount: rawAmount,
            dateStarted: dateStarted, 
            dateCompleted: "",
            completionStatus: "UNCOMPLETED"
          });
        }
      }
    } catch (e) {
      console.warn(`Error on client ${client.clientId}:`, e);
    } finally {
      frame.src = 'about:blank';
      frame.remove();
      processedCount++;
      updateUI(processedCount, batchTotal, client.name);
    }
  };

  // === 6. RUN BATCH ===
  const runWorker = async () => {
    while (cursor < currentBatchTarget) {
      const client = queue[cursor++];
      if (!client) break;
      await processClient(client);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorker()));

  return { ok: true, rows: uncompletedReport, processed: processedCount };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { scrapeBacklogChunk };
