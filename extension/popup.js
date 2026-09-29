const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const send = (type) => chrome.runtime.sendMessage({ type });
const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');

async function refresh() {
  const st = await send('status');
  const run = st.run, last = st.lastStatus;
  const running = run && ['clients', 'pdf', 'backlog', 'upload'].includes(run.phase);
  const box = $('summary');
  if (box) box.replaceChildren();
  const line = (text, cls) => {
    if (!box) return;
    const d = document.createElement('div');
    d.textContent = text;
    if (cls) d.className = cls;
    box.appendChild(d);
  };
  line(`Next scheduled run: ${fmt(st.nextRun)}`);
  if (running) line(`Running: ${run.phase} (started ${fmt(run.startedAt)})`);
  if (last) {
    const isSuccess = last.status ? last.status === 'success' : !!last.ok;
    line(`Last run: ${isSuccess ? 'SUCCESS' : 'FAILED'} at ${fmt(last.timestamp || last.finishedAt)}`, isSuccess ? 'ok' : 'bad');
    if (last.clients !== undefined && last.clients !== null) line(`Clients: ${last.clients}`, 'muted');
    if (last.pending !== undefined && last.pending !== null) line(`Pending: ${last.pending}`, 'muted');
    else if (last.pending === null) line('Pending: unknown', 'muted');
    if (last.contacts !== undefined && last.contacts !== null) line(`Contacts: ${last.contacts}`, 'muted');
    if (last.pdf !== undefined && last.pdf !== null) line(`PDF: ${last.pdf}`, 'muted');
    if (last.backlog !== undefined && last.backlog !== null) line(`Backlog: ${last.backlog}`, 'muted');
    if (last.files) {
      Object.entries(last.files).forEach(([n, f]) => line(`${n}: ${f.rows} rows`, 'muted'));
    }
    const err = last.error || (last.errors && last.errors.length ? last.errors.join(', ') : null);
    if (err) line(err, 'bad');
  }
  const logEl = $('log');
  if (logEl) logEl.textContent = (run && run.log ? run.log : []).join('\n');
  const runBtn = $('run');
  if (runBtn) runBtn.disabled = !!running;
}
if (typeof document !== 'undefined') {
  const rBtn = $('run'); if (rBtn) rBtn.onclick = async () => { const r = await send('runNow'); if (!r.started) alert('Not started: ' + r.reason); refresh(); };
  const sBtn = $('stop'); if (sBtn) sBtn.onclick = async () => { await send('stop'); refresh(); };
  const oBtn = $('opts'); if (oBtn) oBtn.onclick = () => chrome.runtime.openOptionsPage();
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    refresh();
    if (typeof setInterval !== 'undefined') setInterval(refresh, 3000);
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { refresh, fmt };
