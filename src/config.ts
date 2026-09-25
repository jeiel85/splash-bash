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

/**
 * 슬라이드(Krunker 식): 달리다 누르면 확 빨라졌다가 줄어든다.
 * 걷기(6 m/s)에서 시작하면 9.6 → 6.4 m/s, 0.8초에 6.4 m(걷기 4.8 m 의 1.33배).
 * QA 플레이테스트에서 1.25 / 7.5 / 3 은 1초 이동이 걷기보다 3% 길 뿐이라 체감이 없었다.
 */
export const SLIDE = {
  /** 이 속도(m/s) 이상으로 달릴 때만 */
  minSpeed: 4.5,
  /** 시작 속도 = max(지금 속도 × boost, minSlideSpeed), 최대 maxSpeed */
  boost: 1.6,
  minSlideSpeed: 9.5,
  maxSpeed: 11,
  duration: 0.8,
  /** 슬라이드 중 감속(m/s²) — 끝날 때 걷기 속도 조금 위로 떨어져 자연스럽게 이어진다 */
  decel: 4,
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
    id: 'soaker', name: '콸콸 펌프',
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

/**
 * 봇(호스트 AI) 튜닝. 근거: docs/research/design-synthesis.md §12.
 * 사람과 같은 물리·무기 코드를 쓰므로 여기 값은 "판단·조준·이동 습관"만 정한다.
 */
export const BOT = {
  /** 판단 주기(초) — 5Hz. 봇마다 시작 위상을 흩어 같은 프레임에 몰리지 않게 */
  thinkInterval: 0.2,
  /** 이동 속도 배율(사람 6 m/s → 5.4 m/s), 슬라이드 안 씀 */
  speedScale: 0.9,
  /** 시야: 전체 각(도)·거리(m). 시야선 레이는 판단 때만 쏜다 */
  fovDeg: 110,
  sightRange: 30,
  /** "듣기": 이 거리 안에서 쏜 적은 시야 밖이어도 알아챈다 */
  hearRange: 12,
  /** 발사 소리를 들은 것으로 치는 시간(초) */
  hearMemory: 0.6,
  /** 맞으면 쏜 사람을 이 시간(초) 동안 "들은" 것으로 본다 */
  hitMemory: 1.5,
  /** 새로 본 대상에게 첫 발까지 반응 지연(초, 균등) */
  reactionMin: 0.4,
  reactionMax: 0.7,
  /** 잠깐 놓쳤던 같은 대상을 다시 볼 때 반응 지연(초) */
  reacquireDelay: 0.15,
  /** 시야에서 사라진 대상을 붙잡고 쫓는 시간(초) */
  targetMemory: 1.5,
  /** 대상을 잡은 뒤 이 시간(초) 동안은 더 나은 대상이 보여도 바꾸지 않는다(맞으면 예외) */
  retargetHold: 1.5,
  /** 바꿀 때 필요한 점수 차(m 환산) */
  retargetMargin: 3,
  /** 대상 점수(거리 m 기준 가감): 나를 맞힌 사람·현재 대상·보호막·다른 봇이 노리는 수 */
  scoreAttacker: 8,
  scoreCurrent: 4,
  scoreShielded: 20,
  scorePerClaim: 5,
  /** 다른 대상이 있으면 한 대상을 노리는 봇은 이 수까지 */
  maxPerTarget: 2,
  /**
   * 조준 오차 σ(도): 처음 aimSigmaStart → 계속 추적하면 aimTrackTime 초 뒤 aimSigmaEnd.
   * 종합안 §12 는 4° → 2° 이지만 헤드리스 연습 모드 시뮬레이션(사람 1 + 봇 5, 240초 × 16판, tests/botSim.ts)에서
   * 캐주얼 대역(σ 6°→3.5°, 반응 0.55~0.9초)이 4°→2° 봇에게 0/16 승·K/D 0.78, 5°→3° 봇에게 2/16 승·K/D 1.02 —
   * 연습 모드를 캐주얼 플레이어가 이길 수 있게 5° → 3° 로 둔다(봇끼리 실력은 같고, 반응·회전·발사 조건은 종합안 그대로)
   */
  aimSigmaStartDeg: 5,
  aimSigmaEndDeg: 3,
  aimTrackTime: 1.5,
  /** 대상의 옆걸음 속도 1 m/s 당 σ 추가(도) */
  aimSigmaPerLateralDeg: 1,
  /** 세로 오차는 가로의 이 배율(세로 조준이 쉽다) */
  aimPitchScale: 0.6,
  /** 오차 목표를 다시 뽑는 간격(초)과 따라가는 속도(1/초) — 조준점이 대상 둘레를 천천히 떠돈다 */
  aimJitterMin: 0.25,
  aimJitterMax: 0.45,
  aimJitterFollow: 6,
  /** 봐주기: 연속으로 이만큼 흠뻑 젖고 한 번도 못 적신 사람에게 σ 추가(도) — 점수를 내면 해제 */
  mercyStreak: 3,
  mercySigmaDeg: 2,
  /** 조준·시선 회전 한계(도/초) */
  turnRateDeg: 200,
  /** 오차가 이 각도(도) 안이거나 대상 몸통 안일 때만 쏜다 */
  fireConeDeg: 6,
  /** 물방울-몸 판정 반지름(m, STREAM.hitRadius + PLAYER.radius) — "몸통 안" 각도 계산용 */
  bodyRadius: 0.55,
  /** 반자동 무기를 누르는 간격 여유(초, 무기 간격 + 이만큼 균등) */
  clickSlackMin: 0.04,
  clickSlackMax: 0.14,
  /** 무기별 선호 교전 거리(m) */
  preferredRange: { pistol: 14, soaker: 8, bucket: 3 },
  /** 기본 무기 비율(나머지는 권총) */
  loadoutSoaker: 0.6,
  loadoutBucket: 0.25,
  /** 소커 봇 중 가까우면 양동이로 바꾸는 비율 */
  adaptiveShare: 0.5,
  /** 무기 바꾸기 거리(m): 양동이 → 소커, 소커 → 양동이/권총, 권총 → 소커 */
  bucketOut: 7.5,
  soakerToBucket: 3.2,
  soakerToPistol: 16,
  pistolToSoaker: 5,
  /** 무기를 다시 바꾸기까지 최소 간격(초) */
  switchHold: 1.2,
  /** 교전 중 좌우 무빙 방향 유지 시간(초) */
  strafeMin: 0.6,
  strafeMax: 1.2,
  /** 선호 거리에서 이만큼(m) 벗어나면 다가가거나 물러난다 */
  rangeSlack: 2.5,
  /** 교전 중 무작위 점프(초당 확률) */
  jumpPerSec: 0.1,
  /** 물 보충: 이 아래로 떨어지면 가서 이만큼 찰 때까지, 적이 이 거리 안이면 포기하고 싸운다 */
  refillBelow: 25,
  refillUntil: 90,
  refillAbortDist: 8,
  /** 수영장은 노출이 커서 경로 비용에 더하는 벌점(m) */
  poolRefillPenalty: 4,
  /** 후퇴: 내 젖음 ≥ retreatSoak, 대상 ≤ retreatTargetSoak 일 때 시야를 끊는 곳으로 최대 retreatTime 초 */
  retreatSoak: 70,
  retreatTargetSoak: 40,
  retreatTime: 3,
  retreatCooldown: 5,
  /** 엄폐 노드 탐색 반경(m)·후보 수 */
  coverRadius: 14,
  coverCandidates: 8,
  /** 물풍선: 대상 거리(m)·필요 물·봇별 쿨다운(초)·뭉침 판정 반경(m) */
  balloonMin: 5,
  balloonMax: 12,
  balloonTank: 60,
  balloonCooldown: 8,
  clusterRadius: 3,
  /** 던지기 조준을 맞추는 제한 시간(초)과 허용 오차(도) */
  throwWindow: 0.8,
  throwToleranceDeg: 3,
  /** 배회 목표 가중치(노드 종류별) */
  wanderTower: 2.5,
  wanderFountain: 2,
  wanderLane: 1.5,
  wanderOther: 1,
  wanderPatio: 0.6,
  wanderPool: 0.5,
  /** 막다른 노드 배율 */
  wanderDeadEnd: 0.3,
  /** 바깥 레인 판정: |z| ≥ 맵 절반 폭 × 이 비율. 가운데 레인은 수영장에서 이 거리(m) 안 */
  laneOuterFrac: 0.5,
  laneMiddleDist: 3.5,
  /** 이보다 가까운 노드는 배회 목표로 고르지 않는다(m) */
  wanderMinDist: 7,
  /** 목표에 닿은 뒤 머무는 시간(초): 보통 / 전망대 */
  lingerMin: 0.3,
  lingerMax: 1.2,
  towerLingerMin: 3,
  towerLingerMax: 6,
  /** 머무는 동안 둘러보는 회전 속도(도/초) */
  scanRateDeg: 70,
  /** 적이 안 보일 때 마지막으로 본·들은 곳으로 가 볼 확률 */
  investigateChance: 0.5,
  /** 점프대 비행 간선 비용(m 환산)과 경로마다 곱하는 무작위 범위 — 경사로와 번갈아 쓰게 */
  padEdgeCost: 6,
  padCostJitterMin: 0.5,
  padCostJitterMax: 2,
  /** 경로: 노드 도착 반경(m), 이 안이고 다음 노드로 곧장 걸어갈 수 있으면 건너뛴다 */
  arriveRadius: 0.9,
  cornerCutDist: 4,
  /** 높은 노드가 이 거리(m) 안이고 0.6 m 이상 높으면 뛴다(맵 감사 스크립트와 같은 규칙) */
  jumpUpDist: 3,
  jumpUpHeight: 0.6,
  /** 끼임: 0.5초마다 이동량이 이보다 작으면 끼인 시간 누적 → 점프 / 경로 재계산 / 목표 변경 */
  stuckMove: 0.6,
  stuckJump: 0.5,
  stuckReplan: 1.0,
  stuckNewGoal: 2.0,
  /** 막힌 노드를 경로 시작점 후보에서 빼 두는 시간(초) */
  blockedNodeTime: 3,
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
  soaker: '콸콸 펌프',
  bucket: '양동이 블래스터',
  balloon: '물풍선',
};
