/** 게임 전역 공유 타입. 네트워크 프로토콜·게임 로직·UI 가 공통으로 쓴다. */

export type PeerId = string;

export const WEAPON_IDS = ['pistol', 'soaker', 'bucket'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];
/** 킬피드·히트 이벤트에서 쓰는 피해 원인(총 + 물풍선) */
export type DamageSource = WeaponId | 'balloon';

export const HAT_IDS = ['none', 'cap', 'duck', 'flower', 'crown', 'frog', 'bucket'] as const;
export type HatId = (typeof HAT_IDS)[number];

export type GameMode = 'ffa' | 'tdm';
/** -1 = 개인전(팀 없음) */
export type TeamId = -1 | 0 | 1;

export interface Cosmetics {
  /** PLAYER_COLORS 인덱스 */
  color: number;
  hat: HatId;
}

/** 방에 참가한 플레이어(사람·봇)의 정적 정보 */
export interface PlayerInfo {
  id: PeerId;
  name: string;
  cosmetics: Cosmetics;
  isBot: boolean;
  /** 방 참가 시각(각자 로컬 시계, ms). 호스트 선출 순서에 쓴다 */
  joinedAt: number;
}

/** 이동·상태 스냅샷(네트워크 20Hz 전송 단위) */
export interface PlayerSnapshot {
  /** 보낸 쪽 시계(ms) */
  t: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  pitch: number;
  weapon: WeaponId;
  /** 0..1 젖은 정도 */
  soak: number;
  /** 0..1 물탱크 잔량 */
  tank: number;
  alive: boolean;
  grounded: boolean;
  /** 스폰 보호(무적) 중 */
  shielded: boolean;
}

export interface ScoreLine {
  /** 상대를 흠뻑 적신 횟수(킬) */
  splashes: number;
  /** 흠뻑 젖은 횟수(데스) */
  soaked: number;
  team: TeamId;
}

export type MatchPhase = 'playing' | 'results';

/** 호스트가 방송하는 경기 상태 */
export interface MatchState {
  mode: GameMode;
  phase: MatchPhase;
  /** 경기(또는 결과 화면) 남은 시간 ms — 보낸 시점 기준 */
  remainingMs: number;
  /** 경기 번호. 새 경기마다 +1 (늦게 온 메시지 무시용) */
  round: number;
  scores: Record<PeerId, ScoreLine>;
  teamScores: [number, number];
  hostId: PeerId;
  /** 결과 화면일 때 우승자(개인 id 또는 'team0'/'team1') */
  winner?: string;
}

export interface Vec3Like { x: number; y: number; z: number }
