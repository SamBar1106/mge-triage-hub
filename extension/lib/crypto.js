/*
 * MGE shared encryption helpers (identical copy lives at js/mge-crypto.js for the web app).
 * Format ("MGE-ENC v1", JSON):
 *   { v:1, name, alg:"AES-GCM-256", kdf:"PBKDF2-SHA256", iter, z:"gzip"|"none",
 *     salt:<b64 16B>, iv:<b64 12B>, ct:<b64 ciphertext+tag>, createdAt }
 * Key = PBKDF2(passphrase, random salt, iter, SHA-256) -> AES-GCM 256.
 * Plaintext = UTF-8 CSV, gzip-compressed before encryption when CompressionStream exists.
 * AAD = "mge:" + name, so a file cannot be silently swapped for another dataset.
 */
(function (root) {
  'use strict';
  const ITERATIONS = 250000;
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8'); // strips a leading BOM by default

  function toB64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipeBytes(bytes, transform) {
    const rs = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    const buf = await new Response(rs.pipeThrough(transform)).arrayBuffer();
    return new Uint8Array(buf);
  }
  const canGzip = () => typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined';

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptText(text, passphrase, name) {
    if (!passphrase) throw new Error('NO_PASSPHRASE');
    name = String(name || '');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let plain = te.encode(text);
    let z = 'none';
    if (canGzip()) { plain = await pipeBytes(plain, new CompressionStream('gzip')); z = 'gzip'; }
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: te.encode('mge:' + name) }, key, plain));
    return {
      v: 1, name, alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iter: ITERATIONS, z,
      salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), createdAt: new Date().toISOString()
    };
  }

  async function decryptToText(obj, passphrase) {
    if (typeof obj === 'string') obj = JSON.parse(obj);
    if (!obj || obj.v !== 1 || !obj.ct) throw new Error('BAD_FORMAT');
    const key = await deriveKey(passphrase || '', fromB64(obj.salt), obj.iter || ITERATIONS);
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(obj.iv), additionalData: te.encode('mge:' + (obj.name || '')) },
        key, fromB64(obj.ct)));
    } catch (e) {
      throw new Error('BAD_PASSPHRASE'); // wrong passphrase OR tampered file
    }
    if (obj.z === 'gzip') {
      if (typeof DecompressionStream === 'undefined') throw new Error('NO_GZIP_SUPPORT');
      plain = await pipeBytes(plain, new DecompressionStream('gzip'));
    }
    return td.decode(plain);
  }

  function isEncrypted(textOrObj) {
    try {
      const o = typeof textOrObj === 'string' ? JSON.parse(textOrObj) : textOrObj;
      return !!(o && o.v === 1 && o.ct && o.iv && o.salt);
    } catch (e) { return false; }
  }

  const api = { encryptText, decryptToText, isEncrypted, toB64, fromB64, ITERATIONS };
  root.MGECrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
