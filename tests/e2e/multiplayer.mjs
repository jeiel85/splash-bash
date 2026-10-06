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
 *   E2E_SUITES    실행할 묶음(쉼표): nobots,bots,merge,tdm,skew (기본 전부)
 *   E2E_HEADED=1  브라우저 창 보이기
 *
 * 묶음
 *   nobots  사람 2→3명: 연결·호스트 합의, 위치 동기화, 전투·점수, 늦은 참가자, 호스트 정상 종료 → 이전
 *   bots    봇 채우기: 비호스트가 호스트 봇을 봄·적셔 쓰러뜨림, 호스트 탭 강제 종료 → 새 호스트가 봇을 이어받음
 *           (전송 계층이 떠남을 알리기 전에도 멈춘 호스트는 숨김·조준 불가)
 *   merge   두 호스트 합치기: A 의 릴레이 연결을 늦춰 혼자 호스트로 시작시키고, 그사이 B(호스트)·C 가 따로 한 판 →
 *           A 연결 → 모두 먼저 온 A 로 합쳐지고 B·C 는 B 의 봇을 버림. 이어서 두 명 동시 입장
 *   tdm     팀전: 팀 배정 합의, 팀 점수, 호스트 이전 뒤 팀 유지
 *   skew    시계가 10분 늦은 C 가 진행 중인 방에 들어와도 호스트·경기가 그대로(#2)
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
const SUITES = (process.env.E2E_SUITES ?? 'nobots,bots,merge,tdm,skew').split(',').map((s) => s.trim()).filter(Boolean);
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

/**
 * 시그널링 릴레이(wss://) 연결을 window.__openRelays() 를 부를 때까지 미루는 WebSocket 대리자(페이지 안에서 실행).
 * 두 호스트 합치기 시험용: 이 플레이어는 방 탐색 동안 아무도 못 찾아 혼자 호스트로 시작하고, 나중에 연결되어 합쳐진다.
 * Trystero 가 쓰는 부분(on* 처리기, readyState, send, close, url)만 흉내 낸다.
 */
function gateRelaySockets() {
  const Real = window.WebSocket;
  let release;
  const gate = new Promise((r) => (release = r));
  window.__openRelays = () => release();
  class GatedWebSocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.binaryType = 'blob';
      this.ws = null;
      this.closedEarly = false;
      gate.then(() => {
        if (this.closedEarly) return;
        const ws = new Real(url, protocols);
        ws.binaryType = this.binaryType;
        this.ws = ws;
        for (const type of ['open', 'message', 'close', 'error']) {
          ws.addEventListener(type, (e) => this[`on${type}`]?.call(this, e));
        }
      });
    }
    get readyState() {
      return this.ws ? this.ws.readyState : this.closedEarly ? Real.CLOSED : Real.CONNECTING;
    }
    send(data) {
      if (!this.ws) throw new DOMException('아직 연결 전', 'InvalidStateError');
      this.ws.send(data);
    }
    close(code, reason) {
      if (this.ws) this.ws.close(code, reason);
      else this.closedEarly = true;
    }
  }
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) GatedWebSocket[k] = Real[k];
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      return /^wss:/i.test(String(args[0])) ? new GatedWebSocket(...args) : Reflect.construct(target, args);
    },
  });
}

/**
 * 게임 코드(/src/)가 읽는 Date.now() 만 skewMs 만큼 어긋나게 한다(페이지 안에서 실행). 시계가 틀린 기기 흉내.
 * Trystero 의 Nostr 시그널링(created_at·since)은 진짜 시각으로 둔다: 릴레이가 since 로 옛 이벤트를 거르면
 * 시계가 크게 늦은 기기는 연결 자체가 안 되어 #2 상황(연결은 되는데 joinedAt 이 틀림)을 재현할 수 없기 때문.
 * 바로 부른 쪽(스택 두 번째 프레임)이 /src/ 모듈일 때만 어긋난다.
 */
function skewGameClock(skewMs) {
  const realNow = Date.now.bind(Date);
  Date.now = function now() {
    const caller = new Error().stack?.split('\n')[2] ?? '';
    return realNow() + (/\/src\//.test(caller) ? skewMs : 0);
  };
}

class Player {
  /**
   * @param {import('playwright').Browser} browser
   * @param {{ bots: boolean, mode?: 'ffa' | 'tdm', gateRelays?: boolean, clockSkewMs?: number }} opts
   */
  static async open(browser, label, code, { bots, mode = 'ffa', gateRelays = false, clockSkewMs = 0 }) {
    const context = await browser.newContext({ viewport: { width: 480, height: 270 } });
    await context.addInitScript(([key, name, m]) => {
      try {
        localStorage.setItem(key, JSON.stringify({
          name, cosmetics: { color: 0, hat: 'none' }, mode: m,
          settings: { sensitivity: 1, volume: 0, fov: 80, quality: 'low', invertY: false },
        }));
      } catch (e) {
        console.error('profile init failed', e);
      }
    }, [PROFILE_KEY, label, mode]);
    if (gateRelays) await context.addInitScript(gateRelaySockets);
    if (clockSkewMs) await context.addInitScript(skewGameClock, clockSkewMs);
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

  /** 메뉴의 초대 카드 "참가" 버튼(URL #room= 코드) → 방 탐색(NET.discoverMs) → 게임 시작까지 */
  async join() {
    const started = Date.now();
    await this.page.locator('.menu-invite button.btn', { hasText: /^참가$/ }).click({ timeout: T.join });
    const clicked = Date.now();
    await this.page.waitForFunction(() => !!window.__splash, null, { timeout: T.join });
    const s = await this.state();
    this.id = s.selfId;
    log(`${this.label} 게임 입장 (클릭 ${clicked - started}ms + 방 탐색·시작 ${Date.now() - clicked}ms) selfId=${this.id.slice(0, 8)} 피어 ${s.peers.length}명`);
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

/** 두 사람을 시험장 가운데에 6m 떨어뜨려 세우고, 피해자 보호막이 풀리고 쏘는 쪽이 새 위치를 볼 때까지 */
async function faceOff(shooter, victim) {
  await shooter.call('teleport', 0, 0.05, 3);
  await victim.call('teleport', 0, 0.05, -3);
  await waitUntil(`${victim.label} 보호막 해제 + ${shooter.label} 가 ${victim.label} 새 위치를 봄`, T.sync, async () => {
    const [s, v] = await Promise.all([shooter.state(), victim.state()]);
    const r = remoteOf(s, victim.id);
    return { ok: !v.shielded && v.alive && r && !r.shielded && dist(r.pos, v.pos) < 0.3, info: { shielded: v.shielded, seen: r?.pos, own: v.pos } };
  }, 100);
}

/** 조준 사격을 계속해 피해자를 쓰러뜨리고, 쏜 쪽 화면에서도 쓰러진 모습을 확인 */
async function fireUntilDown(shooter, victim) {
  await shooter.call('setIntent', { fire: true });
  let down;
  try {
    down = await waitUntil(`${victim.label} 흠뻑(쓰러짐)`, T.combat, async () => {
      await shooter.call('aimAt', victim.id);
      const v = await victim.state();
      return { ok: !v.alive, info: { soak: v.soak, alive: v.alive } };
    }, 100);
  } finally {
    await shooter.call('setIntent', null);
  }
  // 쓰러짐은 피해자 스냅샷으로도 전해진다(부활까지 3초 — 그 안에 쏜 쪽 화면에서 쓰러진 모습)
  const seenDown = await waitUntil(`${shooter.label} 화면에서 ${victim.label} 가 쓰러짐`, 2500, async () => {
    const r = remoteOf(await shooter.state(), victim.id);
    return { ok: r && !r.alive, info: r };
  }, 50);
  return { down, seenDown };
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
      await faceOff(A, B);
      assert(await A.call('aimAt', B.id), 'A.aimAt(B) 실패 — A 가 B 를 대상 목록에서 못 찾음');
      // 첫 명중까지만 쏜다(고정 시간 연사는 느린 소프트웨어 렌더링 환경에서 프레임이 안 돌아 한 발도 안 나갈 수 있다)
      await A.call('setIntent', { fire: true });
      let hit;
      try {
        hit = await waitUntil('사격 → B 의 젖음 증가', T.combat, async () => {
          const [a, b] = await Promise.all([A.state(), B.state()]);
          return { ok: b.soak > 0 || !b.alive, info: { soak: b.soak, alive: b.alive, aTank: a.tank, aDroplets: a.droplets } };
        }, 30);
      } finally {
        await A.call('setIntent', null);
      }
      const soakAfterBurst = hit.value.info.soak;
      // 계속 쏴서 흠뻑
      const { down, seenDown } = await fireUntilDown(A, B);
      const agree = await waitUntil('모든 피어의 경기 점수 일치(A 1킬, B 1데스)', T.sync, async () => {
        const all = await Promise.all([A, B].map(scoresOf));
        const ok = all.every((sc) => sc[A.id]?.splashes === 1 && sc[B.id]?.soaked === 1 && (sc[A.id]?.soaked ?? 0) === 0);
        return { ok, info: all.map((sc) => ({ A: sc[A.id], B: sc[B.id] })) };
      });
      return `첫 명중 ${hit.ms}ms(B 젖음 ${soakAfterBurst.toFixed(0)}), 흠뻑까지 ${down.ms}ms, A 화면 반영 +${seenDown.ms}ms, 점수 일치 ${agree.ms}ms`;
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

/**
 * 비호스트 shooter 가 호스트의 봇 하나를 쫓아가 적셔 쓰러뜨린다.
 * 명중 판정은 쏜 사람 쪽(shooter 화면의 봇 위치)이고, 봇의 젖음·쓰러짐은 호스트가 hit 메시지를 받아 처리한다.
 */
async function splashBotAsNonHost(host, shooter) {
  const before = (await scoresOf(host))[shooter.id]?.splashes ?? 0;
  let targetId = null;
  await shooter.call('setIntent', { fire: true });
  try {
    return await waitUntil(`${shooter.label}(비호스트)가 봇을 쓰러뜨려 호스트 점수에 반영`, 45_000, async () => {
      const [h, s] = await Promise.all([host.state(), shooter.state()]);
      const bots = s.remotes.filter((r) => r.bot && r.hasData);
      let target = bots.find((r) => r.id === targetId && r.alive);
      if (!target) {
        target = bots.find((r) => r.alive && !r.shielded);
        targetId = target?.id ?? null;
      }
      if (s.alive && target) {
        // 시험장 가운데 쪽으로 2.5m 떨어진 곳에서 조준(벽·상자에 덜 끼게)
        if (dist(s.pos, target.pos) > 4.5) {
          const [x, y, z] = target.pos;
          const len = Math.hypot(x, z);
          const k = len > 1 ? 2.5 / len : 0;
          await shooter.call('teleport', x - x * k + (len > 1 ? 0 : 2.5), y + 0.05, z - z * k);
        }
        await shooter.call('aimAt', target.id);
      }
      const hostBot = h.bots.find((b) => b.id === targetId);
      const splashes = h.match?.scores?.[shooter.id]?.splashes ?? 0;
      return { ok: splashes > before, info: { target: targetId, hostSoak: hostBot?.soak, splashes, shooterAlive: s.alive } };
    }, 60);
  } finally {
    await shooter.call('setIntent', null);
  }
}

/** 모든 피어의 경기 점수표가 같아질 때까지(봇끼리 싸우는 중이라 잠깐씩 다를 수 있다) */
function waitScoresAgree(players) {
  return waitUntil(`${players.map((p) => p.label).join('·')} 경기 점수 일치`, T.sync, async () => {
    const st = await Promise.all(players.map((p) => p.state()));
    const keys = st.map((s) => JSON.stringify(Object.entries(s.match?.scores ?? {}).sort()));
    return { ok: new Set(keys).size === 1 && st.every((s) => s.match?.hostId === st[0].hostId), info: keys };
  }, 100);
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

    await step('B(비호스트)가 호스트의 봇을 적셔 쓰러뜨림 → 호스트 점수 반영, 모두 일치', async () => {
      const kill = await splashBotAsNonHost(A, B);
      const agree = await waitScoresAgree([A, B]);
      return `봇 쓰러뜨림 ${kill.ms}ms (봇 ${kill.value.info.target}), 점수 일치 ${agree.ms}ms`;
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
      // 전송 계층이 떠남을 알리기 전(아직 원격 목록에 있음)에도 멈춘 A 는 보이지 않고 맞지 않아야 한다(유령 방지)
      const ghost = value.states.map((s) => remoteOf(s, A.id)).filter(Boolean);
      assert(ghost.every((r) => !r.visible), `떠난 A 가 아직 보임: ${JSON.stringify(ghost)}`);
      const aimGhost = await Promise.all([B, C].map((p) => p.call('aimAt', A.id)));
      assert(aimGhost.every((ok) => !ok), '떠난 A 가 아직 조준·명중 대상에 있음');
      const agree = await waitBotsAgree([B, C], BOT_FILL_TO - 2);
      const moving = await botsMoveOn(other);
      const hostMoving = await botsMoveOn(newHost);
      return `새 호스트=${newHost.label}, 합의 ${ms}ms, 떠난 A 는 원격 목록에 ${ghost.length ? '남았지만 숨김·조준 불가' : '없음'}, 이어받은 봇 ${kept.length}마리, 봇 목록 일치 ${agree.ms}ms, ${moving}, ${hostMoving}`;
    });
  });
}

// ------------------------------------------------------------------ suite 3: 두 호스트 합치기

async function suiteMerge(browser) {
  await suite('두 호스트 합치기', browser, async (ctx, step) => {
    let A, B, C;

    await step('A 는 릴레이 연결이 늦어 혼자 호스트 + 봇 5마리', async () => {
      A = await ctx.open('A', { bots: true, gateRelays: true });
      await A.join();
      await waitUntil('A 가 호스트로 봇 5마리 생성', T.sync, async () => {
        const s = await A.state();
        return { ok: s.isHost && s.bots.length === BOT_FILL_TO - 1, info: { isHost: s.isHost, bots: s.bots.length } };
      });
    });

    await step('그동안 B·C 가 들어와 따로 한 판(B 호스트, 봇 4마리)', async () => {
      B = await ctx.open('B', { bots: true });
      await B.join();
      C = await ctx.open('C', { bots: true });
      await C.join();
      const mesh = await waitMesh([B, C], T.connect);
      assert(mesh.value.states[0].hostId === B.id, `B 가 호스트여야 함(호스트=${mesh.value.states[0].hostId?.slice(0, 8)})`);
      const agree = await waitBotsAgree([B, C], BOT_FILL_TO - 2);
      const [a, b] = await Promise.all([A.state(), B.state()]);
      assert(a.isHost && a.remotes.length === 0, 'A 가 그사이 누군가와 연결됨(릴레이 지연이 안 먹힘)');
      const shared = b.bots.filter((x) => a.bots.some((y) => y.id === x.id)).map((x) => x.id);
      assert(shared.length === 0, `두 호스트의 봇 id 가 겹침(봇 id 는 호스트별이어야 함): ${shared}`);
      return `B·C 봇 목록 일치 ${agree.ms}ms, A 봇 ${a.bots.map((x) => x.id).join(',')} / B 봇 ${b.bots.map((x) => x.id).join(',')}`;
    });

    await step('A 릴레이 연결 → 먼저 들어온 A 로 합쳐짐: B 는 자기 봇을, C 는 B 의 봇을 버리고 모두 A 의 봇·경기 상태', async () => {
      const bOld = new Set((await B.state()).bots.map((x) => x.id));
      const released = Date.now();
      await A.page.evaluate(() => window.__openRelays());
      const mesh = await waitMesh([A, B, C], T.connect);
      const connectMs = Date.now() - released;
      assert(mesh.value.states[0].hostId === A.id, `먼저 들어온 A 가 호스트여야 함(호스트=${mesh.value.states[0].hostId?.slice(0, 8)})`);
      const agree = await waitBotsAgree([A, B, C], BOT_FILL_TO - 3);
      const [a, b, c] = await Promise.all([A.state(), B.state(), C.state()]);
      assert(b.bots.length === 0, `B 가 자기 봇을 버리지 않음: ${b.bots.map((x) => x.id)}`);
      const aIds = a.bots.map((x) => x.id).sort();
      for (const [p, s] of [[B, b], [C, c]]) {
        const seen = s.remotes.filter((r) => r.bot).map((r) => r.id).sort();
        assert(JSON.stringify(seen) === JSON.stringify(aIds), `${p.label} 가 보는 봇 ${seen} ≠ A 의 봇 ${aIds}`);
        assert(!seen.some((id) => bOld.has(id)), `${p.label} 화면에 B 의 옛 봇이 남음`);
      }
      const scores = await waitScoresAgree([A, B, C]);
      const cs = (await C.state()).match;
      assert(cs.hostId === A.id, `C 의 경기 상태가 A 것이 아님(hostId=${cs.hostId?.slice(0, 8)})`);
      const ids = Object.keys(cs.scores).sort();
      const expected = [A.id, B.id, C.id, ...aIds].sort();
      assert(JSON.stringify(ids) === JSON.stringify(expected), `점수표 참가자가 틀림: ${ids} ≠ ${expected}`);
      const movingB = await botsMoveOn(B);
      const movingC = await botsMoveOn(C);
      return `릴레이 연결→3명 합의 ${connectMs}ms, 봇 목록 일치 ${agree.ms}ms, 점수 일치 ${scores.ms}ms, ${movingB}, ${movingC}`;
    });
  });

  await suite('동시 입장', browser, async (ctx, step) => {
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

// ------------------------------------------------------------------ suite 4: 팀전

/** 경기 상태의 팀 배정 { id: team } (JSON, id 정렬) */
const teamsOf = (s) => JSON.stringify(Object.fromEntries(Object.entries(s.match?.scores ?? {}).map(([id, l]) => [id, l.team]).sort()));

function waitTeamsAgree(players) {
  return waitUntil(`${players.map((p) => p.label).join('·')} 팀 배정 일치`, T.sync, async () => {
    const st = await Promise.all(players.map((p) => p.state()));
    const teams = st.map(teamsOf);
    const assigned = Object.values(JSON.parse(teams[0]));
    const ok = new Set(teams).size === 1 && st.every((s) => s.match?.mode === 'tdm')
      && assigned.length === players.length && assigned.every((t) => t === 0 || t === 1);
    return { ok, teams: JSON.parse(teams[0]), info: teams };
  });
}

async function suiteTdm(browser) {
  await suite('팀전', browser, async (ctx, step) => {
    let A, B, C;
    let teams;

    await step('두 명 팀전 입장 → 서로 다른 팀, 모든 피어 팀 배정 일치', async () => {
      [A, B] = await Promise.all([ctx.open('A', { bots: false, mode: 'tdm' }), ctx.open('B', { bots: false, mode: 'tdm' })]);
      await Promise.all([A.join(), B.join()]);
      await waitMesh([A, B], T.connect);
      const agree = await waitTeamsAgree([A, B]);
      teams = agree.value.teams;
      assert(teams[A.id] !== teams[B.id], `두 명이 같은 팀: ${JSON.stringify(teams)}`);
      return `A=${teams[A.id]}팀, B=${teams[B.id]}팀`;
    });

    await step('A 가 B 를 쓰러뜨림 → A 팀 점수 1, 모든 피어 일치', async () => {
      await faceOff(A, B);
      await fireUntilDown(A, B);
      const agree = await waitUntil('팀 점수 일치', T.sync, async () => {
        const st = await Promise.all([A.state(), B.state()]);
        const ts = st.map((s) => s.match?.teamScores ?? []);
        const ok = ts.every((t) => t[teams[A.id]] === 1 && t[teams[B.id]] === 0);
        return { ok, info: ts };
      });
      return `팀 점수 일치 ${agree.ms}ms`;
    });

    await step('C 입장 → 인원이 적은 팀에 배정, 모두 일치', async () => {
      C = await ctx.open('C', { bots: false, mode: 'tdm' });
      await C.join();
      await waitMesh([A, B, C], T.connect);
      const agree = await waitTeamsAgree([A, B, C]);
      teams = agree.value.teams;
      const counts = [0, 0];
      for (const t of Object.values(teams)) counts[t]++;
      assert(Math.abs(counts[0] - counts[1]) === 1, `팀 인원이 치우침: ${counts}`);
      return `C=${teams[C.id]}팀, 인원 ${counts.join(':')}`;
    });

    await step('호스트 정상 종료 → 새 호스트가 팀·팀 점수를 그대로 이어받음', async () => {
      const hostState = await A.state();
      const host = [A, B, C].find((p) => p.id === hostState.hostId);
      const scoresBefore = hostState.match.teamScores;
      await host.close({ graceful: true });
      const remaining = [A, B, C].filter((p) => !p.closed);
      await waitUntil('남은 피어가 같은 새 호스트에 합의', T.migrate, async () => {
        const st = await Promise.all(remaining.map((p) => p.state()));
        const ok = new Set(st.map((s) => s.hostId)).size === 1 && st[0].hostId !== host.id && st.filter((s) => s.isHost).length === 1
          && st.every((s) => s.match?.hostId === st[0].hostId);
        return { ok, info: st.map((s) => [s.hostId?.slice(0, 8), s.match?.hostId?.slice(0, 8)]) };
      });
      // 떠난 호스트의 점수 줄은 전송 계층이 떠남을 알릴 때(정상 종료 신호가 못 가면 10초+) 빠지므로 남은 사람만 비교
      const agree = await waitUntil('남은 피어의 팀 배정·팀 점수가 그대로이고 모두 일치', T.sync, async () => {
        const st = await Promise.all(remaining.map((p) => p.state()));
        const view = st.map((s) => JSON.stringify([remaining.map((p) => s.match?.scores?.[p.id]?.team), s.match?.teamScores]));
        const expected = JSON.stringify([remaining.map((p) => teams[p.id]), scoresBefore]);
        return { ok: view.every((v) => v === expected), info: { expected, view } };
      });
      return `떠난 호스트=${host.label}, 팀·팀 점수(${scoresBefore.join(':')}) 유지 확인 ${agree.ms}ms`;
    });
  });
}

// ------------------------------------------------------------------ suite 5: 시계가 틀린 참가자(#2)

const SKEW_MS = -10 * 60_000;

async function suiteSkew(browser) {
  await suite('시계 오차', browser, async (ctx, step) => {
    let A, B, C, host;
    let before;

    await step('A·B 접속 → 호스트 합의, 경기 진행', async () => {
      [A, B] = await Promise.all([ctx.open('A', { bots: false }), ctx.open('B', { bots: false })]);
      await Promise.all([A.join(), B.join()]);
      const { value } = await waitMesh([A, B], T.connect);
      host = [A, B].find((p) => p.id === value.states[0].hostId);
      // 새 경기(240초)와 구분되도록 타이머가 충분히 흐른 뒤
      await waitUntil('호스트 타이머가 10초 이상 흐름', T.sync, async () => {
        const s = await host.state();
        return { ok: s.timerMs < MATCH_DURATION_MS - 10_000, info: s.timerMs };
      }, 500);
      before = await host.state();
      return `호스트=${host.label}, 남은 시간 ${(before.timerMs / 1000).toFixed(1)}s`;
    });

    await step('시계가 10분 늦은 C 입장 → 호스트·라운드·타이머 그대로, C 도 같은 경기 상태', async () => {
      C = await ctx.open('C', { bots: false, clockSkewMs: SKEW_MS });
      const offset = await C.page.evaluate(async () => {
        const clock = await import('/src/net/serverClock.ts');
        await clock.syncServerClock();
        return clock.serverNow() - Date.now();
      });
      assert(Math.abs(offset) < 2000, `C 의 서버 시각 보정이 기기 시계 오차를 상쇄하지 못함: serverNow − 실제 = ${offset}ms`);
      const joinedAt = Date.now();
      await C.join();
      await waitMesh([A, B, C], T.connect);
      // 잠깐이라도 호스트가 바뀌면 경기가 초기화되므로 몇 초 동안 계속 지켜본다
      const watchUntil = Date.now() + 5000;
      let last;
      while (Date.now() < watchUntil) {
        const states = await Promise.all([A, B, C].map((p) => p.state()));
        const hs = states.find((s) => s.isHost);
        assert(states.every((s) => s.hostId === host.id) && hs?.selfId === host.id,
          `호스트가 바뀜: ${JSON.stringify(states.map((s) => s.hostId?.slice(0, 8)))} (원래 ${host.id.slice(0, 8)})`);
        assert(hs.match.round === before.match.round, `라운드가 바뀜: ${before.match.round} → ${hs.match.round}`);
        assert(hs.timerMs <= before.timerMs, `타이머가 처음부터 다시 시작됨: ${before.timerMs}ms → ${hs.timerMs}ms`);
        last = states;
        await sleep(250);
      }
      const c = last[2];
      assert(c.match?.round === before.match.round && Math.abs(c.timerMs - last.find((s) => s.isHost).timerMs) < 2500,
        `C 의 경기 상태가 호스트와 다름: ${JSON.stringify({ c: c.match, cTimer: c.timerMs })}`);
      return `C 보정 오차 ${offset}ms, 참가→연결 ${Date.now() - joinedAt - 5000}ms, 호스트=${host.label} 유지`;
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
  if (SUITES.includes('tdm')) await suiteTdm(browser);
  if (SUITES.includes('skew')) await suiteSkew(browser);
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
