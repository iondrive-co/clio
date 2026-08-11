/*
 * Rasterise icon.svg into the PNGs the browser and window manager use.
 * ImageMagick has no SVG delegate on this box, so render with the same engine
 * that will display it. Re-run after editing icon.svg.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(HERE, 'icon.svg'), 'utf8');
const browser = await chromium.launch();

for (const size of [256, 128, 48, 32]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg
      .replace(/width="256"/, `width="${size}"`)
      .replace(/height="256"/, `height="${size}"`)}`,
  );
  const buf = await page.screenshot({ omitBackground: true });
  writeFileSync(join(HERE, `icon-${size}.png`), buf);
  console.log(`icon-${size}.png`);
  await page.close();
}

await browser.close();
