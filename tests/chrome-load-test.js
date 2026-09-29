/* Optional: loads the unpacked extension into a throwaway headless Chrome profile and smoke-tests it
   (service worker boots, libs load, alarm scheduled, popup renders, options save, Run-now refuses when
   unconfigured). Needs: npm i puppeteer-core@25 and Chrome at $CHROME_PATH (default /usr/bin/google-chrome).
   Usage: node tests/chrome-load-test.js */
const puppeteer = require('puppeteer-core');
(async () => {
  const ext = require('path').resolve(__dirname, '../extension');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, pipe: true, enableExtensions: true,
    args: ['--no-sandbox', '--user-data-dir=' + require('fs').mkdtempSync(require('os').tmpdir() + '/mge-chrome-')] });
  const id = await browser.installExtension(ext);
  console.log('installed extension id length', id.length);
  const t = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 20000 });
  const w = await t.worker();
  const r = await w.evaluate(async () => {
    const a = await chrome.alarms.get('mge-daily');
    const m = chrome.runtime.getManifest();
    const libs = [typeof MGECrypto, typeof MGECsv, typeof MGEGitHub, typeof scrapeActiveClientList, typeof scrapePdfSchedulesChunk, typeof scrapeBacklogChunk];
    const enc = await MGECrypto.encryptText('"Client ID"\r\n"1"\r\n', 'pw-test-123456', 'x.csv');
    const dec = await MGECrypto.decryptToText(enc, 'pw-test-123456');
    return { name: m.name, alarm: a ? new Date(a.scheduledTime).toString() : null, libs, gz: enc.z, roundtrip: dec.includes('Client ID') };
  });
  console.log(JSON.stringify(r));
  const extId = new URL(t.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`); await new Promise((r) => setTimeout(r, 1500));
  console.log('popup summary:', await page.$eval('#summary', (e) => e.textContent.slice(0, 120)));
  const notCfg = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow' }));
  console.log('runNow without settings ->', JSON.stringify(notCfg));
  await page.goto(`chrome-extension://${extId}/options.html`); await new Promise((r) => setTimeout(r, 800));
  await page.type('#passphrase', 'correct horse battery staple 1'); await page.type('#passphrase2', 'correct horse battery staple 1');
  await page.click('#save'); await new Promise((r) => setTimeout(r, 800));
  console.log('options save ->', await page.$eval('#msg', (e) => e.className + ': ' + e.textContent.replace(/\d{1,2}\/\d{1,2}\/\d{4}.*/, '<date>')));
  const stored = await w.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); return { hasPass: !!settings.passphrase, runHour: settings.runHour, searchId: settings.searchId }; });
  console.log('stored ->', JSON.stringify(stored));
  await browser.close();
})().catch((e) => { console.error('LOADTEST FAIL', e.message); process.exit(1); });
