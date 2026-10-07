'use strict';

const vm = require('vm');
const { hubError } = require('./errors');

/*
 * Load js/mge-crypto.js, js/mge-buckets.js, and js/app.js in index.html order
 * inside one Node vm. DOMContentLoaded is recorded and never fired, so initApp
 * does not run (no passphrase prompt, no Firebase).
 */

function makeStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
    key(i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; }
  };
}

function makeElement(id) {
  let text = '';
  let html = '';
  const el = {
    id: id == null ? '' : String(id),
    tagName: 'DIV',
    className: '',
    title: '',
    value: '',
    style: {},
    children: [],
    attributes: {},
    options: [],
    selectedIndex: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    focus() {},
    click() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
  Object.defineProperty(el, 'innerText', {
    configurable: true,
    get() { return text; },
    set(v) { text = v == null ? '' : String(v); }
  });
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() { return text; },
    set(v) { text = v == null ? '' : String(v); }
  });
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return html; },
    set(v) { html = v == null ? '' : String(v); }
  });
  if (id === 'filter-event' || id === 'filter-status' || id === 'filter-expired' || id === 'filter-consultant') {
    el.value = 'ALL';
  }
  if (id === 'filter-event') {
    el.options = [{ value: 'ALL', text: 'All Events', textContent: 'All Events' }];
  }
  return el;
}

function createSandbox() {
  const elements = new Map();
  function getElementById(id) {
    const key = String(id);
    if (!elements.has(key)) elements.set(key, makeElement(key));
    return elements.get(key);
  }
  const document = {
    getElementById,
    createElement(tag) {
      const el = makeElement('');
      el.tagName = String(tag || '').toUpperCase();
      return el;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };
  document.body = makeElement('body');
  document.body.tagName = 'BODY';
  document.documentElement = makeElement('html');

  const window = {
    document,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { href: 'https://sambar1106.github.io/mge-triage-hub/', reload() {} },
    screen: { width: 1280, height: 800 },
    navigator: { userAgent: 'mge-hub' },
    addEventListener(type) {
      if (type === 'DOMContentLoaded') return;
    },
    removeEventListener() {},
    dispatchEvent() { return true; },
    open() { return null; }
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    crypto: globalThis.crypto,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    ReadableStream: globalThis.ReadableStream,
    Response: globalThis.Response,
    btoa,
    atob,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Intl,
    encodeURIComponent,
    decodeURIComponent,
    document,
    window,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    navigator: window.navigator
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadHub(sources) {
  const sandbox = createSandbox();
  const order = [
    ['mge-crypto.js', sources.crypto],
    ['mge-buckets.js', sources.buckets],
    ['app.js', sources.app]
  ];
  for (const [filename, code] of order) {
    if (!code) throw hubError(1, 'could not load hub code');
    try {
      vm.runInContext(code, sandbox, { filename });
    } catch (e) {
      const detail = e && e.message ? String(e.message).split('\n')[0].slice(0, 180) : '';
      throw hubError(1, detail ? 'could not load hub code: ' + detail : 'could not load hub code');
    }
  }
  if (typeof sandbox.buildFromTexts !== 'function' || typeof sandbox.MGECrypto === 'undefined') {
    throw hubError(1, 'could not load hub code');
  }
  sandbox.__state = vm.runInContext('state', sandbox);
  sandbox.__datasets = vm.runInContext('DATASETS', sandbox);
  return sandbox;
}

module.exports = { loadHub };
