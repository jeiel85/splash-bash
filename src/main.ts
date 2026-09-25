import '@fontsource/jua';
import './ui/styles.css';
import { MATCH, NET } from './config';
import { Input } from './core/input';
import { Sfx } from './audio/sfx';
import { RenderContext } from './render/renderer';
import { loadAssets, loadMap, type GameAssets } from './render/assets';
import { Game } from './game/game';
import { Hud } from './ui/hud';
import { Menu, PauseMenu, type PlayChoice } from './ui/menu';
import { MenuStage } from './ui/menuStage';
import { loadProfile, makeRoomCode, normalizeRoomCode, saveProfile, type Profile } from './ui/profile';
import { OfflineTransport, TrysteroTransport, type Transport } from './net/transport';
import type { GameMap } from './world/map';
import { buildTestArena } from './world/testArena';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

const profile = loadProfile();
const ctx = new RenderContext(app);
const input = new Input(ctx.renderer.domElement);
const sfx = new Sfx();
const hud = new Hud(ui);

let assets: GameAssets | null = null;
let map: GameMap | null = null;
let stage: MenuStage | null = null;
let game: Game | null = null;
let starting = false;

function applySettings(p: Profile): void {
  input.sensitivity = p.settings.sensitivity;
  input.invertY = p.settings.invertY;
  sfx.volume = p.settings.volume;
  ctx.setFov(p.settings.fov);
  if (ctx.getQuality() !== p.settings.quality) ctx.setQuality(p.settings.quality);
}
applySettings(profile);

const onProfile = (p: Profile) => {
  saveProfile(p);
  applySettings(p);
  stage?.setProfile(p);
  game?.session.updateSelf({ name: p.name, cosmetics: { ...p.cosmetics } });
};

const hashCode = (() => {
  const m = /room=([A-Za-z0-9]+)/.exec(location.hash);
  return m ? normalizeRoomCode(m[1]) : null;
})();

const menu = new Menu(ui, profile, onProfile, (c) => void play(c), hashCode);
const pause = new PauseMenu(ui, profile.settings, () => onProfile(profile), () => input.requestLock(), () => void leave());
const connecting = document.createElement('div');
connecting.className = 'connecting hidden';
ui.appendChild(connecting);
const clickToPlay = document.createElement('button');
clickToPlay.className = 'click-to-play hidden';
clickToPlay.textContent = '클릭해서 시작! 💦';
clickToPlay.addEventListener('click', () => input.requestLock());
ui.appendChild(clickToPlay);

if (hashCode) menu.setStatus(`초대받은 방 ${hashCode} — "참가"를 눌러 들어가요`);

// 첫 입력에서 오디오 잠금 해제(브라우저 자동재생 정책)
addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
addEventListener('keydown', () => sfx.unlock(), { capture: true });

input.on('lockchange', (locked) => {
  if (!game) return;
  game.setInputEnabled(locked);
  clickToPlay.classList.add('hidden');
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
    stage.enter();
    menu.setBusy(false);
    menu.setStatus(hashCode ? `초대받은 방 ${hashCode} — "참가"를 눌러 들어가요` : '');
    (window as unknown as { __ready?: boolean }).__ready = true;
  } catch (err) {
    console.error(err);
    menu.setStatus('게임 데이터를 불러오지 못했어요. 새로고침해 주세요.');
    (window as unknown as { __ready?: boolean; __error?: string }).__error = String(err);
    (window as unknown as { __ready?: boolean }).__ready = true;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 방에 참가하고 피어를 잠시 찾아본다. 정원이 찼으면 null */
async function joinRoom(roomId: string, password?: string): Promise<Transport | null> {
  const t = new TrysteroTransport(roomId, password);
  await wait(NET.discoverMs);
  if (t.peers().length >= MATCH.maxPlayers) {
    await t.leave();
    return null;
  }
  return t;
}

async function play(choice: PlayChoice): Promise<void> {
  if (starting || game || !assets || !map) return;
  starting = true;
  sfx.unlock();
  sfx.play('click');
  menu.setBusy(true);
  // 사용자 클릭 안에서 포인터 락을 요청(연결을 기다리는 동안 잠겨 있어도 무방)
  input.requestLock();
  try {
    let transport: Transport;
    let roomLabel: string;
    let roomCode: string | null = null;
    let mode = profile.mode;
    const showConnecting = (text: string) => {
      connecting.textContent = text;
      connecting.classList.remove('hidden');
    };
    if (choice.kind === 'practice') {
      transport = new OfflineTransport();
      roomLabel = '연습 모드';
      mode = choice.mode;
    } else if (choice.kind === 'quick') {
      mode = 'ffa';
      let found: Transport | null = null;
      let n = 1;
      for (; n <= NET.quickRoomCount && !found; n++) {
        showConnecting(`물총 친구 찾는 중… (방 ${n})`);
        found = await joinRoom(`${NET.quickRoomPrefix}-${n}`);
      }
      if (!found) throw new Error('모든 빠른 대전 방이 가득 찼어요');
      transport = found;
      roomLabel = `빠른 대전 #${n - 1}`;
    } else {
      roomCode = choice.kind === 'create' ? makeRoomCode() : choice.code;
      if (choice.kind === 'create') mode = choice.mode;
      showConnecting(choice.kind === 'create' ? `방 ${roomCode} 만드는 중…` : `방 ${roomCode} 에 들어가는 중…`);
      const t = await joinRoom(`room-${roomCode}`, roomCode);
      if (!t) throw new Error('방이 가득 찼어요 (최대 8명)');
      transport = t;
      roomLabel = `방 ${roomCode}`;
      history.replaceState(null, '', `#room=${roomCode}`);
    }
    connecting.classList.add('hidden');
    stage?.exit();
    menu.show(false);
    game = new Game(ctx, input, sfx, hud, assets, map, { transport, roomLabel, roomCode, mode, botFill: true, profile });
    game.on('notice', (text) => hud.toast(text));
    game.setInputEnabled(input.locked);
    if (!input.locked) clickToPlay.classList.remove('hidden');
    if (choice.kind === 'create') hud.toast(`방 코드 ${roomCode} — Esc 메뉴에서 초대 링크를 복사하세요`);
    if (choice.kind === 'join' && transport.peers().length === 0) hud.toast('아직 아무도 없어요. 친구에게 코드를 알려 주세요!');
  } catch (err) {
    console.error(err);
    connecting.classList.add('hidden');
    input.exitLock();
    menu.setStatus(err instanceof Error ? err.message : '연결에 실패했어요');
  } finally {
    starting = false;
    menu.setBusy(false);
  }
}

async function leave(): Promise<void> {
  if (!game) return;
  const g = game;
  game = null;
  pause.show(false, null);
  clickToPlay.classList.add('hidden');
  input.exitLock();
  await g.dispose();
  history.replaceState(null, '', location.pathname + location.search);
  stage?.enter();
  menu.show(true);
  menu.setStatus('');
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
