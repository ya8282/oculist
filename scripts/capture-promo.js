const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const EXT = path.resolve(__dirname, '..', 'extension');
const INPUT = '#oc-wrap >> .oc-input';
const WORD = 'waterproof';
const PAGE = `<!doctype html><meta charset="utf-8"><title>Field notes</title>
<style>body{margin:0;background:#f7f6f2;color:#222;font:18px/1.6 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 24px}h1{font-size:34px;margin:0 0 20px}</style>
<main><h1>Choosing a jacket for the trail</h1>
<p>A good shell jacket is the most important layer you will carry, because weather in the hills changes faster than any forecast suggests.</p>
<p>Look for taped seams, a hood that moves with your head, and zips that can be worked with gloves on. A fully ${WORD} membrane matters less than how well the cuffs seal.</p>
<p>Pack it small, keep it near the top of the bag, and put it on before you feel cold rather than after.</p>
<p>Wash it according to the label and revive the outer finish once a season so water keeps beading instead of soaking in.</p></main>`;

function effectIds() {
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  const block = src.match(/var effectsRegistry = \{([\s\S]*?)\n\s*\};/);
  const ids = block ? [...block[1].matchAll(/^\s{4}(\w+): \{ label:/gm)].map((m) => m[1]) : [];
  if (ids.length < 30) throw new Error(`parsed only ${ids.length} effect ids from content.js`);
  return ids;
}

async function openFinder(pg) {
  for (let i = 0; i < 20; i++) {
    await pg.keyboard.press('Control+f');
    try { await pg.waitForSelector(INPUT, { timeout: 250 }); return; } catch (e) { /* retry */ }
  }
  await pg.waitForSelector(INPUT, { timeout: 5000 });
}

async function recordVideos(ids) {
  const outDir = path.join(__dirname, '..', 'dist', 'promo-video');
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(outDir, 'tmp-'));
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!hasFfmpeg) console.log('ffmpeg not found: mp4 skipped, keeping webm');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const size = { width: 1280, height: 720 };
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: size, recordVideo: { dir: tmp, size },
  });
  const failures = [];
  try {
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    // onInstalled seeds oc-settings (blocklist, halloween pack); wait so our write is not clobbered.
    await worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const d = await chrome.storage.sync.get('oc-settings');
        if (d['oc-settings'] && d['oc-settings'].seededHalloweenPack) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('settings seeding never finished');
    });
    for (const p of ctx.pages()) await p.close();
    for (const id of ids) {
      try {
        await worker.evaluate((s) => chrome.storage.sync.get('oc-settings').then((d) =>
          chrome.storage.sync.set({ 'oc-settings': Object.assign({}, d['oc-settings'] || {}, s) })),
        { effect: id, enabledPacks: ['halloween', 'adventure'] });
        const created = Date.now();
        const page = await ctx.newPage();
        await page.goto(url);
        await page.waitForTimeout(400);
        await openFinder(page);
        const finderAt = Date.now();
        await page.locator(INPUT).type(WORD, { delay: 60 });
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter'); // Enter navigates to the match, which fires the effect
        try {
          await page.waitForSelector('.oc-beacon-transient', { state: 'attached', timeout: 15000 });
          await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: 15000 });
        } catch (e) { console.warn(`warning: ${id}: no clean effect finish (${e.message.split('\n')[0]}), keeping clip`); }
        await page.waitForTimeout(500);
        const video = page.video();
        await page.close();
        const webm = path.join(outDir, `${id}.webm`);
        await video.saveAs(webm);
        let note = 'webm';
        if (hasFfmpeg) {
          const ss = Math.max(0, (finderAt - created) / 1000 - 0.3).toFixed(2);
          const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', ss, '-i', webm, '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(outDir, `${id}.mp4`)]);
          if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
          note = 'webm + mp4';
        }
        console.log(`Recorded dist/promo-video/${id} (${note})`);
      } catch (e) {
        console.error(`FAILED ${id}: ${e.message}`);
        failures.push(id);
      }
    }
  } finally {
    await ctx.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) { console.error(`Failed effects: ${failures.join(', ')}`); process.exitCode = 1; }
}

(async () => {
  const vi = process.argv.indexOf('--video');
  if (vi !== -1) {
    const all = effectIds();
    const want = process.argv.slice(vi + 1);
    const bad = want.filter((w) => !all.includes(w));
    if (bad.length) {
      console.error(`Unknown effect id(s): ${bad.join(', ')}\nValid ids: ${all.join(', ')}`);
      process.exit(1);
    }
    return recordVideos(want.length ? want : all);
  }
  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const tiles = [
    { file: 'promo-small.html',   out: 'promo-small.png',   w: 440,  h: 280 },
    { file: 'promo-marquee.html', out: 'promo-marquee.png', w: 1400, h: 560 },
  ];

  for (const tile of tiles) {
    await page.setViewportSize({ width: tile.w, height: tile.h });
    await page.goto('file://' + path.join(__dirname, '..', 'docs', tile.file));
    await page.screenshot({
      path: path.join(distDir, tile.out),
      clip: { x: 0, y: 0, width: tile.w, height: tile.h },
    });
    console.log(`Captured dist/${tile.out} (${tile.w}×${tile.h})`);
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
