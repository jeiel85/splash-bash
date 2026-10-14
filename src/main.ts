import '@fontsource/jua';
import './ui/styles.css';
import { MATCH, NET } from './config';
import { canPlayWithMouse, Input, readPointerEnv } from './core/input';
import { FrameClock, simulationPaused } from './core/loop';
import { applyDocument, switchLang, t } from './i18n';
import { Sfx } from './audio/sfx';
import { RenderContext } from './render/renderer';
import { loadAssets, loadMap, type GameAssets } from './render/assets';
import { Game } from './game/game';
import { Hud } from './ui/hud';
import { ConnectingOverlay, Menu, PauseMenu, PlayPrompt, type PlayChoice } from './ui/menu';
import { MenuStage } from './ui/menuStage';
import { loadProfile, makeRoomCode, roomCodeFromHash, saveProfile, type Profile } from './ui/profile';
import { fetchVisitCount } from './ui/visitCounter';
import { syncServerClock } from './net/serverClock';
import { OfflineTransport, TrysteroTransport, type Transport } from './net/transport';
import type { GameMap } from './world/map';
import { buildTestArena } from './world/testArena';

applyDocument();

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

/** 사용자에게 그대로 보여 줄 수 있는 오류(메시지가 곧 안내 문구) */
class FriendlyError extends Error {}

/** 키보드·마우스(포인터 잠금)로 할 수 없는 기기에서 메뉴에 띄우는 안내 */
const DEVICE_BLOCK_TEXT = t('device.block');

/** 게임을 아예 시작할 수 없을 때(WebGL 없음 등) 전체 화면 안내 */
function showFatal(title: string, detail: string): void {
  document.getElementById('boot')?.remove();
  const box = document.createElement('div');
  box.className = 'overlay fatal';
  const card = document.createElement('div');
  card.className = 'overlay-card';
  const head = document.createElement('div');
  head.className = 'overlay-title';
  head.textContent = title;
  const d = document.createElement('div');
  d.className = 'overlay-sub';
  d.textContent = detail;
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = t('reload');
  b.addEventListener('click', () => location.reload());
  card.append(head, d, b);
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
    throw new FriendlyError(t('online.noWebrtc'));
  }
  if (!navigator.onLine) throw new FriendlyError(t('online.offline'));
  if (!window.isSecureContext || !crypto.subtle) {
    throw new FriendlyError(t('online.insecure'));
  }
}

function friendlyMessage(err: unknown): string {
  if (err instanceof FriendlyError) return err.message;
  if (!navigator.onLine) return t('online.lost');
  return t('online.failed');
}

interface Joined { transport: Transport; warning: string | null }

/**
 * 방에 참가하고 피어를 찾아본다. 첫 피어가 오면 조금 더(settle) 모은 뒤, 아무도 없으면 waitMs 뒤 돌아온다.
 * 정원이 찼으면 null. 취소되면 방을 나가고 AbortError.
 */
async function joinRoom(roomId: string, password: string | undefined, waitMs: number, signal: AbortSignal): Promise<Joined | null> {
  const tr = new TrysteroTransport(roomId, password);
  let warning: string | null = null;
  tr.onError = (msg) => {
    warning = msg;
    console.warn('[net] 방 참가 중 오류', msg);
  };
  try {
    if (waitMs > 0) {
      const firstPeer = new Promise<void>((resolve) => {
        if (tr.peers().length) resolve();
        tr.onPeerJoin = () => resolve();
      });
      const found = await Promise.race([firstPeer.then(() => true), wait(waitMs, signal).then(() => false)]);
      if (found) await wait(NET.discover.settleMs, signal);
    }
  } catch (err) {
    await tr.leave().catch((e: unknown) => console.warn('[net] 취소 후 방 나가기 실패', e));
    throw err;
  } finally {
    // Session 이 이어받아 다시 설정한다(이미 연결된 피어에게는 Session 이 hello 를 방송)
    tr.onPeerJoin = null;
  }
  tr.onError = null;
  if (tr.peers().length >= MATCH.maxPlayers) {
    await tr.leave();
    return null;
  }
  return { transport: tr, warning };
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
  /** 빠른 대전에서 처음 확인할 방 번호(정원 초과로 밀려났을 때 다음 방부터) */
  let nextQuickRoom = 1;

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
    onLang: switchLang,
    sound,
  });
  const pause = new PauseMenu(ui, profile.settings, () => onProfile(profile), () => input.requestLock(), () => void leave(), sound);
  const connecting = new ConnectingOverlay(ui, () => connectAbort?.abort(), sound);
  const prompt = new PlayPrompt(ui, () => input.requestLock(), () => void leave(), sound);
  document.getElementById('boot')?.remove();

  // 휴대폰·태블릿·포인터 잠금 없는 브라우저: 조작할 수 없으니 온라인 방에는 들이지 않는다(자리만 차지하고 멈춘 캐릭터가 됨)
  const mouseReady = canPlayWithMouse(readPointerEnv());
  if (!mouseReady) menu.setDeviceBlock(DEVICE_BLOCK_TEXT);

  applyUiScale();
  applySettings(profile);
  menu.setInvite(roomCodeFromHash(location.hash));
  // 방문자 수는 장식이라 기다리지 않는다(실패·차단되면 칸이 숨은 채로 남는다)
  void fetchVisitCount().then((n) => menu.setVisits(n));

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
    // 연습은 잠금이 풀린 동안 시뮬레이션이 멈춘다(step). 온라인은 멈출 수 없다고 카드에 알린다
    pause.show(!locked, game.roomCode, game.session.online);
  });
  // 잠금 요청이 거부되거나 API 가 없으면 시작 안내에 이유를 보인다(같은 카드에 "메뉴로 나가기"가 있다)
  input.on('lockerror', (reason) => {
    if (game) prompt.lockFailed(reason);
  });

  async function boot(): Promise<void> {
    menu.setBusy(true);
    menu.setStatus(t('boot.drop'));
    try {
      const useTest = new URLSearchParams(location.search).get('map') === 'test';
      const [a, m] = await Promise.all([
        loadAssets((done, total) => menu.setStatus(t('boot.progress', { done, total }))),
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
      menu.setStatus(t('boot.failed'), 'error', { label: t('reload'), fn: () => location.reload() });
      (window as unknown as { __error?: string }).__error = String(err);
      (window as unknown as { __ready?: boolean }).__ready = true;
    }
  }

  async function play(choice: PlayChoice): Promise<void> {
    if (starting || game || !assets || !map) return;
    if (!mouseReady && choice.kind !== 'practice') {
      // 버튼은 막혀 있지만 다른 경로(정원 초과 후 다음 방 등)로 와도 온라인 방에는 들어가지 않는다
      menu.setStatus(DEVICE_BLOCK_TEXT, 'error');
      return;
    }
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
      /** 빠른 대전 방 번호(정원 초과로 밀려나면 다음 방부터 본다) */
      let quickRoom = 1;
      if (choice.kind === 'practice') {
        transport = new OfflineTransport();
        roomLabel = t('room.practice');
        mode = choice.mode;
      } else {
        checkOnlineSupport();
        // 입장 순서(joinedAt)를 서버 시각으로 맞춘다(#2). 입장할 때마다 새로 잰다(HEAD 한 번, 최대 3초).
        // 방에 들어가기 전에 기다려야 취소돼도 나갈 방이 없다
        await syncServerClock();
        abort.signal.throwIfAborted();
        if (choice.kind === 'quick') {
          mode = 'ffa';
          let found: Joined | null = null;
          let n = nextQuickRoom;
          nextQuickRoom = 1;
          for (; n <= NET.quickRoomCount && !found; n++) {
            connecting.show(t('connect.quick'), n === 1 ? t('connect.quickFirst') : t('connect.quickNext', { n: n - 1 }));
            found = await joinRoom(`${NET.quickRoomPrefix}-${n}`, undefined, NET.discover.quickWaitMs, abort.signal);
          }
          if (!found) throw new FriendlyError(t('connect.quickFull'));
          transport = found.transport;
          warning = found.warning;
          quickRoom = n - 1;
          roomLabel = t('room.quick', { n: quickRoom });
        } else {
          roomCode = choice.kind === 'create' ? makeRoomCode() : choice.code;
          if (choice.kind === 'create') mode = choice.mode;
          // 문구에서 코드 바로 뒤에 조사를 붙이지 않는다(난수 코드라 받침 유무에 따라 을/를·이/가가 틀린다)
          connecting.show(t(choice.kind === 'create' ? 'connect.creating' : 'connect.joining', { code: roomCode }), t(choice.kind === 'create' ? 'connect.createSub' : 'connect.joinSub'));
          const joined = await joinRoom(`room-${roomCode}`, roomCode, choice.kind === 'create' ? 0 : NET.discover.joinWaitMs, abort.signal);
          if (!joined) throw new FriendlyError(t('connect.roomFull', { code: roomCode, max: MATCH.maxPlayers }));
          transport = joined.transport;
          warning = joined.warning;
          roomLabel = t('room.code', { code: roomCode });
          history.replaceState(null, '', `#room=${roomCode}`);
        }
      }
      connecting.hide();
      startGame(choice, transport, roomLabel, roomCode, mode, warning, quickRoom);
    } catch (err) {
      input.exitLock();
      if (abort.signal.aborted) {
        menu.setStatus(t('online.cancelled'), 'info');
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

  function startGame(choice: PlayChoice, transport: Transport, roomLabel: string, roomCode: string | null, mode: Profile['mode'], warning: string | null, quickRoom: number): void {
    stage?.exit();
    menu.show(false);
    applySettings(profile);
    // ?bots=0 : 봇 없이(맵 확인·테스트용)
    const botFill = new URLSearchParams(location.search).get('bots') !== '0';
    const g = new Game(ctx, input, sfx, hud, assets!, map!, { transport, roomLabel, roomCode, mode, botFill, profile });
    game = g;
    g.on('notice', (text) => hud.toast(text));
    g.on('roomFull', () => void onRoomFull(choice, quickRoom));
    hud.setInvite(roomCode);
    sfx.setScene('game');
    g.setInputEnabled(input.locked);
    if (!input.locked) {
      // 클릭 직후 짧은 시간 안이면 잠금이 되고, 아니면 "클릭해서 시작!" 안내가 남는다(연습은 클릭 때 이미 요청함)
      if (choice.kind !== 'practice') input.requestLock();
      prompt.show(true, roomCode);
      // 잠금을 얻을 수 없는 기기(연습 모드로 들어온 휴대폰 등)는 누르기 전에 이유부터 보인다
      if (!mouseReady) prompt.lockFailed('unsupported');
    }
    if (choice.kind === 'create') hud.toast(t('toast.created', { code: roomCode ?? '' }), 7);
    else if (choice.kind === 'join' && transport.peers().length === 0) hud.toast(t('toast.alone'), 5);
    else if (choice.kind === 'quick' && transport.peers().length === 0) hud.toast(t('toast.quickAlone'), 5);
    if (warning) hud.toast(t('online.unstable'), 5);
  }

  /** 입장 뒤 정원 초과로 밀려남: 빠른 대전은 다음 방으로, 친구 방은 메뉴로 */
  async function onRoomFull(choice: PlayChoice, quickRoom: number): Promise<void> {
    await leave();
    if (choice.kind === 'quick') {
      nextQuickRoom = Math.min(NET.quickRoomCount, quickRoom + 1);
      void play({ kind: 'quick' });
    } else {
      menu.setStatus(t('connect.roomFullLater', { max: MATCH.maxPlayers }), 'error');
    }
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

  // 긴 프레임(탭 전환 등)은 잘게 나눠 시뮬레이션. 멈춘 동안 흐른 시간은 버린다(다시 움직일 때 한꺼번에 밀려들지 않게)
  const clock = new FrameClock(performance.now());
  // DEV 전용 ?pause=0 : 포인터 잠금 없이 연습 모드를 계속 돌린다(tools/ingame-shot.mjs 같은 자동화 스크린샷용)
  const neverPause = import.meta.env.DEV && new URLSearchParams(location.search).get('pause') === '0';
  /** 한 번이라도 update 한 게임(첫 프레임은 멈춤이어도 카메라·HUD 를 맞추려고 돌린다) */
  let tickedGame: Game | null = null;
  const tick = (h: number): void => {
    if (game) {
      game.update(h);
      tickedGame = game;
    } else {
      stage?.update(h);
    }
  };

  function step(now: number): void {
    if (!game) tickedGame = null;
    const paused = game !== null && !neverPause && simulationPaused(game.session.online, input.locked, tickedGame === game);
    clock.advance(now, paused, tick);
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
else showFatal(t('fatal.webgl'), t('fatal.webglDetail'));
