const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
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
})();
