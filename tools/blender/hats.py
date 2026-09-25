"""Splash Buddy 모자 6종 → public/assets/models/hats.glb

실행:
  blender -b --factory-startup --python tools/blender/hats.py -- \
      --out public/assets/models/hats.glb --preview tools/blender/previews/hats.png

노드(규약: docs/ASSETS.md `hats.glb`) — 모두 루트 레벨 메시 오브젝트, 위치 (0,0,0):
  hat_cap, hat_duck, hat_flower, hat_crown, hat_frog, hat_bucket

원점 = 모자 바닥 중앙 = 캐릭터 HatAnchor(정수리, z = splash_char.Z_TOP) 와 맞닿는 점.
런타임은 모자를 HatAnchor 의 자식으로 위치·회전 0 으로 붙이므로(src/render/assets.ts setHat),
머리를 감싸는 모자(캡·개구리·버킷)는 원점 아래로(머리 옆면을 따라) 내려오고,
머리 위에 얹는 모자(오리·꽃·왕관)는 밑면이 머리 곡면을 따라 살짝 파묻힌다(떠 보이지 않게).

모자는 캐릭터와 같은 해석적 머리 형상(splash_char 프로파일)으로 모델링하므로 머리에 딱 맞는다.
몸통 모양을 바꾸면 이 스크립트도 다시 돌려야 한다(npm run assets 가 둘 다 재생성).
정면 = Blender -Y. 색은 고정(플레이어 색과 무관한 코스메틱).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: E402,F401
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import splash_char as sc  # noqa: E402

ANCHOR = Vector((0.0, 0.0, sc.Z_TOP))
TRI_BUDGET = 1500

# 눈 윗선(캐릭터 눈 흰자 꼭대기 ≈ 1.325 m) — 앞쪽 챙·테두리는 이보다 위에 둔다.
EYE_TOP_Z = 1.33


# ---------------------------------------------------------------- small helpers

def xform(verts, matrix: Matrix, offset=Vector((0, 0, 0))):
    """verts 를 행렬로 변환한 뒤 offset 만큼 이동."""
    out = []
    for v in verts:
        p = matrix @ Vector(v) + offset
        out.append((p.x, p.y, p.z))
    return out


def basis(z_axis: Vector, y_hint: Vector) -> Matrix:
    """로컬 z 를 z_axis 로, 로컬 y 를 y_hint 쪽으로 향하게 하는 회전 행렬(3x3)."""
    z = z_axis.normalized()
    y = (y_hint - z * y_hint.dot(z)).normalized()
    x = y.cross(z).normalized()
    return Matrix((x, y, z)).transposed()


def rim_z(theta: float, front: float, back: float) -> float:
    """정면(θ=-π/2)에서 front, 뒤에서 back 높이가 되도록 부드럽게 섞은 테두리 높이."""
    f = 0.5 - 0.5 * math.sin(theta)
    return back + (front - back) * f


def head_shell(rim_front: float, rim_back: float, thick: float, sink: float, segments: int,
               n_outer: int, n_lip: int, n_inner: int, band: float = 0.0):
    """머리를 감싸는 닫힌 껍질 (verts, faces).

    겉면 = 머리 표면 + thick, 둥근 테두리(반원), 안쪽면 = 머리 표면 - sink(머리 속이라 보이지 않음).
    테두리 높이는 정면 rim_front → 뒤 rim_back 으로 부드럽게 변한다(모자가 뒤로 살짝 깊게 씌워짐).
    겉 정수리 극점 → 테두리 → 안쪽 정수리 극점 순서로 행을 만든다.
    band > 0 이면 겉면 마지막 행 간격을 band(호 길이, m)로 고정한다 → 그 행부터 테두리까지를
    다른 색 띠로 칠할 수 있다(shell_rows 로 면의 행 번호를 얻는다).
    """
    rows = n_outer + n_lip + n_inner

    def s_rim(theta):
        return sc.head_s_at_z(rim_z(theta, rim_front, rim_back))

    def pt(k, j):
        theta = 2 * math.pi * j / segments + sc.FRONT
        sr = s_rim(theta)
        if k < n_outer:
            if band > 0.0:
                if k == n_outer - 1:
                    return sc.head_point(theta, sr, thick)
                return sc.head_point(theta, (sr - band) * k / (n_outer - 2), thick)
            t = k / (n_outer - 1)
            return sc.head_point(theta, sr * t, thick)
        k2 = k - n_outer
        if k2 < n_lip:
            a = math.pi * (k2 + 1) / (n_lip + 1)
            c, r = 0.5 * (thick - sink), 0.5 * (thick + sink)
            return sc.head_point(theta, sr + r * math.sin(a), c + r * math.cos(a))
        k3 = k2 - n_lip
        t = 1.0 - k3 / (n_inner - 1)
        return sc.head_point(theta, sr * t, -sink)

    return sc.grid_revolve(pt, rows, segments)


def add_rows(buf: sc.MeshBuf, verts, faces, segments: int, n_rows: int, mat_of_row):
    """grid_revolve(양끝 극점) 메시를 버퍼에 넣되, 면마다 행 번호(면의 가장 위 행)로 머티리얼을 고른다."""
    base = len(buf.verts)
    buf.verts.extend(tuple(v) for v in verts)
    for face in faces:
        k = min(_row_of(i, segments, n_rows) for i in face)
        buf.faces.append(tuple(i + base for i in face))
        buf.face_mat.append(mat_of_row(k))


def finish(buf: sc.MeshBuf, name: str, mats) -> bpy.types.Object:
    ob = buf.build(name, mats, origin=tuple(ANCHOR))
    ob.location = (0.0, 0.0, 0.0)  # 루트 노드: 로컬 원점 = HatAnchor 지점
    sc.recalc_outward(ob)
    sc.assert_closed(ob)
    tris = sc.tri_count_mesh(ob)
    print(f"[tris] {name:10s} {tris}")
    if tris > TRI_BUDGET:
        raise SystemExit(f"{name}: tri budget exceeded {tris} > {TRI_BUDGET}")
    return ob


def lens_h(sink, bulge, k=2.0):
    def h(r):
        return -sink + (bulge + sink) * math.sqrt(max(0.0, 1.0 - r ** k))
    return h


# ---------------------------------------------------------------- hats

def build_cap(M):
    """야구모자: 크림 크라운 + 코랄 챙·단추 + 앞 엠블럼(코랄 동그라미 위 하늘색 물방울). 챙은 정면(-Y).

    머리에 닿는 크라운을 밝은 크림으로 둬서 코랄·핑크처럼 모자와 비슷한 플레이어 색에서도
    모자와 머리의 경계가 멀리서 읽힌다.
    """
    T, SINK = 0.035, 0.010
    RIM_F, RIM_B = 1.405, 1.365
    buf = sc.MeshBuf()
    v, f = head_shell(RIM_F, RIM_B, T, SINK, segments=28, n_outer=10, n_lip=3, n_inner=3)
    buf.add(v, f, 0)

    # 챙: 납작한 베개형 판(가장자리 둥글게), 뒤쪽 절반은 크라운·머리 속에 숨는다.
    s_f = sc.head_s_at_z(RIM_F)
    front = sc.head_point(sc.FRONT, s_f, T * 0.5)
    rx, ry, rz = 0.205, 0.185, 0.018

    def bill(d, q):
        fwd = max(0.0, -q.y)  # 앞으로 나온 거리
        q.z -= 0.028 * (fwd / ry) ** 2.0          # 앞으로 갈수록 살짝 아래로
        q.z -= 0.030 * (q.x / rx) ** 2 * (0.4 + 0.6 * fwd / ry)  # 옆이 둥글게 말림
        return q

    v, f = sc.pillow((0, 0, 0), (rx, ry, rz), segments=20, rings=10, squareness=0.45, deform=bill)
    v = xform(v, Matrix.Identity(3), Vector((0.0, front.y + 0.010, front.z + 0.004)))
    # 얼굴 앞으로 나온 챙 밑면이 눈을 가리지 않는지(눈 윗선 + 3 cm 위)
    bill_low = min(p[2] for p in v if p[1] < front.y)
    if bill_low < EYE_TOP_Z + 0.03:
        raise SystemExit(f"cap bill would cover the eyes: z={bill_low:.3f}")
    print(f"[cap] bill underside z={bill_low:.3f}")
    buf.add(v, f, 1)

    # 단추
    v, f = sc.ellipsoid((0, 0, sc.Z_TOP + T + 0.006), (0.027, 0.027 * sc.DEPTH, 0.017), segments=10, rings=6)
    buf.add(v, f, 1)

    # 앞 엠블럼: 코랄 동그란 패치 위에 하늘색 물방울 — 크라운 겉면을 따라가는 얕은 렌즈 2겹
    fr = sc.OffsetFrame(sc.surface_point_front(0.0, 1.495), T)
    h_badge = lens_h(0.003, 0.004, k=4)
    v, f, flat = sc.lens(fr.point, fr.n, (0, 0), (0.050, 0.048), h_badge,
                         back_depth=0.014, segments=16, rings=2)
    buf.add(v, f, 1, flat)

    def badge_surface(u, w):
        r = math.hypot(u / 0.050, w / 0.048)
        return fr.point(u, w) + fr.n * h_badge(min(r, 1.0))

    def drop_shape(t):  # 위(+v)가 뾰족한 물방울 외곽
        return 1.0 + 0.55 * max(0.0, math.sin(t)) ** 5

    v, f, flat = sc.lens(badge_surface, fr.n, (0.0, -0.007), (0.022, 0.022), lens_h(0.002, 0.003, k=3),
                         back_depth=0.006, segments=16, rings=2, shape=drop_shape)
    buf.add(v, f, 2, flat)
    return finish(buf, "hat_cap", [M["cream"], M["cap"], M["drop"]])


def build_frog(M):
    """개구리 모자: 초록 돔 + 크림 테두리 + 머리 위 눈 두 개(흰자·동공·하이라이트) + 앞쪽 웃는 입 + 볼터치.

    테두리(겉면 마지막 2 cm + 둥근 립)를 크림으로 칠해 초록 계열 플레이어 색·잔디 위에서도
    모자와 머리의 경계가 읽힌다(버킷햇의 크림 띠와 같은 역할, 삼각형 추가 없음).
    """
    T, SINK = 0.030, 0.010
    RIM_F, RIM_B = 1.405, 1.37
    N_OUTER, N_LIP, N_INNER, SEGS = 8, 3, 3, 28
    buf = sc.MeshBuf()
    v, f = head_shell(RIM_F, RIM_B, T, SINK, segments=SEGS, n_outer=N_OUTER, n_lip=N_LIP, n_inner=N_INNER,
                      band=0.020)
    rim_rows = range(N_OUTER - 2, N_OUTER + N_LIP)  # 겉면 마지막 띠 ~ 립이 끝나는 행
    add_rows(buf, v, f, SEGS, N_OUTER + N_LIP + N_INNER, lambda k: 5 if k in rim_rows else 0)

    R = 0.084
    for side in (1, -1):
        th = sc.FRONT + side * 0.86
        c = sc.head_point(th, 0.175, T + 0.036)
        v, f = sc.ellipsoid(tuple(c), (R, R, R), segments=12, rings=7)
        buf.add(v, f, 0)
        # 눈: 혹의 앞·바깥쪽을 향한 렌즈
        look = Vector((side * 0.28, -1.0, 0.30)).normalized()
        wf = sc.SphereFrame(c, R, look)
        v, f, flat = sc.lens(wf.point, wf.n, (0, 0), (0.056, 0.062), lens_h(0.004, 0.010),
                             back_depth=0.02, segments=12, rings=3)
        buf.add(v, f, 1, flat)
        pf = sc.SphereFrame(c, R + 0.010, look)
        pu = (-side * 0.008, -0.007)
        v, f, flat = sc.lens(pf.point, pf.n, pu, (0.032, 0.038), lens_h(0.003, 0.004),
                             back_depth=0.01, segments=12, rings=2)
        buf.add(v, f, 2, flat)
        sf = sc.SphereFrame(c, R + 0.015, look)
        v, f, flat = sc.lens(sf.point, sf.n, (pu[0] - 0.012, pu[1] + 0.015), (0.012, 0.012),
                             lens_h(0.002, 0.003), back_depth=0.006, segments=8, rings=2)
        buf.add(v, f, 3, flat)

    # 입: 돔 정면을 따라가는 넓은 U자 미소(Pupil 머티리얼 = 외곽선 없는 진남색 선)
    s_mid = sc.head_s_at_z(1.462)
    pts = []
    n = 13
    for i in range(n):
        t = -1.0 + 2.0 * i / (n - 1)
        th = sc.FRONT + t * 0.55
        s = s_mid + 0.020 * (1.0 - t * t)
        pts.append(sc.head_point(th, s, T + 0.002))
    v, f = sc.capsule_sweep(pts, 0.0085, ring_segments=6, up_hint=Vector((0, -1, 0.3)), cap_steps=2)
    buf.add(v, f, 2)

    # 볼터치
    for side in (1, -1):
        th = sc.FRONT + side * 0.66
        s = s_mid + 0.004
        p = sc.head_point(th, s, 0.0)
        fr = sc.OffsetFrame(p, T)
        v, f, flat = sc.lens(fr.point, fr.n, (0, 0), (0.030, 0.019), lens_h(0.003, 0.004, k=4),
                             back_depth=0.012, segments=12, rings=2)
        buf.add(v, f, 4, flat)
    return finish(buf, "hat_frog", [M["frog"], M["Eye"], M["Pupil"], M["EyeShine"], M["cheek"], M["cream"]])


def _chaikin(pts: np.ndarray, iterations: int) -> np.ndarray:
    """모서리를 둥글게 깎는 Chaikin 세분(양 끝점 고정)."""
    for _ in range(iterations):
        q = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            q.append(0.75 * a + 0.25 * b)
            q.append(0.25 * a + 0.75 * b)
        q.append(pts[-1])
        pts = np.array(q)
    return pts


def _split_at_z(pts: np.ndarray, z: float, start: int = 0):
    """start 이후 처음으로 높이 z 를 위→아래로 지나는 구간 i 와 그 교점."""
    for i in range(start, len(pts) - 1):
        z0, z1 = pts[i][1], pts[i + 1][1]
        if z0 >= z > z1:
            t = (z0 - z) / (z0 - z1)
            return i, pts[i] + (pts[i + 1] - pts[i]) * t
    raise ValueError(f"profile never crosses z={z}")


def build_bucket(M):
    """버킷햇(낚시 모자): 라벤더 크라운·아래로 처진 챙 + 크림 띠. 챙 앞쪽은 눈 위에 머문다."""
    SINK = 0.010
    BAND_TOP, BAND_BOT = 1.522, 1.468
    ctrl = [
        (0.000, 1.678), (0.120, 1.678), (0.205, 1.672), (0.262, 1.640),
        (0.286, 1.560), (0.300, 1.452), (0.360, 1.418), (0.428, 1.394),
        (0.444, 1.381), (0.426, 1.371), (0.360, 1.392), (0.288, 1.424),
    ]
    # 안쪽면: 머리 표면 - SINK 를 챙 밑면 높이 → 정수리로(보이지 않음)
    s_in = sc.head_s_at_z(1.424)
    for i in range(1, 7):
        p = sc.head_point(0.0, s_in * (1.0 - i / 6.0), -SINK)
        ctrl.append((p.x, p.z))
    dense = sc._resample_polyline(_chaikin(np.array(ctrl, dtype=float), 4), 600)
    # 띠 경계가 정확히 행이 되도록 프로파일을 세 조각으로 나눠 따로 샘플링
    i_top, p_top = _split_at_z(dense, BAND_TOP)
    i_bot, p_bot = _split_at_z(dense, BAND_BOT, i_top)
    a = sc._resample_polyline(np.vstack([dense[:i_top + 1], p_top]), 11, curvature_weight=0.45)
    b = sc._resample_polyline(np.vstack([p_top, dense[i_top + 1:i_bot + 1], p_bot]), 3)
    c = sc._resample_polyline(np.vstack([p_bot, dense[i_bot + 1:]]), 12, curvature_weight=0.5)
    a[0][0] = 0.0
    c[-1][0] = 0.0
    prof = np.vstack([a, b[1:], c[1:]])
    band_rows = range(len(a) - 1, len(a) - 1 + len(b) - 1)  # 띠 면이 시작하는 행
    brim_low = min(z for r, z in prof if r > 0.33)
    if brim_low < EYE_TOP_Z + 0.03:
        raise SystemExit(f"bucket brim would cover the eyes: z={brim_low:.3f}")
    segs = 30

    def pt(k, j):
        r, z = prof[k]
        th = 2 * math.pi * j / segs + sc.FRONT
        return Vector((r * math.cos(th), sc.DEPTH * r * math.sin(th), z))

    v, f = sc.grid_revolve(pt, len(prof), segs)
    buf = sc.MeshBuf()
    buf.verts.extend(v)
    for face in f:
        k = min(_row_of(i, segs, len(prof)) for i in face)
        buf.faces.append(tuple(face))
        buf.face_mat.append(1 if k in band_rows else 0)
    return finish(buf, "hat_bucket", [M["bucket"], M["cream"]])


def _row_of(vid: int, segs: int, n_rows: int) -> int:
    """grid_revolve(극점 양끝) 정점 인덱스 → 행 번호."""
    if vid == 0:
        return 0
    k = 1 + (vid - 1) // segs
    return min(k, n_rows - 1)


def build_crown(M):
    """왕관: 머리 위에 얹힌 금색 띠(둥근 꼭지 5개) + 아래쪽 크림 털 테두리 + 진주 + 보석 3개.

    띠 아래쪽(머리와 닿는 부분)을 크림으로 칠해 노란 계열 플레이어 색에서도 왕관과 머리의 경계가 읽힌다.
    """
    RC = 0.175                  # 띠 중심 반지름(ρ 공간)
    TW = 0.024                  # 띠 두께
    zb = sc.head_top_z(RC, 0.0) - 0.014   # 바닥은 머리 곡면 아래로 살짝
    H0, HL = 0.085, 0.070       # 기본 높이, 꼭지 추가 높이
    FLARE = 0.022               # 위로 갈수록 살짝 벌어짐
    TRIM = 0.044                # 크림 테두리 윗선(zb 기준) — 머리 위로 ≈3 cm 보임(금색 부분은 최소 4 cm)
    NU = 45
    r = TW * 0.5
    # 띠 단면(ρ-z 평면, 한 바퀴): 위 반원(바깥→꼭대기→안쪽) → 안쪽 벽 경계 → 아래 반원 → 바깥 벽 경계.
    # 벽의 경계 행(TRIM)에서 크림/금색이 정확히 나뉜다.
    SEC = [("top", 0), ("top", 45), ("top", 90), ("top", 135), ("top", 180), ("wall", -1),
           ("bot", 180), ("bot", 270), ("bot", 360), ("wall", 1)]
    CREAM_FACES = {5, 6, 7, 8}  # 단면 j → j+1 면 중 TRIM 아래(안쪽 벽 아래·바닥·바깥 벽 아래)

    def height(th):
        lobe = (0.5 + 0.5 * math.cos(5 * (th - sc.FRONT))) ** 2.2
        return H0 + HL * lobe

    def band_rho(z):
        return RC + FLARE * (z - zb) / (H0 + HL)

    def pt(i, j):
        th = 2 * math.pi * i / NU + sc.FRONT
        kind, a = SEC[j]
        if kind == "wall":
            z, d = zb + TRIM, a * r
        else:
            zc = zb + height(th) - r if kind == "top" else zb + r
            z = zc + r * math.sin(math.radians(a))
            d = r * math.cos(math.radians(a))
        rho = band_rho(z) + d
        return Vector((rho * math.cos(th), sc.DEPTH * rho * math.sin(th), z))

    buf = sc.MeshBuf()
    v, f = sc.torus_grid(pt, NU, len(SEC))
    base = len(buf.verts)
    buf.verts.extend(tuple(p) for p in v)
    for idx, face in enumerate(f):
        buf.faces.append(tuple(i + base for i in face))
        buf.face_mat.append(1 if idx % len(SEC) in CREAM_FACES else 0)
    for k in range(5):
        th = sc.FRONT + 2 * math.pi * k / 5
        H = height(th)
        rho = RC + FLARE
        c = (rho * math.cos(th), sc.DEPTH * rho * math.sin(th), zb + H + 0.012)
        v, f = sc.ellipsoid(c, (0.026, 0.026, 0.026), segments=8, rings=5)
        buf.add(v, f, 1)
    GEM = (0.026, 0.032, 0.014)  # 폭·높이·두께
    gz = zb + TRIM + 0.006 + GEM[1]  # 크림 테두리 바로 위(금색 부분)
    for k, gem in ((0, 2), (1, 3), (-1, 4)):
        th = sc.FRONT + k * 2 * math.pi / 5
        rho = band_rho(gz) + r
        out = Vector((math.cos(th), sc.DEPTH * math.sin(th), 0)).normalized()
        c = Vector((rho * math.cos(th), sc.DEPTH * rho * math.sin(th), gz)) + out * 0.002
        v, f = sc.ellipsoid((0, 0, 0), GEM, segments=8, rings=5)
        v = xform(v, basis(out, Vector((0, 0, 1))), c)
        buf.add(v, f, gem)
    # 진주와 털 테두리는 같은 크림 머티리얼(슬롯 1) — 같은 색 슬롯을 두 번 두지 않는다
    return finish(buf, "hat_crown", [M["gold"], M["cream"], M["gem_pink"], M["gem_mint"], M["gem_lav"]])


def build_duck(M):
    """고무 오리: 하늘색 튜브(물놀이 링)에 앉아 머리 위에 얹힌 노란 오리(정면 -Y), 주황 부리, 까만 눈 + 하이라이트.

    튜브가 머리와 오리 사이에 있어 노란 계열 플레이어 색에서도 오리와 머리의 경계가 읽힌다.
    """
    S = 1.5  # 전체 배율(머리 크기에 맞춤 — 20 m 에서도 실루엣이 읽히도록 머리 폭의 ≈절반 이상)
    buf = sc.MeshBuf()
    bc = ANCHOR + Vector((0.0, 0.018, 0.062)) * S
    tail_dir = Vector((0.0, 0.72, 0.69)).normalized()

    def body_def(d, p):
        ang = d.angle(tail_dir)
        p = p + d * (0.055 * S * math.exp(-(ang / 0.42) ** 2))  # 위로 들린 꼬리
        if d.y < 0:
            p.z *= 1.0 + 0.10 * (-d.y)  # 가슴이 통통
        return p

    v, f = sc.ellipsoid((0, 0, 0), tuple(r * S for r in (0.112, 0.148, 0.086)), segments=18, rings=11,
                        deform=body_def)
    v = [(p[0] + bc.x, p[1] + bc.y, p[2] + bc.z) for p in v]
    # 밑면은 머리 곡면을 따라 살짝 파묻히게(떠 보이지 않게)
    v = [(x, y, max(z, sc.head_top_z(x, y) - 0.012)) for x, y, z in v]
    buf.add(v, f, 0)

    hc = ANCHOR + Vector((0.0, -0.070, 0.178)) * S
    HR = 0.076 * S
    v, f = sc.ellipsoid(tuple(hc), (HR, HR, HR * 0.97), segments=16, rings=9)
    buf.add(v, f, 0)

    bw = 0.048 * S

    def beak_def(d, q):
        q.z += 0.010 * S * (q.x / bw) ** 2  # 양끝이 올라간 미소 부리
        return q

    v, f = sc.pillow((0, 0, 0), (bw, 0.042 * S, 0.017 * S), segments=12, rings=7, squareness=0.7, deform=beak_def)
    v = xform(v, Matrix.Rotation(math.radians(-8), 3, "X"), hc + Vector((0.0, -0.075, -0.014)) * S)
    buf.add(v, f, 1)

    for side in (1, -1):
        d = Vector((side * 0.40, -0.85, 0.30)).normalized()  # 머리 실루엣 안쪽(정면 쪽)으로 모음
        ec = hc + d * (HR - 0.007 * S)
        v, f = sc.ellipsoid((0, 0, 0), (0.012 * S, 0.009 * S, 0.018 * S), segments=8, rings=5)
        v = xform(v, _eye_basis(d), ec)
        buf.add(v, f, 2)
        sh = ec + (d * 0.007 + Vector((-0.004, 0.0, 0.0065))) * S
        v, f = sc.ellipsoid(tuple(sh), (0.0055 * S,) * 3, segments=6, rings=4)
        buf.add(v, f, 3)

    def wing_def(d, q):
        q.x *= 1.0 - 0.45 * max(0.0, d.y)  # 뒤(깃 끝)로 갈수록 가늘어지는 물방울형 날개
        return q

    for side in (1, -1):
        wc = bc + Vector((side * 0.104, 0.034, 0.010)) * S
        v, f = sc.pillow((0, 0, 0), (0.034 * S, 0.074 * S, 0.016 * S), segments=10, rings=7, squareness=0.7,
                         deform=wing_def)
        # 로컬 z(얇은 축) → 바깥(±X), 로컬 y(길이) → 뒤·위로 들린 방향
        rot = Matrix.Rotation(math.radians(24), 3, "X") @ Matrix.Rotation(math.radians(side * 80), 3, "Y")
        v = xform(v, rot, wc)
        buf.add(v, f, 0)

    # 물놀이 튜브: 오리 밑에서 머리를 둘러싼 도넛. 머리는 ρ 공간에서 회전 대칭이라 수평 링이 곡면에 고르게 앉는다.
    RR, rr = 0.12 * S, 0.028 * S
    zc = sc.head_top_z(RR, 0.0) + 0.35 * rr  # 튜브 아래쪽 ≈65% 가 머리 속에 묻힘

    RING_U, RING_V = 18, 8  # 둘레 × 단면 분할(288 tris)

    def ring_pt(i, j):
        th = 2 * math.pi * i / RING_U + sc.FRONT
        ph = 2 * math.pi * j / RING_V
        rho = RR + rr * math.cos(ph)
        return Vector((rho * math.cos(th), sc.DEPTH * rho * math.sin(th), zc + rr * math.sin(ph)))

    v, f = sc.torus_grid(ring_pt, RING_U, RING_V)
    buf.add(v, f, 4)
    return finish(buf, "hat_duck", [M["duck"], M["beak"], M["Pupil"], M["EyeShine"], M["drop"]])


def _eye_basis(d: Vector) -> Matrix:
    """작은 눈 타원체: 로컬 y(얇은 축)를 바깥 법선 d 로, 로컬 z 를 위쪽으로."""
    y = d.normalized()
    z = (Vector((0, 0, 1)) - y * y.z).normalized()
    x = y.cross(z).normalized()
    return Matrix((x, y, z)).transposed()


def build_flower(M):
    """새싹 꽃: 머리에서 돋아난 줄기 + 잎 두 장 + 앞·위를 보는 분홍 꽃(노란 꽃술에 웃는 얼굴)."""
    S = 1.55  # 전체 배율(20 m 에서도 읽히게). 줄기 굵기·잎/꽃잎 두께는 배율과 무관하게 고정
    buf = sc.MeshBuf()
    H = 0.150 * S
    top = Vector((0.0, -0.030 * S, sc.Z_TOP - 0.020 + H))
    pts = []
    n = 9
    for i in range(n):
        t = i / (n - 1)
        pts.append(Vector((0.012 * S * math.sin(math.pi * t), -0.030 * S * t * t, sc.Z_TOP - 0.020 + H * t)))
    v, f = sc.capsule_sweep(pts, 0.017, ring_segments=8, up_hint=Vector((1, 0, 0)), cap_steps=2)
    buf.add(v, f, 2)

    lw = 0.030 * S

    def leaf_def(d, q):
        q.x *= 1.0 - 0.55 * max(0.0, d.y)   # 끝으로 갈수록 좁아지는 잎
        q.z += 0.010 * S * (q.x / lw) ** 2   # 가운데 잎맥 쪽으로 오목
        return q

    for side in (1, -1):
        v, f = sc.pillow((0, 0, 0), (lw, 0.068 * S, 0.010), segments=10, rings=7, squareness=0.55, deform=leaf_def)
        out = Vector((side * math.cos(math.radians(28)), 0.15, math.sin(math.radians(28)))).normalized()
        rot = basis(Vector((-side * 0.35, 0, 1)).normalized(), out)
        base = Vector((side * 0.010, 0.0, sc.Z_TOP + 0.010))
        v = xform(v, rot, base + out * 0.064 * S)
        buf.add(v, f, 2)

    F = Vector((0.0, -0.78, 0.62)).normalized()  # 꽃이 바라보는 방향(앞·위)
    up = Vector((0, 0, 1))
    fv = (up - F * up.dot(F)).normalized()
    fu = fv.cross(F).normalized()
    for k in range(5):
        a = math.pi / 2 + 2 * math.pi * k / 5
        radial = (fu * math.cos(a) + fv * math.sin(a)).normalized()
        v, f = sc.pillow((0, 0, 0), (0.036 * S, 0.052 * S, 0.012), segments=10, rings=7, squareness=0.5)
        # 꽃잎 로컬 y = 바깥 방향, z = 꽃 정면(살짝 컵 모양으로 앞으로 기울임)
        z_ax = (F * math.cos(math.radians(14)) - radial * math.sin(math.radians(14))).normalized()
        v = xform(v, basis(z_ax, radial), top + radial * 0.056 * S - F * 0.006 * S)
        buf.add(v, f, 0)
    v, f = sc.pillow((0, 0, 0), (0.042 * S, 0.042 * S, 0.022 * S), segments=12, rings=7, squareness=0.7)
    v = xform(v, basis(F, fv), top + F * 0.006 * S)
    buf.add(v, f, 1)
    # 꽃술 얼굴: 작은 눈 두 개 + 미소
    face = top + F * (0.029 * S)
    for side in (1, -1):
        c = face + fu * (side * 0.014 * S) + fv * (0.006 * S)
        v, f = sc.ellipsoid((0, 0, 0), (0.0055 * S, 0.004 * S, 0.008 * S), segments=6, rings=4)
        v = xform(v, _eye_basis(F), c)
        buf.add(v, f, 3)
    smile = []
    for i in range(7):
        u = -1.0 + 2.0 * i / 6
        smile.append(face + fu * (u * 0.011 * S) + fv * (-0.008 * S - 0.005 * S * (1 - u * u)))
    v, f = sc.capsule_sweep(smile, 0.0028 * S, ring_segments=6, up_hint=F, cap_steps=2)
    buf.add(v, f, 3)
    return finish(buf, "hat_flower", [M["petal"], M["center"], M["leaf"], M["Pupil"]])


# ---------------------------------------------------------------- main

def build_materials():
    return {
        "cap": color_mat("#FF7B7B", roughness=0.5),
        "cream": color_mat("#FFF6E8", roughness=0.5),
        "drop": color_mat("#4FD1E8", roughness=0.4),
        "frog": color_mat("#8BD66B", roughness=0.5),
        "cheek": color_mat("#FF9CCB", roughness=0.6),
        "bucket": color_mat("#B9A6FF", roughness=0.6),
        "gold": color_mat("#FFC83D", roughness=0.3),
        "gem_pink": color_mat("#FF6F91", roughness=0.2),
        "gem_mint": color_mat("#7EE0C3", roughness=0.2),
        "gem_lav": color_mat("#B9A6FF", roughness=0.2),
        "duck": color_mat("#FFD35C", roughness=0.4),
        "beak": color_mat("#FFA552", roughness=0.4),
        "petal": color_mat("#FF9CCB", roughness=0.5),
        "center": color_mat("#FFD35C", roughness=0.5),
        "leaf": color_mat("#5DB85A", roughness=0.5),
        "Eye": material("Eye", "#FFFFFF", roughness=0.15),
        "Pupil": material("Pupil", "#2B2D42", roughness=0.15),
        "EyeShine": material("EyeShine", "#FFFFFF", roughness=0.1),
    }


def main():
    args = parse_args()
    reset_scene()
    M = build_materials()
    hats = [build_cap(M), build_duck(M), build_flower(M), build_crown(M), build_frog(M), build_bucket(M)]
    total = sum(sc.tri_count_mesh(h) for h in hats)
    print(f"[tris] TOTAL {total}")
    bpy.ops.object.select_all(action="SELECT")
    export_glb(args.out, roots=hats)
    if args.preview:
        # 미리보기용으로만 가로로 벌려 놓는다(내보내기 이후라 GLB 에는 영향 없음)
        for i, h in enumerate(hats):
            h.location = ((i - 2.5) * 0.95, 0.0, 0.0)
        render_preview(args.preview, target=(0, 0, 0.0), distance=8.0, yaw_deg=-12, pitch_deg=20,
                       res=(1500, 450), ortho_scale=6.2)


main()
