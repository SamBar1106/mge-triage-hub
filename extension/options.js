const $ = (id) => document.getElementById(id);
const TEXT = ['nsOrigin', 'searchId', 'ghOwner', 'ghRepo', 'ghBranch', 'ghToken', 'pdfChunk', 'backlogBatch'];
const BOOL = ['enableClients', 'enablePdf', 'enableBacklog'];
const DEF = { nsOrigin: 'https://3940793.app.netsuite.com', searchId: '72', ghOwner: 'SamBar1106', ghRepo: 'mge-triage-hub', ghBranch: 'main',
  pdfChunk: 40, backlogBatch: 100, enableClients: true, enablePdf: true, enableBacklog: true, runHour: 10, runMinute: 0 };
const msg = (t, ok) => { $('msg').textContent = t; $('msg').className = ok ? 'ok' : 'bad'; };

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEF, settings || {});
  TEXT.forEach((k) => { $(k).value = s[k] ?? ''; });
  BOOL.forEach((k) => { $(k).checked = !!s[k]; });
  $('runTime').value = `${String(s.runHour).padStart(2, '0')}:${String(s.runMinute).padStart(2, '0')}`;
  if (s.passphrase) { $('passphrase').placeholder = '(saved — leave blank to keep)'; $('passphrase2').placeholder = '(saved)'; }
}

$('save').onclick = async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEF, settings || {});
  TEXT.forEach((k) => { s[k] = $(k).value.trim(); });
  s.pdfChunk = Math.max(5, Number(s.pdfChunk) || 40);
  s.backlogBatch = Math.min(100, Math.max(10, Number(s.backlogBatch) || 100));
  BOOL.forEach((k) => { s[k] = $(k).checked; });
  const [h, m] = ($('runTime').value || '10:00').split(':').map(Number);
  s.runHour = h; s.runMinute = m;
  s.nsOrigin = s.nsOrigin.replace(/\/+$/, '');
  const p1 = $('passphrase').value, p2 = $('passphrase2').value;
  if (p1 || p2) {
    if (p1 !== p2) return msg('Passphrases do not match.', false);
    if (p1.length < 12) return msg('Use a passphrase of at least 12 characters.', false);
    s.passphrase = p1;
  }
  if (s.ghToken && !/^(github_pat_|ghp_)/.test(s.ghToken)) return msg('That does not look like a GitHub token.', false);
  await chrome.storage.local.set({ settings: s });
  $('passphrase').value = ''; $('passphrase2').value = '';
  const r = await chrome.runtime.sendMessage({ type: 'reschedule' });
  msg(`Saved. Next run: ${new Date(r.nextRun).toLocaleString()}`, true);
  load();
};
$('testGh').onclick = async () => {
  msg('Testing…', true);
  const r = await chrome.runtime.sendMessage({ type: 'testGitHub' });
  if (!r.ok) return msg(`GitHub said ${r.status || r.error}. Check the token, owner and repo.`, false);
  msg(r.canPush ? `Token works (repo is ${r.visibility}; write access OK).` : 'Token can read but NOT write. Give it "Contents: Read and write".', r.canPush);
};
$('testNs').onclick = async () => {
  msg('Opening NetSuite in a background tab…', true);
  const r = await chrome.runtime.sendMessage({ type: 'testNetSuite' });
  if (!r.ok) return msg(r.error === 'NOT_LOGGED_IN' ? 'NetSuite is not logged in in this Chrome.' : `NetSuite test failed: ${r.error}`, false);
  msg(`NetSuite OK: ${r.clients} clients found on ${r.pages} page(s).${r.missingColumns.length ? ' Missing columns: ' + r.missingColumns.join(', ') : ''}`, true);
};
$('runNow').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'runNow' });
  msg(r.started ? 'Run started. Watch progress in the toolbar popup.' : `Not started: ${r.reason}`, !!r.started);
};
load();
