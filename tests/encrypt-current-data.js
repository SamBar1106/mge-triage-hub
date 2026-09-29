/* One-off / manual helper: encrypt local plaintext data/*.csv into data/enc/*.csv.enc using the
   exact extension format, and write data/enc/last_run.json (counts + timestamps only).
   Usage: node tests/encrypt-current-data.js /path/to/passphrase.txt */
'use strict';
const fs = require('fs'), path = require('path');
const MGECrypto = require('../extension/lib/crypto.js');
const ROOT = path.resolve(__dirname, '..');
const pass = fs.readFileSync(process.argv[2], 'utf8').trim();
if (pass.length < 12) throw new Error('passphrase too short');
const parse = new Function(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8').match(/function parseCSV[\s\S]*?\n}\n/)[0] + 'return parseCSV;')();
(async () => {
  const outDir = path.join(ROOT, 'data/enc'); fs.mkdirSync(outDir, { recursive: true });
  const files = {}; const now = new Date().toISOString();
  for (const n of ['clients_directory.csv', 'contacts_directory.csv', 'pdf_directory.csv', 'unscheduled_backlog.csv']) {
    const p = path.join(ROOT, 'data', n); if (!fs.existsSync(p)) { console.log('missing', n); continue; }
    const text = fs.readFileSync(p, 'utf8');
    const enc = JSON.stringify(await MGECrypto.encryptText(text, pass, n));
    fs.writeFileSync(path.join(outDir, n + '.enc'), enc);
    files[n] = { rows: parse(text.replace(/^\uFEFF/, '')).length, bytes: enc.length, updatedAt: fs.statSync(p).mtime.toISOString() };
    console.log(`encrypted ${n}: ${files[n].rows} rows -> ${enc.length} bytes`);
  }
  const status = { schema: 1, ok: true, startedAt: now, finishedAt: now, trigger: 'initial-migration', counts: {}, files, errors: [], extensionVersion: 'n/a (seeded from existing CSVs)' };
  fs.writeFileSync(path.join(outDir, 'last_run.json'), JSON.stringify(status, null, 2) + '\n');
})();
