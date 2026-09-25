import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameAssets } from '../src/render/assets';
import { RenderContext } from '../src/render/renderer';
import { OUTLINE_SCREEN, outlineScreenScale } from '../src/render/toon';
import { MenuStage } from '../src/ui/menuStage';
import { DEFAULT_SETTINGS, type Profile } from '../src/ui/profile';
import type { GameMap } from '../src/world/map';

// 캐릭터 모델(GLB)이 필요 없는 가짜 아바타 — 이 테스트는 카메라·외곽선만 본다
vi.mock('../src/game/avatar', async () => {
  const T = await import('three');
  return {
    Avatar: class {
      root = new T.Group();
      setIdentity(): void {}
      update(): void {}
    },
  };
});

/** WebGL 없이 RenderContext 의 카메라·FOV 부분만(setFov 는 실제 구현을 쓴다) */
function fakeCtx() {
  const ctx = {
    camera: new THREE.PerspectiveCamera(80, 16 / 9, 0.1, 500),
    sun: new THREE.DirectionalLight(),
    scene: new THREE.Scene(),
    followShadow(): void {},
    setFov(fov: number): void {
      RenderContext.prototype.setFov.call(ctx as unknown as RenderContext, fov);
    },
  };
  ctx.sun.position.set(18, 30, 12);
  return ctx;
}

/** 트인 평지: 아래로 2 m 에 바닥, 벽 없음 */
const map = {
  root: new THREE.Group(),
  water: [],
  spawns: [{ pos: new THREE.Vector3(0, 0, 0), yaw: 0 }],
  collision: {
    raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number) {
      if (dir.y > -0.99 || far < 2) return null;
      return { distance: 2, point: origin.clone().setY(origin.y - 2), normal: new THREE.Vector3(0, 1, 0) };
    },
    lineOfSight: () => true,
  },
} as unknown as GameMap;

const profile: Profile = { name: '말랑한펭귄', cosmetics: { color: 0, hat: 'none' }, mode: 'ffa', settings: { ...DEFAULT_SETTINGS } };

describe('메뉴 캐릭터 외곽선 두께(QA: 게임 시야각 설정을 따라 2~4배 두꺼움)', () => {
  let saved: number;
  beforeEach(() => {
    saved = OUTLINE_SCREEN.value;
  });
  afterEach(() => {
    OUTLINE_SCREEN.value = saved;
  });

  function stageWith(gameFov: number, h: number) {
    const ctx = fakeCtx();
    // 앱 시작·설정 변경 때 applySettings 가 게임 FOV 로 맞춰 둔 상태
    ctx.setFov(gameFov);
    const stage = new MenuStage(ctx as unknown as RenderContext, {} as GameAssets, map, profile);
    stage.setFrame({ x: 0, y: 0, h });
    stage.enter();
    return { ctx, stage };
  }

  it('설정 FOV(60°·110°)와 상관없이 메뉴 화각(38°) 기준 두께', () => {
    for (const gameFov of [60, 80, 110]) {
      const { ctx, stage } = stageWith(gameFov, 0.5);
      stage.update(1 / 60);
      expect(ctx.camera.fov).toBeCloseTo(38, 3);
      expect(OUTLINE_SCREEN.value).toBeCloseTo(outlineScreenScale(38), 12);
    }
  });

  it('메뉴에서 시야각 슬라이더를 움직여도 다음 프레임(렌더 전)에 메뉴 두께로 돌아온다', () => {
    const { ctx, stage } = stageWith(80, 0.5);
    stage.update(1 / 60);
    ctx.setFov(110);
    expect(OUTLINE_SCREEN.value).toBeCloseTo(outlineScreenScale(110), 12);
    stage.update(1 / 60);
    expect(OUTLINE_SCREEN.value).toBeCloseTo(outlineScreenScale(38), 12);
  });

  it('칸이 작아 화각을 넓히면 두께 단위도 그 화각을 따른다', () => {
    const { ctx, stage } = stageWith(80, 0.2);
    stage.update(1 / 60);
    expect(ctx.camera.fov).toBeGreaterThan(38);
    expect(OUTLINE_SCREEN.value).toBeCloseTo(outlineScreenScale(ctx.camera.fov), 12);
  });
});
