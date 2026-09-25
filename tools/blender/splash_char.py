"""Splash Buddy(캐릭터)·모자 전용 도메인 헬퍼.

character.py / hats.py / char_with_hat_preview.py 가 공유한다(common.py 는 범용 헬퍼만).

핵심 아이디어
- 몸통은 해석적(analytic) 회전체: 옆 실루엣 프로파일 r(z) 를 수직축으로 돌리고 앞뒤만 D 배로 납작하게.
  → 메시는 호 길이·곡률 기반으로 샘플링해 바로 최종 해상도로 만든다(서브디비전 대신 파라메트릭 매끈함).
- 눈·볼·배·입은 같은 해석적 표면에 "붙는" 렌즈/튜브로 만든다(표면을 레이캐스트 → 곡면을 그대로 따라감).
  렌즈 가장자리는 표면 아래로 살짝 가라앉혀 두어 떠 보이지도, z-fighting 도 없게 한다.
- 모자는 머리 꼭대기 형상(head_top_z)을 알아야 머리에 딱 붙으므로 같은 모듈의 프로파일을 쓴다.
"""
from __future__ import annotations

import math

import bpy
import numpy as np
from mathutils import Vector

# ---------------------------------------------------------------- body shape constants

Z_TOP = 1.60        # 정수리(HatAnchor)
Z_BOTTOM = 0.11     # 몸통 바닥(발 위에 얹힘)
TOP_BASE = 1.33     # 윗 돔이 시작되는 높이
BOT_BASE = 0.36     # 아래 둥근 부분이 시작되는 높이
R_TOP = 0.290       # 윗부분 반지름(x)
R_BOT = 0.390       # 아랫부분 반지름(x) — 아래가 넓은 검드롭/젤리빈(캡슐 반지름 0.4 안)
SIDE_EASE = 2.4     # 옆선 테이퍼 곡선(>1 → 위쪽에서 빨리 넓어지고 배 쪽은 완만)
SIDE_BULGE = 0.012  # 옆선이 직선(알약)처럼 보이지 않도록 살짝 볼록하게
P_TOP = 2.3         # 윗 돔 초타원 지수(>2 → 살짝 눌린 돔)
P_BOT = 2.8         # 아래는 더 납작
DEPTH = 0.92        # 앞뒤(y) 납작 비율(머리·얼굴 높이 SHAPE_Z_MAX 이상은 항상 이 값)

# 옆에서 본 실루엣이 수직 캡슐(알약)로 보이지 않도록 몸통 아래쪽만 앞뒤 비율을 바꾼다.
# 앞(y<0)은 배가 나오고(z≈0.55 에서 +2.5 cm), 뒤(y>0)는 살짝 평평. 얼굴·머리·모자는 영향 없음.
BELLY_BULGE = 0.07  # 앞 깊이 비율 추가량(가우스 최대)
BELLY_CZ = 0.55     # 배가 가장 나오는 높이
BELLY_W = 0.28      # 가우스 폭
BACK_FLAT = 0.02    # 등 깊이 비율 감소량(0.92 → 0.90)
SHAPE_Z_MAX = 0.95  # 이 높이부터는 앞뒤 변형 없음(0.80 부터 부드럽게 사라짐)


def _smoothstep(a: float, b: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def depth_at(z: float, front: bool) -> float:
    """높이 z 에서 앞(front, y<0) 또는 뒤(y>0) 반쪽의 y 납작 비율. 옆(y=0)에서 두 반쪽은 접선이 이어진다."""
    fade = 1.0 - _smoothstep(0.80, SHAPE_Z_MAX, z)
    if front:
        return DEPTH + BELLY_BULGE * math.exp(-((z - BELLY_CZ) / BELLY_W) ** 2) * fade
    return DEPTH - BACK_FLAT * _smoothstep(0.25, 0.45, z) * fade


def _superellipse_quarter(R, H, p, n, top=True):
    """(r, z_offset) 목록. top=True: 축(r=0) → 가장자리(r=R). z_offset 은 기준 높이로부터 +/-."""
    pts = []
    for i in range(n + 1):
        phi = (math.pi / 2) * i / n
        s, c = math.sin(phi), math.cos(phi)
        r = R * (s ** (2.0 / p))
        dz = H * (c ** (2.0 / p))
        pts.append((r, dz if top else -dz))
    return pts


def _resample_polyline(pts: np.ndarray, n: int, curvature_weight: float = 0.0) -> np.ndarray:
    """폴리라인을 호 길이(+곡률 가중) 기준으로 n 개 점으로 재샘플."""
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    if curvature_weight > 0:
        d = np.diff(pts, axis=0)
        ang = np.arctan2(d[:, 1], d[:, 0])
        turn = np.abs(np.diff(np.unwrap(ang)))
        turn = np.concatenate([[0.0], turn, [0.0]])
        t_acc = np.cumsum(turn)
        w = (1 - curvature_weight) * s / s[-1] + curvature_weight * t_acc / max(t_acc[-1], 1e-9)
    else:
        w = s / s[-1]
    targets = np.linspace(0.0, 1.0, n)
    r = np.interp(targets, w, pts[:, 0])
    z = np.interp(targets, w, pts[:, 1])
    return np.stack([r, z], axis=1)


def _build_dense_profile() -> np.ndarray:
    """정수리(r=0) → 바닥(r=0) 순서의 조밀한 (r, z) 프로파일(매끈하게 다듬음)."""
    top = [(r, TOP_BASE + dz) for r, dz in _superellipse_quarter(R_TOP, Z_TOP - TOP_BASE, P_TOP, 200, top=True)]
    side = []
    n_side = 200
    for i in range(1, n_side):
        t = i / n_side
        z = TOP_BASE + (BOT_BASE - TOP_BASE) * t
        r = R_TOP + (R_BOT - R_TOP) * (1.0 - (1.0 - t) ** SIDE_EASE) + SIDE_BULGE * math.sin(math.pi * t)
        side.append((r, z))
    bot = [(r, BOT_BASE + dz) for r, dz in _superellipse_quarter(R_BOT, BOT_BASE - Z_BOTTOM, P_BOT, 200, top=False)]
    bot.reverse()  # 가장자리 → 축
    pts = np.array(top + side + bot, dtype=float)
    pts = _resample_polyline(pts, 1200)
    # 이음매(돔↔옆면)의 기울기 불연속을 라플라시안 평활로 지운다. 양 끝(축 위의 점)은 고정.
    for _ in range(300):
        pts[1:-1] = pts[1:-1] * 0.5 + (pts[:-2] + pts[2:]) * 0.25
    pts[0] = (0.0, Z_TOP)
    pts[-1] = (0.0, Z_BOTTOM)
    return pts


_PROFILE = None


def profile() -> np.ndarray:
    global _PROFILE
    if _PROFILE is None:
        _PROFILE = _build_dense_profile()
    return _PROFILE


def body_radius(z: float) -> float:
    """높이 z 에서의 몸통 x 반지름(프로파일 보간)."""
    p = profile()
    zs = p[::-1, 1]
    rs = p[::-1, 0]
    return float(np.interp(z, zs, rs, left=0.0, right=0.0))


def body_inside(p: Vector) -> float:
    """음수면 몸통 내부."""
    rho = math.sqrt(p.x * p.x + (p.y / depth_at(p.z, p.y < 0)) ** 2)
    if p.z <= Z_BOTTOM or p.z >= Z_TOP:
        return rho + 1.0
    return rho - body_radius(p.z)


def body_normal(p: Vector) -> Vector:
    """해석적 표면 법선(수치 기울기)."""
    e = 1e-4
    g = Vector((
        body_inside(p + Vector((e, 0, 0))) - body_inside(p - Vector((e, 0, 0))),
        body_inside(p + Vector((0, e, 0))) - body_inside(p - Vector((0, e, 0))),
        body_inside(p + Vector((0, 0, e))) - body_inside(p - Vector((0, 0, e))),
    ))
    return g.normalized()


def ray_body(origin: Vector, direction: Vector, max_dist: float = 2.0) -> Vector | None:
    """바깥에서 쏜 광선이 몸통 표면과 처음 만나는 점(행진 + 이분법)."""
    d = direction.normalized()
    step = 0.004
    prev_t = 0.0
    prev_f = body_inside(origin)
    if prev_f < 0:
        return None
    t = step
    while t <= max_dist:
        f = body_inside(origin + d * t)
        if f < 0:
            lo, hi = prev_t, t
            for _ in range(40):
                mid = (lo + hi) * 0.5
                if body_inside(origin + d * mid) < 0:
                    hi = mid
                else:
                    lo = mid
            return origin + d * hi
        prev_t, prev_f = t, f
        t += step
    return None


def surface_point_front(x: float, z: float) -> Vector:
    """정면(-Y) 쪽 표면 점: (x, z) 에서 +Y 방향으로 쏜 광선의 첫 교점."""
    hit = ray_body(Vector((x, -1.0, z)), Vector((0, 1, 0)))
    if hit is None:
        raise ValueError(f"no body surface at x={x} z={z}")
    return hit


def head_top_z(x: float, y: float) -> float:
    """정수리 부근 머리 표면 높이(모자 밑면을 머리에 맞추는 용도). 머리 밖이면 TOP_BASE 이하 값."""
    rho = math.sqrt(x * x + (y / DEPTH) ** 2)
    p = profile()
    top_half = p[p[:, 1] >= (TOP_BASE - 0.25)]  # 정수리 → 옆면 위쪽 (r 증가, z 감소)
    return float(np.interp(rho, top_half[:, 0], top_half[:, 1], right=float(top_half[-1, 1])))


# ---------------------------------------------------------------- tangent frame on the body

class SurfaceFrame:
    """몸통 표면의 한 점 주변 (u, v) 접평면 파라미터. u=오른쪽(+X 쪽), v=위, n=바깥 법선.

    point(u, v) 는 평면 좌표를 법선 반대로 투영해 실제 곡면 위 점을 돌려준다 → 부품이 곡률을 따라간다.
    """

    def __init__(self, center: Vector):
        self.c = center.copy()
        self.n = body_normal(center)
        up = Vector((0, 0, 1))
        self.v = (up - self.n * up.dot(self.n)).normalized()
        self.u = self.v.cross(self.n).normalized()  # 정면 기준 오른쪽(+X)
        if self.u.x < 0:
            self.u = -self.u

    def point(self, u: float, v: float) -> Vector:
        o = self.c + self.u * u + self.v * v + self.n * 0.35
        hit = ray_body(o, -self.n, max_dist=0.8)
        if hit is None:
            raise ValueError("surface frame ray missed the body")
        return hit


# ---------------------------------------------------------------- mesh building

def mesh_object(name, verts, faces, mats, face_mat=None, flat_faces=None, origin=(0, 0, 0), parent=None):
    """pydata 로 메시 오브젝트 생성. verts 는 월드 좌표, origin 이 오브젝트 위치(부모 로컬 = 월드, 부모가 원점 항등일 때)."""
    ox, oy, oz = origin
    local = [(v[0] - ox, v[1] - oy, v[2] - oz) for v in verts]
    me = bpy.data.meshes.new(name)
    me.from_pydata(local, [], faces)
    me.update(calc_edges=True)
    for m in mats:
        me.materials.append(m)
    flat = set(flat_faces or [])
    for i, poly in enumerate(me.polygons):
        poly.use_smooth = i not in flat
        if face_mat is not None:
            poly.material_index = face_mat[i]
    me.validate()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = origin
    if parent is not None:
        ob.parent = parent
    return ob


class MeshBuf:
    """여러 조각을 하나의 메시로 모으는 버퍼(조각마다 머티리얼 인덱스)."""

    def __init__(self):
        self.verts: list[tuple] = []
        self.faces: list[tuple] = []
        self.face_mat: list[int] = []
        self.flat: list[int] = []

    def add(self, verts, faces, mat_index=0, flat_faces=()):
        base = len(self.verts)
        fbase = len(self.faces)
        self.verts.extend(tuple(v) for v in verts)
        for f in faces:
            self.faces.append(tuple(i + base for i in f))
            self.face_mat.append(mat_index)
        self.flat.extend(fbase + i for i in flat_faces)

    def build(self, name, mats, origin=(0, 0, 0), parent=None):
        return mesh_object(name, self.verts, self.faces, mats, self.face_mat, self.flat, origin, parent)


def lathe_body(segments=44, rings=30):
    """몸통 회전체 메시 데이터 (verts, faces). 정수리/바닥은 극점."""
    prof = _resample_polyline(profile(), rings, curvature_weight=0.35)
    verts = [(0.0, 0.0, float(prof[0, 1]))]
    for r, z in prof[1:-1]:
        for j in range(segments):
            a = 2 * math.pi * j / segments
            sa = math.sin(a)
            verts.append((r * math.cos(a), depth_at(z, sa < 0) * r * sa, z))
    verts.append((0.0, 0.0, float(prof[-1, 1])))
    faces = []
    nr = len(prof) - 2
    top, bot = 0, len(verts) - 1

    def vid(i, j):
        return 1 + i * segments + (j % segments)

    for j in range(segments):
        faces.append((top, vid(0, j + 1), vid(0, j)))
    for i in range(nr - 1):
        for j in range(segments):
            faces.append((vid(i, j), vid(i, j + 1), vid(i + 1, j + 1), vid(i + 1, j)))
    for j in range(segments):
        faces.append((bot, vid(nr - 1, j), vid(nr - 1, j + 1)))
    return verts, faces


def lens(frame_point, n_dir: Vector, center_uv, semi, height_fn, back_depth, segments=20, rings=5, rot=0.0,
         shape=None):
    """표면에 붙는 렌즈(닫힌 메시).

    frame_point(u, v) -> 표면 점, n_dir: 오프셋 방향(부품 중심의 표면 법선),
    height_fn(r) -> r∈[0,1] 에서 표면 위 높이(가장자리 r=1 은 음수로 → 표면 아래로 가라앉음),
    back_depth: 뒷면 중심이 표면 아래로 들어가는 깊이.
    shape(t) -> 배율: 방위각 t(0=+u, π/2=+v)별 외곽 반지름 배율(물방울 등 비타원 외곽용, 기본 타원).
    반환: verts, faces, flat_faces(뒷면 — 보이지 않으므로 평면 셰이딩으로 경계 법선 분리)
    """
    cu, cv = center_uv
    a, b = semi
    cr, sr = math.cos(rot), math.sin(rot)
    verts = []
    p0 = frame_point(cu, cv)
    verts.append(tuple(p0 + n_dir * height_fn(0.0)))
    for i in range(1, rings + 1):
        r = math.sin(0.5 * math.pi * i / rings)
        for j in range(segments):
            t = 2 * math.pi * j / segments
            m = shape(t) if shape else 1.0
            lu, lv = a * r * m * math.cos(t), b * r * m * math.sin(t)
            du, dv = lu * cr - lv * sr, lu * sr + lv * cr
            p = frame_point(cu + du, cv + dv)
            verts.append(tuple(p + n_dir * height_fn(r)))
    back = len(verts)
    verts.append(tuple(p0 - n_dir * back_depth))
    faces = []

    def vid(i, j):
        return 1 + (i - 1) * segments + (j % segments)

    for j in range(segments):
        faces.append((0, vid(1, j), vid(1, j + 1)))
    for i in range(1, rings):
        for j in range(segments):
            faces.append((vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)))
    flat = []
    for j in range(segments):
        flat.append(len(faces))
        faces.append((back, vid(rings, j + 1), vid(rings, j)))
    return verts, faces, flat


def ellipsoid(center, radii, segments=24, rings=14, deform=None):
    """UV 타원체 (verts, faces). deform(unit_dir, local_pos) -> local_pos 로 모양 변형 가능."""
    cx, cy, cz = center
    rx, ry, rz = radii
    verts = []
    faces = []
    for i in range(rings + 1):
        th = math.pi * i / rings
        if i in (0, rings):
            ds = [Vector((0, 0, math.cos(th)))]
        else:
            ds = [Vector((math.sin(th) * math.cos(2 * math.pi * j / segments),
                          math.sin(th) * math.sin(2 * math.pi * j / segments),
                          math.cos(th))) for j in range(segments)]
        for d in ds:
            p = Vector((d.x * rx, d.y * ry, d.z * rz))
            if deform:
                p = deform(d, p)
            verts.append((p.x + cx, p.y + cy, p.z + cz))

    def vid(i, j):
        if i == 0:
            return 0
        if i == rings:
            return 1 + (rings - 1) * segments
        return 1 + (i - 1) * segments + (j % segments)

    for j in range(segments):
        faces.append((0, vid(1, j), vid(1, j + 1)))
    for i in range(1, rings - 1):
        for j in range(segments):
            faces.append((vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)))
    for j in range(segments):
        faces.append((vid(rings, 0), vid(rings - 1, j + 1), vid(rings - 1, j)))
    return verts, faces


def capsule_sweep(points, radius, ring_segments=8, up_hint=Vector((0, 0, 1)), cap_steps=3):
    """폴리라인 중심선을 따라가는 둥근 끝 튜브(verts, faces). points: Vector 목록."""
    pts = [Vector(p) for p in points]
    # 누적 길이
    L = [0.0]
    for i in range(1, len(pts)):
        L.append(L[-1] + (pts[i] - pts[i - 1]).length)
    total = L[-1]

    def at(s):
        s = max(0.0, min(total, s))
        for i in range(1, len(pts)):
            if L[i] >= s:
                t = (s - L[i - 1]) / max(L[i] - L[i - 1], 1e-9)
                p = pts[i - 1].lerp(pts[i], t)
                tan = (pts[i] - pts[i - 1]).normalized()
                return p, tan
        return pts[-1], (pts[-1] - pts[-2]).normalized()

    # 샘플 (center, tangent, ring_radius): 양 끝은 중심선 끝점을 중심으로 한 반구(각도 균등), 가운데는 균등 간격
    samples = []
    p0, t0 = at(0.0)
    for k in range(cap_steps + 1):
        ang = (math.pi / 2) * k / cap_steps
        samples.append((p0 - t0 * (radius * math.cos(ang)), t0, radius * math.sin(ang)))
    inner = 6
    for k in range(1, inner):
        s = total * k / inner
        p, tan = at(s)
        # 접선은 앞뒤 평균으로 부드럽게
        pa, _ = at(s - total / inner * 0.5)
        pb, _ = at(s + total / inner * 0.5)
        tan = (pb - pa).normalized()
        samples.append((p, tan, radius))
    p1, t1 = at(total)
    t1 = (pts[-1] - pts[-2]).normalized()
    for k in range(cap_steps, -1, -1):
        ang = (math.pi / 2) * k / cap_steps
        samples.append((p1 + t1 * (radius * math.cos(ang)), t1, radius * math.sin(ang)))

    verts, faces = [], []
    ring_ids = []
    for c, tan, rr in samples:
        if rr < 1e-6:
            ring_ids.append([len(verts)])
            verts.append(tuple(c))
            continue
        side = tan.cross(up_hint).normalized()
        nrm = side.cross(tan).normalized()
        ids = []
        for j in range(ring_segments):
            a = 2 * math.pi * j / ring_segments
            q = c + (nrm * math.cos(a) + side * math.sin(a)) * rr
            ids.append(len(verts))
            verts.append(tuple(q))
        ring_ids.append(ids)
    for i in range(len(ring_ids) - 1):
        A, B = ring_ids[i], ring_ids[i + 1]
        if len(A) == 1:
            for j in range(ring_segments):
                faces.append((A[0], B[(j + 1) % ring_segments], B[j]))
        elif len(B) == 1:
            for j in range(ring_segments):
                faces.append((A[j], A[(j + 1) % ring_segments], B[0]))
        else:
            for j in range(ring_segments):
                faces.append((A[j], A[(j + 1) % ring_segments], B[(j + 1) % ring_segments], B[j]))
    return verts, faces


def tri_count_mesh(ob) -> int:
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def recalc_outward(ob):
    """법선 방향을 바깥으로 통일(닫힌 메시 외곽선용)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


# ---------------------------------------------------------------- head-hugging helpers (hats)
#
# 머리 윗부분 프로파일을 호 길이 s(정수리=0 → 아래로 증가)로 매개화한다.
# 모자는 (θ, s, off) 로 머리 표면을 법선 방향으로 off 만큼 띄운 점을 써서 머리에 딱 맞게 감싼다.
# θ 는 수평 방위각이고 정면(-Y)이 θ = -π/2 이다. y 는 몸통과 같은 DEPTH 로 납작해진다.

FRONT = -math.pi / 2  # 정면 방위각

_HEAD_ARC = None


def _head_arc():
    """(s, rho, z, n_rho, n_z) 배열 — 정수리에서 z≈1.0 까지."""
    global _HEAD_ARC
    if _HEAD_ARC is None:
        p = profile()
        top = p[p[:, 1] >= 1.0]
        d = np.gradient(top, axis=0)
        t = d / np.linalg.norm(d, axis=1, keepdims=True)
        n = np.stack([-t[:, 1], t[:, 0]], axis=1)  # 바깥(위·옆) 법선
        n[0] = (0.0, 1.0)
        seg = np.linalg.norm(np.diff(top, axis=0), axis=1)
        s = np.concatenate([[0.0], np.cumsum(seg)])
        _HEAD_ARC = (s, top[:, 0], top[:, 1], n[:, 0], n[:, 1])
    return _HEAD_ARC


def head_s_at_z(z: float) -> float:
    """머리 표면에서 높이 z 인 지점까지의 정수리부터 호 길이."""
    s, _, zz, _, _ = _head_arc()
    return float(np.interp(z, zz[::-1], s[::-1]))


def head_point(theta: float, s: float, off: float = 0.0) -> Vector:
    """방위각 theta, 정수리부터 호 길이 s 인 머리 표면 점을 법선 방향으로 off 만큼 띄운 점(월드)."""
    ss, rho, z, nr, nz = _head_arc()
    r = float(np.interp(s, ss, rho))
    zz = float(np.interp(s, ss, z))
    a, b = float(np.interp(s, ss, nr)), float(np.interp(s, ss, nz))
    ln = math.hypot(a, b) or 1.0
    rr = max(0.0, r + off * a / ln)
    return Vector((rr * math.cos(theta), DEPTH * rr * math.sin(theta), zz + off * b / ln))


def grid_revolve(point_fn, n_rows: int, segments: int, pole_start=True, pole_end=True):
    """행(row) × 방위(segments) 격자를 둘러 감은 메시 (verts, faces).

    point_fn(k, j) -> Vector: k 번째 행, j 번째 방위 점. 극점 행은 point_fn(k, 0) 한 점만 쓴다.
    양 끝이 극점이면 닫힌 메시가 된다(외곽선용 닫힌 표면).
    """
    verts, rows = [], []
    for k in range(n_rows):
        if (k == 0 and pole_start) or (k == n_rows - 1 and pole_end):
            rows.append([len(verts)])
            verts.append(tuple(point_fn(k, 0)))
            continue
        ids = []
        for j in range(segments):
            ids.append(len(verts))
            verts.append(tuple(point_fn(k, j)))
        rows.append(ids)
    faces = []
    for k in range(n_rows - 1):
        A, B = rows[k], rows[k + 1]
        if len(A) == 1:
            for j in range(segments):
                faces.append((A[0], B[j], B[(j + 1) % segments]))
        elif len(B) == 1:
            for j in range(segments):
                faces.append((A[j], B[0], A[(j + 1) % segments]))
        else:
            for j in range(segments):
                faces.append((A[j], B[j], B[(j + 1) % segments], A[(j + 1) % segments]))
    return verts, faces


def torus_grid(point_fn, n_u: int, n_v: int):
    """양 방향 모두 닫힌(도넛 위상) 격자 메시 (verts, faces). point_fn(i, j) -> Vector."""
    verts = [tuple(point_fn(i, j)) for i in range(n_u) for j in range(n_v)]
    faces = []
    for i in range(n_u):
        for j in range(n_v):
            a = i * n_v + j
            b = ((i + 1) % n_u) * n_v + j
            c = ((i + 1) % n_u) * n_v + (j + 1) % n_v
            d = i * n_v + (j + 1) % n_v
            faces.append((a, b, c, d))
    return verts, faces


def pillow(center, radii, segments=16, rings=10, squareness=0.5, deform=None):
    """초타원체 '베개'(위아래는 평평, 가장자리는 둥근) (verts, faces).

    squareness(ε1<1)가 작을수록 납작한 판에 가깝고 가장자리 둥글기 반지름 ≈ radii.z.
    얇은 판(챙·잎·꽃잎)을 날카로운 렌즈 모서리 없이 만들기 위함. deform(unit_dir, local_pos) 가능.
    """
    e = squareness

    def sq(d, p):
        h = math.hypot(d.x, d.y)
        nh = h ** e if h > 1e-9 else 0.0
        nz = math.copysign(abs(d.z) ** e, d.z)
        q = Vector((radii[0] * nh * (d.x / h) if h > 1e-9 else 0.0,
                    radii[1] * nh * (d.y / h) if h > 1e-9 else 0.0,
                    radii[2] * nz))
        return deform(d, q) if deform else q

    return ellipsoid(center, (1.0, 1.0, 1.0), segments=segments, rings=rings, deform=sq)


class SphereFrame:
    """구 표면 위 한 점 주변 접평면 (u, v) — lens() 에 쓰는 frame_point 대용."""

    def __init__(self, center: Vector, radius: float, direction: Vector, up=Vector((0, 0, 1))):
        self.o = Vector(center)
        self.R = radius
        self.n = Vector(direction).normalized()
        self.c = self.o + self.n * radius
        v = up - self.n * up.dot(self.n)
        if v.length < 1e-6:
            v = Vector((0, 1, 0)) - self.n * self.n.y
        self.v = v.normalized()
        self.u = self.v.cross(self.n).normalized()

    def point(self, u: float, v: float) -> Vector:
        q = self.c + self.u * u + self.v * v - self.o
        return self.o + q.normalized() * self.R


class OffsetFrame:
    """몸통 SurfaceFrame 을 법선 방향으로 off 만큼 띄운 면(모자 겉면 위 장식용)."""

    def __init__(self, center_on_body: Vector, off: float):
        self.f = SurfaceFrame(center_on_body)
        self.off = off
        self.n = self.f.n
        self.c = self.f.c + self.n * off

    def point(self, u: float, v: float) -> Vector:
        p = self.f.point(u, v)
        return p + body_normal(p) * self.off


def assert_closed(ob):
    """외곽선(inverted hull)용으로 모든 메시가 닫혀 있는지(각 모서리에 면 2개) 확인. 아니면 빌드 실패."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bad = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    degenerate = sum(1 for f in bm.faces if f.calc_area() < 1e-12)
    bm.free()
    if bad or degenerate:
        raise SystemExit(f"{ob.name}: not a clean closed mesh (non-manifold edges={bad}, degenerate faces={degenerate})")
