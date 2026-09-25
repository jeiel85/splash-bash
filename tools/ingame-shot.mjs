/**
 * 인게임 스크린샷(연습 모드, 봇 없이 가만히 서서 찍기).
 *   node tools/ingame-shot.mjs <out.png> x y z yawDeg pitchDeg [width height] [--map=test]
 * 개발 서버(http://127.0.0.1:5317)와 DEV 빌드의 window.__splash 디버그 API 를 쓴다.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [out, x, y, z, yaw = '0', pitch = '0', w = '1280', h = '720'] = args;
if (!out || z === undefined) {
  console.error('usage: node tools/ingame-shot.mjs <out.png> x y z yawDeg pitchDeg [w h] [--map=test]');
  process.exit(2);
}
const map = flags.find((f) => f.startsWith('--map='))?.slice(6);
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5317';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/?bots=0${map ? `&map=${map}` : ''}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  const err = await page.evaluate(() => window.__error ?? null);
  if (err) throw new Error(err);
  await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('연습'))?.click());
  await page.waitForFunction(() => !!window.__splash, null, { timeout: 30000 });
  await page.evaluate(([x, y, z, yaw, pitch]) => {
    const s = window.__splash;
    s.teleport(x, y, z);
    s.look((yaw * Math.PI) / 180, (pitch * Math.PI) / 180);
    document.querySelector('.click-to-play')?.classList.add('hidden');
  }, [Number(x), Number(y), Number(z), Number(yaw), Number(pitch)]);
  await page.waitForTimeout(700);
  await page.evaluate(([yaw, pitch]) => window.__splash.look((yaw * Math.PI) / 180, (pitch * Math.PI) / 180), [Number(yaw), Number(pitch)]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: out });
  if (errors.length) console.error('page errors:\n' + errors.join('\n'));
  console.log('saved', out);
} finally {
  await browser.close();
}
