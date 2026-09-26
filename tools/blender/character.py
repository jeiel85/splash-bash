"""Splash Buddy 캐릭터 → public/assets/models/character.glb

실행:
  blender -b --factory-startup --python tools/blender/character.py -- \
      --out public/assets/models/character.glb --preview tools/blender/previews/character.png

노드 트리(규약: docs/ASSETS.md `character.glb`):
  Character (Empty, 원점 = 발바닥 중앙)
  ├─ Body (Tint + 배 패치 TintLight, 원점 = 지면 중앙 → 스쿼시·기울이기 피벗)
  │   ├─ EyeL / EyeR (Eye + Pupil + EyeShine, 원점 = 눈 중심 → 깜빡임 스케일 피벗)
  │   ├─ Mouth (Pupil 머티리얼: 외곽선 없는 진남색 선)
  │   ├─ Cheeks (#FF9CCB)
  │   └─ HatAnchor (정수리)
  ├─ HandL / HandR (흰 주먹 장갑 + 엄지, 원점 = 손 중심)
  │   └─ GunAnchor (HandR 자식, 손 중심에서 앞·아래·살짝 바깥(GUN_OFFSET), 회전 없음 → -Y(정면)로 모델링된 총이 그대로 정면을 향함)
  ├─ FootL / FootR (TintDark, 원점 = 발 중심)
  └─ NameAnchor (z = 2.0)
캐릭터 기준 오른쪽(R) = Blender -X (정면이 -Y 이므로).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: E402,F401
from mathutils import Matrix, Vector  # noqa: E402

import splash_char as sc  # noqa: E402

# ---------------------------------------------------------------- design parameters (m)

EYE_X, EYE_Z = 0.142, 1.218          # 눈 중심(정면 투영 x, 높이)
EYE_SEMI = (0.079, 0.107)            # 흰자 반폭·반높이 (세로 타원)
EYE_SINK, EYE_BULGE = 0.008, 0.022   # 가장자리는 표면 아래로, 가운데는 표면 위로 볼록
PUPIL_SEMI = (0.055, 0.076)
PUPIL_OFF = (-0.004, -0.011)         # 흰자 중심 기준(u 는 코 쪽으로 부호 보정)
SHINE_BIG = ((-0.017, 0.027), (0.0165, 0.019))    # 동공 중심 기준 오프셋, 반지름(월드 기준 같은 쪽 = 광원 방향)
SHINE_SMALL = ((0.019, -0.030), (0.0085, 0.0085))

CHEEK_X, CHEEK_Z = 0.222, 1.078
CHEEK_SEMI = (0.050, 0.030)

MOUTH_Z = 1.068
MOUTH_HALF_W, MOUTH_SAG, MOUTH_R = 0.042, 0.020, 0.0105

BELLY_Z = 0.53
BELLY_SEMI = (0.180, 0.225)          # 얼굴과 시선을 다투지 않도록 몸통 폭의 ≈46%

HAND_POS = (0.43, -0.26, 0.76)       # HandL 기준(HandR 은 x 반전) — 가슴 높이, 몸 앞쪽(바깥 끝 x ≈ 0.53)
HAND_RADII = (0.098, 0.112, 0.118)   # 주먹 장갑(≈0.11–0.13 m 반지름)
THUMB_RADII = (0.036, 0.036, 0.055)  # 엄지: 별도 닫힌 타원체(긴 축 = thumb_dir), 같은 메시 안
THUMB_OUT = 0.092                    # 엄지 중심 = 손 중심 + thumb_dir × THUMB_OUT
THUMB_ROOT_AMP, THUMB_ROOT_W = 0.014, 0.60   # 엄지 뿌리 필렛(주먹 표면의 낮고 넓은 부풂: 진폭 m, 각도 폭 rad)
THUMB_SEGS = 16                      # 엄지 둘레 분할(고리 8개, 둘레 꺾임 22.5°) — 엄지 224 tris, 손 하나 664 tris
HAND_GAP_MIN = 0.02                  # 손과 몸통 사이 최소 틈(떠 있는 손이 몸에 박히지 않게)
# GunAnchor 의 HandR 로컬 위치: 손잡이가 주먹 앞쪽 아래에 오게(총열이 주먹 위·앞으로 드러남).
# x 는 바깥쪽(HandR 은 -X)으로 1.5 cm — 소커 개머리판 안쪽 모서리가 몸통 옆면에 닿지 않게(틈 ≈ 1 cm).
GUN_OFFSET = (-0.015, -0.09, -0.07)

FOOT_POS = (0.155, -0.13, 0.044)     # FootL 기준 — 발끝이 몸 앞으로 8~10 cm 보이게
FOOT_RADII = (0.115, 0.175, 0.085)
FOOT_SPLAY = math.radians(12)

NAME_Z = 2.0


def lens_height(sink, bulge, k=2.0):
    """렌즈 단면: r=0 에서 +bulge, r=1 에서 -sink. k 가 크면 윗면이 평평하고 가장자리가 가파르다."""
    def h(r):
        return -sink + (bulge + sink) * math.sqrt(max(0.0, 1.0 - r ** k))
    return h


def build_materials():
    return {
        "Tint": material("Tint", "#FF6F7D", roughness=0.5),
        "TintDark": material("TintDark", "#B8505A", roughness=0.5),
        "TintLight": material("TintLight", "#FFA3AB", roughness=0.5),
        "Eye": material("Eye", "#FFFFFF", roughness=0.15),
        "Pupil": material("Pupil", "#2B2D42", roughness=0.15),
        "EyeShine": material("EyeShine", "#FFFFFF", roughness=0.1),
        "Cheek": color_mat("#FF9CCB", roughness=0.6),
        "Glove": color_mat("#FFFFFF", roughness=0.5),
    }


def build_body(M, parent):
    buf = sc.MeshBuf()
    v, f = sc.lathe_body(segments=40, rings=28)
    buf.add(v, f, 0)
    # 배 패치: 표면에 붙은 얕은 렌즈(가장자리가 표면 아래로 → 깔끔한 타원 경계, 떠 보이지 않음)
    fr = sc.SurfaceFrame(sc.surface_point_front(0.0, BELLY_Z))
    v, f, flat = sc.lens(fr.point, fr.n, (0.0, 0.0), BELLY_SEMI, lens_height(0.004, 0.010, k=4),
                         back_depth=0.02, segments=28, rings=6)
    buf.add(v, f, 1, flat)
    ob = buf.build("Body", [M["Tint"], M["TintLight"]], origin=(0, 0, 0), parent=parent)
    sc.recalc_outward(ob)
    return ob


def build_eye(M, side, parent):
    """side=+1 → EyeL(+X), -1 → EyeR(-X)."""
    center = sc.surface_point_front(side * EYE_X, EYE_Z)
    fr = sc.SurfaceFrame(center)
    n = fr.n
    a, b = EYE_SEMI
    h_white = lens_height(EYE_SINK, EYE_BULGE)

    def white_surface(u, v):
        r = math.sqrt((u / a) ** 2 + (v / b) ** 2)
        return fr.point(u, v) + n * h_white(min(r, 1.0))

    pu = (PUPIL_OFF[0] * side, PUPIL_OFF[1])  # 동공은 살짝 코 쪽·아래
    pa, pb = PUPIL_SEMI
    h_pupil = lens_height(0.003, 0.0045)

    def pupil_surface(u, v):
        r = math.sqrt(((u - pu[0]) / pa) ** 2 + ((v - pu[1]) / pb) ** 2)
        return white_surface(u, v) + n * h_pupil(min(r, 1.0))

    buf = sc.MeshBuf()
    v, f, flat = sc.lens(fr.point, n, (0, 0), EYE_SEMI, h_white, back_depth=0.03, segments=24, rings=5)
    buf.add(v, f, 0, flat)
    v, f, flat = sc.lens(white_surface, n, pu, PUPIL_SEMI, h_pupil, back_depth=0.012, segments=24, rings=4)
    buf.add(v, f, 1, flat)
    for (off, semi), seg, rings in ((SHINE_BIG, 14, 3), (SHINE_SMALL, 10, 2)):
        c = (pu[0] + off[0], pu[1] + off[1])  # 하이라이트는 두 눈 모두 같은 쪽(광원 방향 일치)
        v, f, flat = sc.lens(pupil_surface, n, c, semi, lens_height(0.002, 0.004), back_depth=0.006,
                             segments=seg, rings=rings)
        buf.add(v, f, 2, flat)
    name = "EyeL" if side > 0 else "EyeR"
    ob = buf.build(name, [M["Eye"], M["Pupil"], M["EyeShine"]], origin=tuple(center), parent=parent)
    sc.recalc_outward(ob)
    return ob


def build_cheeks(M, parent):
    buf = sc.MeshBuf()
    for side in (1, -1):
        fr = sc.SurfaceFrame(sc.surface_point_front(side * CHEEK_X, CHEEK_Z))
        v, f, flat = sc.lens(fr.point, fr.n, (0, 0), CHEEK_SEMI, lens_height(0.003, 0.0045, k=4),
                             back_depth=0.012, segments=20, rings=3, rot=math.radians(-8 * side))
        buf.add(v, f, 0, flat)
    origin = sc.surface_point_front(0.0, CHEEK_Z)
    ob = buf.build("Cheeks", [M["Cheek"]], origin=tuple(origin), parent=parent)
    sc.recalc_outward(ob)
    return ob


def build_mouth(M, parent):
    fr = sc.SurfaceFrame(sc.surface_point_front(0.0, MOUTH_Z))
    pts = []
    n_pts = 13
    for i in range(n_pts):
        u = -MOUTH_HALF_W + 2 * MOUTH_HALF_W * i / (n_pts - 1)
        v = -MOUTH_SAG * (1 - (u / MOUTH_HALF_W) ** 2)  # 가운데가 낮은 U자 미소
        pts.append(fr.point(u, v) - fr.n * 0.004)  # 튜브 반지름의 ≈40% 만 드러남(옆 실루엣에서 혹으로 안 튀어나오게)
    v, f = sc.capsule_sweep(pts, MOUTH_R, ring_segments=8, up_hint=fr.n, cap_steps=3)
    origin = fr.c
    ob = sc.mesh_object("Mouth", v, f, [M["Pupil"]], origin=tuple(origin), parent=parent)
    sc.recalc_outward(ob)
    return ob


def _axis_basis(z_axis: Vector) -> "Matrix":
    """로컬 z 를 z_axis 로 보내는 회전 행렬(3x3). 로컬 x 는 수평에 가깝게."""
    z = z_axis.normalized()
    ref = Vector((0, 0, 1)) if abs(z.z) < 0.9 else Vector((1, 0, 0))
    x = ref.cross(z).normalized()
    y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed()


def build_hand(M, side, parent):
    x, y, z = HAND_POS
    center = Vector((side * x, y, z))
    inner = -side
    thumb_dir = Vector((inner * 0.55, -0.50, 0.67)).normalized()  # 정면에서도 보이도록 위·안쪽

    def deform(d, p):
        # 엄지 뿌리 쪽 주먹이 넓고 낮게 부풀어(폭 넓은 가우스 → 꼭짓점 없음) 엄지가 주먹에서 자라난 듯 이어진다
        root = THUMB_ROOT_AMP * math.exp(-(d.angle(thumb_dir) / THUMB_ROOT_W) ** 2)
        # 손바닥(안쪽)은 살짝 납작
        flat = 0.012 * max(0.0, d.x * inner) ** 2
        return p + d * root - Vector((inner * flat, 0, 0))

    buf = sc.MeshBuf()
    v, f = sc.ellipsoid((0, 0, 0), HAND_RADII, segments=20, rings=12, deform=deform)
    buf.add([(p[0] + center.x, p[1] + center.y, p[2] + center.z) for p in v], f, 0)
    # 엄지: 주먹 위·앞·안쪽에 얹힌 둥근 타원체(끝이 둥글어 어느 각도에서도 뾰족한 꼭짓점이 없다).
    # 긴 타원체를 극각 균등으로 나누면 끝(극점)의 다각형 각이 ≈146° 로 뾰족해지므로,
    # 법선 각이 균등하게 도는 매개변수로 고리를 놓는다 → 모든 고리 사이 꺾임 = 180°/rings.
    ta, tc_len = THUMB_RADII[0], THUMB_RADII[2]

    def thumb_rings(d, p):
        th = math.acos(max(-1.0, min(1.0, d.z)))      # 법선 각(0 = 끝)
        t = math.atan2(ta * math.sin(th), tc_len * math.cos(th))  # 법선 각 → 타원 매개변수
        h = math.hypot(d.x, d.y)
        cx, cy = (d.x / h, d.y / h) if h > 1e-9 else (0.0, 0.0)
        return Vector((ta * math.sin(t) * cx, THUMB_RADII[1] * math.sin(t) * cy, tc_len * math.cos(t)))

    tc = center + thumb_dir * THUMB_OUT
    rot = _axis_basis(thumb_dir)
    v, f = sc.ellipsoid((0, 0, 0), THUMB_RADII, segments=THUMB_SEGS, rings=8, deform=thumb_rings)
    buf.add([tuple(rot @ Vector(p) + tc) for p in v], f, 0)

    gap = min(sc.body_inside(Vector(p)) for p in buf.verts)  # ≈ 몸통 표면까지의 수평 거리
    if gap < HAND_GAP_MIN:
        raise SystemExit(f"hand intersects/touches body: gap={gap:.3f} < {HAND_GAP_MIN}")
    name = "HandL" if side > 0 else "HandR"
    ob = buf.build(name, [M["Glove"]], origin=tuple(center), parent=parent)
    sc.recalc_outward(ob)
    print(f"[hand] {name} gap={gap:.3f} outer_x={max(abs(p[0]) for p in buf.verts):.3f}")
    return ob


def build_foot(M, side, parent):
    x, y, z = FOOT_POS
    center = Vector((side * x, y, z))
    rot = side * FOOT_SPLAY  # 발끝이 바깥으로 살짝 벌어짐
    cr, sr = math.cos(rot), math.sin(rot)

    def deform(d, p):
        q = Vector(p)
        if q.z < 0:
            q.z *= 0.55        # 바닥은 납작(지면에 앉음)
        if q.y < 0:
            q.x *= 1.0 + 0.10 * (-d.y)   # 발끝이 조금 더 통통
            q.z *= 1.0 + 0.08 * (-d.y)
        # z 축 회전(바깥으로 벌림): 정면(-Y)이 바깥(+side X)으로
        return Vector((q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z))

    v, f = sc.ellipsoid((0, 0, 0), FOOT_RADII, segments=18, rings=10, deform=deform)
    v = [(p[0] + center.x, p[1] + center.y, p[2] + center.z) for p in v]
    name = "FootL" if side > 0 else "FootR"
    ob = sc.mesh_object(name, v, f, [M["TintDark"]], origin=tuple(center), parent=parent)
    sc.recalc_outward(ob)
    return ob


def main():
    args = parse_args()
    reset_scene()
    M = build_materials()

    root = empty("Character", (0, 0, 0), size=0.3)
    body = build_body(M, root)
    eye_l = build_eye(M, +1, body)
    eye_r = build_eye(M, -1, body)
    mouth = build_mouth(M, body)
    cheeks = build_cheeks(M, body)
    hand_l = build_hand(M, +1, root)
    hand_r = build_hand(M, -1, root)
    foot_l = build_foot(M, +1, root)
    foot_r = build_foot(M, -1, root)

    empty("HatAnchor", (0, 0, sc.Z_TOP), parent=body, size=0.15)
    # GunAnchor: HandR 자식, 회전 없음(부모 HandR 도 회전 없음) → -Y 로 모델링된 총이 그대로 정면을 향함.
    # 위치는 손 중심에서 앞·아래(주먹 앞쪽 아래가 손잡이를 쥔 모양) — 총열·탱크가 둥근 장갑 위로 드러나게.
    empty("GunAnchor", GUN_OFFSET, parent=hand_r, size=0.15)
    empty("NameAnchor", (0, 0, NAME_Z), parent=root, size=0.15)

    meshes = [body, eye_l, eye_r, mouth, cheeks, hand_l, hand_r, foot_l, foot_r]
    total = 0
    for ob in meshes:
        sc.assert_closed(ob)
        t = sc.tri_count_mesh(ob)
        total += t
        print(f"[tris] {ob.name:8s} {t}")
    print(f"[tris] TOTAL {total}")
    if total > 6000:
        raise SystemExit(f"character tri budget exceeded: {total} > 6000")

    export_glb(args.out, roots=[root])
    if args.preview:
        render_preview(args.preview, target=(0, 0, 0.85), distance=4.2, yaw_deg=-25, pitch_deg=10)


main()
