/* Minimal GitHub Contents API client (fine-grained token: this repo only, Contents: Read and write). */
(function (root) {
  'use strict';
  const API = 'https://api.github.com';

  function headers(token, accept) {
    return {
      Authorization: 'Bearer ' + token,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function getSha(cfg, path) {
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(cfg.branch)}`;
    // "object" media type returns metadata (sha) even for files > 1 MB.
    const r = await fetch(url, { headers: headers(cfg.token, 'application/vnd.github.object+json'), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GH_GET_' + r.status);
    return (await r.json()).sha || null;
  }

  async function putFile(cfg, path, text, message) {
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${encPath(path)}`;
    const content = utf8ToB64(text);
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await getSha(cfg, path);
      const body = { message, content, branch: cfg.branch };
      if (sha) body.sha = sha;
      const r = await fetch(url, {
        method: 'PUT',
        headers: Object.assign(headers(cfg.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      });
      if (r.ok) return (await r.json()).commit?.sha || true;
      if (r.status === 409 || r.status === 422) { await new Promise((res) => setTimeout(res, 1500)); continue; } // sha race: refetch
      throw new Error('GH_PUT_' + r.status);
    }
    throw new Error('GH_PUT_CONFLICT');
  }

  async function testAccess(cfg) {
    const r = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, { headers: headers(cfg.token) });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, visibility: j.visibility, canPush: !!(j.permissions && j.permissions.push), defaultBranch: j.default_branch };
  }

  const api = { putFile, getSha, testAccess, utf8ToB64 };
  root.MGEGitHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
