import * as THREE from 'three';

const MAX_PARTICLES = 900;
const MAX_DECALS = 160;
const WATER = new THREE.Color('#8BE4FF');
const WATER_DEEP = new THREE.Color('#3FB6F0');
const WHITE = new THREE.Color('#FFFFFF');

interface Particle {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size: number;
  gravity: number;
}

interface Decal {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();
const _v = new THREE.Vector3();

/**
 * 물 효과: 튀는 물방울 파티클 + 바닥·벽의 젖은 자국(데칼).
 * 인스턴싱으로 한 번에 그린다.
 */
export class Fx {
  private readonly particles: Particle[] = [];
  private readonly decals: Decal[] = [];
  private pCursor = 0;
  private dCursor = 0;
  private readonly pMesh: THREE.InstancedMesh;
  private readonly dMesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0.05, gravity: 14 });
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals.push({ life: 0, maxLife: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.3 });
    }
    this.pMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      MAX_PARTICLES,
    );
    this.pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.pMesh.frustumCulled = false;
    this.pMesh.count = 0;
    this.pMesh.name = 'fx-particles';

    const decalGeo = new THREE.CircleGeometry(1, 20);
    this.dMesh = new THREE.InstancedMesh(
      decalGeo,
      new THREE.MeshBasicMaterial({
        color: '#2E9BD6',
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      MAX_DECALS,
    );
    this.dMesh.frustumCulled = false;
    this.dMesh.count = 0;
    this.dMesh.name = 'fx-decals';
    this.dMesh.renderOrder = 1;
    scene.add(this.pMesh, this.dMesh);
  }

  /** 물방울이 표면에 부딪힘 */
  impact(point: THREE.Vector3, normal: THREE.Vector3, scale = 1): void {
    const n = Math.round(4 * scale) + 2;
    for (let i = 0; i < n; i++) {
      this.spawn(point, _v.copy(normal).multiplyScalar(2 + Math.random() * 2.5).add(randomDir(2.2)), 0.025 + Math.random() * 0.03 * scale, 0.35 + Math.random() * 0.25);
    }
    if (Math.random() < 0.55 * scale) this.decal(point, normal, 0.18 + Math.random() * 0.22 * scale);
  }

  /** 캐릭터 몸에 맞음 */
  bodyHit(point: THREE.Vector3): void {
    for (let i = 0; i < 7; i++) {
      this.spawn(point, randomDir(4).add(_v.set(0, 1.5, 0)), 0.03 + Math.random() * 0.03, 0.4 + Math.random() * 0.2);
    }
  }

  /** 물풍선 폭발 */
  burst(point: THREE.Vector3, radius: number): void {
    for (let i = 0; i < 70; i++) {
      const d = randomDir(1).normalize();
      d.y = Math.abs(d.y) * 0.8 + 0.2;
      this.spawn(point, d.multiplyScalar(4 + Math.random() * radius * 2.2), 0.05 + Math.random() * 0.08, 0.6 + Math.random() * 0.5);
    }
    this.decal(_v.copy(point).setY(point.y - 0.05), new THREE.Vector3(0, 1, 0), radius * 0.6, 7);
  }

  /** 흠뻑 젖어 쓰러짐 — 큰 물기둥 */
  bigSplash(point: THREE.Vector3): void {
    for (let i = 0; i < 90; i++) {
      const d = randomDir(1);
      d.y = Math.abs(d.y) * 2.5 + 1;
      this.spawn(_v.copy(point).add(randomDir(0.35)), d.multiplyScalar(2.5 + Math.random() * 3.5), 0.05 + Math.random() * 0.09, 0.7 + Math.random() * 0.6);
    }
    this.decal(point, new THREE.Vector3(0, 1, 0), 1.3, 8);
  }

  /** 걷는 중 수영장 물 튀김 등 작은 효과 */
  sprinkle(point: THREE.Vector3, count = 3): void {
    for (let i = 0; i < count; i++) this.spawn(point, randomDir(1.2).add(_v.set(0, 2.2, 0)), 0.025 + Math.random() * 0.02, 0.35);
  }

  update(dt: number): void {
    let n = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      _s.setScalar(p.size * (0.4 + 0.6 * k));
      _m.compose(p.pos, _q.identity(), _s);
      this.pMesh.setMatrixAt(n, _m);
      _c.copy(WATER_DEEP).lerp(WATER, k).lerp(WHITE, k > 0.8 ? (k - 0.8) * 2 : 0);
      this.pMesh.setColorAt(n, _c);
      n++;
    }
    this.pMesh.count = n;
    this.pMesh.instanceMatrix.needsUpdate = true;
    if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true;

    let m = 0;
    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      const k = Math.min(1, d.life / (d.maxLife * 0.4));
      _s.setScalar(d.size * (0.6 + 0.4 * k));
      _m.compose(d.pos, d.quat, _s);
      this.dMesh.setMatrixAt(m++, _m);
    }
    this.dMesh.count = m;
    this.dMesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.particles.forEach((p) => (p.life = 0));
    this.decals.forEach((d) => (d.life = 0));
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, size: number, life: number): void {
    const p = this.particles[this.pCursor];
    this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.size = size;
    p.life = p.maxLife = life;
    p.gravity = 14;
  }

  private decal(pos: THREE.Vector3, normal: THREE.Vector3, size: number, life = 5): void {
    const d = this.decals[this.dCursor];
    this.dCursor = (this.dCursor + 1) % MAX_DECALS;
    d.pos.copy(pos).addScaledVector(normal, 0.015);
    d.quat.setFromUnitVectors(_up, normal);
    d.size = size;
    d.life = d.maxLife = life;
  }
}

function randomDir(scale: number): THREE.Vector3 {
  return new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(scale);
}
