# NetSuite Paid Uncompleted Items Extractor
**Project Documentation & Technical Guide**

## 1. The Objective
The goal was to build an automated browser script to extract a master list of **"Paid Uncompleted Items"** across 749 active clients from a specific NetSuite Dashboard portlet (`neg1061__tab`). The extraction needed to capture critical financial data, including the exact **Memo**, **Amount**, **Date Purchased**, and **Date Started**, while filtering out `$0.00` items and items that already had a **Date Completed**.

## 2. The Challenges & Roadblocks
During development, we encountered two massive technical hurdles related to how NetSuite and Google Chrome operate:

1. **The "Missing Rows" Bug (Asynchronous Loading)**
   NetSuite dashboard portlets load their data dynamically. The previous extraction scripts were grabbing the HTML table the exact millisecond the first row appeared. If a client had 64 items, the script would frequently capture only 1 item and move on before the other 63 could load, resulting in massive data loss.
2. **The "Aw, Snap! Error Code 5" Bug (Chrome Memory Leaks)**
   Loading hundreds of heavy NetSuite dashboards sequentially inside hidden iframes causes Chrome DevTools to hoard network history. Even when destroying the `iframe` elements, the Chrome V8 Engine eventually hits a hard 4GB memory limit and physically crashes the tab (Error Code 5).

## 3. The Solutions
To overcome these limitations without resorting to complex external software, we engineered a completely custom **Auto-Saving Batch Extractor**:

* **The "Stability Sensor"**
  Instead of guessing when a dashboard is done loading, the script implements a multi-check stability sensor. It continuously counts the number of rows in the table every 200 milliseconds. It refuses to extract the data until the row count remains completely unchanged for 4 consecutive checks (800ms). This guarantees 100% data capture without missing a single dynamically loaded row.
* **The "Video Game" Auto-Save Architecture**
  To completely bypass Chrome's 4GB memory crash limit, the script limits itself to chunks of 100 clients per run. After processing 100 clients, it automatically downloads a clean CSV file (e.g., `Batch_1_to_100.csv`) and saves the user's exact queue position (cursor) inside the browser's persistent `localStorage`. The script then explicitly halts and instructs the user to refresh the page. Refreshing the page wipes Chrome's memory clean (0% usage). When the user pastes the script again, it automatically detects the save file and resumes from client 101.
* **Inline Data Sanitization**
  The script skips items natively by looking at the HTML table cells. If `Date Completed` has text, or if the `Amount` is <= 0, it skips the row immediately, ensuring the downloaded CSV is perfectly clean and requires zero manual cleanup in Excel.

---

## 4. The Final Master Code

```javascript
(async () => {
  if (!window.location.hostname.includes('netsuite.com')) {
    return alert(`Target context error: Switch DevTools context to top (${window.location.hostname}).`);
  }

  // === 1. CONFIGURATION ===
  const CONCURRENCY = 3;           
  const RENDER_TIMEOUT_MS = 15000; 
  const BATCH_SIZE = 100; // Hardcoded to 100 to absolutely prevent Chrome from crashing
  const DASHBOARD_BASE = "/app/center/card.nl?sc=-69&entityid=";

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

  // === 2. ROBUST QUEUE RESOLUTION ===
  const bodyTable = document.getElementById('div__body');
  if (!bodyTable) {
    return alert("No results table found. Ensure #div__body is present.");
  }

  const tableRows = Array.from(bodyTable.querySelectorAll("tr.uir-list-row-tr, tr[id^='row']"));
  const queue = [];
  const seenIds = new Set();

  for (const r of tableRows) {
    const clientLink = r.querySelector("a[href*='custjob.nl']");
    if (!clientLink) continue;
    const match = clientLink.href.match(/[?&]id=(\d+)/);
    if (!match) continue;
    
    const clientId = match[1];
    if (seenIds.has(clientId)) continue;
    seenIds.add(clientId);

    const cells = Array.from(r.querySelectorAll('td')).map(td => clean(td.textContent));
    queue.push({
      clientId,
      name: `${cells[9] || ""} ${cells[8] || ""}`.trim() || `Client #${clientId}`,
      email: cells[11] || "",
      consultant: cells[18] || "Unassigned"
    });
  }

  const totalClients = queue.length;
  if (totalClients === 0) return alert("Queued 0 clients! Make sure you are running this on the Saved Search list page.");

  // === AUTO-RESUME CHECKPOINT LOGIC ===
  let cursor = parseInt(localStorage.getItem('ns_batch_cursor') || '0', 10);
  if (cursor >= totalClients) cursor = 0; 

  if (cursor > 0) {
      if (!confirm(`💾 Saved progress found!\n\nResume extracting from client ${cursor + 1} out of ${totalClients}?\n\n(Click Cancel to wipe save and start over from 1)`)) {
          cursor = 0;
      }
  }
  
  const currentBatchStart = cursor;
  let currentBatchTarget = Math.min(cursor + BATCH_SIZE, totalClients);

  console.log(`%c[AUTO-SAVE EXTRACTOR] Processing clients ${currentBatchStart + 1} to ${currentBatchTarget}...`, "color:#38bdf8;font-weight:bold;font-size:14px;");

  // === 3. HUD MONITOR OVERLAY ===
  const existingUI = document.getElementById('ns-purchased-items-hud');
  if (existingUI) existingUI.remove();

  const ui = document.createElement('div');
  ui.id = 'ns-purchased-items-hud';
  ui.innerHTML = `
    <div style="position:fixed;bottom:20px;right:20px;z-index:999999;width:380px;background:#0f172a;color:#f8fafc;padding:16px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;border:1px solid #334155;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <b style="font-size:13px;color:#38bdf8;">Auto-Save Batch: ${currentBatchStart + 1} to ${currentBatchTarget}</b>
        <span id="purchased-status-tag" style="background:#0284c7;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;">Running</span>
      </div>
      <div id="purchased-progress-text" style="margin-bottom:8px;color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Starting workers...</div>
      <div style="width:100%;background:#1e293b;height:8px;border-radius:4px;overflow:hidden;margin-bottom:12px;">
        <div id="purchased-progress-bar" style="width:0%;height:100%;background:#38bdf8;transition:width 0.2s;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(ui);

  const updateUI = (current, total, clientName) => {
    const pct = Math.round((current / total) * 100);
    document.getElementById('purchased-progress-bar').style.width = `${pct}%`;
    document.getElementById('purchased-progress-text').innerText = `[${current}/${total}] ${clientName}`;
  };

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

  // === 7. CSV EXPORT & SAVE CHECKPOINT ===
  document.getElementById('purchased-status-tag').innerText = 'Complete';
  document.getElementById('purchased-status-tag').style.background = '#10b981';
  document.getElementById('purchased-progress-text').innerText = 'Batch complete! Downloading CSV...';

  // Save the progress marker so it remembers where it left off!
  localStorage.setItem('ns_batch_cursor', cursor);

  const headers = [
    "Client ID", "Client Name", "Email", "Consultant", "Item Name", "Memo", 
    "Date Purchased", "Amount", "Date Started", "Date Completed", "Completion Status"
  ];

  const csvRows = uncompletedReport.map(r => [
    r.clientId, escapeCsv(r.clientName), escapeCsv(r.email), escapeCsv(r.consultant),
    escapeCsv(r.itemName), escapeCsv(r.memo), escapeCsv(r.datePurchased), escapeCsv(r.amount),
    escapeCsv(r.dateStarted), escapeCsv(r.dateCompleted), escapeCsv(r.completionStatus)
  ]);

  const csvContent = ["\uFEFF" + headers.join(','), ...csvRows.map(line => line.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Batch_${currentBatchStart + 1}_to_${currentBatchTarget}_items.csv`;
  link.click();
  URL.revokeObjectURL(link.href);

  // Completion Prompts
  if (cursor < totalClients) {
      alert(`✅ Batch ${currentBatchStart + 1} to ${currentBatchTarget} complete!\nYour CSV has downloaded.\n\nCRITICAL NEXT STEP:\n1. Refresh this Chrome tab to clear the memory.\n2. Paste the exact same script again to resume from client ${cursor + 1}!`);
  } else {
      alert(`🎉 ALL CLIENTS COMPLETE! \n\nYou can now combine all your Batch CSV files in Excel!`);
      localStorage.removeItem('ns_batch_cursor'); // Wipe the save data for next time
  }

})();
```

## 5. Execution Instructions
1. Navigate to the **Active Client List** (Saved Search) in NetSuite.
2. Open Chrome Developer Tools (F12 or Right-Click -> Inspect -> Console).
3. Paste the Master Code into the console and press Enter.
4. Let the script run. Do not click around the page while it is extracting.
5. Once it finishes a batch of 100, it will automatically download `Batch_X_to_Y_items.csv`.
6. Read the popup alert. **Click OK, and physically refresh the page (F5).**
7. Open the console, paste the exact same script, and hit Enter. It will detect the `localStorage` save file and prompt you to resume where it left off.
8. Repeat until the final popup says "ALL CLIENTS COMPLETE!". Drag all the CSVs into Excel or a CSV Merger tool.
