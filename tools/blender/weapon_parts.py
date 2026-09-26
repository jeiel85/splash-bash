"""weapons.glb 전용 모델링 헬퍼 (Blender 4.5).

common.py 의 범용 헬퍼 위에 '둥근 장난감 물총'에 필요한 형태 생성기만 둔다.

- fillet()      : 2D 폴리라인의 꼭짓점을 원호로 둥글린다(회전체 프로파일용)
- lathe()       : 프로파일 (r, t) 를 임의 축으로 돌린 회전체. 여러 머티리얼 구간 지원
- tube()        : 경로를 따라가는 둥근 끝 튜브(방아쇠, 방아쇠울, 양동이 손잡이)
- smooth_path() : Catmull-Rom 으로 경로 점을 촘촘하게
- soft_box()    : 모서리가 크게 둥근 박스(위·앞쪽 테이퍼 가능)
- blob()        : 방향을 지정한 타원체(버튼, 하이라이트, 노즐 돌기)
- set_origin()  : 형상은 그대로 두고 원점만 옮긴다

모든 생성 함수는 트랜스폼이 이미 적용된(오브젝트 트랜스폼 = 항등) 메시 오브젝트를 돌려준다.
즉 좌표를 '총 좌표계(원점 = 손잡이)' 그대로 넣으면 되고, join() 해도 위치가 변하지 않는다.
면 방향은 프로파일 진행 방향으로 결정한다(아래 lathe() 설명).
"""
from __future__ import annotations

import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from common import apply_modifiers, link, smooth

_EPS = 1e-7


# ---------------------------------------------------------------- 내부

def _finish(name, bm, mats):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    link(obj)
    smooth(obj)
    return obj


def _frame(axis):
    """축 w 에 대한 직교 기저 (u, v, w). u×v = w (오른손 좌표계)."""
    w = Vector(axis).normalized()
    up = Vector((0, 0, 1)) if abs(w.z) < 0.9 else Vector((0, 1, 0))
    u = up.cross(w).normalized()
    v = w.cross(u).normalized()
    return u, v, w


# ---------------------------------------------------------------- 2D 프로파일

def fillet(points, radius=0.0, steps=4, closed=False):
    """(r, t[, 필렛반경[, 분할수]]) 폴리라인의 내부 꼭짓점을 원호로 둥글린다.

    - 필렛 반경은 점마다 3번째 값으로 줄 수 있고, 없으면 `radius`. 0 이면 뾰족한 꼭짓점 그대로
      (다른 부품에 가려지는 모서리에만 쓴다).
    - 원호 분할 수는 점마다 4번째 값으로 줄 수 있고, 없으면 `steps`(폴리 예산 조절용).
    - 열린 프로파일의 끝점(보통 축 위의 극점)은 그대로 둔다. 끝점에 붙은 변은
      필렛이 변 전체를 쓸 수 있어 (0,a)-(R,a)-(R,b) 같은 모서리가 반구가 된다.
    - 그 밖의 변은 양쪽 필렛이 겹치지 않도록 변 길이의 절반까지만 쓴다.
    """
    n = len(points)
    P = [Vector((float(p[0]), float(p[1]))) for p in points]
    R = [float(p[2]) if len(p) > 2 else float(radius) for p in points]
    S = [max(1, int(p[3])) if len(p) > 3 else max(1, int(steps)) for p in points]
    out = []
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            out.append(P[i].copy())
            continue
        a, p, b = P[(i - 1) % n], P[i], P[(i + 1) % n]
        r, st = R[i], S[i]
        u, v = a - p, b - p
        lu, lv = u.length, v.length
        if r <= 0 or lu < _EPS or lv < _EPS:
            out.append(p.copy())
            continue
        u, v = u / lu, v / lv
        theta = math.acos(max(-1.0, min(1.0, u.dot(v))))
        if theta < 1e-3 or theta > math.pi - 1e-3:
            out.append(p.copy())
            continue
        la = lu if (not closed and i - 1 == 0) else lu * 0.5
        lb = lv if (not closed and i + 1 == n - 1) else lv * 0.5
        d = r / math.tan(theta / 2)
        if d > min(la, lb):
            d = min(la, lb)
            r = d * math.tan(theta / 2)
        t1, t2 = p + u * d, p + v * d
        c = p + (u + v).normalized() * (r / math.sin(theta / 2))
        a1 = math.atan2(t1.y - c.y, t1.x - c.x)
        a2 = math.atan2(t2.y - c.y, t2.x - c.x)
        da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        for k in range(st + 1):
            ang = a1 + da * k / st
            out.append(Vector((c.x + r * math.cos(ang), c.y + r * math.sin(ang))))
    res = []
    for q in out:
        q = (max(0.0, q.x), q.y)
        if res and abs(res[-1][0] - q[0]) < 1e-6 and abs(res[-1][1] - q[1]) < 1e-6:
            continue
        res.append(q)
    if closed and len(res) > 2 and abs(res[0][0] - res[-1][0]) < 1e-6 and abs(res[0][1] - res[-1][1]) < 1e-6:
        res.pop()
    return res


def ellipse_profile(rc, tc, rr, rt, n=8):
    """(rc, tc) 중심의 타원 단면(닫힌 링용, 반시계)."""
    return [(rc + rr * math.cos(2 * math.pi * k / n), tc + rt * math.sin(2 * math.pi * k / n)) for k in range(n)]


# ---------------------------------------------------------------- 회전체

def lathe(name, profile, mat, **kw):
    """단일 머티리얼 회전체. 인자는 lathe_multi 참고."""
    return lathe_multi(name, [(profile, mat)], **kw)


def lathe_multi(name, parts, *, origin=(0, 0, 0), axis=(0, -1, 0), segments=24, radius=0.0, steps=4,
                squash=(1.0, 1.0), closed=False, phase=0.0):
    """프로파일 (r = 축에서 거리, t = 축 방향 위치)을 `axis` 둘레로 돌린다.

    parts: [(프로파일, 머티리얼), ...] — 이어지는 구간은 앞 구간 끝점에서 시작해야 한다
           (예: 나팔 바깥면 분홍 → 안쪽면 진분홍).
    면 방향: 프로파일 진행 방향의 '오른쪽'(r 을 x, t 를 y 로 볼 때)이 바깥이다.
             즉 뒤쪽 극점에서 바깥 면을 따라 앞으로 가면 바깥을 향하고,
             입구에서 안쪽으로 되돌아오는 면(나팔 속)은 축 쪽(빈 공간)을 향한다.
    closed=True: 축에 닿지 않는 닫힌 단면(링). 방향은 자동으로 반시계로 맞춘다.
    squash: 단면을 (u, v) 방향으로 눌러 타원 단면을 만든다. 축이 -Y 면 u=X, v=Z.
    """
    u, v, w = _frame(axis)
    o = Vector(origin)
    pts, seg_mat = [], []
    for k, (prof, _mat) in enumerate(parts):
        fp = fillet(prof, radius, steps, closed=closed and len(parts) == 1)
        if k > 0:
            fp = fp[1:]
        for q in fp:
            if pts:
                seg_mat.append(k)
            pts.append(q)
    if closed:
        area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
                   for i in range(len(pts)))
        if area < 0:
            pts.reverse()
            seg_mat.reverse()
        seg_mat.append(0)

    bm = bmesh.new()
    rings = []
    for r, t in pts:
        c = o + w * t
        if r < 1e-6:
            rings.append([bm.verts.new(c)])
        else:
            ring = []
            for i in range(segments):
                a = phase + 2 * math.pi * i / segments
                ring.append(bm.verts.new(c + u * (math.cos(a) * r * squash[0]) + v * (math.sin(a) * r * squash[1])))
            rings.append(ring)
    pairs = list(zip(rings, rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    n = segments
    for (A, B), mi in zip(pairs, seg_mat):
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:
            fs = [bm.faces.new((A[0], B[(i + 1) % n], B[i])) for i in range(n)]
        elif len(B) == 1:
            fs = [bm.faces.new((A[i], A[(i + 1) % n], B[0])) for i in range(n)]
        else:
            fs = [bm.faces.new((A[i], A[(i + 1) % n], B[(i + 1) % n], B[i])) for i in range(n)]
        for f in fs:
            f.material_index = mi
    return _finish(name, bm, [m for _, m in parts])


# ---------------------------------------------------------------- 튜브

def smooth_path(points, per_seg=3):
    """Catmull-Rom 스플라인으로 경로 점을 보간한다(끝점 통과)."""
    P = [Vector(p) for p in points]
    out = []
    for i in range(len(P) - 1):
        p1, p2 = P[i], P[i + 1]
        p0 = P[i - 1] if i > 0 else p1 * 2 - p2
        p3 = P[i + 2] if i + 2 < len(P) else p2 * 2 - p1
        for k in range(per_seg):
            t = k / per_seg
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1].copy())
    return out


def arc_points(center, radius, a0, a1, n, u=(1, 0, 0), v=(0, 0, 1)):
    """center + u·R·cos(a) + v·R·sin(a), a: a0→a1(도), n+1 점."""
    c, uu, vv = Vector(center), Vector(u), Vector(v)
    return [c + uu * (radius * math.cos(math.radians(a0 + (a1 - a0) * k / n)))
            + vv * (radius * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def tube(name, path, radius, mat, *, sides=10, squash=(1.0, 1.0), ref=(1, 0, 0)):
    """경로를 따라가는 튜브. 양 끝은 반구로 닫는다(닫힌 매니폴드).

    단면 기준축 N 은 `ref` 를 첫 접선에 직교 투영한 것(평행 이동 프레임으로 전달).
    squash = (N 방향 배율, 접선×N 방향 배율).
    """
    P = [Vector(p) for p in path]
    n = len(P)
    T = []
    for i in range(n):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        T.append(t.normalized())
    r0 = Vector(ref)
    if abs(T[0].dot(r0.normalized())) > 0.95:
        r0 = Vector((0, 0, 1)) if abs(T[0].z) < 0.9 else Vector((0, 1, 0))
    N = [(r0 - T[0] * r0.dot(T[0])).normalized()]
    for i in range(1, n):
        N.append((N[-1] - T[i] * N[-1].dot(T[i])).normalized())

    bm = bmesh.new()

    def ring(c, t, nrm, r):
        b = t.cross(nrm)
        return [bm.verts.new(c + nrm * (math.cos(a) * r * squash[0]) + b * (math.sin(a) * r * squash[1]))
                for a in (2 * math.pi * k / sides for k in range(sides))]

    rings = [[bm.verts.new(P[0] - T[0] * radius)]]
    for phi in (60, 30):
        ph = math.radians(phi)
        rings.append(ring(P[0] - T[0] * (radius * math.sin(ph)), T[0], N[0], radius * math.cos(ph)))
    for i in range(n):
        rings.append(ring(P[i], T[i], N[i], radius))
    for phi in (30, 60):
        ph = math.radians(phi)
        rings.append(ring(P[-1] + T[-1] * (radius * math.sin(ph)), T[-1], N[-1], radius * math.cos(ph)))
    rings.append([bm.verts.new(P[-1] + T[-1] * radius)])
    s = sides
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1:
            for k in range(s):
                bm.faces.new((A[0], B[(k + 1) % s], B[k]))
        elif len(B) == 1:
            for k in range(s):
                bm.faces.new((A[k], A[(k + 1) % s], B[0]))
        else:
            for k in range(s):
                bm.faces.new((A[k], A[(k + 1) % s], B[(k + 1) % s], B[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return _finish(name, bm, [mat])


# ---------------------------------------------------------------- 박스 / 타원체

def soft_box(name, size, mat, *, loc=(0, 0, 0), rot=(0, 0, 0), radius=0.02, segments=3,
             top=(1.0, 1.0), front=(1.0, 1.0)):
    """모서리를 크게 둥글린 박스(Bevel 모디파이어 적용 완료 상태로 반환).

    top=(sx, sy): 윗면(+Z) 꼭짓점의 X/Y 배율(1 미만이면 위가 좁아짐 → 손잡이 밑단이 퍼져 보임)
    front=(sx, sz): 앞면(-Y) 꼭짓점의 X/Z 배율
    rot: 라디안 오일러(XYZ). 회전 → 이동 순으로 형상에 굽는다.
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for vert in bm.verts:
        x, y, z = vert.co.x * sx, vert.co.y * sy, vert.co.z * sz
        if vert.co.z > 0:
            x, y = x * top[0], y * top[1]
        if vert.co.y < 0:
            x, z = x * front[0], z * front[1]
        vert.co = Vector((x, y, z))
    obj = _finish(name, bm, [mat])
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = min(radius, 0.49 * min(size))
    m.segments = segments
    m.limit_method = "NONE"
    m.profile = 0.5
    m.use_clamp_overlap = True
    apply_modifiers(obj)
    obj.data.transform(Matrix.LocRotScale(Vector(loc), Euler(rot, "XYZ").to_quaternion(), None))
    smooth(obj)
    return obj


def blob(name, center, radii, mat, *, normal=(0, 0, 1), up=(0, 1, 0), segs=12, rings=8):
    """타원체. radii = (up 방향, normal×up 방향, normal 방향) 반지름."""
    nrm = Vector(normal).normalized()
    upv = Vector(up)
    t1 = upv - nrm * upv.dot(nrm)
    if t1.length < 1e-6:
        t1 = nrm.orthogonal()
    t1.normalize()
    t2 = nrm.cross(t1)          # (t1, t2, nrm) 오른손 좌표계 → 면 방향(바깥)이 보존된다
    c = Vector(center)

    def P(x, y, z):
        return c + t1 * (x * radii[0]) + t2 * (y * radii[1]) + nrm * (z * radii[2])

    # UV 구를 직접 만든다. bmesh.ops.create_uvsphere 는 실행마다 요소 순서가 달라져
    # 같은 스크립트라도 GLB 바이트가 바뀐다(재현성). 면은 바깥을 향하도록 감는다.
    bm = bmesh.new()
    top = bm.verts.new(P(0, 0, 1))
    ring_vs = []
    for k in range(1, rings):
        phi = math.pi * k / rings
        ring_vs.append([bm.verts.new(P(math.sin(phi) * math.cos(2 * math.pi * i / segs),
                                       math.sin(phi) * math.sin(2 * math.pi * i / segs), math.cos(phi)))
                        for i in range(segs)])
    bottom = bm.verts.new(P(0, 0, -1))
    n = segs
    for i in range(n):
        bm.faces.new((top, ring_vs[0][i], ring_vs[0][(i + 1) % n]))
    for A, B in zip(ring_vs, ring_vs[1:]):
        for i in range(n):
            bm.faces.new((A[i], B[i], B[(i + 1) % n], A[(i + 1) % n]))
    for i in range(n):
        bm.faces.new((ring_vs[-1][i], bottom, ring_vs[-1][(i + 1) % n]))
    return _finish(name, bm, [mat])


def set_origin(obj, point):
    """형상의 월드 위치는 유지한 채 오브젝트 원점을 `point` 로 옮긴다."""
    p = Vector(point)
    obj.data.transform(Matrix.Translation(-p))
    obj.location = obj.location + p
    return obj


def mesh_tris(obj) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)
