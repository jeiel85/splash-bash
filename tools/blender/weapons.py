"""weapons.glb — 장난감 물총 3종 + 물풍선 (docs/ASSETS.md 'weapons.glb' 규약).

실행:
  blender -b --factory-startup --python tools/blender/weapons.py -- \
      --out public/assets/models/weapons.glb [--preview tools/blender/previews/weapons.png]

노드 트리(모두 씬 루트, 월드 원점·항등 트랜스폼):
  gun_pistol            Empty  원점 = 손잡이 쥐는 점, 정면 = Blender -Y (glTF +Z)
    gun_pistol_Body     Mesh   색 머티리얼(C_xxxxxx) + EyeShine(탱크 반짝임)
    gun_pistol_Tank     Mesh   Water, 원점 = 탱크 바닥 중앙
    gun_pistol_Muzzle   Empty  노즐 끝(발사 위치), 회전 없음 → +Z 가 발사 방향
  gun_soaker            (위와 같음) + gun_soaker_Pump  Mesh 펌프 손잡이(원점 = 손잡이 중심, 앞뒤 슬라이드용)
  gun_bucket            (위와 같음)
  balloon               Mesh   머티리얼 1개(C_FF8AD8), 원점 = 풍선 몸통 중심, 지름 0.22 m, 꼭지는 +Z(glTF +Y)

Muzzle 이름: Blender·glTF 모두 이름이 유일해야 하므로 규약의 `Muzzle` 대신
`<총 이름>_Muzzle` 을 쓴다(런타임은 이름이 Muzzle 로 끝나는 자식을 찾는다 — src/render/assets.ts).

치수: 각 총은 '설계 치수'(아래 build_* 의 숫자)로 만든 뒤 finish_gun() 에서 손잡이 원점 기준
균일 배율(GUN_SCALE)을 형상·Tank/Pump 원점·Muzzle 에 함께 굽는다(노드 트랜스폼은 항등 유지).
캐릭터 장갑(약 0.19 × 0.24 × 0.22 m)에 총이 묻히지 않도록 정한 배율이다.
외곽선(inverted hull)은 메시 크기와 무관한 두께로 그려지므로(런타임 src/render/toon.ts), 부품이 만나는 곳은
겉면을 얕게 스치지 말고 한쪽 부품 속에 충분히(설계 치수 7 mm 이상) 묻어야 이음새에 검은 사선·가시가 생기지 않는다.

풍선: 게임(src/game/game.ts)이 풍선 노드의 첫 번째 Mesh 하나만 투사체로 쓰고, GLTFLoader 는
머티리얼마다 Mesh 를 나누므로 풍선은 머티리얼 1개짜리 메시여야 한다(꼭지도 같은 색).

둥글림: 대부분 회전체(lathe) 프로파일의 원호 필렛으로 만든다(모디파이어 없이 형상 자체가 둥글다).
폴리 예산(총 ≤ 3k, 풍선 ≤ 800 tris): 1인칭에서 카메라에 가장 가까운 부분(몸통 뒤·탱크·띠·개머리판)에
분할을 몰아주고, 다른 부품 속에 묻히는 모서리·지름 1 cm 안팎의 작은 링은 필렛 분할을 1~2로 줄인다.
반짝임(glint)은 외곽선·그림자가 없는 흰색이 필요해 `EyeShine` 머티리얼을 재사용한다(탱크만).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: E402,F401,F403
from weapon_parts import (arc_points, blob, ellipse_profile, lathe, lathe_multi, mesh_tris,  # noqa: E402
                          set_origin, smooth_path, soft_box, tube)

D = math.radians
FWD = (0, -1, 0)   # 총의 정면(Blender -Y = glTF +Z)
BACK = (0, 1, 0)
UPZ = (0, 0, 1)

# 설계 치수 → 게임 치수 배율(손잡이 원점 기준). 캐릭터 장갑 크기에 맞춘 값.
GUN_SCALE = {"gun_pistol": 1.8, "gun_soaker": 1.5, "gun_bucket": 1.6}


def palette():
    return {
        "orange": color_mat("#FFA552", 0.35),
        "yellow": color_mat("#FFD35C", 0.35),
        "coral": color_mat("#FF7B7B", 0.35),
        "teal": color_mat("#2EC4B6", 0.35),
        "teal_dark": color_mat("#1E9E93", 0.35),
        "pink": color_mat("#FF9CCB", 0.35),
        "pink_deep": color_mat("#E86FAE", 0.35),
        "lavender": color_mat("#B9A6FF", 0.35),
        "balloon": color_mat("#FF8AD8", 0.2),
        "water": material("Water", "#4FD1E8", roughness=0.05, alpha=0.6),
        "shine": material("EyeShine", "#FFFFFF", roughness=0.2),
    }


def finish_gun(root, body_parts, tank, tank_bottom, muzzle_loc, extra=()):
    """설계 치수 부품에 GUN_SCALE 을 굽고, 합쳐서 `<root>_Body` 로 만든 뒤 Tank/Muzzle/추가 메시를 붙인다.

    extra: [(메시, 설계 치수 원점), ...] — 별도 노드로 남길 부품(예: 펌프).
    """
    name = root.name
    k = GUN_SCALE[name]
    S = Matrix.Scale(k, 4)
    for o in [*body_parts, tank, *(e for e, _ in extra)]:
        o.data.transform(S)
    breakdown = sorted(((mesh_tris(o), o.name) for o in body_parts), reverse=True)
    print(f"[weapons] {name} parts: " + ", ".join(f"{n}={t}" for t, n in breakdown))
    body = join(body_parts, f"{name}_Body")
    body.parent = root
    tank.name = tank.data.name = f"{name}_Tank"
    set_origin(tank, Vector(tank_bottom) * k)
    tank.parent = root
    for o, org in extra:
        set_origin(o, Vector(org) * k)
        o.parent = root
    empty(f"{name}_Muzzle", loc=Vector(muzzle_loc) * k, parent=root, size=0.03)
    return root


def trigger_and_guard(prefix, *, trig_mat, guard_mat, scale=1.0, body_z=0.05, trig_sides=8, trig_per_seg=2):
    """방아쇠(앞으로 휜 손가락 걸이)와 방아쇠울(몸통 아래 → 손잡이 앞 고리).

    가늘어서(반지름 7~9 mm) 단면 6~8각이면 게임 거리에서 충분히 둥글다.
    두 부품의 윗끝은 몸통 밑면보다 외곽선 두께 이상 깊이 묻는다(이음새 검은 틈 방지).
    방아쇠는 게임에서 장갑 속에 묻히므로 폴리 예산이 빠듯한 총은 단면·경로 분할(trig_sides/trig_per_seg)을 줄인다.
    """
    s = scale
    trig = tube(f"{prefix}_trigger",
                smooth_path([(0, -0.027 * s, body_z + 0.01), (0, -0.034 * s, 0.030 * s), (0, -0.032 * s, 0.014 * s),
                             (0, -0.024 * s, 0.004 * s)], trig_per_seg),
                0.0085 * s, trig_mat, sides=trig_sides, squash=(1.15, 1.0))
    guard = tube(f"{prefix}_guard",
                 smooth_path([(0, -0.078 * s, body_z + 0.02), (0, -0.078 * s, 0.022 * s),
                              (0, -0.068 * s, 0.0), (0, -0.048 * s, -0.012 * s),
                              (0, -0.024 * s, -0.015 * s), (0, 0.0, -0.012 * s)], 2),
                 0.0068 * s, guard_mat, sides=6, squash=(1.35, 1.0))
    return [trig, guard]


# ---------------------------------------------------------------- 퐁퐁 권총

def build_pistol(M):
    root = empty("gun_pistol", size=0.05)
    az = 0.078          # 몸통 축 높이
    parts = []
    # 콩 모양 몸통(옆으로 살짝 눌린 캡슐, 앞이 조금 가늘다). 1인칭에서 가장 가까운 면이라 둘레 28분할
    parts.append(lathe("p_body", [(0, -0.095), (0.036, -0.095, 0.034), (0.038, -0.01, 0.08),
                                  (0.029, 0.105, 0.022), (0, 0.105)],
                       M["orange"], origin=(0, 0, az), axis=FWD, segments=28, steps=4, squash=(0.8, 1.0)))
    # 노즐: 노란 칼라 + 산호색 노즐(끝이 둥근 전구 모양). 칼라에 묻히는 노즐 뿌리 모서리는 분할 1
    parts.append(lathe("p_collar", [(0.017, 0.088), (0.029, 0.088), (0.029, 0.113), (0.017, 0.113)],
                       M["yellow"], origin=(0, 0, az), axis=FWD, segments=18, closed=True, radius=0.008, steps=1))
    parts.append(lathe("p_nozzle", [(0, 0.095), (0.017, 0.095, 0.004, 1), (0.0135, 0.148, 0.012),
                                    (0.0165, 0.163, 0.007), (0.0135, 0.18, 0.007), (0, 0.18)],
                       M["coral"], origin=(0, 0, az), axis=FWD, segments=14, steps=2))
    # 손잡이(뒤로 16° 기울어짐, 밑단이 살짝 퍼짐). 손잡이·방아쇠는 게임에서 장갑 속에 거의 다 묻히므로
    # 분할을 줄이고, 그 예산을 1인칭에서 가장 크게 보이는 탱크·받침 링(24분할)에 쓴다
    parts.append(soft_box("p_grip", (0.044, 0.054, 0.13), M["yellow"], loc=(0, 0.014, 0.0),
                          rot=(D(16), 0, 0), radius=0.021, segments=2, top=(0.92, 0.88)))
    parts += trigger_and_guard("p", trig_mat=M["coral"], guard_mat=M["yellow"], body_z=0.05, trig_sides=6)
    # 물방울 탱크(윗면 뒤쪽) + 노란 받침 링 + 주입구 뚜껑.
    # 받침 링은 몸통(반폭 0.030)과 그 외곽선보다 넓고(0.046), 아래 둥근 모서리를 몸통 속(0.094)에 묻는다
    # → 링 옆으로 몸통 외곽선이 삐져나오지 않는다.
    tc = (0, 0.03, 0.146)
    tr = 0.034
    tank = lathe("p_tank", [(0, -tr), (tr, -tr, tr), (tr, tr, tr), (0, tr)], M["water"],
                 origin=tc, axis=UPZ, segments=24, steps=4)
    # 안쪽 아래 모서리는 몸통 속(뾰족), 안쪽 위 모서리는 탱크 속(분할 1)
    parts.append(lathe("p_tank_ring", [(0.024, 0.094, 0.0), (0.046, 0.094, 0.007, 2), (0.046, 0.132, 0.007, 2),
                                       (0.024, 0.132, 0.007, 1)],
                       M["yellow"], origin=(0, tc[1], 0), axis=UPZ, segments=24, closed=True))
    # 뚜껑: 외곽선보다 확실히 굵게(반지름 15 mm) — 가늘면 검은 구슬처럼 보인다. 아랫단은 탱크 속에 묻는다
    parts.append(lathe("p_tank_cap", [(0, 0.170), (0.015, 0.170, 0.004, 1), (0.015, 0.194, 0.007, 2), (0, 0.194)],
                       M["yellow"], origin=(0, tc[1], 0), axis=UPZ, segments=14))
    gl = Vector((-0.55, -0.35, 0.76)).normalized()
    parts.append(blob("p_glint", Vector(tc) + gl * (tr + 0.0012), (0.0095, 0.0055, 0.0015), M["shine"],
                      normal=gl, up=(0, 0, 1), segs=8, rings=4))
    parts += pressure_dial(M, az)
    return finish_gun(root, parts, tank, (0, tc[1], tc[2] - tr), (0, -0.18, az))


def pressure_dial(M, az):
    """권총 뒤 둥근 면(1인칭에서 플레이어가 보는 면)의 노란 압력계 + 산호색 바늘.

    뒤 돔은 필렛 원호(중심 r=0.002, t=-0.061, 반경 0.034)를 돌린 면이므로 그 위의 점·법선을 직접 구한다.
    다이얼 뒤쪽은 돔 곡률(가장자리에서 약 6 mm 처짐)보다 깊게(12 mm) 묻어 뜨지 않게 한다.
    """
    phi = D(22)                                  # 축(뒤쪽)에서 위로 22° — 1인칭 카메라 방향과 거의 정면
    n = Vector((0, math.cos(phi), math.sin(phi)))
    p0 = Vector((0, 0.061 + 0.034 * math.cos(phi), az + 0.002 + 0.034 * math.sin(phi)))
    dial = lathe("p_dial", [(0, -0.012), (0.016, -0.012), (0.016, 0.003, 0.0035, 2), (0, 0.0045)],
                 M["yellow"], origin=p0, axis=n, segments=14)
    # 바늘: 뒤에서 볼 때 2시 방향(뒤에서 본 오른쪽 = -X). 면에 살짝 묻히도록 끝을 낮춘다
    up = Vector((0, -math.sin(phi), math.cos(phi)))
    d = (up * math.cos(D(55)) + Vector((-1, 0, 0)) * math.sin(D(55))).normalized()
    needle = tube("p_needle", [p0 + n * 0.0062, p0 + n * 0.0052 + d * 0.0105], 0.0022, M["coral"], sides=6)
    hub = blob("p_hub", p0 + n * 0.0052, (0.0034, 0.0034, 0.0022), M["coral"], normal=n, up=up, segs=8, rings=4)
    return [dial, needle, hub]


# ---------------------------------------------------------------- 슈퍼 소커

def build_soaker(M):
    root = empty("gun_soaker", size=0.08)
    bz = 0.12           # 총열 축 높이(통통한 총열 뒤끝이 몸통 윗면 밖으로 튀어나오지 않는 높이)
    rz = 0.055          # 펌프 봉 축 높이(펌프 윗면이 총열 밑면에 닿지 않게)
    parts = []
    # 몸통 앞면은 통통한 총열(반지름 0.033)보다 폭·높이 모두 3 mm 이상 크게(총열 외곽선이 몸통 겉면을 뚫지 않게)
    parts.append(soft_box("s_recv", (0.076, 0.30, 0.10), M["teal"], loc=(0, -0.05, 0.108),
                          radius=0.034, segments=3, front=(0.95, 0.95)))
    # 개머리판: 1인칭에서 카메라에 가장 가까운 면이라 모서리 분할 5
    parts.append(soft_box("s_stock", (0.064, 0.17, 0.115), M["yellow"], loc=(0, 0.15, 0.085),
                          rot=(D(-10), 0, 0), radius=0.03, segments=5))
    # 손잡이는 게임에서 장갑 속에 거의 다 묻히므로 모서리 분할 2(예산을 개머리판·탱크로 돌린다)
    parts.append(soft_box("s_grip", (0.048, 0.058, 0.15), M["teal"], loc=(0, 0.012, 0.0),
                          rot=(D(17), 0, 0), radius=0.022, segments=2, top=(0.92, 0.88)))
    parts += trigger_and_guard("s", trig_mat=M["orange"], guard_mat=M["teal"], scale=1.1, body_z=0.066,
                               trig_sides=6, trig_per_seg=1)
    # 통통한 총열: 뒤끝은 몸통 속, 앞끝은 칼라 속이라 양 끝 모서리는 뾰족하게 둔다.
    # 몸통 속 뿌리는 가늘게(0.026) 시작해 몸통 앞 모서리가 꺾이는 곳(t≈0.17)에서 제 굵기가 된다
    parts.append(lathe("s_barrel", [(0, 0.15), (0.026, 0.15), (0.033, 0.172), (0.033, 0.40), (0, 0.40)],
                       M["teal"], origin=(0, 0, bz), axis=FWD, segments=14))
    # 노란 칼라(1인칭에서 보이는 뒷면 모서리만 분할 2) + 주황 노즐(작아서 10분할)
    parts.append(lathe("s_collar", [(0, 0.372), (0.042, 0.372, 0.009, 2), (0.042, 0.396, 0.009, 1), (0, 0.402)],
                       M["yellow"], origin=(0, 0, bz), axis=FWD, segments=14))
    parts.append(lathe("s_tip", [(0, 0.395), (0.021, 0.395), (0.02, 0.417, 0.01, 1), (0.025, 0.438, 0.009, 2),
                                 (0.009, 0.447), (0.0065, 0.437), (0, 0.437)],
                       M["orange"], origin=(0, 0, bz), axis=FWD, segments=10))
    # 펌프 실린더(몸통 앞 밑에 박힌 굵은 부분) → 가는 봉 → 앞 기둥.
    # 봉이 몸통 밑면을 얕게 스치면 외곽선이 봉 위에 사선으로 그어지므로, 굵은 실린더를 몸통에
    # 깊이(설계 치수 11 mm) 박고 봉은 실린더 앞면에서 수직으로 나오게 한다.
    parts.append(lathe("s_rodmount", [(0, 0.12), (0.017, 0.12, 0.012, 2), (0.017, 0.19, 0.005, 1), (0, 0.19)],
                       M["teal_dark"], origin=(0, 0, rz), axis=FWD, segments=8))
    parts.append(lathe("s_rod", [(0, 0.18), (0.011, 0.18), (0.011, 0.35), (0, 0.35)],
                       M["teal_dark"], origin=(0, 0, rz), axis=FWD, segments=6))
    z0, z1 = rz - 0.02, bz + 0.01
    ph = (z1 - z0) / 2
    parts.append(lathe("s_post", [(0, -ph), (0.016, -ph, 0.016, 2), (0.016, ph, 0.016, 2), (0, ph)],
                       M["teal"], origin=(0, -0.345, (z0 + z1) / 2), axis=UPZ, segments=8, squash=(1.0, 0.95)))
    # 큰 캡슐 물탱크 + 노란 띠 2개(아래쪽이 몸통에 박혀 받침 역할) + 뒤쪽 주황 병뚜껑.
    # 띠 단면: 바깥 둥근 4면 + 탱크 속에 묻히는 안쪽 1면(5점) — 탱크와 같은 24분할이라 면이 뚫고 나오지 않는다
    tz, tr = 0.222, 0.06
    tank = lathe("s_tank", [(0, -0.135), (tr, -0.135, tr), (tr, 0.12, tr), (0, 0.12)], M["water"],
                 origin=(0, 0, tz), axis=FWD, segments=24, steps=6)
    for i, t0 in enumerate((-0.073, 0.062)):
        strap = [(tr - 0.0025, t0 - 0.012), (tr + 0.0035, t0 - 0.0105), (tr + 0.0072, t0),
                 (tr + 0.0035, t0 + 0.0105), (tr - 0.0025, t0 + 0.012)]
        parts.append(lathe(f"s_strap{i}", strap, M["yellow"], origin=(0, 0, tz), axis=FWD, segments=24,
                           closed=True))
    # 뒤 끝 병뚜껑: 뒤에서 띠가 물 너머로 동심원처럼 비쳐 쌍안경처럼 보이던 것을 '물병'으로 읽히게 한다.
    # 뒤 반구(중심 y=0.075, 반경 0.06)는 r=0.02 에서 y=0.1316 → 뚜껑 앞단(0.126)이 표면 속에 묻힌다.
    # 병뚜껑이 주입구 역할을 하므로 윗면 주입구는 두지 않는다(뚜껑 두 개가 시선을 나눈다).
    parts.append(lathe("s_bottlecap", [(0, 0.126), (0.02, 0.126), (0.02, 0.15, 0.007, 2), (0, 0.15)],
                       M["orange"], origin=(0, 0, tz), axis=BACK, segments=12))
    gl = Vector((-0.62, 0, 0.78)).normalized()
    parts.append(blob("s_glint", Vector((0, -0.01, tz)) + gl * (tr + 0.0012), (0.05, 0.0075, 0.0015),
                      M["shine"], normal=gl, up=(0, 1, 0), segs=8, rings=4))
    # 펌프 손잡이(별도 노드) — 홈 2줄(홈 바닥은 뾰족한 V, 스무스 셰이딩으로 부드럽게 보임)
    pump = lathe("gun_soaker_Pump",
                 [(0, 0.225), (0.029, 0.225, 0.01, 1), (0.03, 0.252), (0.025, 0.259), (0.03, 0.266),
                  (0.03, 0.284), (0.025, 0.291), (0.03, 0.298), (0.029, 0.325, 0.01, 1), (0, 0.325)],
                 M["orange"], origin=(0, 0, rz), axis=FWD, segments=12)
    return finish_gun(root, parts, tank, (0, 0.0075, tz - tr), (0, -0.446, bz),
                      extra=[(pump, (0, -0.275, rz))])


# ---------------------------------------------------------------- 양동이 블래스터

def build_bucket(M):
    root = empty("gun_bucket", size=0.07)
    bz = 0.105
    parts = []
    # 통통한 달걀 몸통(앞 극점은 나팔 속). 1인칭에서 명암 경계가 계단지지 않게 둘레 28분할
    parts.append(lathe("b_body", [(0, -0.145), (0.056, -0.145, 0.055, 4), (0.066, -0.02, 0.08, 4),
                                  (0.05, 0.1, 0.03, 1), (0, 0.1)],
                       M["lavender"], origin=(0, 0, bz), axis=FWD, segments=28, squash=(0.92, 1.0)))
    # 손잡이·방아쇠는 게임에서 장갑 속에 거의 다 묻히므로 분할을 줄인다
    parts.append(soft_box("b_grip", (0.048, 0.058, 0.15), M["pink"], loc=(0, 0.012, 0.0),
                          rot=(D(16), 0, 0), radius=0.022, segments=2, top=(0.92, 0.88)))
    parts += trigger_and_guard("b", trig_mat=M["yellow"], guard_mat=M["lavender"], scale=1.05, body_z=0.055,
                               trig_sides=6)
    # 나팔 총열: 바깥 분홍 → 입구에서 안쪽 진분홍으로 되돌아와 바닥.
    # 몸통 속 뿌리·노란 입술 속 모서리는 분할을 줄이고 보이는 곡면에만 분할을 쓴다.
    outer = [(0, 0.05), (0.043, 0.05), (0.041, 0.22, 0.06, 3), (0.058, 0.32, 0.08, 3), (0.1, 0.395, 0.02, 1),
             (0.101, 0.405)]
    inner = [(0.101, 0.405), (0.086, 0.402), (0.05, 0.352, 0.03, 1), (0.03, 0.337, 0.01, 1), (0.021, 0.337)]
    dome = [(0.021, 0.337), (0.02, 0.347, 0.009, 1), (0, 0.351)]      # 나팔 바닥의 노란 산탄 노즐 돔
    parts.append(lathe_multi("b_bell", [(outer, M["pink"]), (inner, M["pink_deep"]), (dome, M["yellow"])],
                             origin=(0, 0, bz), axis=FWD, segments=20))
    # 노란 입술(나팔 테두리)
    parts.append(lathe("b_lip", ellipse_profile(0.094, 0.405, 0.012, 0.011, 6), M["yellow"],
                       origin=(0, 0, bz), axis=FWD, segments=20, closed=True))
    # 나팔-몸통 이음새 칼라: 몸통(28분할)과 나팔(20분할)이 만나는 선(t≈0.088~0.092)이 지그재그로
    # 보이던 것을 폭 12 mm 노란 링으로 덮는다(권총 칼라처럼 색 흐름도 이어 준다)
    # 단면은 바깥 둥근 4면 + 나팔 속에 묻히는 안쪽 1면(5점)
    parts.append(lathe("b_collar", [(0.040, 0.0835), (0.0475, 0.0845), (0.0515, 0.09), (0.0475, 0.0955),
                                    (0.040, 0.0965)], M["yellow"],
                       origin=(0, 0, bz), axis=FWD, segments=20, closed=True))
    # 양동이 물탱크(윗면, 위가 넓은 양동이 꼴) + 노란 테·손잡이.
    # 3인칭에서 '양동이'로 읽히도록 크게(바닥 0.048 → 윗면 0.062, 높이 0.085), 테·손잡이도 굵게.
    by, b0, bh = 0.03, 0.146, 0.085
    rb, rt = 0.048, 0.062
    top = b0 + bh
    tank = lathe("b_tank", [(0, b0), (rb, b0, 0.008, 1), (rt, top, 0.006, 1), (0, top)], M["water"],
                 origin=(0, by, 0), axis=UPZ, segments=20)
    parts.append(lathe("b_rim", ellipse_profile(rt - 0.0005, top - 0.003, 0.009, 0.009, 6), M["yellow"],
                       origin=(0, by, 0), axis=UPZ, segments=20, closed=True))
    hz = top - 0.012
    tilt = D(15)        # 손잡이를 살짝 뒤로 눕힌 아치: 1인칭(뒤)에서 ∩ 모양으로 보여 양동이로 읽힌다
    handle = arc_points((0, by, hz), 0.066, 0, 180, 10, u=(1, 0, 0), v=(0, math.sin(tilt), math.cos(tilt)))
    parts.append(tube("b_handle", handle, 0.008, M["yellow"], sides=6))
    # 반짝임: 벌어진 옆면(기울기 atan(0.014/0.085))에 붙도록 법선을 아래로 기울인다
    flare = math.atan2(rt - rb, bh)
    gd = Vector((-0.62, -0.78, 0)).normalized()
    gn = (gd * math.cos(flare) + Vector((0, 0, -math.sin(flare)))).normalized()
    gh = 0.045
    gr = rb + (rt - rb) * gh / bh
    parts.append(blob("b_glint", Vector((0, by, b0 + gh)) + gd * (gr + 0.0012), (0.022, 0.007, 0.0015),
                      M["shine"], normal=gn, up=(0, 0, 1), segs=8, rings=4))
    return finish_gun(root, parts, tank, (0, by, b0), (0, -0.41, bz))


# ---------------------------------------------------------------- 물풍선

def build_balloon(M):
    """머티리얼 1개(C_FF8AD8)짜리 단일 메시 — 게임은 풍선 노드의 첫 Mesh 만 투사체로 쓴다."""
    R = 0.11
    prof = []
    n = 15
    for i in range(n + 1):
        th = math.pi * i / n
        x, z = R * math.sin(th), -R * math.cos(th)
        if z > 0:                       # 위쪽을 꼭지로 모아 물방울 모양
            k = z / R
            x *= 1 - 0.38 * k ** 1.6
            z *= 1 + 0.12 * k
        prof.append((x, z))
    body = lathe("balloon_body", prof, M["balloon"], axis=UPZ, segments=24)
    top = prof[-1][1]
    # 꼭지: 잘록한 목 → 도톰하게 말린 입구(몸통과 같은 머티리얼)
    knot = lathe("balloon_knot", [(0, top - 0.012), (0.011, top - 0.008, 0.004, 1), (0.007, top + 0.008, 0.004, 1),
                                  (0.014, top + 0.024, 0.005, 2), (0, top + 0.03)],
                 M["balloon"], axis=UPZ, segments=8)
    return join([body, knot], "balloon")


# ---------------------------------------------------------------- main

def main():
    args = parse_args()
    reset_scene()
    M = palette()
    roots = [build_pistol(M), build_soaker(M), build_bucket(M), build_balloon(M)]

    for r in roots:
        meshes = [r] if r.type == "MESH" else []
        meshes += [c for c in r.children_recursive if c.type == "MESH"]
        tris = sum(mesh_tris(o) for o in meshes)
        kids = ", ".join(f"{c.name}({c.type[0]})" for c in r.children)
        print(f"[weapons] {r.name}: tris={tris}  children=[{kids}]")

    export_glb(args.out, roots=roots)

    if args.preview:
        for r, x in zip(roots, (-0.75, -0.15, 0.6, -1.25)):
            r.location.x = x
        render_preview(args.preview, target=(0.2, 0, 0.15), distance=3.0, yaw_deg=-60, pitch_deg=15)


main()
