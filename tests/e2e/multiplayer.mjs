/**
 * 실제 멀티 브라우저 온라인 E2E — 진짜 Trystero(WebRTC) + 공개 Nostr 릴레이 시그널링.
 *
 *   npm run test:e2e
 *
 * 기본으로 이 스크립트가 HMR·파일 감시를 끈 Vite 개발 서버를 따로 띄운다(DEV 빌드 = window.__splash 사용 가능).
 * 공용 개발 서버(5317)를 쓰면 테스트 도중 누군가 소스를 고칠 때 HMR 이 모든 탭을 새로 고쳐 게임이 메뉴로 돌아가 버린다.
 *
 * 브라우저 컨텍스트 하나 = 독립된 플레이어(별도 localStorage·Trystero selfId).
 * DEV 빌드의 window.__splash 디버그 API 로 상태를 읽고 조작한다(src/game/game.ts DebugApi).
 *
 * 환경 변수
 *   BASE_URL      이미 떠 있는 개발 서버를 쓰려면 주소(예: http://127.0.0.1:5317). 없으면 자체 서버
 *   E2E_MAP       맵(기본 test = 코드 시험장. 'backyard' 면 실제 맵)
 *   E2E_SUITES    실행할 묶음(쉼표): nobots,bots,merge (기본 전부)
 *   E2E_HEADED=1  브라우저 창 보이기
 *
 * 실패하면 종료 코드 1, 실패 시점 스크린샷·상태는 test-results/e2e/ 에 남긴다.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let BASE = process.env.BASE_URL?.replace(/\/$/, '') ?? null;
const MAP = process.env.E2E_MAP ?? 'test';
const SUITES = (process.env.E2E_SUITES ?? 'nobots,bots,merge').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = 'test-results/e2e';
const PROFILE_KEY = 'splash-bash:profile:v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** config.ts MATCH 값(테스트 기대치) */
const MATCH_DURATION_MS = 240_000;
const BOT_FILL_TO = 6;

/** 넉넉한 제한 시간(공개 릴레이 시그널링은 수 초~수십 초 걸릴 수 있다) */
const T = {
  load: 120_000,
  join: 60_000,
  connect: 90_000,
  sync: 15_000,
  combat: 20_000,
  migrate: 45_000,
};

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function roomCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

class AssertionError extends Error {}
function assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

/**
 * fn() 이 { ok: true } 를 돌려줄 때까지 폴링. 제한 시간을 넘기면 마지막 관측값과 함께 실패.
 * @returns 걸린 시간(ms)과 마지막 값
 */
async function waitUntil(desc, timeoutMs, fn, intervalMs = 250) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last?.ok) return { ms: Date.now() - start, value: last };
    await sleep(intervalMs);
  }
  throw new AssertionError(`${desc} — ${timeoutMs / 1000}s 안에 충족되지 않음. 마지막 관측: ${JSON.stringify(last?.info ?? last)}`);
}

// ------------------------------------------------------------------ player

class Player {
  /** @param {import('playwright').Browser} browser */
  static async open(browser, label, code, { bots }) {
    const context = await browser.newContext({ viewport: { width: 480, height: 270 } });
    await context.addInitScript(([key, name]) => {
      try {
        localStorage.setItem(key, JSON.stringify({
          name, cosmetics: { color: 0, hat: 'none' }, mode: 'ffa',
          settings: { sensitivity: 1, volume: 0, fov: 80, quality: 'low', invertY: false },
        }));
      } catch (e) {
        console.error('profile init failed', e);
      }
    }, [PROFILE_KEY, label]);
    const page = await context.newPage();
    const p = new Player(label, context, page);
    const params = new URLSearchParams();
    if (!bots) params.set('bots', '0');
    if (MAP === 'test') params.set('map', 'test');
    await page.goto(`${BASE}/?${params}#room=${code}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: T.load });
    const err = await page.evaluate(() => window.__error ?? null);
    if (err) throw new Error(`${label}: 게임 데이터 로드 실패 ${err}`);
    return p;
  }

  constructor(label, context, page) {
    this.label = label;
    this.context = context;
    this.page = page;
    this.errors = [];
    this.closed = false;
    this.id = null;
    page.on('pageerror', (e) => {
      this.errors.push(String(e));
      log(`  !! ${label} pageerror: ${e}`);
    });
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() === 'error' && !/pointer ?lock|requestPointerLock|AudioContext/i.test(text)) {
        this.errors.push(text);
        log(`  !! ${label} console.error: ${text}`);
      } else if (/\[net\]/.test(text)) {
        log(`  .. ${label} ${m.type()}: ${text}`);
      }
    });
  }

  /** 메뉴의 "참가" 버튼(해시로 받은 방 코드) → 게임 시작까지 */
  async join() {
    const started = Date.now();
    await this.page.locator('button.btn', { hasText: /^참가$/ }).click();
    await this.page.waitForFunction(() => !!window.__splash, null, { timeout: T.join });
    const s = await this.state();
    this.id = s.selfId;
    log(`${this.label} 게임 입장 (${Date.now() - started}ms) selfId=${this.id.slice(0, 8)}`);
    return started;
  }

  state() {
    return this.page.evaluate(() => window.__splash?.state() ?? null);
  }

  call(method, ...args) {
    return this.page.evaluate(([m, a]) => window.__splash[m](...a), [method, args]);
  }

  async close({ graceful }) {
    this.closed = true;
    // graceful: beforeunload → Trystero 가 떠남 메시지를 보냄 / 아니면 탭이 죽은 것처럼 연결만 끊김
    if (graceful) await this.page.close({ runBeforeUnload: true });
    await this.context.close();
  }

  async shot(name) {
    if (this.closed) return;
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      await this.page.screenshot({ path: `${OUT_DIR}/${name}-${this.label}.png` });
      writeFileSync(`${OUT_DIR}/${name}-${this.label}.json`, JSON.stringify(await this.state(), null, 2));
    } catch (e) {
      log(`  (${this.label} 실패 기록 저장 불가: ${e})`);
    }
  }
}

// ------------------------------------------------------------------ helpers

const remoteOf = (s, id) => s?.remotes?.find((r) => r.id === id) ?? null;

/** 모든 플레이어가 서로를 보고(스냅샷 수신), 같은 호스트에 합의할 때까지 */
async function waitMesh(players, timeoutMs) {
  return waitUntil(`${players.map((p) => p.label).join('·')} 서로 연결 + 호스트 합의`, timeoutMs, async () => {
    const states = await Promise.all(players.map((p) => p.state()));
    const info = {};
    let ok = true;
    for (let i = 0; i < players.length; i++) {
      const s = states[i];
      const sees = players.filter((o) => o !== players[i]).map((o) => {
        const r = remoteOf(s, o.id);
        return `${o.label}:${r ? (r.hasData ? 'data' : 'info') : '-'}`;
      });
      info[players[i].label] = { host: s?.hostId?.slice(0, 8), peers: s?.peers?.length, sees: sees.join(' ') };
      for (const o of players) if (o !== players[i] && !remoteOf(s, o.id)?.hasData) ok = false;
    }
    const hosts = new Set(states.map((s) => s?.hostId));
    const hostIsMember = players.some((p) => p.id === states[0]?.hostId);
    const selfHosts = states.filter((s) => s?.isHost).length;
    ok = ok && hosts.size === 1 && hostIsMember && selfHosts === 1;
    return { ok, info, states };
  });
}

async function scoresOf(p) {
  const s = await p.state();
  return s?.match?.scores ?? {};
}

// ------------------------------------------------------------------ runner

const results = [];

async function suite(name, browser, body) {
  log(`=== 묶음: ${name} ===`);
  const players = [];
  const ctx = {
    browser,
    code: roomCode(),
    players,
    async open(label, opts) {
      const p = await Player.open(browser, label, ctx.code, opts);
      players.push(p);
      return p;
    },
  };
  log(`방 코드 ${ctx.code}`);
  let failed = false;
  const step = async (title, fn) => {
    if (failed) {
      results.push({ suite: name, title, status: 'SKIP' });
      log(`- SKIP ${title}`);
      return;
    }
    const start = Date.now();
    log(`> ${title}`);
    try {
      const note = await fn();
      const errs = players.flatMap((p) => p.errors.map((e) => `${p.label}: ${e}`));
      if (errs.length) throw new AssertionError(`페이지 오류 발생:\n${errs.join('\n')}`);
      results.push({ suite: name, title, status: 'PASS', ms: Date.now() - start, note });
      log(`  PASS ${title} (${Date.now() - start}ms)${note ? ` — ${note}` : ''}`);
    } catch (e) {
      failed = true;
      results.push({ suite: name, title, status: 'FAIL', ms: Date.now() - start, error: e.message ?? String(e) });
      log(`  FAIL ${title}: ${e.message ?? e}`);
      if (!(e instanceof AssertionError)) console.error(e);
      const safe = `${name}-${title}`.replace(/[^\w가-힣-]+/g, '_').slice(0, 60);
      await Promise.all(players.map((p) => p.shot(safe)));
    }
  };
  try {
    await body(ctx, step);
  } finally {
    await Promise.all(players.filter((p) => !p.closed).map((p) => p.context.close().catch(() => undefined)));
  }
}

// ------------------------------------------------------------------ suite 1: 사람만(봇 없음)

async function suiteNoBots(browser) {
  await suite('봇 없음', browser, async (ctx, step) => {
    let A, B, C;
    let host, others;

    await step('두 명 접속·서로 보임·호스트 1명 합의', async () => {
      [A, B] = await Promise.all([ctx.open('A', { bots: false }), ctx.open('B', { bots: false })]);
      const clicked = Date.now();
      await Promise.all([A.join(), B.join()]);
      const { value } = await waitMesh([A, B], T.connect);
      const hostId = value.states[0].hostId;
      host = [A, B].find((p) => p.id === hostId);
      others = [A, B].filter((p) => p !== host);
      return `참가 클릭→서로 보임 ${Date.now() - clicked}ms, 호스트=${host.label}`;
    });

    await step('위치 동기화(A 순간이동 → B 가 0.5m 안에서 봄)', async () => {
      const notes = [];
      for (const [mover, watcher, target] of [[A, B, [6, 0.05, 6]], [B, A, [-6, 0.05, 6]]]) {
        await mover.call('teleport', ...target);
        const { ms } = await waitUntil(`${watcher.label} 가 ${mover.label} 새 위치를 봄`, T.sync, async () => {
          const [m, w] = await Promise.all([mover.state(), watcher.state()]);
          const r = remoteOf(w, mover.id);
          const d = r ? dist(r.pos, m.pos) : Infinity;
          return { ok: d < 0.5 && dist(m.pos, target) < 1, info: { own: m.pos, seen: r?.pos, d } };
        }, 100);
        notes.push(`${mover.label}→${watcher.label} ${ms}ms`);
      }
      return notes.join(', ');
    });

    await step('전투: A 가 B 를 조준 사격 → B 젖음 → 흠뻑(쓰러짐) → 모든 피어 점수 일치', async () => {
      await A.call('teleport', 0, 0.05, 3);
      await B.call('teleport', 0, 0.05, -3);
      // B 가 보호막이 풀리고, A 가 B 의 새 위치를 볼 때까지
      await waitUntil('B 보호막 해제 + A 가 B 새 위치를 봄', T.sync, async () => {
        const [a, b] = await Promise.all([A.state(), B.state()]);
        const r = remoteOf(a, B.id);
        return { ok: !b.shielded && b.alive && r && !r.shielded && dist(r.pos, b.pos) < 0.3, info: { bShield: b.shielded, seen: r?.pos, own: b.pos } };
      }, 100);
      assert(await A.call('aimAt', B.id), 'A.aimAt(B) 실패 — A 가 B 를 대상 목록에서 못 찾음');
      await A.call('setIntent', { fire: true });
      await sleep(150);
      await A.call('setIntent', null);
      const hit = await waitUntil('짧은 사격 후 B 의 젖음 증가', T.combat, async () => {
        const b = await B.state();
        return { ok: b.soak > 0 || !b.alive, info: { soak: b.soak, alive: b.alive } };
      }, 50);
      const soakAfterBurst = hit.value.info.soak;
      // 계속 쏴서 흠뻑
      await A.call('setIntent', { fire: true });
      const down = await waitUntil('B 흠뻑(쓰러짐)', T.combat, async () => {
        await A.call('aimAt', B.id);
        const b = await B.state();
        return { ok: !b.alive, info: { soak: b.soak, alive: b.alive } };
      }, 100);
      await A.call('setIntent', null);
      const agree = await waitUntil('모든 피어의 경기 점수 일치(A 1킬, B 1데스)', T.sync, async () => {
        const all = await Promise.all([A, B].map(scoresOf));
        const ok = all.every((sc) => sc[A.id]?.splashes === 1 && sc[B.id]?.soaked === 1 && (sc[A.id]?.soaked ?? 0) === 0);
        return { ok, info: all.map((sc) => ({ A: sc[A.id], B: sc[B.id] })) };
      });
      const bRemoteOnA = remoteOf(await A.state(), B.id);
      return `짧은 사격 뒤 B 젖음 ${soakAfterBurst.toFixed(0)}, 흠뻑까지 ${down.ms}ms, 점수 일치 ${agree.ms}ms, A 가 본 B alive=${bRemoteOnA?.alive}`;
    });

    await step('늦게 온 C: 경기 상태 수신·모두 보임', async () => {
      C = await ctx.open('C', { bots: false });
      const clicked = Date.now();
      await C.join();
      await waitMesh([A, B, C], T.connect);
      const connectMs = Date.now() - clicked;
      const { ms } = await waitUntil('C 의 경기 상태 = 호스트 경기 상태', T.sync, async () => {
        const [h, c] = await Promise.all([host.state(), C.state()]);
        const hs = h.match?.scores ?? {};
        const cs = c.match?.scores ?? {};
        const ok = !!c.match && c.match.round === h.match.round && c.match.mode === h.match.mode
          && cs[A.id]?.splashes === 1 && cs[B.id]?.soaked === 1 && !!cs[C.id]
          && JSON.stringify(Object.keys(cs).sort()) === JSON.stringify(Object.keys(hs).sort());
        return { ok, info: { host: h.match, c: c.match } };
      });
      return `참가 클릭→3명 연결 ${connectMs}ms, 경기 상태 일치 ${ms}ms`;
    });

    await step('호스트 이전(호스트 탭 정상 종료) → 같은 새 호스트, 타이머·점수 이어짐', async () => {
      const before = await Promise.all(others.concat(C).map((p) => p.state()));
      const timerBefore = Math.min(...before.map((s) => s.timerMs));
      const roundBefore = before[0].match.round;
      const leftId = host.id;
      log(`  호스트 ${host.label} 종료(정상), 종료 전 남은 시간 ${(timerBefore / 1000).toFixed(1)}s`);
      const closedAt = Date.now();
      await host.close({ graceful: true });
      const remaining = [A, B, C].filter((p) => !p.closed);
      const { ms, value } = await waitUntil('남은 피어가 같은 새 호스트에 합의', T.migrate, async () => {
        const states = await Promise.all(remaining.map((p) => p.state()));
        const hosts = new Set(states.map((s) => s.hostId));
        const newHost = states[0].hostId;
        const ok = hosts.size === 1 && newHost !== leftId && remaining.some((p) => p.id === newHost)
          && states.filter((s) => s.isHost).length === 1
          && states.every((s) => !remoteOf(s, leftId));
        return { ok, states, info: states.map((s) => ({ host: s.hostId?.slice(0, 8), isHost: s.isHost, remotes: s.remotes.map((r) => r.id.slice(0, 8)) })) };
      });
      const newHost = remaining.find((p) => p.id === value.states[0].hostId);
      const elapsed = Date.now() - closedAt;
      const hs = value.states.find((s) => s.isHost);
      assert(hs.match.round === roundBefore, `라운드가 바뀜: ${roundBefore} → ${hs.match.round}`);
      assert(hs.timerMs <= timerBefore + 1500 && hs.timerMs >= timerBefore - elapsed - 3000,
        `타이머가 이어지지 않음: 종료 전 ${timerBefore}ms, 새 호스트 ${hs.timerMs}ms (경과 ${elapsed}ms, 새 경기면 ${MATCH_DURATION_MS})`);
      assert(!(leftId in hs.match.scores), '떠난 호스트의 점수 줄이 새 호스트 경기 상태에 남아 있음');
      assert(hs.match.scores[B.id]?.soaked === 1 || B.closed, `B 의 데스 기록이 사라짐: ${JSON.stringify(hs.match.scores[B.id])}`);
      // 타이머가 계속 흐르는지, 남은 피어 점수가 일치하는지
      await sleep(2000);
      const after = await Promise.all(remaining.map((p) => p.state()));
      const h2 = after.find((s) => s.isHost);
      assert(h2.timerMs < hs.timerMs - 1000, `새 호스트 타이머가 멈춤: ${hs.timerMs} → ${h2.timerMs}`);
      await waitUntil('남은 피어 점수·타이머 일치', T.sync, async () => {
        const st = await Promise.all(remaining.map((p) => p.state()));
        const keys = st.map((s) => JSON.stringify(s.match?.scores ?? null));
        const timers = st.map((s) => s.timerMs);
        const ok = new Set(keys).size === 1 && Math.max(...timers) - Math.min(...timers) < 2500;
        return { ok, info: { keys, timers } };
      });
      return `새 호스트=${newHost.label}, 합의까지 ${ms}ms, 타이머 ${(timerBefore / 1000).toFixed(1)}s → ${(h2.timerMs / 1000).toFixed(1)}s`;
    });
  });
}

// ------------------------------------------------------------------ suite 2: 봇 채우기

/** 봇 목록(id 정렬) — 호스트는 bots, 다른 피어는 bot 원격 */
const botIds = (s) => (s.isHost ? s.bots.map((b) => b.id) : s.remotes.filter((r) => r.bot).map((r) => r.id)).sort();
/** 봇 id → 이름(같은 id 의 다른 봇이 섞이지 않았는지) */
const botNames = (s) => JSON.stringify(Object.fromEntries((s.isHost ? s.bots : s.remotes.filter((r) => r.bot)).map((b) => [b.id, b.name]).sort()));
const botPos = (s) => Object.fromEntries((s.isHost ? s.bots : s.remotes.filter((r) => r.bot && r.hasData)).map((b) => [b.id, b.pos]));

/** 모든 피어가 같은 봇 목록(id·이름)을 보고, 호스트가 아닌 피어는 자기 봇이 없고 봇 스냅샷을 받는다 */
function waitBotsAgree(players, expected) {
  return waitUntil(`${players.map((p) => p.label).join('·')} 봇 ${expected}마리 목록 일치`, T.sync * 2, async () => {
    const st = await Promise.all(players.map((p) => p.state()));
    const lists = st.map(botNames);
    const ok = new Set(lists).size === 1 && botIds(st[0]).length === expected
      && st.every((s) => s.isHost || (s.bots.length === 0 && s.remotes.filter((r) => r.bot).every((r) => r.hasData)));
    return { ok, info: st.map((s, i) => ({ host: s.isHost, own: s.bots.length, list: lists[i] })) };
  });
}

/** 피어가 본 봇이 움직이는지(2.5초 간격 위치 비교) */
async function botsMoveOn(watcher) {
  const p1 = botPos(await watcher.state());
  await sleep(2500);
  const p2 = botPos(await watcher.state());
  const ids = Object.keys(p1).filter((id) => p2[id]);
  const moved = ids.filter((id) => dist(p1[id], p2[id]) > 0.3);
  assert(ids.length > 0, `${watcher.label} 가 본 봇 위치가 없음`);
  assert(moved.length >= Math.ceil(ids.length / 2), `${watcher.label} 가 본 봇 대부분이 멈춰 있음 (${moved.length}/${ids.length} 이동)`);
  return `${watcher.label} 가 본 봇 ${moved.length}/${ids.length} 이동`;
}

async function suiteBots(browser) {
  await suite('봇 있음', browser, async (ctx, step) => {
    let A, B, C;

    await step('A 혼자 입장 → 봇으로 채움', async () => {
      A = await ctx.open('A', { bots: true });
      await A.join();
      const { ms } = await waitUntil('A 가 호스트로 봇 5마리 생성', T.sync, async () => {
        const s = await A.state();
        return { ok: s.isHost && s.bots.length === BOT_FILL_TO - 1, info: { isHost: s.isHost, bots: s.bots.length } };
      });
      return `${ms}ms`;
    });

    await step('B 입장 → 호스트 1명 합의, 봇 4마리, B 가 호스트의 봇이 움직이는 것을 봄', async () => {
      B = await ctx.open('B', { bots: true });
      const clicked = Date.now();
      await B.join();
      const mesh = await waitMesh([A, B], T.connect);
      assert(mesh.value.states[0].hostId === A.id, `먼저 들어온 A 가 호스트여야 함(호스트=${mesh.value.states[0].hostId})`);
      const connectMs = Date.now() - clicked;
      const agree = await waitBotsAgree([A, B], BOT_FILL_TO - 2);
      const moving = await botsMoveOn(B);
      return `연결 ${connectMs}ms, 봇 목록 일치 ${agree.ms}ms, ${moving}`;
    });

    await step('C 입장 → 봇 3마리, 모두 같은 봇 목록', async () => {
      C = await ctx.open('C', { bots: true });
      const clicked = Date.now();
      await C.join();
      await waitMesh([A, B, C], T.connect);
      const connectMs = Date.now() - clicked;
      const agree = await waitBotsAgree([A, B, C], BOT_FILL_TO - 3);
      const moving = await botsMoveOn(C);
      return `연결 ${connectMs}ms, 봇 목록 일치 ${agree.ms}ms, ${moving}`;
    });

    await step('호스트 탭 비정상 종료 → 새 호스트가 봇을 이어받아 계속 움직임', async () => {
      const [sb, sc] = await Promise.all([B.state(), C.state()]);
      const inherited = botIds(sb);
      const timerBefore = Math.min(sb.timerMs, sc.timerMs);
      const closedAt = Date.now();
      await A.close({ graceful: false });
      const { ms, value } = await waitUntil('B·C 가 같은 새 호스트에 합의', T.migrate, async () => {
        const st = await Promise.all([B.state(), C.state()]);
        const ok = st[0].hostId === st[1].hostId && st[0].hostId !== A.id && st.filter((s) => s.isHost).length === 1;
        return { ok, states: st, info: st.map((s) => ({ host: s.hostId?.slice(0, 8), isHost: s.isHost })) };
      }, 200);
      // 전송 계층의 끊김 감지(10초+)를 기다리지 않고 호스트 침묵(NET.hostSilenceMs=3초)으로 넘어가야 한다
      assert(ms < 8000, `호스트 이전이 너무 느림: ${ms}ms`);
      const hostState = value.states.find((s) => s.isHost);
      const newHost = hostState.selfId === B.id ? B : C;
      const other = newHost === B ? C : B;
      const hostBots = hostState.bots.map((b) => b.id);
      const kept = inherited.filter((id) => hostBots.includes(id));
      assert(kept.length === inherited.length, `새 호스트가 이어받지 못한 봇: ${inherited.filter((id) => !hostBots.includes(id)).join(',')}`);
      const elapsed = Date.now() - closedAt;
      assert(hostState.timerMs <= timerBefore + 1500 && hostState.timerMs >= timerBefore - elapsed - 3000,
        `타이머가 이어지지 않음: ${timerBefore} → ${hostState.timerMs} (경과 ${elapsed}ms)`);
      const agree = await waitBotsAgree([B, C], BOT_FILL_TO - 2);
      const moving = await botsMoveOn(other);
      const hostMoving = await botsMoveOn(newHost);
      return `새 호스트=${newHost.label}, 합의 ${ms}ms, 이어받은 봇 ${kept.length}마리, 봇 목록 일치 ${agree.ms}ms, ${moving}, ${hostMoving}`;
    });
  });
}

// ------------------------------------------------------------------ suite 3: 두 호스트 합치기

async function suiteMerge(browser) {
  await suite('동시 입장(호스트 합치기)', browser, async (ctx, step) => {
    let A, B;
    await step('봇 켠 두 명이 동시에 입장 → 한 호스트로 합쳐지고 진 쪽은 자기 봇을 버리고 이긴 쪽 봇을 봄', async () => {
      [A, B] = await Promise.all([ctx.open('A', { bots: true }), ctx.open('B', { bots: true })]);
      const clicked = Date.now();
      await Promise.all([A.join(), B.join()]);
      // 입장 직후 둘 다 자기 봇을 가진 호스트였는지(= 합치기가 실제로 일어났는지) 기록
      let bothHosted = false;
      const mesh = await waitUntil('A·B 연결 + 호스트 합의', T.connect, async () => {
        const [a, b] = await Promise.all([A.state(), B.state()]);
        if (a.isHost && b.isHost && a.bots.length > 0 && b.bots.length > 0) bothHosted = true;
        const ok = a.hostId === b.hostId && a.isHost !== b.isHost && remoteOf(a, B.id)?.hasData && remoteOf(b, A.id)?.hasData;
        return { ok, info: { a: [a.hostId?.slice(0, 8), a.bots.length], b: [b.hostId?.slice(0, 8), b.bots.length] } };
      }, 100);
      const connectMs = Date.now() - clicked;
      const agree = await waitBotsAgree([A, B], BOT_FILL_TO - 2);
      const host = (await A.state()).isHost ? A : B;
      const other = host === A ? B : A;
      const moving = await botsMoveOn(other);
      return `연결 ${connectMs}ms (합의 대기 ${mesh.ms}ms), 두 호스트 합치기 ${bothHosted ? '발생' : '안 일어남(탐색 중 서로 발견)'}, 호스트=${host.label}, 봇 목록 일치 ${agree.ms}ms, ${moving}`;
    });
  });
}

// ------------------------------------------------------------------ main

const headed = process.env.E2E_HEADED === '1';
let server = null;
let browser = null;
try {
  if (!BASE) {
    server = await createServer({
      root: ROOT,
      logLevel: 'warn',
      server: { port: 5319, strictPort: false, hmr: false, watch: null },
    });
    await server.listen();
    BASE = server.resolvedUrls.local[0].replace(/\/$/, '');
  }
  const res = await fetch(BASE).catch(() => null);
  if (!res?.ok) throw new Error(`개발 서버(${BASE})에 연결할 수 없어요.`);
  browser = await chromium.launch({
    headless: !headed,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  log(`E2E 시작 — ${BASE}${server ? ' (자체 서버, HMR 끔)' : ''}, 맵=${MAP}, 묶음=${SUITES.join(',')}`);
  if (SUITES.includes('nobots')) await suiteNoBots(browser);
  if (SUITES.includes('bots')) await suiteBots(browser);
  if (SUITES.includes('merge')) await suiteMerge(browser);
} catch (e) {
  results.push({ suite: '(실행)', title: '하네스', status: 'FAIL', error: e.message ?? String(e) });
  console.error(e);
} finally {
  await browser?.close();
  await server?.close();
}

console.log('\n==================== E2E 결과 ====================');
for (const r of results) {
  const time = r.ms !== undefined ? ` (${(r.ms / 1000).toFixed(1)}s)` : '';
  console.log(`${r.status.padEnd(4)} [${r.suite}] ${r.title}${time}${r.note ? `\n       ${r.note}` : ''}${r.error ? `\n       ${r.error}` : ''}`);
}
const failed = results.filter((r) => r.status !== 'PASS');
console.log(`\n${results.length - failed.length}/${results.length} 통과, 총 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed.length ? 1 : 0);
