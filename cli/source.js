'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { hubError } = require('./errors');

const REPO = 'https://raw.githubusercontent.com/SamBar1106/mge-triage-hub';
const JS_FILES = ['mge-crypto.js', 'mge-buckets.js', 'app.js'];
const MAX_BYTES = 32 * 1024 * 1024;

function stripOneNewline(text) {
  let s = String(text);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

function safeRef(ref) {
  const value = String(ref || '');
  if (!value || value.length > 200 || !/^[A-Za-z0-9._\-/]+$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) {
    throw hubError(1, 'invalid --ref');
  }
  return value;
}

function refPath(ref) {
  return safeRef(ref).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function readPassphrase(opts) {
  if (opts.passphraseFile) return readPassphraseFile(opts.passphraseFile);
  if (process.env.MGE_HUB_PASSPHRASE_FILE) return readPassphraseFile(process.env.MGE_HUB_PASSPHRASE_FILE);
  if (process.env.MGE_HUB_PASSPHRASE != null && process.env.MGE_HUB_PASSPHRASE !== '') {
    return stripOneNewline(process.env.MGE_HUB_PASSPHRASE);
  }
  throw hubError(1, 'passphrase is required (--passphrase-file, MGE_HUB_PASSPHRASE_FILE, or MGE_HUB_PASSPHRASE)');
}

function readPassphraseFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw hubError(1, 'could not read passphrase file');
  }
  return stripOneNewline(text);
}

function cacheDir(opts) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const root = path.join(base, 'mge-hub');
  const dir = path.join(root, safeRef(opts.ref).replace(/\//g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch (e) { /* ignore */ }
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    throw hubError(1, 'could not write encrypted cache');
  }
}

function cacheFile(opts, name) {
  const base = path.basename(name);
  if (base !== name || !/^[A-Za-z0-9._-]+$/.test(base)) throw hubError(1, 'invalid data file name');
  return path.join(cacheDir(opts), base);
}

function httpsText(url, redirects) {
  const left = redirects == null ? 5 : redirects;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const req = https.get(url, {
      headers: { 'User-Agent': 'mge-hub', 'Accept-Encoding': 'identity' }
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (left <= 0) return fail(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        httpsText(next, left - 1).then(resolve, fail);
        return;
      }
      if (code !== 200) {
        res.resume();
        return fail(new Error('download failed'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          fail(new Error('download too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
      res.on('error', fail);
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
  });
}

function repoRoot() {
  return path.resolve(__dirname, '..');
}

async function loadCode(opts) {
  if (opts.code === 'remote') {
    const ref = refPath(opts.ref);
    const out = {};
    for (const name of JS_FILES) {
      try {
        out[name] = await httpsText(`${REPO}/${ref}/js/${name}`);
      } catch (e) {
        throw hubError(1, 'could not download hub code');
      }
    }
    return { crypto: out['mge-crypto.js'], buckets: out['mge-buckets.js'], app: out['app.js'] };
  }
  if (opts.code !== 'local') throw hubError(1, 'invalid --code');
  const dir = path.join(repoRoot(), 'js');
  try {
    return {
      crypto: fs.readFileSync(path.join(dir, 'mge-crypto.js'), 'utf8'),
      buckets: fs.readFileSync(path.join(dir, 'mge-buckets.js'), 'utf8'),
      app: fs.readFileSync(path.join(dir, 'app.js'), 'utf8')
    };
  } catch (e) {
    throw hubError(1, 'could not load hub code');
  }
}

function stripBom(text) {
  if (text && text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

async function readEnc(name, opts) {
  if (opts.sourceDir) {
    const from = path.join(opts.sourceDir, name);
    let body;
    try {
      body = fs.readFileSync(from);
    } catch (e) {
      throw hubError(1, 'missing encrypted file ' + name);
    }
    if (!opts.noCache) writePrivate(cacheFile(opts, name), body);
    return stripBom(body.toString('utf8'));
  }
  const url = `${REPO}/${refPath(opts.ref)}/data/enc/${encodeURIComponent(name)}`;
  try {
    const body = stripBom(await httpsText(url));
    if (!opts.noCache) writePrivate(cacheFile(opts, name), body);
    return body;
  } catch (e) {
    if (!opts.noCache) {
      const cached = cacheFile(opts, name);
      if (fs.existsSync(cached)) {
        process.stderr.write('using cached encrypted file ' + name + '\n');
        return stripBom(fs.readFileSync(cached, 'utf8'));
      }
    }
    throw hubError(1, 'could not download ' + name);
  }
}

async function readLastRun(opts) {
  if (opts.sourceDir) {
    const from = path.join(opts.sourceDir, 'last_run.json');
    if (!fs.existsSync(from)) return null;
    try {
      return stripBom(fs.readFileSync(from, 'utf8'));
    } catch (e) {
      return null;
    }
  }
  try {
    return stripBom(await httpsText(`${REPO}/${refPath(opts.ref)}/data/enc/last_run.json`));
  } catch (e) {
    return null;
  }
}

async function loadData(opts, encNames) {
  const entries = await Promise.all(encNames.map(async (name) => [name, await readEnc(name, opts)]));
  const enc = {};
  entries.forEach(([name, body]) => { enc[name] = body; });
  const lastRun = await readLastRun(opts);
  return { enc, lastRun };
}

module.exports = {
  stripOneNewline,
  readPassphrase,
  loadCode,
  loadData,
  safeRef
};
