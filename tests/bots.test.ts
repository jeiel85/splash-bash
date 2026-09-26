import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { loadGlbNode } from './glb';
import { formatSim, runBotSim, type SimResult } from './botSim';
import { buildMapFromScene, type GameMap } from '../src/world/map';
import { BotBrain, BotDirector, BotNav, botShotDirection, refillRateAt, solveThrowPitch, type BotSkill } from '../src/game/bots';
import { PlayerBody } from '../src/game/playerBody';
import { Arsenal } from '../src/game/weapons';
import { makeContact } from '../src/world/collision';
import { BALLOON, BOT, PLAYER } from '../src/config';
import type { PeerId, ScoreLine } from '../src/types';

const FILE = 'public/assets/models/map_backyard.glb';
const DT = 1 / 60;
const DEG = Math.PI / 180;
/** BOT_SIM_REPORT=1 이면 시뮬레이션 통계를 출력한다(밸런스 점검용) */
const REPORT = !!process.env.BOT_SIM_REPORT;
/** 캐주얼 플레이어 대역: 봇보다 조준이 거칠고(σ 6°→3.5°) 반응이 느리며(0.55~0.9초) 시선 회전도 느리다 */
const CASUAL: Partial<BotSkill> = { reactionMin: 0.55, reactionMax: 0.9, aimSigmaStartDeg: 6, aimSigmaEndDeg: 3.5, turnRateDeg: 160 };

describe('BotDirector — 봐주기 규칙·대상 나눠 갖기(맵 무관)', () => {
  const map = { collision: {}, waypoints: new Map(), fountains: [], jumpPads: [], water: [], bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1, killY: -5 } } as unknown as GameMap;
  const v = () => new THREE.Vector3();
  const line = (splashes: number, soaked: number): ScoreLine => ({ splashes, soaked, team: -1 });

  function frame(d: BotDirector, time: number, targets: Record<PeerId, PeerId | null> = {}) {
    d.begin(map, time);
    d.see('human', -1, v(), v(), true, false, 0, false);
    d.see('b1', -1, v(), v(), true, false, 0, true, targets.b1 ?? null);
    d.see('b2', -1, v(), v(), true, false, 0, true, targets.b2 ?? null);
    d.see('b3', -1, v(), v(), true, false, 0, true, targets.b3 ?? null);
  }

  it('사람이 점수 없이 3번 연속 흠뻑 젖으면 봐주기, 한 번 적시면 해제, 봇에게는 적용 안 함', () => {
    const d = new BotDirector();
    frame(d, 0);
    d.syncScores({ human: line(0, 0), b1: line(0, 0) });
    frame(d, 1);
    expect(d.mercyOn('human')).toBe(false);
    d.syncScores({ human: line(0, 2), b1: line(0, 5) });
    frame(d, 2);
    expect(d.mercyOn('human')).toBe(false);
    d.syncScores({ human: line(0, 3), b1: line(0, 5) });
    frame(d, 3);
    expect(d.mercyOn('human')).toBe(true);
    expect(d.mercyOn('b1')).toBe(false);
    // 점수를 내면 해제, 그 뒤 다시 3번이면 다시 켜짐
    d.syncScores({ human: line(1, 3), b1: line(0, 6) });
    frame(d, 4);
    expect(d.mercyOn('human')).toBe(false);
    d.syncScores({ human: line(1, 5), b1: line(0, 6) });
    frame(d, 5);
    expect(d.mercyOn('human')).toBe(false);
    d.syncScores({ human: line(1, 6), b1: line(0, 6) });
    frame(d, 6);
    expect(d.mercyOn('human')).toBe(true);
    // 새 경기(점수 초기화)면 기록도 처음부터
    d.syncScores({ human: line(0, 0), b1: line(0, 0) });
    frame(d, 7);
    expect(d.mercyOn('human')).toBe(false);
  });

  it('인지 목록의 claims 는 그 참가자를 노리는 봇 수', () => {
    const d = new BotDirector();
    frame(d, 0, { b1: 'human', b2: 'human', b3: 'b1' });
    const ctx = d.context('b3', 0);
    const claims = Object.fromEntries(ctx.others.map((o) => [o.id, o.claims]));
    expect(claims).toEqual({ human: 2, b1: 1, b2: 0, b3: 0 });
    expect(ctx.selfId).toBe('b3');
  });

  it('발사 소리는 게임 시각으로 기록되고 오래되면 잊는다', () => {
    const d = new BotDirector();
    frame(d, 10);
    d.noteFire('human');
    frame(d, 10.1);
    expect(d.context('b1', 0).others.find((o) => o.id === 'human')!.firedAt).toBeCloseTo(10, 9);
    frame(d, 30);
    d.syncScores({});
    frame(d, 30.1);
    expect(d.context('b1', 0).others.find((o) => o.id === 'human')!.firedAt).toBe(-Infinity);
  });
});

describe('봇 조준 도구', () => {
  it('물풍선 피치: 풀어 낸 각으로 던지면 목표 거리·높이에 떨어진다', () => {
    // 봇이 던지는 범위(5~12 m, 몸통은 눈보다 0.5~1 m 낮음)
    for (const [D, H] of [[5, -0.7], [8, -1], [12, -0.7], [10, -3], [6, 1.5]]) {
      const th = solveThrowPitch(D, H);
      expect(th, `D ${D} H ${H}`).not.toBeNull();
      const vx = BALLOON.throwSpeed * Math.cos(th!);
      const vy = BALLOON.throwSpeed * Math.sin(th!) + BALLOON.throwUp;
      const t = D / vx;
      expect(vy * t - 0.5 * BALLOON.gravity * t * t).toBeCloseTo(H, 2);
    }
    // 닿지 않는 거리
    expect(solveThrowPitch(30, 0)).toBeNull();
  });

  it('물줄기 방향은 총구에서 시선 위 조준점으로 모인다', () => {
    const eye = new THREE.Vector3(0, 1.42, 0);
    const aim = new THREE.Vector3(0, 0, -1);
    const muzzle = new THREE.Vector3(0.35, 0.95, -0.55);
    const out = botShotDirection(eye, aim, muzzle, 10, new THREE.Vector3());
    const p = muzzle.clone().addScaledVector(out, (10 - 0.55) / -out.z);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1.42, 6);
    // 조준 거리를 모르면 시선 그대로
    expect(botShotDirection(eye, aim, muzzle, 0, new THREE.Vector3()).toArray()).toEqual([0, 0, -1]);
  });
});

describe.runIf(existsSync(FILE))('봇 — 실제 맵(map_backyard.glb)', () => {
  let map: GameMap;
  let nav: BotNav;

  beforeAll(async () => {
    const scene = await loadGlbNode(FILE);
    map = buildMapFromScene('backyard', scene.getObjectByName('Map') ?? scene);
    nav = BotNav.for(map);
  });

  /** 한 봇(과 움직이지 않는 참가자들)을 seconds 동안 돌린다. onFrame 이 true 면 멈춤 */
  function drive(opts: {
    brain: BotBrain; body: PlayerBody; arsenal: Arsenal; director?: BotDirector; seconds: number;
    others?: Array<{ id: PeerId; pos: THREE.Vector3; isBot?: boolean }>;
    onFrame?: (t: number, fire: boolean) => boolean | void;
  }): number {
    const d = opts.director ?? new BotDirector();
    const zero = new THREE.Vector3();
    let t = 0;
    while (t < opts.seconds - 1e-9) {
      t += DT;
      d.begin(map, t);
      d.see('me', -1, opts.body.position, opts.body.velocity, true, false, 0, true, opts.brain.targetId);
      for (const o of opts.others ?? []) d.see(o.id, -1, o.pos, zero, true, false, 0, o.isBot ?? false);
      const intent = opts.brain.think(DT, opts.body, opts.arsenal, d.context('me', 0));
      opts.body.speedScale = BOT.speedScale;
      opts.body.step(DT, intent);
      opts.arsenal.tick(DT, intent, refillRateAt(map, opts.body.position), false, 'still');
      if (opts.onFrame?.(t, intent.fire)) break;
    }
    return t;
  }

  function standable(p: THREE.Vector3): boolean {
    const c = makeContact();
    map.collision.resolveCapsule(new THREE.Vector3(p.x, p.y + PLAYER.radius + 0.1, p.z), new THREE.Vector3(p.x, p.y + PLAYER.height - PLAYER.radius, p.z), PLAYER.radius, c);
    return c.push.lengthSq() < 1e-4;
  }

  /** 눈높이 시야가 트이고 거리가 [min, max] 인 바닥 웨이포인트 쌍 */
  function openPair(min: number, max: number): [THREE.Vector3, THREE.Vector3] {
    const ids = [...nav.ids.keys()].filter((i) => nav.kind[i] === 'ground' && nav.ids[i].startsWith('wp_'));
    for (const i of ids) {
      for (const j of ids) {
        const a = nav.pos[i];
        const b = nav.pos[j];
        const d = a.distanceTo(b);
        if (d < min || d > max) continue;
        const ea = a.clone().setY(a.y + PLAYER.eyeHeight);
        if (!map.collision.lineOfSight(ea, b.clone().setY(b.y + 0.3)) || !map.collision.lineOfSight(ea, b.clone().setY(b.y + 1.5))) continue;
        return [a, b];
      }
    }
    throw new Error(`시야가 트인 ${min}~${max} m 웨이포인트 쌍이 없음`);
  }

  describe('길찾기 그래프(BotNav)', () => {
    it('보충 노드: 분수마다 둘레 자리, 수영장 안 웨이포인트 — 서 있으면 실제로 물이 찬다', () => {
      const fountainSpots = nav.refill.filter((r) => nav.kind[r] === 'fountain');
      const poolSpots = nav.refill.filter((r) => nav.kind[r] === 'pool');
      expect(poolSpots.length).toBeGreaterThanOrEqual(1);
      map.fountains.forEach((_f, fi) => {
        expect(fountainSpots.some((r) => nav.ids[r].startsWith(`fountain_${fi}_`)), `fountain ${fi}`).toBe(true);
      });
      for (const r of nav.refill) {
        const body = new PlayerBody(map.collision);
        body.teleport(nav.pos[r].clone().setY(nav.pos[r].y + 0.05), 0);
        for (let i = 0; i < 60; i++) body.step(DT, { moveX: 0, moveZ: 0, jump: false, jumpPressed: false, slidePressed: false, fire: false, firePressed: false, throwPressed: false, weaponSlot: null, weaponCycle: 0 });
        expect(body.grounded, nav.ids[r]).toBe(true);
        expect(body.position.distanceTo(nav.pos[r]), `${nav.ids[r]} 밀려남`).toBeLessThan(0.3);
        expect(refillRateAt(map, body.position), `${nav.ids[r]} 보충`).toBeGreaterThan(0);
      }
    });

    it('모든 노드에서 모든 보충 노드·전망대로 가는 경로가 있다(점프대는 한쪽 방향)', () => {
      const path: number[] = [];
      for (let i = 0; i < nav.count; i++) {
        if (nav.kind[i] === 'pad') continue;
        for (const goal of [...nav.refill, ...nav.towers]) {
          expect(nav.findPath(i, goal, path), `${nav.ids[i]} → ${nav.ids[goal]}`).toBe(true);
          expect(path[0]).toBe(i);
          expect(path[path.length - 1]).toBe(goal);
        }
      }
    });

    it('점프대 노드는 전망대 데크로만 이어지고, 데크에서 점프대로 돌아가는 간선은 없다', () => {
      const pads = [...nav.ids.keys()].filter((i) => nav.kind[i] === 'pad');
      expect(pads.length).toBe(map.jumpPads.length);
      expect(nav.towers.length).toBeGreaterThanOrEqual(2);
      for (const p of pads) {
        expect(nav.links[p].length).toBe(1);
        expect(nav.kind[nav.links[p][0]]).toBe('deck');
        for (const t of nav.towers) expect(nav.links[t]).not.toContain(p);
      }
    });

    it('경로 시작: 그래프 근처(간선 옆 ±1.5 m) 어디서든 가까운 노드 중 곧장 걸어갈 수 있는 것을 고른다', () => {
      let points = 0;
      let direct = 0;
      const perp = new THREE.Vector3();
      for (let i = 0; i < nav.count; i++) {
        for (const j of nav.links[i]) {
          if (j < i || nav.kind[i] === 'pad' || nav.kind[j] === 'pad') continue;
          const a = nav.pos[i];
          const b = nav.pos[j];
          if (Math.abs(a.y - b.y) > 0.3) continue;
          perp.set(-(b.z - a.z), 0, b.x - a.x).normalize();
          for (const t of [0.3, 0.7]) {
            const mid = a.clone().lerp(b, t);
            for (const off of [-1.5, 1.5]) {
              const x = mid.x + perp.x * off;
              const z = mid.z + perp.z * off;
              const y = nav.floorAt(x, mid.y + 1, z, 1.5);
              if (Number.isNaN(y) || Math.abs(y - mid.y) > 0.3) continue;
              const p = new THREE.Vector3(x, y, z);
              if (!standable(p) || !nav.canWalk(mid, p)) continue;
              points++;
              if (nav.canWalk(p, nav.pos[nav.nearest(p, true)])) direct++;
            }
          }
        }
      }
      expect(points).toBeGreaterThan(100);
      // 시야가 막힌 몇 곳은 가장 가까운 노드로 가다가 끼임 회복(점프·막힌 노드 빼고 재계획)으로 벗어난다
      expect(direct / points).toBeGreaterThanOrEqual(0.97);
    });
  });

  describe('BotBrain 행동', () => {
    it('처음 본 대상에게 첫 발은 반응 지연(0.4~0.7초) 뒤, 오차 6° 안일 때(소커 — 10 m 에서 처짐 보정 없음)', () => {
      const [a, b] = openPair(8, 12);
      const delays: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const body = new PlayerBody(map.collision);
        body.teleport(a, Math.atan2(-(b.x - a.x), -(b.z - a.z)));
        const brain = new BotBrain(seed, () => -1, {}, 'soaker');
        const arsenal = new Arsenal();
        let acquired = -1;
        let fired = -1;
        let errAtFire = 0;
        drive({
          brain, body, arsenal, seconds: 3, others: [{ id: 'dummy', pos: b }],
          onFrame: (t, fire) => {
            if (acquired < 0 && brain.targetId === 'dummy') acquired = t;
            if (fire && fired < 0) {
              fired = t;
              const eye = body.eyePosition(new THREE.Vector3());
              const to = b.clone().setY(b.y + PLAYER.height * 0.55).sub(eye).normalize();
              errAtFire = Math.acos(Math.min(1, body.aimDirection(new THREE.Vector3()).dot(to)));
              return true;
            }
          },
        });
        expect(acquired, `seed ${seed} 대상 인지`).toBeGreaterThan(0);
        expect(acquired, `seed ${seed} 5Hz 판단 안에 인지`).toBeLessThanOrEqual(BOT.thinkInterval + DT);
        expect(fired, `seed ${seed} 발사`).toBeGreaterThan(0);
        delays.push(fired - acquired);
        // 판단 시점 눈 위치 기준이라 이동 한 프레임만큼 여유(0.5°)
        expect(errAtFire / DEG, `seed ${seed} 오차`).toBeLessThan(BOT.fireConeDeg + 0.5);
      }
      // 반응 지연 전에는 절대 쏘지 않는다. 지연이 끝나도 오차가 6° 를 넘으면(σ 4° 라 가끔) 다음 오차 뽑기까지 기다린다
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(BOT.reactionMin - 1e-9);
        expect(d).toBeLessThanOrEqual(BOT.reactionMax + BOT.aimJitterMax + DT);
      }
      expect(delays.filter((d) => d <= BOT.reactionMax + DT).length).toBeGreaterThanOrEqual(delays.length * 0.75);
      // 균등 분포: 전부 한쪽 끝에 몰리지 않는다
      expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(0.1);
    });

    it('시야 밖(등 뒤)의 적은 못 보지만 12 m 안에서 쏘면 들어서 돌아본다, 멀면 못 듣는다', () => {
      const [a, near] = openPair(7, 10);
      const face = Math.atan2((near.x - a.x), (near.z - a.z)); // 반대쪽을 본다
      const setup = () => {
        const body = new PlayerBody(map.collision);
        body.teleport(a, face);
        return { body, brain: new BotBrain(3, () => -1), arsenal: new Arsenal(), director: new BotDirector() };
      };
      // 조용하면 모른다(둘러보기 전에: 0.5초)
      const quiet = setup();
      drive({ ...quiet, seconds: 0.5, others: [{ id: 'enemy', pos: near }] });
      expect(quiet.brain.targetId).toBeNull();
      // 쏘면 판단 한 번(≤0.2초) 안에 알아챈다
      const loud = setup();
      let heardAt = -1;
      drive({
        ...loud, seconds: 1, others: [{ id: 'enemy', pos: near }],
        onFrame: (t) => {
          loud.director.noteFire('enemy');
          if (loud.brain.targetId === 'enemy') {
            heardAt = t;
            return true;
          }
        },
      });
      expect(heardAt).toBeGreaterThan(0);
      expect(heardAt).toBeLessThanOrEqual(BOT.thinkInterval + 2 * DT);
      // 듣기 거리 밖(등 뒤 20 m 쯤)은 쏴도 모른다
      const far = a.clone().addScaledVector(near.clone().sub(a).normalize(), BOT.hearRange + 6);
      const distant = setup();
      drive({ ...distant, seconds: 0.5, others: [{ id: 'enemy', pos: far }], onFrame: () => void distant.director.noteFire('enemy') });
      expect(distant.brain.targetId).toBeNull();
    });

    it('대상 나눠 갖기: 다른 적도 보이면 한 대상에 봇 2명까지', () => {
      // 팀전: 봇 셋(팀 0)이 한곳에, 사람 둘(팀 1)이 8~12 m 앞 좌우에 서 있다(가까운 쪽 e1)
      let setup: { bots: THREE.Vector3[]; enemies: THREE.Vector3[] } | null = null;
      const ids = [...nav.ids.keys()].filter((i) => nav.kind[i] === 'ground' && nav.ids[i].startsWith('wp_'));
      search: for (const i of ids) {
        for (const j of ids) {
          const a = nav.pos[i];
          const b = nav.pos[j];
          const d = a.distanceTo(b);
          if (d < 8 || d > 12) continue;
          const side = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
          const at = (p: THREE.Vector3, off: number) => {
            const x = p.x + side.x * off;
            const z = p.z + side.z * off;
            const y = nav.floorAt(x, p.y + 1, z, 1.5);
            return Number.isNaN(y) || Math.abs(y - p.y) > 0.2 ? null : new THREE.Vector3(x, y, z);
          };
          const bots = [at(a, -1.2), at(a, 0), at(a, 1.2)];
          const enemies = [at(b, -1.6), at(b, 2)];
          if (bots.includes(null) || enemies.includes(null)) continue;
          for (const p of bots) {
            for (const e of enemies) {
              const eye = p!.clone().setY(p!.y + PLAYER.eyeHeight);
              if (!map.collision.lineOfSight(eye, e!.clone().setY(e!.y + 0.5)) || !map.collision.lineOfSight(eye, e!.clone().setY(e!.y + 1.45))) continue search;
            }
          }
          setup = { bots: bots as THREE.Vector3[], enemies: enemies as THREE.Vector3[] };
          break search;
        }
      }
      expect(setup, '시야가 트인 자리').not.toBeNull();
      const { bots, enemies } = setup!;
      const director = new BotDirector();
      const zero = new THREE.Vector3();
      const agents = bots.map((p, k) => {
        const body = new PlayerBody(map.collision);
        body.teleport(p, Math.atan2(-(enemies[0].x - p.x), -(enemies[0].z - p.z)));
        return { id: `b${k}`, body, brain: new BotBrain(40 + k, () => 0), arsenal: new Arsenal() };
      });
      let maxOnE1 = 0;
      let t = 0;
      for (let f = 0; f < 90; f++) {
        t += DT;
        director.begin(map, t);
        for (const a of agents) director.see(a.id, 0, a.body.position, a.body.velocity, true, false, 0, true, a.brain.targetId);
        enemies.forEach((e, k) => director.see(`e${k}`, 1, e, zero, true, false, 0, false));
        for (const a of agents) {
          const intent = a.brain.think(DT, a.body, a.arsenal, director.context(a.id, 0));
          a.body.step(DT, intent);
          a.arsenal.tick(DT, intent, 0, false, 'still');
        }
        maxOnE1 = Math.max(maxOnE1, agents.filter((a) => a.brain.targetId === 'e0').length);
      }
      const targets = agents.map((a) => a.brain.targetId);
      expect(targets.every((x) => x === 'e0' || x === 'e1'), targets.join()).toBe(true);
      expect(maxOnE1).toBeLessThanOrEqual(BOT.maxPerTarget);
      expect(targets).toContain('e1');
    });

    it('물이 25 아래면 보충 자리(분수 둘레·수영장)로 가서 90 이상 찰 때까지 머문다 — 모든 부활 지점에서', () => {
      for (const sp of map.spawns) {
        const body = new PlayerBody(map.collision);
        body.teleport(sp.pos, sp.yaw);
        const brain = new BotBrain(7, () => -1);
        const arsenal = new Arsenal();
        arsenal.tank = 5;
        let arrived = -1;
        let leftRefillAt = -1;
        let tankWhenLeft = 0;
        const where = `spawn ${sp.pos.toArray().map((x) => x.toFixed(1))}`;
        drive({
          brain, body, arsenal, seconds: 25,
          onFrame: (t) => {
            if (arrived < 0 && brain.mode === 'refill' && refillRateAt(map, body.position) > 0) arrived = t;
            if (arrived >= 0 && brain.mode !== 'refill') {
              leftRefillAt = t;
              tankWhenLeft = arsenal.tank;
              return true;
            }
          },
        });
        expect(arrived, `${where} 보충 도착`).toBeGreaterThan(0);
        expect(arrived, `${where} 도착 시간`).toBeLessThan(15);
        expect(leftRefillAt, `${where} 보충 끝`).toBeGreaterThan(arrived);
        expect(tankWhenLeft, where).toBeGreaterThanOrEqual(BOT.refillUntil);
        expect(brain.stats.refillTrips).toBe(1);
      }
    });
  });

  describe('헤드리스 시뮬레이션(60Hz, 실제 물리·무기·투사체)', () => {
    const SEEDS = [1, 2, 3];
    const SECONDS = 90;
    const results: SimResult[] = [];

    beforeAll(() => {
      for (const seed of SEEDS) results.push(runBotSim(map, { seed, bots: 6, seconds: SECONDS }));
      if (REPORT) results.forEach((r, i) => console.log(formatSim(`FFA 6 bots seed ${SEEDS[i]}`, r)));
    });

    it('봇 6명 FFA: 모두 여러 웨이포인트를 돌고, 3초 넘게 끼이지 않고, 시선은 200°/s 이하로 돈다', () => {
      for (const r of results) {
        for (const a of r.agents) {
          expect(a.waypointsVisited, `${a.id} 방문 웨이포인트`).toBeGreaterThanOrEqual(15);
          expect(a.maxStuck, `${a.id} 끼임`).toBeLessThan(3);
          expect(a.maxYawRate, `${a.id} 회전`).toBeLessThanOrEqual(BOT.turnRateDeg + 0.5);
        }
      }
    });

    it('적심이 적당한 속도로 일어나고(6명 합 분당 8~45), 싸움이 한순간에 끝나지 않는다', () => {
      for (const r of results) {
        expect(r.splashesPerMin).toBeGreaterThanOrEqual(8);
        expect(r.splashesPerMin).toBeLessThanOrEqual(45);
        // 처음 맞은 뒤 쓰러질 때까지 평균 1.5초 이상 — 도망·반격할 틈
        expect(r.avgFight).toBeGreaterThan(1.5);
        // 한 봇이 판을 휩쓸지 않는다
        const top = Math.max(...r.agents.map((a) => a.splashes));
        expect(top / r.splashes).toBeLessThan(0.5);
      }
    });

    it('보충·후퇴·물풍선·전망대(경사로·점프대)를 쓴다(물풍선은 탱크 60 이상·봇마다 8초 간격)', () => {
      const towers = [0, 0];
      for (const r of results) {
        expect(r.agents.reduce((s, a) => s + a.refills, 0), '보충').toBeGreaterThan(0);
        expect(r.agents.reduce((s, a) => s + a.retreats, 0), '후퇴').toBeGreaterThan(0);
        expect(r.weapons.balloon.shots, '물풍선').toBeGreaterThan(0);
        for (const a of r.agents) {
          if (a.balloons > 1) expect(a.minBalloonGap, `${a.id} 물풍선 간격`).toBeGreaterThanOrEqual(BOT.balloonCooldown - 1e-6);
          if (a.balloons > 0) expect(a.minBalloonTank, `${a.id} 물풍선 탱크`).toBeGreaterThanOrEqual(BOT.balloonTank);
          towers[0] += a.towerArrivals[0];
          towers[1] += a.towerArrivals[1];
        }
      }
      expect(towers[0], '서쪽 전망대').toBeGreaterThan(0);
      expect(towers[1], '동쪽 전망대').toBeGreaterThan(0);
      // 전망대에는 경사로뿐 아니라 점프대로도 올라간다
      expect(results.reduce((s, r) => s + r.agents.reduce((x, a) => x + a.padLaunches, 0), 0), '점프대').toBeGreaterThan(0);
    });

    it('무기마다 선호 거리에서 싸운다(명중 거리: 양동이 < 소커 < 권총)', () => {
      const avg = (k: 'pistol' | 'soaker' | 'bucket') => {
        let hits = 0;
        let sum = 0;
        for (const r of results) {
          hits += r.weapons[k].hits;
          sum += r.weapons[k].avgHitDist * r.weapons[k].hits;
        }
        return sum / Math.max(1, hits);
      };
      expect(avg('bucket')).toBeLessThan(avg('soaker'));
      expect(avg('soaker')).toBeLessThan(avg('pistol'));
    });

    it(`판단 비용: 봇 한 명 think() 평균 ≤ 0.25 ms(설계 예산), p99 ≤ 1 ms`, () => {
      for (const r of results) {
        expect(r.thinkAvgUs).toBeLessThan(250);
        expect(r.thinkP99Us).toBeLessThan(1000);
      }
    });

    it('연습 모드(캐주얼 사람 대역 + 봇 5): 사람에게 몰리지 않고 부활하자마자 당하지 않는다', () => {
      const r = runBotSim(map, { seed: 5, bots: 5, seconds: SECONDS, human: CASUAL });
      if (REPORT) console.log(formatSim('practice casual seed 5', r));
      const h = r.human!;
      const me = r.agents.find((a) => a.human)!;
      // 봇 교전 시간 중 사람을 노린 비율은 공평한 몫(1/5) 근처
      expect(h.attentionShare).toBeLessThan(0.3);
      // 봇 3명 이상이 동시에 노린 시간은 드물다
      expect(h.dogpile3Share).toBeLessThan(0.08);
      // 부활 3초 안에는 봇 2명 넘게 노리지 않고, 부활 5초 안에 쓰러지는 일은 거의 없다
      expect(h.spawnMaxClaims).toBeLessThanOrEqual(2);
      expect(h.spawnDeaths).toBeLessThanOrEqual(1);
      expect(me.splashes, '사람 대역도 적신다').toBeGreaterThan(0);
    });
  });
});
