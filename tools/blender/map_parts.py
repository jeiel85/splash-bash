"""map_backyard.glb 전용 모델링 헬퍼 (Blender 4.5).

맵은 소품이 수백 개라 bpy.ops 로 오브젝트를 하나씩 만들면 느리고 드로우콜도 늘어난다.
그래서 모든 형상을 bmesh 로 만든 뒤 `Builder` 가 (충돌 종류, 머티리얼) 버킷별로
정점·면 목록에 바로 누적하고, 마지막에 버킷당 메시 오브젝트 1개로 만든다
→ 드로우콜 ≈ 버킷 수, 이름 규칙(nocol_/water_/col_)은 버킷 종류가 보장한다.

좌표: 모든 함수는 **Blender 좌표(Z-up)** 를 받는다. 게임(Three.js, Y-up) 좌표 (x, y, z) 는
Blender (x, -z, y) 이므로 레이아웃은 `G(x, z, y)` 로 변환해서 넘긴다.
형상 생성 함수(bm_*)는 로컬 좌표(원점 기준) bmesh 를 돌려주고, `Builder.add` 에
`at(...)` 로 만든 변환 행렬을 넘겨 배치한다.

둥글림: 박스는 bmesh bevel, 회전체는 필렛 프로파일(lathe), 튜브는 반구형 끝.
노멀: 버킷 오브젝트마다 Weighted Normal(면적 가중) 모디파이어를 달아 큰 평면은 평평하게,
베벨·곡면은 부드럽게 보이게 한다(export_apply 로 내보낼 때 적용).
"""
from __future__ import annotations

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from common import color_mat, link, material

TAU = math.tau


# ---------------------------------------------------------------- 좌표

def G(x: float, z: float, y: float = 0.0) -> Vector:
    """게임 좌표(x 동쪽, z 남쪽(+z = 북쪽 스케매틱 위), y 위) → Blender 좌표."""
    return Vector((x, -z, y))


def at(x: float, z: float, y: float = 0.0, rot: float = 0.0) -> Matrix:
    """게임 좌표 위치 + Blender Z축 회전(도) 변환 행렬."""
    return Matrix.Translation(G(x, z, y)) @ Matrix.Rotation(math.radians(rot), 4, "Z")


def rot_x(deg: float) -> Matrix:
    return Matrix.Rotation(math.radians(deg), 4, "X")


def rot_y(deg: float) -> Matrix:
    return Matrix.Rotation(math.radians(deg), 4, "Y")


def rot_z(deg: float) -> Matrix:
    return Matrix.Rotation(math.radians(deg), 4, "Z")


def tr(x: float, y: float, z: float) -> Matrix:
    """Blender 좌표 이동 행렬."""
    return Matrix.Translation(Vector((x, y, z)))


# ---------------------------------------------------------------- 버킷 빌더

KIND_PREFIX = {"solid": "", "nocol": "nocol_", "water": "water_", "col": "col_"}


class Builder:
    """(오브젝트 이름, 머티리얼) 버킷에 형상을 누적한다."""

    def __init__(self):
        # key -> {"verts": [...], "faces": [...], "kind": str, "mat": str}
        self.buckets: dict[tuple[str, str], dict] = {}

    def _bucket(self, kind: str, mat: str, obj: str | None):
        if obj is None:
            if kind == "col":
                obj = "col_helper"
            else:
                obj = f"{KIND_PREFIX[kind]}{'m' if kind == 'solid' else 'd'}_{mat_key(mat)}"
        key = (obj, mat)
        b = self.buckets.get(key)
        if b is None:
            b = {"verts": [], "faces": [], "kind": kind, "mat": mat, "obj": obj}
            self.buckets[key] = b
        return b

    def add(self, bm: bmesh.types.BMesh, mat, mtx: Matrix | None = None, kind: str = "solid", obj: str | None = None):
        """bmesh 를 변환해 버킷에 넣고 bm 을 해제한다.

        mat 이 callable 이면 면마다 mat(로컬 면 중심, 로컬 면 노멀) → 머티리얼 키를 받는다(줄무늬 등).
        """
        bm.normal_update()
        if callable(mat):
            # 머티리얼은 변환 전(로컬 좌표)에서 고른다 → 회전된 소품도 같은 규칙으로 줄무늬가 난다
            groups: dict[str, list] = {}
            for f in bm.faces:
                groups.setdefault(mat(f.calc_center_median(), f.normal), []).append(f)
        else:
            groups = {mat: list(bm.faces)}
        if mtx is not None:
            bmesh.ops.transform(bm, matrix=mtx, verts=bm.verts)
        bm.verts.index_update()
        for m, faces in groups.items():
            b = self._bucket(kind, m, obj)
            remap: dict[int, int] = {}
            verts = b["verts"]
            for f in faces:
                idx = []
                for v in f.verts:
                    j = remap.get(v.index)
                    if j is None:
                        j = len(verts)
                        verts.append(v.co.copy())
                        remap[v.index] = j
                    idx.append(j)
                b["faces"].append(idx)
        bm.free()

    def tris(self, kinds=None) -> int:
        n = 0
        for b in self.buckets.values():
            if kinds and b["kind"] not in kinds:
                continue
            n += sum(len(f) - 2 for f in b["faces"])
        return n

    def finish(self, parent) -> list:
        """버킷마다 메시 오브젝트를 만든다(이름 순서 고정 → 결정적 출력)."""
        objs = []
        for key in sorted(self.buckets):
            b = self.buckets[key]
            if not b["faces"]:
                continue
            name = b["obj"]
            me = bpy.data.meshes.new(name)
            me.from_pydata([tuple(v) for v in b["verts"]], [], b["faces"])
            me.validate(clean_customdata=False)
            me.update()
            for p in me.polygons:
                p.use_smooth = True
            me.materials.append(resolve_mat(b["mat"]))
            ob = bpy.data.objects.new(name, me)
            link(ob, parent)
            if b["mat"] not in ("Invisible", "Water"):
                wn = ob.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
                wn.mode = "FACE_AREA"
                wn.weight = 100
                wn.thresh = 1.0
                wn.keep_sharp = True
            objs.append(ob)
        return objs


def mat_key(mat: str) -> str:
    return mat.lstrip("#").upper()


def resolve_mat(mat: str):
    if mat == "Water":
        return material("Water", "#4FD1E8", roughness=0.05, alpha=0.7)
    if mat == "Invisible":
        return material("Invisible", "#FF00FF", roughness=1.0)
    return color_mat(mat, 0.6)


# ---------------------------------------------------------------- 2D 프로파일

def fillet(pts, radius: float = 0.0, steps: int = 3):
    """(x, y[, r]) 폴리라인의 내부 꼭짓점을 원호로 둥글린다. r(점별)이 0 이면 뾰족하게 둔다."""
    out = [Vector(pts[0][:2])]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = Vector(pts[i - 1][:2]), Vector(pts[i][:2]), Vector(pts[i + 1][:2])
        rr = pts[i][2] if len(pts[i]) > 2 else radius
        if rr <= 0:
            out.append(p1)
            continue
        d1 = p0 - p1
        d2 = p2 - p1
        l1, l2 = d1.length, d2.length
        if l1 < 1e-9 or l2 < 1e-9:
            out.append(p1)
            continue
        d1 /= l1
        d2 /= l2
        cosang = max(-1.0, min(1.0, d1.dot(d2)))
        ang = math.acos(cosang)
        if ang < 1e-3 or abs(ang - math.pi) < 1e-3:
            out.append(p1)
            continue
        t = rr / math.tan(ang / 2)
        t = min(t, l1 * 0.5, l2 * 0.5)
        r_eff = t * math.tan(ang / 2)
        a = p1 + d1 * t
        b = p1 + d2 * t
        bis = (d1 + d2).normalized()
        c = p1 + bis * (r_eff / math.sin(ang / 2))
        va, vb = a - c, b - c
        aa = math.atan2(va.y, va.x)
        ab = math.atan2(vb.y, vb.x)
        da = ab - aa
        while da > math.pi:
            da -= TAU
        while da < -math.pi:
            da += TAU
        for k in range(steps + 1):
            t_ = aa + da * k / steps
            out.append(c + Vector((math.cos(t_), math.sin(t_))) * r_eff)
    out.append(Vector(pts[-1][:2]))
    return [(p.x, p.y) for p in out]


def fillet_closed(pts, radius: float = 0.0, steps: int = 3):
    """닫힌 다각형의 모든 꼭짓점을 둥글린다."""
    ext = [pts[-1]] + list(pts) + [pts[0]]
    out = fillet(ext, radius, steps)
    return out[1:-1]


# ---------------------------------------------------------------- 형상 생성(bmesh)

def bm_rbox(sx: float, sy: float, sz: float, r: float = 0.05, segs: int = 2,
            base: bool = True, bulge: float = 0.0) -> bmesh.types.BMesh:
    """둥근 박스. base=True 면 바닥 중심이 원점(z 0..sz), 아니면 중심이 원점.

    bulge: 옆면 가운데를 살짝 부풀리는 비율 — 평행선 없는 장난감 같은 인상.
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    r = max(0.0, min(r, sx * 0.49, sy * 0.49, sz * 0.49))
    if r > 1e-4 and segs > 0:
        bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=r, offset_type="OFFSET",
                        segments=segs, profile=0.5, affect="EDGES", clamp_overlap=True)
    if bulge:
        for v in bm.verts:
            t = v.co.z / sz + 0.5  # 0 바닥 → 1 윗면
            b = 1.0 + bulge * math.sin(math.pi * t) * 2.0 / max(sx, sy)
            v.co.x *= b
            v.co.y *= b
    if base:
        for v in bm.verts:
            v.co.z += sz / 2
    return bm


def bm_lathe(profile, segs: int = 16, phase: float = 0.0) -> bmesh.types.BMesh:
    """(r, z) 프로파일을 Z축으로 돌린 회전체. r=0 인 끝점은 극점 1개로 닫는다.

    프로파일은 아래→바깥→위(→안) 순서여야 바깥쪽 노멀이 된다.
    """
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        if r < 1e-6:
            rings.append([bm.verts.new((0.0, 0.0, z))])
        else:
            ring = []
            for j in range(segs):
                a = TAU * j / segs + phase
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
    for i in range(len(rings) - 1):
        lo, hi = rings[i], rings[i + 1]
        for j in range(segs):
            j2 = (j + 1) % segs
            if len(lo) == 1 and len(hi) == 1:
                continue
            if len(lo) == 1:
                bm.faces.new((lo[0], hi[j2], hi[j]))
            elif len(hi) == 1:
                bm.faces.new((lo[j], lo[j2], hi[0]))
            else:
                bm.faces.new((lo[j], lo[j2], hi[j2], hi[j]))
    return bm


def bm_ellipsoid(rx: float, ry: float, rz: float, segs: int = 16, rings: int = 8) -> bmesh.types.BMesh:
    prof = [(math.sin(math.pi * i / rings), -math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    prof[0] = (0.0, -1.0)
    prof[-1] = (0.0, 1.0)
    bm = bm_lathe(prof, segs)
    for v in bm.verts:
        v.co.x *= rx
        v.co.y *= ry
        v.co.z *= rz
    return bm


def bm_sphere(r: float, segs: int = 14, rings: int = 8) -> bmesh.types.BMesh:
    return bm_ellipsoid(r, r, r, segs, rings)


def bm_cyl(r: float, h: float, segs: int = 16, bevel: float = 0.04, r_top: float | None = None,
           steps: int = 1) -> bmesh.types.BMesh:
    """바닥 중심 원점, 높이 h 의 둥근 모서리 원기둥(r_top 으로 테이퍼)."""
    rt = r if r_top is None else r_top
    b = min(bevel, r * 0.45, rt * 0.45, h * 0.45)
    prof = fillet([(0, 0), (r, 0, b), (rt, h, b), (0, h)], b, steps) if b > 0 else [(0, 0), (r, 0), (rt, h), (0, h)]
    return bm_lathe(prof, segs)


def bm_torus(major: float, minor: float, segs: int = 24, rings: int = 10, a0: float = -90.0, a1: float = 270.0,
             close: bool = True) -> bmesh.types.BMesh:
    """Z축 도넛. a0..a1(도) 은 단면 원의 각도 범위(-90 = 안쪽 아래 … 90 = 위 …)."""
    prof = []
    for i in range(rings + 1):
        a = math.radians(a0 + (a1 - a0) * i / rings)
        prof.append((major + minor * math.cos(a), minor * math.sin(a)))
    if close and abs((a1 - a0) - 360) < 1e-6:
        prof = prof[:-1]
        bm = bm_lathe(prof, segs)
        # 첫 링과 마지막 링을 잇는다(닫힌 도넛)
        rings_v = []
        verts = list(bm.verts)
        n = segs
        for i in range(len(prof)):
            rings_v.append(verts[i * n:(i + 1) * n])
        lo, hi = rings_v[-1], rings_v[0]
        for j in range(n):
            j2 = (j + 1) % n
            bm.faces.new((lo[j], lo[j2], hi[j2], hi[j]))
        return bm
    return bm_lathe(prof, segs)


def bm_prism(outline, z0: float, z1: float, bevel: float = 0.0, segs: int = 2, bevel_bottom: bool = False):
    """2D 외곽(CCW, Blender XY)을 z0..z1 로 돌출한 기둥. bevel 이면 윗면(과 선택 시 아랫면) 모서리를 둥글린다."""
    bm = bmesh.new()
    bottom = [bm.verts.new((x, y, z0)) for x, y in outline]
    top = [bm.verts.new((x, y, z1)) for x, y in outline]
    n = len(outline)
    bm.faces.new(list(reversed(bottom)))
    bm.faces.new(top)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    bm.normal_update()
    if bevel > 0:
        edges = [e for e in bm.edges if all(abs(v.co.z - z1) < 1e-6 for v in e.verts)]
        if bevel_bottom:
            edges += [e for e in bm.edges if all(abs(v.co.z - z0) < 1e-6 for v in e.verts)]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, offset_type="OFFSET", segments=segs, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    return bm


def bm_wedge(w: float, length: float, h: float, extra: float = 0.15) -> bmesh.types.BMesh:
    """충돌용 경사로 쐐기: 폭 w(X), 로컬 -Y 쪽(y=0)이 높이 h, +Y 로 length 만큼 가서 z=0.

    extra 만큼 아래·끝으로 연장해 바닥에 묻는다(턱이 생기지 않게).
    """
    bm = bmesh.new()
    slope = h / length
    y_end = length + extra
    z_end = -extra * slope
    hw = w / 2
    p = [(-hw, 0, h), (hw, 0, h), (hw, y_end, z_end), (-hw, y_end, z_end),
         (-hw, 0, z_end - 0.1), (hw, 0, z_end - 0.1), (hw, y_end, z_end - 0.1), (-hw, y_end, z_end - 0.1)]
    v = [bm.verts.new(c) for c in p]
    for f in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([v[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def bm_tube(path, radius: float, sides: int = 8, caps: bool = True, radii=None) -> bmesh.types.BMesh:
    """경로(Blender 좌표 점 목록)를 따라가는 튜브. caps=True 면 둥근 끝."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    tangents = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = (pts[i + 1] - pts[i - 1])
        tangents.append(t.normalized())
    up = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((1, 0, 0))
    u = up.cross(tangents[0]).normalized()
    frames = []
    for i in range(n):
        t = tangents[i]
        u = (u - t * u.dot(t)).normalized()
        v = t.cross(u).normalized()
        frames.append((u, v))
    bm = bmesh.new()
    rings = []

    def ring(center, u, v, r):
        return [bm.verts.new(center + (u * math.cos(TAU * k / sides) + v * math.sin(TAU * k / sides)) * r)
                for k in range(sides)]

    if caps:
        t0 = tangents[0]
        u0, v0 = frames[0]
        r0 = radii[0] if radii else radius
        rings.append([bm.verts.new(pts[0] - t0 * r0)])
        rings.append(ring(pts[0] - t0 * r0 * 0.7, u0, v0, r0 * 0.71))
    for i in range(n):
        r = radii[i] if radii else radius
        rings.append(ring(pts[i], frames[i][0], frames[i][1], r))
    if caps:
        t1 = tangents[-1]
        u1, v1 = frames[-1]
        r1 = radii[-1] if radii else radius
        rings.append(ring(pts[-1] + t1 * r1 * 0.7, u1, v1, r1 * 0.71))
        rings.append([bm.verts.new(pts[-1] + t1 * r1)])
    for i in range(len(rings) - 1):
        lo, hi = rings[i], rings[i + 1]
        for j in range(sides):
            j2 = (j + 1) % sides
            if len(lo) == 1:
                bm.faces.new((lo[0], hi[j2], hi[j]))
            elif len(hi) == 1:
                bm.faces.new((lo[j], lo[j2], hi[0]))
            else:
                bm.faces.new((lo[j], lo[j2], hi[j2], hi[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def bm_loop_tube(path, radius: float, sides: int = 8) -> bmesh.types.BMesh:
    """닫힌 경로 튜브(수영장 가장자리 등)."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    bm = bmesh.new()
    rings = []
    for i in range(n):
        t = (pts[(i + 1) % n] - pts[i - 1]).normalized()
        u = Vector((0, 0, 1)).cross(t).normalized()  # 수평 바깥/안쪽
        v = Vector((0, 0, 1))
        rings.append([bm.verts.new(pts[i] + (u * math.cos(TAU * k / sides) + v * math.sin(TAU * k / sides)) * radius)
                      for k in range(sides)])
    for i in range(n):
        lo, hi = rings[i], rings[(i + 1) % n]
        for j in range(sides):
            j2 = (j + 1) % sides
            bm.faces.new((lo[j], lo[j2], hi[j2], hi[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def bm_ring(outer, inner, z: float = 0.0) -> bmesh.types.BMesh:
    """같은 개수의 두 닫힌 루프(CCW, XY) 사이를 잇는 평평한 링(윗면 노멀 +Z)."""
    bm = bmesh.new()
    n = len(outer)
    vo = [bm.verts.new((x, y, z)) for x, y in outer]
    vi = [bm.verts.new((x, y, z)) for x, y in inner]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((vi[i], vo[i], vo[j], vi[j]))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    return bm


def bm_star_fill(loop, z_of, scales=(1.0, 0.75, 0.5, 0.25), center=(0.0, 0.0)) -> bmesh.types.BMesh:
    """원점 기준 별 모양(star-shaped) 다각형을 동심 링으로 채운 면(윗면 +Z). z_of(x, y) 로 높이."""
    bm = bmesh.new()
    cx, cy = center
    rings = []
    for s in scales:
        rings.append([bm.verts.new((cx + (x - cx) * s, cy + (y - cy) * s, z_of(cx + (x - cx) * s, cy + (y - cy) * s)))
                      for x, y in loop])
    c = bm.verts.new((cx, cy, z_of(cx, cy)))
    n = len(loop)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((b[i], a[i], a[j], b[j]))
    last = rings[-1]
    for i in range(n):
        bm.faces.new((c, last[i], last[(i + 1) % n]))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    return bm


def bisect_stripes(bm, axis: int, spacing: float, lo: float, hi: float, offset: float = 0.0):
    """axis(0=X,1=Y,2=Z) 방향으로 spacing 간격 평면으로 면을 자른다(줄무늬·타일용)."""
    k0 = math.floor((lo - offset) / spacing)
    k1 = math.ceil((hi - offset) / spacing)
    no = [0.0, 0.0, 0.0]
    no[axis] = 1.0
    for k in range(k0, k1 + 1):
        co = [0.0, 0.0, 0.0]
        co[axis] = offset + k * spacing
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
    return bm


def transform(bm, mtx: Matrix):
    bmesh.ops.transform(bm, matrix=mtx, verts=bm.verts)
    return bm
