/**
 * 튜닝 값 모음. 수치 근거는 docs/GAME_DESIGN.md 참고.
 * 게임플레이 수치를 바꿀 때는 이 파일만 고친다(로직에 매직 넘버 금지).
 */
import type { DamageSource, WeaponId } from './types';

export const GAME_VERSION = '0.1.0';

export const PLAYER = {
  radius: 0.4,
  height: 1.6,
  eyeHeight: 1.42,
  slideEyeHeight: 0.9,
  walkSpeed: 6.0,
  backpedalScale: 0.9,
  groundAccel: 50,
  groundDecel: 40,
  airAccel: 15,
  jumpVelocity: 6.93,
  gravity: 20,
  terminalFall: 30,
  /** 이 속도 이상으로 떨어지면 착지 효과음 */
  hardLandingSpeed: 9,
  /** 경사면을 바닥으로 인정하는 법선 y 최솟값(≈ 50°) */
  groundNormalY: 0.64,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  maxSoak: 100,
  /** 마지막 피격 후 마르기 시작까지(초) */
  regenDelay: 1.5,
  regenPerSec: 15,
  respawnDelay: 3.0,
  spawnProtection: 2.0,
  /** 수영장 안 이동 배율 */
  waterSpeedScale: 0.7,
} as const;

export const SLIDE = {
  minSpeed: 4.5,
  boost: 1.25,
  minSlideSpeed: 7.5,
  maxSpeed: 9.0,
  duration: 0.8,
  /** 슬라이드 중 감속(m/s²) */
  decel: 3,
  /** 슬라이드 중 방향 전환 한계(라디안/초) */
  steer: (60 * Math.PI) / 180,
  cooldown: 0.6,
} as const;

export const TANK = {
  capacity: 100,
  /** 발사를 멈추고 이 시간 뒤부터 자연 회복 */
  regenDelay: 0.6,
  regenPerSec: 8,
  fountainPerSec: 30,
  poolPerSec: 60,
  /** 이 이하면 "물 부족" 경고 */
  lowThreshold: 20,
} as const;

export interface WeaponDef {
  id: WeaponId;
  /** UI 표시 이름 */
  name: string;
  /** 발사 간격(초) */
  interval: number;
  /** 버튼을 누르고 있으면 연사 */
  automatic: boolean;
  /** 한 번 발사 시 물방울 수 */
  pellets: number;
  /** 산탄 패턴: 가운데 1발 + 링(각도°, 개수). 없으면 원뿔 무작위 */
  pattern?: Array<{ deg: number; count: number }>;
  /** 원뿔 퍼짐(도, 반각) — 서 있을 때 */
  spreadDeg: number;
  /** 움직일 때 / 공중일 때 퍼짐 배율 */
  spreadMoving: number;
  spreadAir: number;
  speed: number;
  /** 곧게 나는 시간(초). 이후 공기저항 + 중력 */
  straightTime: number;
  /** 물방울 수명(초) — 최대 사거리 */
  life: number;
  /** 시각 크기(m) */
  visualRadius: number;
  /** 적심: near 거리까지 soakNear, far 거리에서 soakFar 로 선형 감소 */
  soakNear: number;
  soakFar: number;
  falloffNear: number;
  falloffFar: number;
  /** 발사 1회 물 소모 */
  cost: number;
  /** 카메라 반동(도) */
  recoilDeg: number;
  /** 사격 중 이동 속도 배율 */
  moveScaleFiring: number;
}

/** 직진 이후 적용되는 탄도 — 모든 물줄기 공통 [스플래툰] */
export const STREAM = {
  drag: 4,
  gravity: 25,
  /** 물방울 vs 플레이어 판정 반지름(너그럽게) */
  hitRadius: 0.15,
} as const;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: '퐁퐁 권총',
    interval: 0.22, automatic: false, pellets: 1,
    spreadDeg: 0.4, spreadMoving: 2, spreadAir: 4,
    speed: 60, straightTime: 0.3, life: 0.7, visualRadius: 0.085,
    soakNear: 25, soakFar: 15, falloffNear: 18, falloffFar: 30,
    cost: 4, recoilDeg: 1.2, moveScaleFiring: 1,
  },
  soaker: {
    id: 'soaker', name: '슈퍼 소커',
    interval: 0.1, automatic: true, pellets: 1,
    spreadDeg: 1.5, spreadMoving: 2, spreadAir: 4,
    speed: 40, straightTime: 0.25, life: 0.6, visualRadius: 0.075,
    soakNear: 16, soakFar: 8, falloffNear: 10, falloffFar: 17,
    cost: 1.5, recoilDeg: 0.3, moveScaleFiring: 0.8,
  },
  bucket: {
    id: 'bucket', name: '양동이 블래스터',
    interval: 0.7, automatic: false, pellets: 10,
    pattern: [{ deg: 3, count: 3 }, { deg: 7, count: 6 }],
    spreadDeg: 0, spreadMoving: 1, spreadAir: 1.3,
    speed: 22, straightTime: 0.1, life: 0.45, visualRadius: 0.1,
    soakNear: 10, soakFar: 4, falloffNear: 3, falloffFar: 6.5,
    cost: 8, recoilDeg: 1.5, moveScaleFiring: 0.85,
  },
};

export const BALLOON = {
  cost: 40,
  cooldown: 1.2,
  throwSpeed: 14,
  throwUp: 2.5,
  /** 던지는 사람 속도의 이만큼을 더한다 */
  inheritVelocity: 0.5,
  gravity: 20,
  radius: 0.2,
  directSoak: 60,
  blastRadius: 3,
  /** 폭발: 1 m 이내 blastNear, 3 m 에서 blastFar */
  blastNear: 45,
  blastFar: 15,
  knockback: 3.5,
  knockUp: 2.5,
  fuse: 3,
} as const;

export const JUMPPAD = {
  defaultPower: 14,
  radius: 1.1,
  /** 연속 발동 방지 */
  cooldown: 0.5,
} as const;

export const MATCH = {
  durationSec: 240,
  ffaScoreLimit: 15,
  tdmScoreLimit: 30,
  resultsSec: 8,
  maxPlayers: 8,
  /** 사람 수가 이보다 적으면 봇으로 채운다 */
  botFillTo: 6,
} as const;

export const NET = {
  appId: 'splash-bash-p1',
  stateHz: 20,
  interpDelayMs: 110,
  matchBroadcastMs: 1000,
  /** 빠른 대전 방 이름 접두사. 가득 차면 -2, -3 ... */
  quickRoomPrefix: 'quick',
  quickRoomCount: 20,
  /**
   * 방 참가 후 피어 탐색: 첫 피어가 오면 settle 만큼 더 모은 뒤 시작, 아무도 없으면 wait 뒤 혼자 시작.
   * 실측(E2E) 연결 시간이 4~11초라 빠른 대전은 짧게 기다리고(혼자면 봇과 먼저 시작 — 나중에 합류),
   * 코드 참가는 방장이 있을 가능성이 높아 더 기다린다. 방 만들기는 기다리지 않는다.
   */
  discover: {
    quickWaitMs: 6000,
    joinWaitMs: 10000,
    settleMs: 1500,
  },
  /**
   * 호스트가 이만큼(ms) 아무 메시지도 안 보내면 쓰러진 것으로 보고 다음 사람을 호스트로 뽑는다.
   * 전송 계층의 연결 끊김 감지(탭 강제 종료 시 10초 이상)를 기다리지 않기 위함. 호스트가 다시 말하면 되돌린다.
   * 숨겨진 탭도 1초 간격으로는 보내므로(main.ts 타이머) 그보다 넉넉하게.
   */
  hostSilenceMs: 3000,
  protocol: 1,
} as const;

/** 개인전 색(파란색 계열은 물·하늘과 겹쳐 하나만 진하게) */
export const PLAYER_COLORS = [
  '#FF8A1F', '#7B5CFF', '#FF4F8B', '#19C3A6',
  '#FFD23F', '#3D8BFF', '#A0E426', '#FF6F7D',
] as const;

export const TEAM_COLORS = ['#FF8A1F', '#7B5CFF'] as const;
export const TEAM_NAMES = ['탠저린 팀', '그레이프 팀'] as const;

/** 물줄기 색: 쏜 사람 색을 이만큼 물빛에 섞는다 */
export const WATER_TINT = { base: '#BFF3FF', mix: 0.35 } as const;

export const SOURCE_LABEL: Record<DamageSource, string> = {
  pistol: '퐁퐁 권총',
  soaker: '슈퍼 소커',
  bucket: '양동이 블래스터',
  balloon: '물풍선',
};
