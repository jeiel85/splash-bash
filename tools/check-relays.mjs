/**
 * 시그널링 릴레이 실측 — 릴레이 하나만 설정한 두 브라우저(= 두 플레이어)가 Trystero 방에서 연결되고 메시지를 주고받는지.
 *
 *   node tools/check-relays.mjs                 src/net/transport.ts 의 SIGNALING_RELAYS 점검(통과 < 4곳이면 종료 코드 1)
 *   node tools/check-relays.mjs --candidates    후보 전체(설정 목록 + Trystero 기본 목록 + 잘 알려진 공개 릴레이) 점검
 *   node tools/check-relays.mjs --rounds 2      릴레이마다 여러 번(기본 1)
 *   node tools/check-relays.mjs --only a.com,b.com
 *
 * HMR·감시를 끈 Vite 개발 서버를 따로 띄워 dev/relay-check.html 을 연다(게임과 같은 Trystero 빌드).
 * 결과를 보고 SIGNALING_RELAYS 를 고칠 때는 모든 회차를 통과하고, 스테이징·시험용 서버가 아니며, 가입·신뢰망이 필요 없는 곳만 고른다.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROUNDS = Number(opt('--rounds') ?? 1);
const CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;
/** 설정 목록에서 이만큼은 통과해야 한다(한두 곳이 죽어도 만날 수 있게) */
const MIN_WORKING = 4;

/** Trystero 기본 목록 밖의 잘 알려진 공개 릴레이(후보 점검용) */
const EXTRA = [
  'relay.damus.io', 'relay.nostr.band', 'relay.primal.net', 'relay.snort.social', 'nostr.mom', 'relay.nostr.bg',
  'offchain.pub', 'nostr.oxtr.dev', 'relay.nostr.net', 'nostr-pub.wellorder.net', 'nostr.bitcoiner.social',
  'relay.nos.social', 'nostr.fmt.wiz.biz', 'nostr21.com', 'relay.orangepill.dev', 'nostr.einundzwanzig.space',
  'relay.lexingtonbitcoin.org', 'nostr.wine', 'purplepag.es', 'relay.nostr.wirednet.jp', 'nostr.rocks',
  'relay.nostrati.com', 'nostr.azzamo.net', 'relay.fountain.fm', 'nostr.bond', 'relay.nostrcheck.me',
].map((h) => `wss://${h}`);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5328, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

async function openPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/dev/relay-check.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  return { context, page };
}

async function check(url) {
  const a = await openPage();
  const b = await openPage();
  const appId = `relay-check-${Math.random().toString(36).slice(2, 10)}`;
  const roomId = Math.random().toString(36).slice(2, 10);
  try {
    const run = (p, role) => p.page.evaluate(([u, ap, ro, r, t]) => window.relayCheck.run(u, ap, ro, r, t), [url, appId, roomId, role, TIMEOUT_MS]);
    const [ra, rb] = await Promise.all([run(a, 'a'), run(b, 'b')]);
    return { ok: ra.ok && rb.ok, joinedMs: Math.max(ra.joinedMs ?? -1, rb.joinedMs ?? -1), reason: ra.reason ?? rb.reason, warnings: [...new Set([...ra.warnings, ...rb.warnings])] };
  } catch (e) {
    return { ok: false, reason: String(e), warnings: [] };
  } finally {
    await a.context.close();
    await b.context.close();
  }
}

let failed = false;
try {
  const probe = await openPage();
  const { configured, trysteroDefaults } = await probe.page.evaluate(() => ({ configured: [...window.relayCheck.configured], trysteroDefaults: [...window.relayCheck.trysteroDefaults] }));
  await probe.context.close();
  let list = configured;
  if (args.includes('--candidates')) list = [...new Set([...configured, ...trysteroDefaults, ...EXTRA])];
  if (opt('--only')) list = opt('--only').split(',').map((s) => (s.startsWith('wss://') ? s : `wss://${s}`));
  log(`릴레이 ${list.length}곳 × ${ROUNDS}회 (설정 ${configured.length}곳, Trystero 기본 ${trysteroDefaults.length}곳)`);

  const results = new Map(list.map((u) => [u, []]));
  for (let round = 0; round < ROUNDS; round++) {
    const queue = [...list];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const url = queue.shift();
        const r = await check(url);
        results.get(url).push(r);
        const warn = r.warnings.length ? `  ⚠ ${r.warnings.join(' | ').slice(0, 160)}` : '';
        log(`${r.ok ? 'OK  ' : 'FAIL'} ${url} ${r.ok ? `${r.joinedMs}ms` : r.reason}${warn}`);
      }
    }));
  }

  console.log('\n=== 요약(통과 회수 / 회차, 연결까지 ms)');
  const rows = [...results].map(([url, rs]) => ({ url, pass: rs.filter((r) => r.ok).length, ms: rs.filter((r) => r.ok).map((r) => r.joinedMs) }));
  rows.sort((x, y) => y.pass - x.pass || Math.max(...x.ms, 1e9) - Math.max(...y.ms, 1e9));
  for (const r of rows) console.log(`${r.pass}/${ROUNDS} ${configured.includes(r.url) ? '*' : ' '} ${r.url.padEnd(44)} ${r.ms.join(', ')}`);
  console.log('(* = 지금 설정 목록)');
  const working = configured.filter((u) => results.get(u)?.length && results.get(u).every((r) => r.ok));
  const checkedConfigured = configured.filter((u) => results.has(u));
  if (checkedConfigured.length === configured.length) {
    console.log(`설정 목록 통과: ${working.length}/${configured.length}`);
    if (working.length < MIN_WORKING) {
      console.error(`설정 목록에서 ${MIN_WORKING}곳 이상 통과해야 합니다 — --candidates 로 후보를 점검해 SIGNALING_RELAYS 를 갱신하세요`);
      failed = true;
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
