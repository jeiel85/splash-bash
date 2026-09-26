/**
 * Playwright 로 페이지를 열고 window.__ready 를 기다린 뒤 PNG 로 저장한다.
 *   node tools/screenshot.mjs "<url path+query>" <out.png> [width] [height]
 * 예) node tools/screenshot.mjs "/dev/viewer.html?file=character.glb" tools/blender/previews/char_web.png
 * 개발 서버(npm run dev, http://127.0.0.1:5317)가 떠 있어야 한다. BASE_URL 환경변수로 변경 가능.
 */
import { chromium } from 'playwright';

const [, , path, out, w = '1000', h = '750'] = process.argv;
if (!path || !out) {
  console.error('usage: node tools/screenshot.mjs "<path?query>" <out.png> [width] [height]');
  process.exit(2);
}
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5317';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + path);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out });
  const pageErr = await page.evaluate(() => window.__error ?? null);
  if (pageErr) errors.push(pageErr);
  if (errors.length) {
    console.error('page errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
  console.log('saved', out);
} finally {
  await browser.close();
}
