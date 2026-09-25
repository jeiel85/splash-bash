import * as THREE from 'three';

const MAX_PARTICLES = 900;
const MAX_DECALS = 160;
const MAX_RINGS = 64;
const MAX_CONFETTI = 512;

const WATER = new THREE.Color('#D2F6FF');
const WATER_DEEP = new THREE.Color('#86D9FA');
const WHITE = new THREE.Color('#FFFFFF');
/** 젖은 자국이 바탕색에 곱해지는 배율(화면 색 공간 값 그대로) — 어둡고 살짝 푸르게 */
const WET_MULTIPLY = new THREE.Vector3(0.7, 0.8, 0.93);
const RING_COLOR = new THREE.Color('#F2FDFF');

/**
 * 물방울 공용 셰이더(인스턴싱): 뒤쪽 반구를 aTail 배만큼 늘려 꼬리 달린 물방울,
 * 화면 기준 조명(윗왼쪽)으로 밝은 면·하이라이트 점·가장자리 흰빛. 불투명이라 정렬 문제 없음.
 * 투사체(물줄기)와 튀는 물방울 파티클이 같이 쓴다.
 */
export function makeDropMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'WaterDrop',
    fog: true,
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: /* glsl */ `
      attribute float aTail;
      varying vec3 vNormalV;
      varying vec3 vColor;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position;
        vec3 nrm = normal;
        if ( p.z < 0.0 ) { p.z *= aTail; nrm.z /= aTail; }
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
        vNormalV = normalize( normalMatrix * mat3( instanceMatrix ) * nrm );
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3( 1.0 );
        #endif
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormalV;
      varying vec3 vColor;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 n = normalize( vNormalV );
        vec3 L = normalize( vec3( -0.35, 0.75, 0.55 ) );
        float ndl = dot( n, L );
        // 2단 툰 음영 + 안쪽 밝은 테 + 하이라이트 점 + 가장자리 진한 선(만화 물방울)
        vec3 c = vColor * mix( 0.86, 1.08, smoothstep( -0.08, 0.08, ndl ) );
        float fres = 1.0 - saturate( n.z );
        c = mix( c, vec3( 1.0 ), smoothstep( 0.42, 0.62, fres ) * 0.5 );
        float spec = smoothstep( 0.962, 0.975, dot( n, normalize( L + vec3( 0.0, 0.0, 1.0 ) ) ) );
        c = mix( c, vec3( 1.0 ), spec * 0.9 );
        c = mix( c, vec3( 0.25, 0.45, 0.7 ) * vColor, smoothstep( 0.82, 0.94, fres ) * 0.55 );
        gl_FragColor = vec4( c, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
}

/** 물방울 지오메트리(앞 반구 = 머리, 뒤 반구는 셰이더가 꼬리로 늘림) */
export function makeDropGeometry(detail = 2): THREE.BufferGeometry {
  return new THREE.IcosahedronGeometry(1, detail);
}

/** 인스턴스별 float 속성(동적) */
function instanceFloat(mesh: THREE.InstancedMesh, name: string, count: number, init = 0): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(init), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute(name, attr);
  return attr;
}

interface Particle {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size: number;
  gravity: number;
  color: THREE.Color;
  /** 수명이 끝나 갈수록 흰 거품에서 물빛으로 */
  foam: boolean;
}

interface Decal {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
  seed: number;
}

interface Ring {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
}

interface Confetti {
  life: number;
  maxLife: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  angle: number;
  phase: number;
  color: THREE.Color;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _upY = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _water = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 반지름 scale 인 구 안의 무작위 벡터(out 에 씀) */
function randomDir(out: THREE.Vector3, scale: number): THREE.Vector3 {
  return out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(scale);
}

/**
 * 물 효과: 튀는 물방울, 착탄 물결 고리, 젖은 자국(데칼), 색종이, 물 떨어짐.
 * 종류마다 인스턴싱 메시 하나 = 드로우콜 하나. 모두 고정 크기 풀을 돌려 쓴다(프레임 중 할당 없음).
 */
export class Fx {
  private readonly particles: Particle[] = [];
  private readonly decals: Decal[] = [];
  private readonly rings: Ring[] = [];
  private readonly confetti: Confetti[] = [];
  private pCursor = 0;
  private dCursor = 0;
  private rCursor = 0;
  private cCursor = 0;
  private readonly pMesh: THREE.InstancedMesh;
  private readonly pTail: THREE.InstancedBufferAttribute;
  private readonly dMesh: THREE.InstancedMesh;
  private readonly dFade: THREE.InstancedBufferAttribute;
  private readonly dSeed: THREE.InstancedBufferAttribute;
  private readonly rMesh: THREE.InstancedMesh;
  private readonly rProg: THREE.InstancedBufferAttribute;
  private readonly cMesh: THREE.InstancedMesh;
  private readonly meshes: THREE.InstancedMesh[];

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0.05, gravity: 14, color: new THREE.Color(), foam: true });
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals.push({ life: 0, maxLife: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.3, seed: 0 });
    }
    for (let i = 0; i < MAX_RINGS; i++) {
      this.rings.push({ life: 0, maxLife: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.3 });
    }
    for (let i = 0; i < MAX_CONFETTI; i++) {
      this.confetti.push({
        life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0),
        spin: 0, angle: 0, phase: 0, color: new THREE.Color(),
      });
    }

    // 물방울 파티클
    this.pMesh = new THREE.InstancedMesh(makeDropGeometry(2), makeDropMaterial(), MAX_PARTICLES);
    this.pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.pTail = instanceFloat(this.pMesh, 'aTail', MAX_PARTICLES, 1);
    this.pMesh.name = 'fx-particles';

    // 젖은 자국: 불규칙한 물 얼룩 + 주변 작은 방울(셰이더). 곱하기 혼합으로 바탕색을 어둡고 푸르게(젖은 느낌)
    this.dMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      name: 'WetDecal',
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uWet: { value: WET_MULTIPLY } }]),
      vertexShader: /* glsl */ `
        attribute float aFade;
        attribute float aSeed;
        varying vec2 vUv;
        varying float vFade;
        varying float vSeed;
        #include <common>
        #include <fog_pars_vertex>
        void main() {
          vUv = position.xy;
          vFade = aFade;
          vSeed = aSeed;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uWet;
        varying vec2 vUv;
        varying float vFade;
        varying float vSeed;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          float r = length( vUv );
          float a = atan( vUv.y, vUv.x );
          float s = vSeed * 6.2831;
          float edge = 0.62 + 0.1 * sin( a * 5.0 + s ) + 0.06 * sin( a * 9.0 + s * 2.7 ) + 0.04 * sin( a * 13.0 - s );
          float body = smoothstep( edge, edge - 0.06, r );
          float sat = 0.0;
          for ( int i = 0; i < 5; i++ ) {
            float fi = float( i );
            float ang = s * 1.7 + fi * 1.33;
            float rad = 0.8 + 0.12 * fract( vSeed * 13.1 + fi * 0.37 );
            float size = 0.05 + 0.05 * fract( vSeed * 7.3 + fi * 0.61 );
            sat = max( sat, smoothstep( size, size - 0.03, length( vUv - vec2( cos( ang ), sin( ang ) ) * rad ) ) );
          }
          float k = max( body, sat );
          // 가운데는 조금 옅게(물이 고인 가장자리가 진한 얼룩)
          k *= mix( 0.8, 1.0, smoothstep( edge - 0.3, edge - 0.05, r ) ) * vFade;
          #ifdef USE_FOG
            k *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
          #endif
          if ( k < 0.01 ) discard;
          // 곱하기 혼합: 1 = 그대로, uWet = 흠뻑 젖은 바닥색 배율(화면 색 공간)
          gl_FragColor = vec4( mix( vec3( 1.0 ), uWet, k ), 1.0 );
        }
      `,
    }), MAX_DECALS);
    this.dFade = instanceFloat(this.dMesh, 'aFade', MAX_DECALS);
    this.dSeed = instanceFloat(this.dMesh, 'aSeed', MAX_DECALS);
    this.dMesh.name = 'fx-decals';
    this.dMesh.renderOrder = 1;

    // 착탄 물결 고리: 처음엔 꽉 찬 원(번쩍)에서 점점 가늘게 퍼지며 사라진다
    this.rMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      name: 'SplashRing',
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      uniforms: { uColor: { value: RING_COLOR } },
      vertexShader: /* glsl */ `
        attribute float aProg;
        varying vec2 vUv;
        varying float vProg;
        void main() {
          vUv = position.xy;
          vProg = aProg;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vProg;
        void main() {
          float r = length( vUv );
          float t = vProg;
          float outer = mix( 0.3, 1.0, 1.0 - ( 1.0 - t ) * ( 1.0 - t ) );
          float width = mix( 0.3, 0.07, t );
          float ring = smoothstep( outer, outer - 0.05, r ) * smoothstep( outer - width - 0.05, outer - width, r );
          float alpha = ring * ( 1.0 - t ) * 0.9;
          if ( alpha < 0.01 ) discard;
          gl_FragColor = vec4( uColor, alpha );
          #include <colorspace_fragment>
        }
      `,
    }), MAX_RINGS);
    this.rProg = instanceFloat(this.rMesh, 'aProg', MAX_RINGS);
    this.rMesh.name = 'fx-rings';
    this.rMesh.renderOrder = 2;

    // 색종이(흠뻑 젖어 펑! 할 때 쏜 사람 색)
    this.cMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 0.62),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
      MAX_CONFETTI,
    );
    this.cMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CONFETTI * 3), 3);
    this.cMesh.name = 'fx-confetti';

    this.meshes = [this.pMesh, this.dMesh, this.rMesh, this.cMesh];
    for (const m of this.meshes) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    }
    scene.add(...this.meshes);
  }

  /** 물방울이 표면에 부딪힘. color = 물줄기 색(없으면 기본 물빛) */
  impact(point: THREE.Vector3, normal: THREE.Vector3, scale = 1, color?: THREE.Color): void {
    const n = Math.round(4 * scale) + 3;
    for (let i = 0; i < n; i++) {
      _d.copy(normal).multiplyScalar(rnd(2, 4.5)).add(randomDir(_v, 2.2));
      this.spawn(point, _d, rnd(0.022, 0.05) * scale, rnd(0.3, 0.55), color);
    }
    this.ring(point, normal, 0.32 * scale, 0.26);
    if (Math.random() < 0.6 * scale) this.decal(point, normal, rnd(0.2, 0.4) * scale);
  }

  /** 캐릭터 몸에 맞음 */
  bodyHit(point: THREE.Vector3, color?: THREE.Color): void {
    for (let i = 0; i < 8; i++) {
      _d.set(0, 1.6, 0).add(randomDir(_v, 4));
      this.spawn(point, _d, rnd(0.03, 0.06), rnd(0.35, 0.6), color);
    }
  }

  /** 물풍선 폭발: 큰 물보라 + 바닥까지 퍼지는 물결 고리 두 겹 + 큰 웅덩이 */
  burst(point: THREE.Vector3, radius: number, color?: THREE.Color): void {
    for (let i = 0; i < 90; i++) {
      randomDir(_d, 1).normalize();
      _d.y = Math.abs(_d.y) * 0.9 + 0.25;
      _d.multiplyScalar(rnd(3, 4 + radius * 2.4));
      this.spawn(point, _d, rnd(0.05, 0.14), rnd(0.6, 1.1), color);
    }
    // 가운데 솟는 물기둥
    for (let i = 0; i < 24; i++) {
      _d.set(rnd(-0.8, 0.8), rnd(6, 9), rnd(-0.8, 0.8));
      this.spawn(point, _d, rnd(0.06, 0.12), rnd(0.7, 1.0), color);
    }
    _p.copy(point).setY(point.y - 0.05);
    this.ring(_p, _upY, radius, 0.45);
    this.ring(_p, _upY, radius * 0.6, 0.32);
    this.decal(_p, _upY, radius * 0.75, 7);
  }

  /** 큰 물기둥(로컬 플레이어가 흠뻑 젖었을 때 등) */
  bigSplash(point: THREE.Vector3): void {
    for (let i = 0; i < 90; i++) {
      randomDir(_d, 1);
      _d.y = Math.abs(_d.y) * 2.5 + 1;
      _d.multiplyScalar(rnd(2.5, 6));
      this.spawn(randomDir(_p, 0.35).add(point), _d, rnd(0.05, 0.14), rnd(0.7, 1.3));
    }
    _p.copy(point).setY(point.y - 0.75);
    this.ring(_p, _upY, 1.8, 0.5);
    this.decal(_p, _upY, 1.3, 8);
  }

  /**
   * 캐릭터가 흠뻑 젖어 펑! — 물방울 32 + 색종이 60(쏜 사람 색, 1초, 중력 3 m/s², 팔랑팔랑) + 웅덩이 5초.
   * @param feetY 발바닥 높이(웅덩이 위치)
   */
  splashOut(center: THREE.Vector3, color: THREE.ColorRepresentation, feetY = center.y - 0.8): void {
    _c.set(color).getHSL(_hsl);
    // 물방울은 물줄기처럼 쏜 사람 색이 35% 섞인 물빛
    _water.copy(WATER).lerp(_c, 0.35);
    for (let i = 0; i < 32; i++) {
      randomDir(_d, 1).normalize();
      _d.y = Math.abs(_d.y) * 1.2 + 0.6;
      _d.multiplyScalar(rnd(3, 6.5));
      this.spawn(randomDir(_p, 0.3).add(center), _d, rnd(0.06, 0.13), rnd(0.6, 1.0), _water);
    }
    for (let i = 0; i < 60; i++) {
      const c = this.confetti[this.cCursor];
      this.cCursor = (this.cCursor + 1) % MAX_CONFETTI;
      c.pos.copy(center).add(randomDir(_p, 0.35));
      randomDir(c.vel, 1).normalize();
      c.vel.y = Math.abs(c.vel.y) * 1.4 + 0.5;
      c.vel.multiplyScalar(rnd(3.5, 7));
      randomDir(c.axis, 1).normalize();
      c.spin = rnd(8, 18);
      c.angle = rnd(0, Math.PI * 2);
      c.phase = rnd(0, Math.PI * 2);
      c.life = c.maxLife = rnd(0.9, 1.15);
      // 쏜 사람 색 + 밝기 변주 + 가끔 흰색
      const k = Math.random();
      if (k < 0.15) c.color.copy(WHITE);
      else c.color.setHSL(_hsl.h + rnd(-0.03, 0.03), Math.min(1, _hsl.s * rnd(0.9, 1.1)), THREE.MathUtils.clamp(_hsl.l + rnd(-0.12, 0.16), 0.25, 0.85));
    }
    _p.set(center.x, feetY + 0.02, center.z);
    this.ring(_p, _upY, 1.6, 0.45);
    this.decal(_p, _upY, 1.2, 5);
  }

  /** 젖은 캐릭터에서 떨어지는 물방울 한 방울 */
  drip(point: THREE.Vector3): void {
    _d.set(rnd(-0.2, 0.2), rnd(-0.6, -0.1), rnd(-0.2, 0.2));
    const p = this.spawn(point, _d, rnd(0.03, 0.045), rnd(0.35, 0.55));
    p.gravity = 9;
    p.foam = false;
  }

  /** 걷는 중 수영장 물 튀김 등 작은 효과 */
  sprinkle(point: THREE.Vector3, count = 3): void {
    for (let i = 0; i < count; i++) {
      _d.set(0, 2.2, 0).add(randomDir(_v, 1.2));
      this.spawn(point, _d, rnd(0.025, 0.045), 0.35);
    }
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
      const speed = p.vel.length();
      _q.setFromUnitVectors(_zAxis, _v.copy(p.vel).divideScalar(speed || 1));
      _s.setScalar(p.size * (0.35 + 0.65 * Math.min(1, k * 1.6)));
      _m.compose(p.pos, _q, _s);
      this.pMesh.setMatrixAt(n, _m);
      this.pTail.setX(n, 1 + Math.min(speed * 0.12, 2.5));
      if (p.foam) _c.copy(p.color).lerp(WHITE, k > 0.75 ? (k - 0.75) * 2.4 : 0);
      else _c.copy(p.color);
      this.pMesh.setColorAt(n, _c);
      n++;
    }
    this.pMesh.count = n;
    if (n > 0) {
      this.pMesh.instanceMatrix.needsUpdate = true;
      this.pTail.needsUpdate = true;
      if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true;
    }

    let m = 0;
    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      const age = d.maxLife - d.life;
      // 톡 퍼졌다가(0.12초) 마지막 40% 동안 흐려짐
      const grow = Math.min(1, age / 0.12);
      _s.setScalar(d.size * (0.55 + 0.45 * (1 - (1 - grow) * (1 - grow))));
      _m.compose(d.pos, d.quat, _s);
      this.dMesh.setMatrixAt(m, _m);
      this.dFade.setX(m, Math.min(1, d.life / (d.maxLife * 0.4)));
      this.dSeed.setX(m, d.seed);
      m++;
    }
    this.dMesh.count = m;
    if (m > 0) {
      this.dMesh.instanceMatrix.needsUpdate = true;
      this.dFade.needsUpdate = true;
      this.dSeed.needsUpdate = true;
    }

    let r = 0;
    for (const g of this.rings) {
      if (g.life <= 0) continue;
      g.life -= dt;
      if (g.life <= 0) continue;
      _s.setScalar(g.size);
      _m.compose(g.pos, g.quat, _s);
      this.rMesh.setMatrixAt(r, _m);
      this.rProg.setX(r, 1 - g.life / g.maxLife);
      r++;
    }
    this.rMesh.count = r;
    if (r > 0) {
      this.rMesh.instanceMatrix.needsUpdate = true;
      this.rProg.needsUpdate = true;
    }

    let c = 0;
    for (const f of this.confetti) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) continue;
      // 공기저항이 커서 금방 느려지고 팔랑거리며 떨어진다
      f.vel.multiplyScalar(Math.exp(-2.6 * dt));
      f.vel.y -= 3 * dt;
      f.phase += dt * 7;
      f.pos.addScaledVector(f.vel, dt);
      f.pos.x += Math.sin(f.phase) * 0.35 * dt;
      f.pos.z += Math.cos(f.phase * 0.8) * 0.35 * dt;
      f.angle += f.spin * dt;
      _q.setFromAxisAngle(f.axis, f.angle);
      _q2.setFromAxisAngle(_upY, f.phase * 0.5);
      _q.premultiply(_q2);
      const k = f.life / f.maxLife;
      _s.setScalar(0.11 * Math.min(1, k * 4));
      _m.compose(f.pos, _q, _s);
      this.cMesh.setMatrixAt(c, _m);
      this.cMesh.setColorAt(c, f.color);
      c++;
    }
    this.cMesh.count = c;
    if (c > 0) {
      this.cMesh.instanceMatrix.needsUpdate = true;
      if (this.cMesh.instanceColor) this.cMesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.particles.forEach((p) => (p.life = 0));
    this.decals.forEach((d) => (d.life = 0));
    this.rings.forEach((r) => (r.life = 0));
    this.confetti.forEach((c) => (c.life = 0));
    for (const m of this.meshes) m.count = 0;
  }

  /** 씬에서 빼고 GPU 자원 해제 */
  dispose(): void {
    this.clear();
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, size: number, life: number, color?: THREE.Color): Particle {
    const p = this.particles[this.pCursor];
    this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.size = size;
    p.life = p.maxLife = life;
    p.gravity = 14;
    p.foam = true;
    if (color) p.color.copy(color);
    else p.color.copy(WATER_DEEP).lerp(WATER, Math.random());
    return p;
  }

  private decal(pos: THREE.Vector3, normal: THREE.Vector3, size: number, life = 5): void {
    const d = this.decals[this.dCursor];
    this.dCursor = (this.dCursor + 1) % MAX_DECALS;
    d.pos.copy(pos).addScaledVector(normal, 0.015);
    // 법선 둘레로 무작위 회전해 같은 모양이 반복돼 보이지 않게
    d.quat.setFromUnitVectors(_zAxis, normal);
    _q.setFromAxisAngle(_zAxis, Math.random() * Math.PI * 2);
    d.quat.multiply(_q);
    d.size = size;
    d.seed = Math.random();
    d.life = d.maxLife = life;
  }

  private ring(pos: THREE.Vector3, normal: THREE.Vector3, size: number, life: number): void {
    const r = this.rings[this.rCursor];
    this.rCursor = (this.rCursor + 1) % MAX_RINGS;
    r.pos.copy(pos).addScaledVector(normal, 0.03);
    r.quat.setFromUnitVectors(_zAxis, normal);
    r.size = size;
    r.life = r.maxLife = life;
  }
}
