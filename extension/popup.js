const $ = (id) => document.getElementById(id);
const send = (type) => chrome.runtime.sendMessage({ type });
const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');

async function refresh() {
  const st = await send('status');
  const run = st.run, last = st.lastStatus;
  const running = run && ['clients', 'pdf', 'backlog', 'upload'].includes(run.phase);
  const box = $('summary'); box.replaceChildren();
  const line = (text, cls) => { const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; box.appendChild(d); };
  line(`Next scheduled run: ${fmt(st.nextRun)}`);
  if (running) line(`Running: ${run.phase} (started ${fmt(run.startedAt)})`);
  if (last) {
    line(`Last run: ${last.ok ? 'OK' : 'FAILED'} at ${fmt(last.finishedAt)}`, last.ok ? 'ok' : 'bad');
    Object.entries(last.files || {}).forEach(([n, f]) => line(`${n}: ${f.rows} rows`, 'muted'));
    if (last.errors && last.errors.length) line(last.errors.join(', '), 'bad');
  }
  $('log').textContent = (run && run.log ? run.log : []).join('\n');
  $('run').disabled = !!running;
}
$('run').onclick = async () => { const r = await send('runNow'); if (!r.started) alert('Not started: ' + r.reason); refresh(); };
$('stop').onclick = async () => { await send('stop'); refresh(); };
$('opts').onclick = () => chrome.runtime.openOptionsPage();
refresh(); setInterval(refresh, 3000);
