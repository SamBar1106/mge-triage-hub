const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const send = (type) => chrome.runtime.sendMessage({ type });
const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');

const SCRAPER_NAMES = {
  clients: 'Client list',
  pdf: 'PDF schedules',
  backlog: 'Unscheduled backlog',
  upload: 'Upload'
};

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

  const progBox = $('progress');
  if (progBox) {
    progBox.replaceChildren();
    const list = document.createElement('div');
    list.className = 'progress-list';
    for (const key of ['clients', 'pdf', 'backlog', 'upload']) {
      const p = (run && run.progress && run.progress[key]) || {
        status: 'Waiting',
        step: 'Waiting',
        done: 0,
        total: null,
        startedAt: null
      };
      const row = document.createElement('div');
      row.className = 'progress-row';

      const header = document.createElement('div');
      header.className = 'progress-header';
      const nameEl = document.createElement('span');
      nameEl.className = 'progress-name';
      nameEl.textContent = SCRAPER_NAMES[key];
      const statusEl = document.createElement('span');
      statusEl.className = `progress-status status-${(p.status || 'waiting').toLowerCase()}`;
      statusEl.textContent = p.status || 'Waiting';
      header.appendChild(nameEl);
      header.appendChild(statusEl);

      const details = document.createElement('div');
      details.className = 'progress-details';
      const stepEl = document.createElement('span');
      stepEl.className = 'progress-step';
      stepEl.textContent = p.step || '—';
      const timeEl = document.createElement('span');
      timeEl.className = 'progress-time';
      timeEl.textContent = p.startedAt ? `Started ${fmt(p.startedAt)}` : '—';
      details.appendChild(stepEl);
      details.appendChild(timeEl);

      const bar = document.createElement('progress');
      if (p.total !== null && p.total !== undefined && p.total > 0) {
        bar.value = p.done || 0;
        bar.max = p.total;
      } else if (p.status === 'Done') {
        bar.value = 1;
        bar.max = 1;
      } else if (p.status === 'Running') {
        bar.removeAttribute('value');
      } else {
        bar.value = 0;
        bar.max = 1;
      }

      row.appendChild(header);
      row.appendChild(details);
      row.appendChild(bar);
      list.appendChild(row);
    }
    progBox.appendChild(list);
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
    if (typeof setInterval !== 'undefined') setInterval(refresh, 1000);
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(() => refresh());
    }
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { refresh, fmt, SCRAPER_NAMES };
