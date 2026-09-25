import '@fontsource/jua';
import './ui/styles.css';
import { MATCH, NET } from './config';
import { Input } from './core/input';
import { Sfx } from './audio/sfx';
import { RenderContext } from './render/renderer';
import { loadAssets, loadMap, type GameAssets } from './render/assets';
import { Game } from './game/game';
import { Hud } from './ui/hud';
import { ConnectingOverlay, Menu, PauseMenu, PlayPrompt, type PlayChoice } from './ui/menu';
import { MenuStage } from './ui/menuStage';
import { loadProfile, makeRoomCode, roomCodeFromHash, saveProfile, type Profile } from './ui/profile';
import { OfflineTransport, TrysteroTransport, type Transport } from './net/transport';
import type { GameMap } from './world/map';
import { buildTestArena } from './world/testArena';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

/** 사용자에게 그대로 보여 줄 수 있는 오류(메시지가 곧 안내 문구) */
class FriendlyError extends Error {}

/** 게임을 아예 시작할 수 없을 때(WebGL 없음 등) 전체 화면 안내 */
function showFatal(title: string, detail: string): void {
  document.getElementById('boot')?.remove();
  const box = document.createElement('div');
  box.className = 'overlay fatal';
  const card = document.createElement('div');
  card.className = 'overlay-card';
  const t = document.createElement('div');
  t.className = 'overlay-title';
  t.textContent = title;
  const d = document.createElement('div');
  d.className = 'overlay-sub';
  d.textContent = detail;
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = '새로고침';
  b.addEventListener('click', () => location.reload());
  card.append(t, d, b);
  box.appendChild(card);
  ui.appendChild(box);
}

function createRenderer(): RenderContext | null {
  try {
    return new RenderContext(app);
  } catch (err) {
    console.error('[main] WebGL 렌더러를 만들 수 없습니다', err);
    return null;
  }
}

/** 화면 크기에 맞춘 UI 배율(1280×720 = 1) */
function applyUiScale(): void {
  const u = Math.min(1.6, Math.max(0.72, Math.min(innerWidth / 1280, innerHeight / 720)));
  document.documentElement.style.setProperty('--u', u.toFixed(3));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('연결 취소', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('연결 취소', 'AbortError'));
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 온라인 대전이 가능한 환경인지 먼저 확인(안 되면 이유를 알려 준다) */
function checkOnlineSupport(): void {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new FriendlyError('이 브라우저는 온라인 대전(WebRTC)을 지원하지 않아요. 연습 모드로 놀아 주세요!');
  }
  if (!navigator.onLine) throw new FriendlyError('인터넷에 연결되어 있지 않아요. 연결을 확인하거나 연습 모드로 놀아 주세요.');
  if (!window.isSecureContext || !crypto.subtle) {
    throw new FriendlyError('온라인 대전은 보안 연결(https) 주소에서만 할 수 있어요.');
  }
}

function friendlyMessage(err: unknown): string {
  if (err instanceof FriendlyError) return err.message;
  if (!navigator.onLine) return '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요. (연습 모드는 바로 할 수 있어요)';
  return '연결에 실패했어요. 잠시 후 다시 시도해 주세요. (연습 모드는 바로 할 수 있어요)';
}

interface Joined { transport: Transport; warning: string | null }

/** 방에 참가하고 피어를 잠시 찾아본다. 정원이 찼으면 null. 취소되면 방을 나가고 AbortError */
async function joinRoom(roomId: string, password: string | undefined, signal: AbortSignal): Promise<Joined | null> {
  const t = new TrysteroTransport(roomId, password);
  let warning: string | null = null;
  t.onError = (msg) => {
    warning = msg;
    console.warn('[net] 방 참가 중 오류', msg);
  };
  try {
    await wait(NET.discoverMs, signal);
  } catch (err) {
    await t.leave().catch((e: unknown) => console.warn('[net] 취소 후 방 나가기 실패', e));
    throw err;
  }
  t.onError = null;
  if (t.peers().length >= MATCH.maxPlayers) {
    await t.leave();
    return null;
  }
  return { transport: t, warning };
}

function start(ctx: RenderContext): void {
  const profile = loadProfile();
  const input = new Input(ctx.renderer.domElement);
  const sfx = new Sfx();
  const hud = new Hud(ui, sfx);
  const sound = (name: Parameters<Sfx['play']>[0]) => sfx.play(name);

  let assets: GameAssets | null = null;
  let map: GameMap | null = null;
  let stage: MenuStage | null = null;
  let game: Game | null = null;
  let starting = false;
  let connectAbort: AbortController | null = null;

  function applySettings(p: Profile): void {
    const s = p.settings;
    input.sensitivity = s.sensitivity;
    input.invertY = s.invertY;
    sfx.setVolumes(s.volume, s.music, s.sfx);
    ctx.setFov(s.fov);
    hud.setFov(s.fov);
    hud.setReduceMotion(s.reduceMotion);
    stage?.setReduceMotion(s.reduceMotion);
    document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);
    if (ctx.getQuality() !== s.quality) ctx.setQuality(s.quality);
  }

  const onProfile = (p: Profile) => {
    saveProfile(p);
    applySettings(p);
    stage?.setProfile(p);
    game?.session.updateSelf({ name: p.name, cosmetics: { ...p.cosmetics } });
  };

  const menu = new Menu(ui, profile, {
    onProfile,
    onPreview: (p) => stage?.setProfile(p),
    onPlay: (c) => void play(c),
    sound,
  });
  const pause = new PauseMenu(ui, profile.settings, () => onProfile(profile), () => input.requestLock(), () => void leave(), sound);
  const connecting = new ConnectingOverlay(ui, () => connectAbort?.abort(), sound);
  const prompt = new PlayPrompt(ui, () => input.requestLock(), sound);
  document.getElementById('boot')?.remove();

  applyUiScale();
  applySettings(profile);
  menu.setInvite(roomCodeFromHash(location.hash));

  // 메뉴 레이아웃의 캐릭터 칸에 3D 캐릭터를 맞춘다
  const updateStageFrame = () => {
    if (!stage || !menu.visible) return;
    const r = menu.stageSlot.getBoundingClientRect();
    const w = innerWidth;
    const h = innerHeight;
    if (r.width < 10 || r.height < 10) {
      stage.setFrame({ x: 0, y: 0.25, h: 0.4 });
      return;
    }
    stage.setFrame({
      x: ((r.left + r.width / 2) / w) * 2 - 1,
      y: -(((r.top + r.height / 2) / h) * 2 - 1),
      h: Math.min(0.62, (r.height * 0.84) / h),
    });
  };
  new ResizeObserver(updateStageFrame).observe(menu.stageSlot);
  menu.root.addEventListener('scroll', updateStageFrame, { passive: true });
  addEventListener('resize', () => {
    applyUiScale();
    updateStageFrame();
  });

  addEventListener('hashchange', () => {
    if (!game && !starting) menu.setInvite(roomCodeFromHash(location.hash));
  });

  // 첫 입력에서 오디오 잠금 해제(브라우저 자동재생 정책) — 메뉴 음악도 이때 시작
  addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
  addEventListener('keydown', (e) => {
    sfx.unlock();
    if (e.key === 'Escape' && connecting.visible) connectAbort?.abort();
  }, { capture: true });

  input.on('lockchange', (locked) => {
    if (!game) return;
    game.setInputEnabled(locked);
    prompt.show(false);
    pause.show(!locked, game.roomCode);
  });

  async function boot(): Promise<void> {
    menu.setBusy(true);
    menu.setStatus('물총에 물 채우는 중… 💧');
    try {
      const useTest = new URLSearchParams(location.search).get('map') === 'test';
      const [a, m] = await Promise.all([
        loadAssets((done, total) => menu.setStatus(`물총에 물 채우는 중… ${done}/${total}`)),
        useTest ? Promise.resolve(buildTestArena()) : loadMap('backyard'),
      ]);
      assets = a;
      map = m;
      stage = new MenuStage(ctx, a, m, profile);
      stage.setReduceMotion(profile.settings.reduceMotion);
      stage.enter();
      updateStageFrame();
      menu.setBusy(false);
      menu.setStatus('');
      (window as unknown as { __ready?: boolean }).__ready = true;
    } catch (err) {
      console.error('[main] 게임 데이터 로드 실패', err);
      menu.setStatus('게임 데이터를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.', 'error', { label: '새로고침', fn: () => location.reload() });
      (window as unknown as { __error?: string }).__error = String(err);
      (window as unknown as { __ready?: boolean }).__ready = true;
    }
  }

  async function play(choice: PlayChoice): Promise<void> {
    if (starting || game || !assets || !map) return;
    starting = true;
    const abort = new AbortController();
    connectAbort = abort;
    sfx.unlock();
    sfx.play('click');
    menu.setBusy(true);
    menu.setStatus('');
    // 연습은 바로 시작하므로 이 클릭 안에서 포인터 잠금. 온라인은 연결을 기다리는 동안 취소 버튼을 누를 수 있게 잠그지 않는다
    if (choice.kind === 'practice') input.requestLock();
    try {
      let transport: Transport;
      let roomLabel: string;
      let roomCode: string | null = null;
      let mode = profile.mode;
      let warning: string | null = null;
      if (choice.kind === 'practice') {
        transport = new OfflineTransport();
        roomLabel = '연습 모드';
        mode = choice.mode;
      } else {
        checkOnlineSupport();
        if (choice.kind === 'quick') {
          mode = 'ffa';
          let found: Joined | null = null;
          let n = 1;
          for (; n <= NET.quickRoomCount && !found; n++) {
            connecting.show('물총 친구 찾는 중…', n === 1 ? '아무도 없으면 봇들과 먼저 시작해요' : `${n - 1}번 방이 가득 차서 다음 방을 보고 있어요`);
            found = await joinRoom(`${NET.quickRoomPrefix}-${n}`, undefined, abort.signal);
          }
          if (!found) throw new FriendlyError('빠른 대전 방이 모두 가득 찼어요 😢 잠시 후 다시 시도하거나 방을 만들어 보세요.');
          transport = found.transport;
          warning = found.warning;
          roomLabel = `빠른 대전 #${n - 1}`;
        } else {
          roomCode = choice.kind === 'create' ? makeRoomCode() : choice.code;
          if (choice.kind === 'create') mode = choice.mode;
          connecting.show(choice.kind === 'create' ? `방 ${roomCode} 만드는 중…` : `방 ${roomCode} 에 들어가는 중…`, choice.kind === 'create' ? '만들고 나면 초대 링크를 복사할 수 있어요' : '친구들을 찾고 있어요');
          const joined = await joinRoom(`room-${roomCode}`, roomCode, abort.signal);
          if (!joined) throw new FriendlyError(`방 ${roomCode} 이 가득 찼어요 (최대 ${MATCH.maxPlayers}명). 다른 방을 만들어 보세요.`);
          transport = joined.transport;
          warning = joined.warning;
          roomLabel = `방 ${roomCode}`;
          history.replaceState(null, '', `#room=${roomCode}`);
        }
      }
      connecting.hide();
      startGame(choice, transport, roomLabel, roomCode, mode, warning);
    } catch (err) {
      input.exitLock();
      if (abort.signal.aborted) {
        menu.setStatus('연결을 취소했어요.', 'info');
      } else {
        console.error('[main] 방 참가 실패', err);
        menu.setStatus(friendlyMessage(err), 'error');
      }
    } finally {
      connecting.hide();
      starting = false;
      connectAbort = null;
      menu.setBusy(false);
    }
  }

  function startGame(choice: PlayChoice, transport: Transport, roomLabel: string, roomCode: string | null, mode: Profile['mode'], warning: string | null): void {
    stage?.exit();
    menu.show(false);
    applySettings(profile);
    // ?bots=0 : 봇 없이(맵 확인·테스트용)
    const botFill = new URLSearchParams(location.search).get('bots') !== '0';
    const g = new Game(ctx, input, sfx, hud, assets!, map!, { transport, roomLabel, roomCode, mode, botFill, profile });
    game = g;
    g.on('notice', (text) => hud.toast(text));
    hud.setInvite(roomCode);
    sfx.setScene('game');
    g.setInputEnabled(input.locked);
    if (!input.locked) {
      // 클릭 직후 짧은 시간 안이면 잠금이 되고, 아니면 "클릭해서 시작!" 안내가 남는다(연습은 클릭 때 이미 요청함)
      if (choice.kind !== 'practice') input.requestLock();
      prompt.show(true, roomCode);
    }
    if (choice.kind === 'create') hud.toast(`방 ${roomCode} 을 만들었어요! Esc → 초대 링크 복사 💌`, 7);
    else if (choice.kind === 'join' && transport.peers().length === 0) hud.toast('아직 아무도 없어요. 친구에게 방 코드를 알려 주세요!', 5);
    else if (choice.kind === 'quick' && transport.peers().length === 0) hud.toast('지금은 봇들과 먼저 놀아요. 누가 들어오면 알려 줄게요!', 5);
    if (warning) hud.toast('온라인 연결이 불안정해요 — 친구가 못 들어올 수도 있어요', 5);
  }

  async function leave(): Promise<void> {
    if (!game) return;
    const g = game;
    game = null;
    pause.show(false, null);
    prompt.show(false);
    input.exitLock();
    try {
      await g.dispose();
    } catch (err) {
      console.error('[main] 방 나가기 정리 중 오류', err);
    }
    history.replaceState(null, '', location.pathname + location.search);
    menu.setInvite(null);
    sfx.setScene('menu');
    stage?.enter();
    menu.show(true);
    menu.setStatus('');
    updateStageFrame();
  }

  // ---------------------------------------------------------------- loop

  const MAX_STEP = 0.05;
  let last = performance.now();

  function step(now: number): void {
    let dt = Math.min(1, (now - last) / 1000);
    last = now;
    // 긴 프레임(탭 전환 등)은 잘게 나눠 시뮬레이션
    while (dt > 0) {
      const h = Math.min(MAX_STEP, dt);
      if (game) game.update(h);
      else stage?.update(h);
      dt -= h;
    }
  }

  function frame(now: number): void {
    step(now);
    ctx.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 탭이 가려지면 rAF 가 멈추므로, 멀티플레이 중에는 타이머로 시뮬레이션·네트워크를 유지한다(호스트가 멈추지 않도록)
  setInterval(() => {
    if (document.hidden && game) step(performance.now());
  }, 250);

  void boot();
}

const ctx = createRenderer();
if (ctx) start(ctx);
else showFatal('3D 그래픽을 켤 수 없어요 😢', '브라우저 설정에서 하드웨어 가속(WebGL)을 켜거나, 최신 Chrome·Edge·Firefox·Safari 로 열어 주세요.');
