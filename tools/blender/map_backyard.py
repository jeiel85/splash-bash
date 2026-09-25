"""map_backyard.glb — "뒷마당 수영장 파티" 아레나 (docs/ASSETS.md 'map_backyard.glb', design-synthesis §10).

실행:
  blender -b --factory-startup --python tools/blender/map_backyard.py -- \
      --out public/assets/models/map_backyard.glb [--preview tools/blender/previews/map_top.png] [--audit]

좌표: 레이아웃 수치는 모두 **게임 좌표**(x 동쪽, z 북쪽(+z = 스케매틱 위), y 위)로 적고
`G()/at()`(map_parts.py)로 Blender(Z-up) 로 바꾼다. glTF(Y-up) 로 내보내면 다시 게임 좌표가 된다.

대칭: 게임플레이에 영향을 주는 모든 것은 원점 기준 180° 회전 대칭이다. `half(M)` 류 함수가
서쪽/북쪽 절반을 만들고 M = 항등 / Rz(180°) 로 두 번 부른다(팀 0 = 서쪽 파티오, 팀 1 = 동쪽).

노드 트리:
  Map                       Empty 루트
    m_<색>                  충돌하는 보이는 정적 메시(머티리얼별 1개로 합침)
    nocol_d_<색>            충돌 없는 장식(꽃·수건·풍선 소품 겉모습·집 등)
    water_pool              수영장 수면(Water, 충돌 없음, 채우기 구역)
    col_helper              보이지 않는 충돌 — Invisible: 경계벽(펜스 위 10 m), 파티오 계단 위 경사로,
                            산울타리 1.7 m 상자, 둥근 소품을 감싼 수직 기둥(pillar), 올라서기 방지 덮개
                            (anti_perch_cap: 오두막·티키 지붕, 전망대 옆 파티오 격자 윗면)
    spawn_XX / fountain_XX / jumppad_XX / jumptarget_XX / wp_XX / bounds   Empty 마커(extras)

올라서기 규칙: PlayerBody 는 딛고 선 면보다 1.45 m 높은 수직 턱까지 올라서고 1.50 m 부터 못 오른다.
둥근 풍선·화분 소품은 겉모습을 nocol 로 두고, 주변에서 딛을 수 있는 가장 높은 면 + 1.5 m 이상인 수직 기둥으로
막는다(옆구리·고리·덤불을 밟고 기어올라 울타리·지붕으로 번지는 길을 없앰).

--audit: 눈높이(1.42 m) 2 m 격자 점 쌍의 시야선 길이 분포(35 m 초과 목록), 팀 스폰 노출(적 전망대 데크·적 파티오
·스폰끼리), 35 m 초과 시야선을 가장 많이 끊는 차단물 후보 자리, 웨이포인트 간선의 직선 보행 가능성(바닥 연속·
장애물·점프 턱)을 출력한다(빌드 산출물에는 영향 없음).
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: E402,F401,F403
from map_parts import *  # noqa: E402,F401,F403

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

# ---------------------------------------------------------------- 팔레트(환경은 캐릭터보다 채도 ≥30% 낮게)

C = {
    "grass": "#A6D98C", "grass2": "#9BD080", "grass_out": "#B4DC9E",
    "deck": "#F2D6B0", "deck2": "#EACB9F", "deck_trim": "#D9B48A",
    "tile": "#DDF4F7", "pool_floor": "#86D9EA", "pool_ramp": "#BDEEF4",
    "patio": "#F6E2C6", "patio2": "#EDD2AE",
    "wood": "#E8B07A", "wood_dark": "#C98B55", "wood_light": "#F0C99A",
    "white": "#FFF8EE",
    "hedge": "#7FB27A",
    "leaf": "#8CCB74", "leaf2": "#A3D68A", "leaf3": "#79B96A",
    "coral": "#FF9E9E", "mint": "#A8E6CF", "lemon": "#FFE7A0", "pink": "#FFC8D8", "peach": "#FFC9A3",
    "aqua": "#A8E4F0", "lavender": "#D2C8FF", "rose": "#FF8FAF", "sun": "#FFD35C",
    "team0": "#FFB46B", "team1": "#B3A0FF",
    "thatch": "#EBC47C", "thatch2": "#D9AE62", "bamboo": "#DCC27E",
    "stone": "#EDE6DA", "stone2": "#D9CFBF", "terracotta": "#E9A17C",
    "ink": "#4E4460", "glass": "#8DB6D9",
    "pad_mat": "#FF7B9C",
    "roof_teal": "#8FC7C0", "roof_peach": "#F2A07F", "roof_lav": "#A99BD8", "roof_pink": "#E88FA8", "mint_lt": "#D6F0E0",
}
# 드로우콜을 줄이려고 비슷한 색은 같은 머티리얼을 쓴다(환경 전용 별칭)
# butter: 넓은 면에 쓰는 환경용 노랑. 캐릭터 노랑(#FFD23F, 채도 0.75)과 겹치지 않게 채도 ≈0.37 인 lemon 을 쓴다
#         (아트 리뷰 제안 #FFE3A3 과 사실상 같은 색 — 머티리얼을 하나 아끼려고 lemon 으로 통일).
#         sun(#FFD35C) 은 꽃술·깃발·손잡이처럼 0.1 m 안팎의 작은 소품에만 쓴다.
C.update({
    "fence": C["white"], "stucco": C["white"], "patio_lip": C["white"], "coping": C["white"],
    "patio_side": C["deck_trim"], "trunk": C["wood_dark"], "hedge_hi": C["leaf"], "lattice_bg": C["leaf"],
    "team0_lt": C["peach"], "team1_lt": C["lavender"], "charcoal": C["ink"], "pad_rim": C["coral"],
    "butter": C["lemon"], "tile_out": C["pool_ramp"],
    "fountain_band": "#6FD6E8", "foam": "#F4FFFF",
    "horizon": "#D4F1FF", "duck_wing": C["thatch"],
})


def _hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def _rgb_hex(c):
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in c)


def mix_hex(a, b, t):
    """a 를 b 쪽으로 t 만큼 섞는다(sRGB)."""
    ca, cb = _hex_rgb(a), _hex_rgb(b)
    return _rgb_hex([x + (y - x) * t for x, y in zip(ca, cb)])


def desat_hex(h, k):
    """HSV 채도를 k 배로."""
    import colorsys
    hh, s, v = colorsys.rgb_to_hsv(*_hex_rgb(h))
    return _rgb_hex(colorsys.hsv_to_rgb(hh, s * k, v))

R180 = Matrix.Rotation(math.pi, 4, "Z")
I4 = Matrix.Identity(4)

B = Builder()


def put(bm, mat, M, x, z, y=0.0, rot=0.0, kind="solid", local=None, obj=None):
    """bm 을 M @ at(x, z, y, rot) [@ local] 로 배치."""
    m = M @ at(x, z, y, rot)
    if local is not None:
        m = m @ local
    B.add(bm, mat, m, kind=kind, obj=obj)


def by_normal(top, side, bottom=None, thresh=0.5):
    """윗면/옆면(/아랫면) 머티리얼 선택기."""
    def f(c, n):
        if n.z > thresh:
            return top
        if bottom is not None and n.z < -thresh:
            return bottom
        return side
    return f


# ---------------------------------------------------------------- 형태 함수(SDF)

def _smin(a, b, k):
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


def _smax(a, b, k):
    return -_smin(-a, -b, k)


def pool_sdf(x, y):
    """강낭콩(땅콩) 수영장: 14 × 7 m 스타디움에 남북 가운데를 1 m 씩 오목하게(180° 대칭)."""
    qx = x - max(-3.5, min(3.5, x))
    d = math.hypot(qx, y) - 3.5
    d = _smax(d, 2.8 - math.hypot(x, y - 5.3), 0.9)
    d = _smax(d, 2.8 - math.hypot(x, y + 5.3), 0.9)
    return d


def rrect_sdf(hw, hh, r):
    def f(x, y):
        qx = abs(x) - (hw - r)
        qy = abs(y) - (hh - r)
        return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r
    return f


def ray_boundary(sdf, ang, rmax=60.0):
    lo, hi = 0.0, rmax
    ca, sa = math.cos(ang), math.sin(ang)
    for _ in range(48):
        mid = (lo + hi) * 0.5
        if sdf(mid * ca, mid * sa) < 0:
            lo = mid
        else:
            hi = mid
    r = (lo + hi) * 0.5
    return (r * ca, r * sa)


def star_loop(sdf, n):
    return [ray_boundary(sdf, math.tau * i / n) for i in range(n)]


def offset_loop(loop, d):
    """CCW 루프를 바깥(+d)/안(-d)으로 법선 방향 이동."""
    n = len(loop)
    out = []
    for i in range(n):
        ax, ay = loop[i - 1]
        bx, by = loop[(i + 1) % n]
        tx, ty = bx - ax, by - ay
        ln = math.hypot(tx, ty) or 1.0
        nx, ny = ty / ln, -tx / ln
        out.append((loop[i][0] + nx * d, loop[i][1] + ny * d))
    return out


def pool_floor(x):
    """수영장 바닥 높이(양 끝 완만한 경사 입수로)."""
    ax = abs(x)
    a, b = 4.3, 6.95
    if ax <= a:
        return -0.65
    if ax >= b:
        return 0.0
    t = (ax - a) / (b - a)
    return -0.65 + 0.65 * t * t * (3 - 2 * t)


POOL_N = 96     # 수영장 외곽 샘플 수(0.4 m 간격 — 둥근 코핑·수면·데크 링이 모두 이 점을 공유한다)
POOL = star_loop(pool_sdf, POOL_N)
DECK_SDF = rrect_sdf(9.0, 5.5, 2.8)


# ---------------------------------------------------------------- 지면·수영장·데크

def build_ground_and_pool():
    pout = offset_loop(POOL, 0.10)
    angs = [math.atan2(y, x) for x, y in pout]
    deck = [ray_boundary(DECK_SDF, a) for a in angs]
    deck_in = [ray_boundary(rrect_sdf(9.0 - 0.3, 5.5 - 0.3, 2.5), a) for a in angs]
    def rect_loop(hx, hz):
        out = []
        for a in angs:
            ca, sa = math.cos(a), math.sin(a)
            t = min(hx / max(abs(ca), 1e-9), hz / max(abs(sa), 1e-9))
            out.append((t * ca, t * sa))
        return out
    outer = rect_loop(50.0, 44.0)
    fence_loop = rect_loop(24.4, 18.4)

    # 잔디: 펜스 안은 동서 방향 3 m 두 톤 줄무늬, 펜스 밖은 옅은 한 색(줄무늬로 자르지 않아 삼각형이 적다)
    bm = bm_ring(fence_loop, deck, 0.0)
    bisect_stripes(bm, 1, 3.0, -18.4, 18.4, offset=1.5)
    B.add(bm, lambda c, n: C["grass"] if math.floor((c.y + 1.5) / 3.0) % 2 == 0 else C["grass2"])
    B.add(bm_ring(outer, fence_loop, 0.0), C["grass_out"])

    # 데크(널판 줄무늬) + 테두리
    bm = bm_ring(deck_in, pout, 0.0)
    bisect_stripes(bm, 1, 0.45, -6, 6)
    B.add(bm, lambda c, n: C["deck"] if math.floor(c.y / 0.45) % 2 == 0 else C["deck2"])
    B.add(bm_ring(deck, deck_in, 0.0), C["deck_trim"])

    # 수영장 안쪽(벽 → 둥근 모서리 → 바닥 → 양 끝 경사)
    pin = offset_loop(POOL, -0.14)
    bm = bmesh.new()
    ra = [bm.verts.new((x, y, -0.02)) for x, y in POOL]
    rb = [bm.verts.new((x, y, min(-0.02, pool_floor(x) + 0.14))) for x, y in POOL]
    rings = [ra, rb]
    for s in (1.0, 0.84, 0.68, 0.52, 0.36, 0.2):
        rings.append([bm.verts.new((x * s, y * s, pool_floor(x * s))) for x, y in pin])
    center = bm.verts.new((0, 0, pool_floor(0)))
    n = POOL_N
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    for i in range(n):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % n], center))
    bm.normal_update()
    for f in bm.faces:
        c = f.calc_center_median()
        if f.normal.dot(Vector((-c.x, -c.y, 4.0))) < 0:
            f.normal_flip()

    def pool_mat(c, nrm):
        if nrm.z < 0.8:
            return C["tile"]
        return C["pool_ramp"] if abs(c.x) > 4.3 else C["pool_floor"]
    B.add(bm, pool_mat)

    # 가장자리 둥근 테(코핑)
    rim = [(x, y, -0.05) for x, y in offset_loop(POOL, 0.03)]
    B.add(bm_loop_tube(rim, 0.09, sides=8), C["coping"])

    # 수면
    water = offset_loop(POOL, -0.02)
    B.add(bm_star_fill(water, lambda x, y: -0.05, scales=(1.0, 0.8, 0.6, 0.4, 0.2)), "Water", kind="water", obj="water_pool")


# ---------------------------------------------------------------- 공용 소품

def slope_frame(p_top, p_bot):
    """경사면 기준 축: X = 내리막, Y = 폭, Z = 경사면 법선(위)."""
    d = (Vector(p_bot) - Vector(p_top))
    xax = d.normalized()
    yax = Vector((0, 0, 1)).cross(xax).normalized()
    zax = xax.cross(yax).normalized()
    return d.length, xax, yax, zax


def slope_mtx(p_top, p_bot, L, thick, lift=0.0, side=0.0):
    """경사를 따라 놓을 판(로컬 X = 내리막 길이 L, Z = 두께, 원점 = 판 중심)의 변환 행렬.

    판 윗면이 p_top → p_bot 을 지나고(lift = 0), lift 는 법선 방향, side 는 폭 방향 평행 이동.
    """
    _, xax, yax, zax = slope_frame(p_top, p_bot)
    m = Matrix((xax, yax, zax)).transposed().to_4x4()
    m.translation = Vector(p_top) + xax * (L / 2) - zax * (thick / 2) + zax * lift + yax * side
    return m


FLOWER_SEGS = (10, 5)   # 꽃잎 분할(6×3 은 가까이서 팝콘·자갈처럼 보였다). 송이 수는 절반 이하로 줄였다


def flowers(M, pts, colors, kind="nocol", r=0.07, segs=FLOWER_SEGS):
    for i, p in enumerate(pts):
        x, z, y = p
        col = colors[i % len(colors)]
        put(bm_ellipsoid(r, r, r * 0.55, segs[0], segs[1]), col, M, x, z, y, kind=kind)
        put(bm_ellipsoid(r * 0.45, r * 0.45, r * 0.3, 4, 2), C["lemon"] if col != C["lemon"] else C["white"], M, x, z,
            y + r * 0.7, kind=kind)


def pillar(M, x, z, rx, rz, h, rot=0.0, y=0.0, segs=16, local=None):
    """보이지 않는 수직 기둥 충돌체(타원 단면, 윗면 평평).

    둥근 풍선·화분 소품은 겉모습 메시를 그대로 충돌시키면 옆구리·고리·덤불을 발판 삼아 위로 기어올라
    산울타리·지붕으로 건너뛰는 자리가 생긴다. 옆면이 수직인 턱은 PlayerBody 로 재 보면 딛고 선 면보다
    1.45 m 높이까지 올라서고 1.50 m 부터 못 오른다 → 윗면을 주변에서 딛을 수 있는 가장 높은 면 + 1.5 m 이상으로 둔다.
    겉모습 메시는 nocol 로 두고 이 기둥만 충돌시킨다.
    rx = 로컬 X 반지름, rz = 로컬 Y 반지름(rot 으로 함께 돈다).
    """
    bm = bm_lathe([(0.0, 0.0), (1.0, 0.0), (1.0, h), (0.0, h)], segs)
    transform(bm, Matrix.Diagonal((rx, rz, 1.0, 1.0)))
    put(bm, "Invisible", M, x, z, y, rot, kind="col", local=local)


def anti_perch_cap(M, x, z, sx, sz, y0, y1, rot=0.0):
    """보이지 않는 '올라서기 방지' 덮개(상자, 게임 좌표 x·z 중심, 로컬 X = sx, 로컬 Y = sz, 높이 y0..y1).

    전망대 데크·산울타리처럼 원래 올라갈 수 있는 곳에서 뛰어 닿는 얇은 윗면(가림막 윗살, 초가지붕)은
    그 위에 서면 스폰·수영장을 내려다보는 자리가 된다. 윗면을 닿지 않는 높이(y1)까지 덮는다.
    """
    put(bm_rbox(sx, sz, y1 - y0, r=0.0, segs=0), "Invisible", M, x, z, y0, rot, kind="col")


def cooler(M, x, z, rot=0.0, body=None):
    body = body or C["aqua"]
    put(bm_rbox(0.95, 0.6, 0.66, r=0.1, segs=2, bulge=0.02), body, M, x, z, 0.0, rot)
    put(bm_rbox(1.0, 0.65, 0.22, r=0.1, segs=2), C["white"], M, x, z, 0.64, rot)
    for sx in (-1, 1):
        put(bm_tube([(sx * 0.49, -0.13, 0.52), (sx * 0.56, 0.0, 0.52), (sx * 0.49, 0.13, 0.52)], 0.03, 6),
            C["white"], M, x, z, 0.0, rot, kind="nocol")
    put(bm_rbox(0.5, 0.05, 0.12, r=0.02, segs=1), C["white"], M, x, z, 0.35, rot, kind="nocol", local=tr(0, -0.3, 0))


def planter(M, x, z, pot=None, flower=None, y=0.0):
    pot = pot or C["terracotta"]
    prof = fillet([(0, 0), (0.40, 0, 0.06), (0.50, 0.50, 0.06), (0.57, 0.55, 0.03), (0.57, 0.66, 0.04),
                   (0.47, 0.66, 0.03), (0.46, 0.58), (0, 0.58)], 0.04, 1)
    put(bm_lathe(prof, 14), pot, M, x, z, y)
    for (dx, dz, dy, r, col) in ((0, 0, 0.84, 0.42, C["leaf"]), (0.2, 0.12, 0.98, 0.26, C["leaf2"]),
                                 (-0.18, -0.1, 0.96, 0.27, C["leaf3"])):
        put(bm_ellipsoid(r, r, r * 0.9, 16 if r > 0.3 else 14, 10 if r > 0.3 else 8), col, M, x + dx, z + dz, y + dy)
    rnd = random.Random(int(abs(x) * 100 + abs(z) * 7))
    pts = []
    for k in range(4):
        a = rnd.uniform(0, math.tau)
        el = rnd.uniform(0.2, 1.1)
        pts.append((x + math.cos(a) * math.cos(el) * 0.42, z + math.sin(a) * math.cos(el) * 0.42,
                    y + 0.84 + math.sin(el) * 0.38))
    flowers(M, pts, [flower or C["pink"], C["white"], C["coral"]])


def lounger(M, x, z, rot=0.0, cushion=None):
    cushion = cushion or C["aqua"]
    put(bm_rbox(0.72, 1.9, 0.12, r=0.05, segs=2), C["white"], M, x, z, 0.18, rot)
    for lx in (-0.28, 0.28):
        for ly in (-0.8, 0.8):
            put(bm_cyl(0.05, 0.2, 6, 0.0), C["white"], M, x, z, 0.0, rot, local=tr(lx, ly, 0))
    put(bm_rbox(0.66, 1.3, 0.1, r=0.05, segs=2), cushion, M, x, z, 0.3, rot, local=tr(0, 0.28, 0))
    bm = bm_rbox(0.66, 0.62, 0.1, r=0.05, segs=2, base=False)
    transform(bm, rot_x(-38))
    put(bm, cushion, M, x, z, 0.0, rot, local=tr(0, -0.62, 0.52))
    put(bm_ellipsoid(0.24, 0.12, 0.08, 10, 5), C["white"], M, x, z, 0.0, rot, kind="nocol", local=tr(0, -0.72, 0.66))


def hedge(M, x0, x1, z):
    """산울타리(길이 x1-x0, 폭 0.8, 높이 ≈1.75).

    보이는 몸통(알약형 단면)·혹·꽃은 충돌 없음이고, 충돌은 높이 1.7 m 상자(베벨 0.1)를 따로 둔다.
    둥근 몸통을 그대로 충돌시키면 둥근 윗모서리에 캡슐이 걸쳐 올라서서 레인 분리가 깨진다.
    1.7 m 는 지면 점프(1.2 m)로 닿지 않고, 주변 3.5 m 안에는 0.9 m 넘게 올라설 소품을 두지 않는다.
    """
    L = x1 - x0
    cx = (x0 + x1) / 2
    put(bm_rbox(L, 0.8, 1.5, r=0.38, segs=3, bulge=0.05), C["hedge"], M, cx, z, kind="nocol")
    put(bm_rbox(L, 0.8, 1.7, r=0.1, segs=1), "Invisible", M, cx, z, kind="col")
    # 윗면 혹(양 끝에서 0.45 m 안쪽)
    n = int((L - 0.9) / 0.8) + 1
    for i in range(n):
        bx = x0 + 0.45 + (L - 0.9) * i / max(1, n - 1)
        put(bm_ellipsoid(0.4, 0.44, 0.34, 12, 6), C["hedge_hi"] if i % 2 else C["hedge"], M, bx, z, 1.4, kind="nocol")
    # 옆면 혹(0.5 m 간격, 양쪽 번갈아) — 끝에서 보면 판처럼 보이던 면을 깨 준다
    k = 0
    bx = x0 + 0.5
    while bx < x1 - 0.45:   # 0.6 m 간격, 양쪽 번갈아
        side = 1 if k % 2 == 0 else -1
        hy = 0.55 + 0.35 * ((k * 7) % 3) / 2
        put(bm_ellipsoid(0.32, 0.18, 0.4, 10, 5), C["hedge_hi"] if k % 3 == 1 else C["hedge"], M, bx, z + side * 0.4, hy,
            kind="nocol")
        bx += 0.6
        k += 1
    rnd = random.Random(int(abs(cx) * 31 + abs(z) * 13))
    pts = []
    for k in range(4):
        side = rnd.choice((-1, 1))
        pts.append((x0 + rnd.uniform(0.5, L - 0.5), z + side * 0.44, rnd.uniform(0.4, 1.3)))
    flowers(M, pts, [C["white"], C["pink"], C["lemon"]], r=0.06)


FOUNTAIN_R = 0.75   # 수반 바깥 반지름: 캡슐(0.4)이 붙어 서면 중심에서 1.15 m → 봇 도착 판정(1.2 m)·보충 반경(1.5 m) 안
REFILL_R = 1.5


def fountain(M, x, z):
    """물 보충 분수(랜드마크): 하늘색 타일 수반 + 흰 윗테 + 높은 물기둥·거품, 바닥에 보충 반경 링."""
    R = FOUNTAIN_R
    basin = fillet([(0, 0), (R - 0.1, 0, 0.08), (R - 0.08, 0.58, 0.1), (R, 0.78, 0.06), (R, 0.9, 0.05),
                    (R - 0.15, 0.9, 0.04), (R - 0.17, 0.72, 0.04), (0, 0.72)], 0.05, 1)

    def basin_mat(c, n):
        r = math.hypot(c.x, c.y)
        if c.z > 0.76 and r > R - 0.13:
            return C["white"]            # 윗테(바깥 턱 + 윗면)
        if r < R - 0.13 and c.z > 0.6:
            return C["fountain_band"]    # 안쪽 띠
        return C["tile_out"]
    put(bm_lathe(basin, 28), basin_mat, M, x, z)
    put(bm_cyl(0.17, 0.62, 12, 0.04, r_top=0.12), C["white"], M, x, z, 0.7)
    bowl = fillet([(0, 0), (0.1, 0, 0.03), (0.45, 0.14, 0.05), (0.5, 0.22, 0.03), (0.42, 0.24, 0.02), (0, 0.2)], 0.03, 2)
    put(bm_lathe(bowl, 24), lambda c, n: C["fountain_band"] if (n.z > 0.5 and math.hypot(c.x, c.y) < 0.43) else C["white"],
        M, x, z, 1.24)
    # 물(충돌 없음): 수반 수면, 윗 그릇 수면, 흘러내리는 물막, 물기둥 + 거품
    put(bm_lathe([(0, 0), (R - 0.16, 0), (R - 0.16, 0.02), (0, 0.02)], 32), "Water", M, x, z, 0.8, kind="nocol")
    put(bm_lathe([(0, 0), (0.44, 0), (0.44, 0.02), (0, 0.02)], 16), "Water", M, x, z, 1.4, kind="nocol")
    put(bm_lathe([(0.47, 0.82), (0.52, 0.95), (0.545, 1.12), (0.53, 1.3), (0.5, 1.44)], 24), "Water", M, x, z, 0.0,
        kind="nocol")
    put(bm_cyl(0.12, 0.9, 12, 0.06), "Water", M, x, z, 1.4, kind="nocol")
    put(bm_sphere(0.18, 16, 10), C["foam"], M, x, z, 2.3, kind="nocol")
    # 가운데 기둥·윗 그릇(1.5 m)을 발판 삼아 오리·고래 위로 건너뛰지 못하게 보이지 않는 기둥으로 감싼다(윗면 2.6 m)
    pillar(M, x, z, 0.52, 0.52, 1.9, y=0.7)
    # 보충 반경 표시 링(바닥, 충돌 없음)
    w = 0.06
    put(bm_lathe([(REFILL_R + w, 0.0), (REFILL_R + w, 0.03), (REFILL_R - w, 0.03), (REFILL_R - w, 0.0)], 64),
        C["tile_out"], M, x, z, 0.0, kind="nocol")
    rnd = random.Random(int(abs(x) * 17 + abs(z) * 5))
    pts = []
    for k in range(6):
        a = math.tau * k / 6 + rnd.uniform(-0.12, 0.12)
        rr = rnd.uniform(R + 0.12, R + 0.24)
        pts.append((x + math.cos(a) * rr, z + math.sin(a) * rr, 0.08))
    flowers(M, pts, [C["pink"], C["lemon"], C["white"], C["coral"]], r=0.08)


def laundry(M, x0, x1, z):
    """빨랫줄(전부 장식, 충돌 없음). 수건은 시야만 가리고 물·사람은 통과한다.
    기둥 꼭대기(2.4 m)도 고래·산울타리를 잇는 징검다리가 돼서 가는 기둥까지 nocol 로 뒀다."""
    for px in (x0, x1):
        put(bm_cyl(0.07, 2.4, 10, 0.03), C["white"], M, px, z, kind="nocol")
        put(bm_rbox(0.09, 0.8, 0.09, r=0.035, segs=1), C["white"], M, px, z, 2.28, kind="nocol")
        put(bm_sphere(0.09, 8, 5), C["coral"], M, px, z, 2.46, kind="nocol")
    towels = [(C["coral"], C["white"]), (C["aqua"], C["lemon"]), (C["mint"], C["white"]), (C["pink"], C["lemon"])]
    n = len(towels)
    span = x1 - x0
    for zz in (-0.3, 0.3):
        pts = [G(x0 + span * k / 10, z + zz, 2.3 - 0.1 * math.sin(math.pi * k / 10)) for k in range(11)]
        put(bm_tube(pts, 0.015, 5, caps=False), C["white"], M, 0, 0, kind="nocol")
    for i, (a, b) in enumerate(towels):
        t = (i + 0.5) / n
        tx = x0 + span * t
        zz = -0.3 if i % 2 == 0 else 0.3
        top = 2.3 - 0.1 * math.sin(math.pi * t) - 0.02
        bm = bm_rbox(0.95, 0.045, 1.8, r=0.02, segs=1)
        bisect_stripes(bm, 2, 0.3, 0, 1.8)
        put(bm, lambda c, nn, a=a, b=b: a if math.floor(c.z / 0.3) % 2 == 0 else b, M, tx, z + zz, top - 1.8, kind="nocol")
        for px in (-0.3, 0.3):
            put(bm_rbox(0.04, 0.06, 0.12, r=0.015, segs=1), C["wood"], M, tx + px, z + zz, top - 0.04, kind="nocol")


def towel_rack(M, x, z):
    """수건 거치대. 가로대를 사다리처럼 밟고 1.4 m 위로 올라 빨랫줄 T자 받침 → 산울타리로 건너뛰는 길이 있어서
    겉모습은 nocol, 충돌은 거치대 전체를 감싼 보이지 않는 상자(윗면 1.55 m, 지면 점프로 닿지 않음) — 엄폐물로 읽힌다."""
    for sx in (-0.75, 0.75):
        put(bm_rbox(0.09, 0.09, 1.3, r=0.03, segs=1), C["wood"], M, x + sx, z, kind="nocol")
        put(bm_rbox(0.12, 0.7, 0.08, r=0.03, segs=1), C["wood"], M, x + sx, z, kind="nocol")
        put(bm_sphere(0.07, 8, 5), C["wood_dark"], M, x + sx, z, 1.32, kind="nocol")
    for hy in (1.25, 0.75):
        put(bm_tube([G(x - 0.75, z, hy), G(x + 0.75, z, hy)], 0.035, 8), C["wood_dark"], M, 0, 0, kind="nocol")
    put(bm_rbox(1.62, 0.3, 1.55, r=0.0, segs=0), "Invisible", M, x, z, kind="col")
    for (dz, col, col2) in ((-0.07, C["aqua"], C["white"]), (0.07, C["peach"], C["white"])):
        bm = bm_rbox(1.3, 0.035, 0.85, r=0.015, segs=1)
        bisect_stripes(bm, 0, 0.2, -0.65, 0.65)
        put(bm, lambda c, n, a=col, b=col2: a if math.floor(c.x / 0.2) % 2 == 0 else b, M, x, z + dz, 0.4, kind="nocol")
    put(bm_tube([G(x - 0.65, z, 1.27), G(x + 0.65, z, 1.27)], 0.075, 8), C["aqua"], M, 0, 0, kind="nocol")


def jump_pad(M, x, z, tx, tz):
    """낮은 풍선 트램펄린(윗면 PAD_TOP). 테두리 경사 ≈ 33° 라 걸어서 올라가도 발동한다.

    (tx, tz) = 착지 목표(게임 좌표): 가운데 흰 원판 위 셰브론 2개가 그쪽을 가리킨다.
    둘레 바닥의 분홍 점선 링은 튜브 더미·도넛 같은 수영장 장난감과 구분되는 '발판' 표시.
    """
    prof = fillet([(0, 0), (1.28, 0, 0.02), (1.3, 0.03, 0.03), (1.04, 0.2, 0.08), (0.95, 0.22, 0.05),
                   (0.88, PAD_TOP, 0.03), (0, PAD_TOP)], 0.04, 2)

    def mat(c, n):
        r = math.hypot(c.x, c.y)
        if r > 0.9:
            return C["pad_rim"] if math.floor(math.atan2(c.y, c.x) / (math.tau / 12)) % 2 == 0 else C["white"]
        return C["pad_mat"]
    put(bm_lathe(prof, 30), mat, M, x, z)
    put(bm_torus(0.62, 0.035, 30, 6, 0, 180, close=False), C["white"], M, x, z, PAD_TOP - 0.012, kind="nocol")
    put(bm_lathe([(0, 0), (0.34, 0), (0.34, 0.012), (0, 0.012)], 24), C["white"], M, x, z, PAD_TOP, kind="nocol")
    # 셰브론(로컬 +X 를 가리키는 V) — 목표 방향으로 돌린다(Blender XY = (게임 x, -게임 z))
    ang = math.degrees(math.atan2(-(tz - z), tx - x))
    chev = fillet_closed([(0.125, 0.0), (-0.025, 0.2), (-0.125, 0.2), (0.025, 0.0), (-0.125, -0.2), (-0.025, -0.2)],
                         0.015, 1)
    for off in (-0.1, 0.13):
        bm = bm_prism(chev, 0.0, 0.01)
        transform(bm, Matrix.Translation((off, 0, 0)))
        put(bm, C["pad_mat"], M, x, z, PAD_TOP + 0.012, rot=ang, kind="nocol")
    dash = fillet_closed([(-0.05, -0.15), (0.05, -0.15), (0.05, 0.15), (-0.05, 0.15)], 0.045, 1)
    for k in range(14):
        bm = bm_prism(dash, 0.0, 0.02)
        transform(bm, Matrix.Translation((1.47, 0, 0)))
        transform(bm, rot_z(360 * k / 14))
        put(bm, C["pad_mat"], M, x, z, 0.0, kind="nocol")


def bbq(M, x, z, y=0.0, rot=0.0):
    put(bm_rbox(1.2, 0.62, 0.6, r=0.1, segs=2, bulge=0.02), C["coral"], M, x, z, y + 0.14, rot)
    for lx in (-0.48, 0.48):
        for ly in (-0.22, 0.22):
            put(bm_cyl(0.05, 0.16, 6, 0.0), C["charcoal"], M, x, z, y, rot, local=tr(lx, ly, 0))
    put(bm_ellipsoid(0.56, 0.29, 0.27, 16, 8), C["charcoal"], M, x, z, y + 0.73, rot)
    put(bm_tube([(-0.2, -0.22, 0.93), (-0.2, -0.3, 0.97), (0.2, -0.3, 0.97), (0.2, -0.22, 0.93)], 0.025, 6),
        C["white"], M, x, z, y, rot, kind="nocol")
    for sx in (-1, 1):
        put(bm_rbox(0.3, 0.5, 0.05, r=0.02, segs=1), C["wood"], M, x, z, y + 0.68, rot, local=tr(sx * 0.74, 0, 0))


def umbrella_table(M, x, z, y, team):
    tcol = C["team0"] if team == 0 else C["team1"]
    tlt = C["team0_lt"] if team == 0 else C["team1_lt"]
    put(bm_cyl(0.3, 0.05, 16, 0.02), C["white"], M, x, z, y)
    put(bm_cyl(0.06, 0.72, 10, 0.02), C["white"], M, x, z, y)
    put(bm_cyl(0.66, 0.06, 24, 0.03), C["white"], M, x, z, y + 0.72)
    put(bm_cyl(0.035, 1.9, 8, 0.01), C["white"], M, x, z, y + 0.78)
    canopy = bm_lathe([(0.0, 2.34), (1.5, 2.16), (1.52, 2.22), (0.0, 2.7)], 16, phase=math.pi / 16)
    # 캐노피는 장식(충돌 없음): 충돌시키면 BBQ 뚜껑에서 뛰어 캐노피 위(3.8 m)로 올라가 맵 전체를 내려다봤다
    put(canopy, lambda c, n: tcol if math.floor((math.atan2(c.y, c.x) + math.tau) / (math.tau / 8)) % 2 == 0 else C["white"],
        M, x, z, y, kind="nocol")
    put(bm_sphere(0.07, 8, 5), tcol, M, x, z, y + 2.74, kind="nocol")
    for sz in (-1, 1):
        cx, cz = x - 0.35, z + sz * 0.95
        rot = math.degrees(math.atan2(x - cx, z - cz))  # 의자 정면(로컬 -Y)이 테이블을 본다
        put(bm_cyl(0.2, 0.04, 12, 0.02), C["white"], M, cx, cz, y)
        put(bm_cyl(0.04, 0.4, 8, 0.01), C["white"], M, cx, cz, y)
        put(bm_rbox(0.46, 0.46, 0.1, r=0.04, segs=1), tlt, M, cx, cz, y + 0.4, rot)
        put(bm_rbox(0.46, 0.09, 0.42, r=0.04, segs=1), tlt, M, cx, cz, y + 0.46, rot, local=tr(0, 0.2, 0))


def lattice(M, cx, cz, L, y, rot=0.0, style="lattice"):
    """길이 L, 높이 1.8 가림막(로컬 Y 방향으로 뻗음, rot=0 이면 게임 z 방향).

    style='lattice': 초록 판(덩굴) 위 흰 사선 살 + 꽃 / 'climb': 놀이터 암벽(알록달록 손잡이).
    """
    m = M @ at(cx, cz, y, rot)
    climb = style == "climb"
    B.add(bm_rbox(0.07, L - 0.1, 1.72, r=0.02, segs=1), C["butter"] if climb else C["lattice_bg"], m @ tr(0, 0, 0.06))
    post = C["coral"] if climb else C["white"]
    for yy in (-L / 2 + 0.07, L / 2 - 0.07):
        B.add(bm_rbox(0.14, 0.14, 1.9, r=0.04, segs=1), post, m @ tr(0, yy, 0))
        B.add(bm_sphere(0.1, 8, 5), C["mint"] if climb else C["white"], m @ tr(0, yy, 1.98))
    for hy in (0.06, 1.74):
        B.add(bm_rbox(0.12, L - 0.14, 0.08, r=0.03, segs=1), post, m @ tr(0, 0, hy))
    rnd = random.Random(int(abs(cx) * 3 + abs(cz) * 11 + rot))
    if climb:
        cols = [C["coral"], C["mint"], C["aqua"], C["pink"], C["lavender"]]
        for side in (-1, 1):
            for k in range(int(L * 5)):
                bm = bm_ellipsoid(0.09, 0.07, 0.06, 6, 3)
                transform(bm, rot_y(90 * side))
                B.add(bm, cols[k % 5], m @ tr(side * 0.04, rnd.uniform(-L / 2 + 0.2, L / 2 - 0.2), rnd.uniform(0.25, 1.6)),
                      kind="nocol")
        return
    u0, u1, v0, v1 = -L / 2 + 0.12, L / 2 - 0.12, 0.14, 1.74
    for side in (-1, 1):
        xo = side * 0.05
        for sgn in (1, -1):
            c = -8.0
            while c < 8.0:
                lo_u, hi_u = sorted(((v0 - c) / sgn, (v1 - c) / sgn))
                a, b = max(u0, lo_u), min(u1, hi_u)
                if b - a > 0.08:
                    B.add(bm_tube([(xo, a, sgn * a + c), (xo, b, sgn * b + c)], 0.022, 4, caps=False), C["white"], m,
                          kind="nocol")
                c += 0.45
    for k in range(int(L * 1.6)):   # 덩굴 꽃: 송이 수를 줄이고 분할을 올렸다(5×3 은 팝콘처럼 보였다)
        side = rnd.choice((-1, 1))
        col = (C["pink"], C["white"], C["rose"])[k % 3]
        B.add(bm_ellipsoid(0.08, 0.08, 0.064, 8, 4), col, m @ tr(side * 0.08, rnd.uniform(-L / 2 + 0.2, L / 2 - 0.2),
                                                                 rnd.uniform(0.25, 1.9)), kind="nocol")
    for k in range(int(L * 1.5)):
        side = rnd.choice((-1, 1))
        B.add(bm_ellipsoid(0.12, 0.22, 0.16, 8, 5), C["leaf"], m @ tr(side * 0.07, rnd.uniform(-L / 2 + 0.3, L / 2 - 0.3),
                                                                      rnd.uniform(1.6, 1.95)), kind="nocol")


def float_stack(M, x, z):
    """수영장 튜브를 쌓아 둔 더미(키 ≈ 2.25 m) — 데크 모서리 시야 차단 엄폐.

    고리가 계단처럼 층층이 있어 겉모습을 그대로 충돌시키면 꼭대기(2.25 m)까지 올라가 울타리로 건너뛴다
    → 겉모습은 nocol, 충돌은 보이지 않는 기둥 하나.
    """
    put(bm_cyl(0.32, 1.7, 12, 0.05), C["white"], M, x, z, kind="nocol")
    cols = [C["butter"], C["pink"], C["aqua"], C["mint"]]
    for k, col in enumerate(cols):
        ring = bm_torus(0.5, 0.21, 22, 9)
        transform(ring, rot_x(6 if k % 2 else -5))
        put(ring, col, M, x + (0.04 if k % 2 else -0.03), z, 0.22 + 0.42 * k, 20 * k, kind="nocol")
    put(bm_sphere(0.3, 16, 10), lambda c, n: [C["coral"], C["white"], C["butter"], C["white"]][
        int(((math.atan2(c.y, c.x) + math.tau) % math.tau) / (math.tau / 4)) % 4], M, x, z, 1.95, kind="nocol")
    pillar(M, x, z, 0.7, 0.7, 2.25)


def rubber_duck(M, x, z, rot=0.0):
    """잔디 위 대형 고무오리 튜브(키 ≈ 2.05 m). 로컬 -Y 가 정면. 충돌은 보이지 않는 타원 기둥(올라서지 못함)."""
    yel, beak = C["lemon"], C["coral"]
    put(bm_ellipsoid(0.85, 1.05, 0.62, 18, 10), yel, M, x, z, 0.62, rot, kind="nocol")
    put(bm_ellipsoid(0.3, 0.3, 0.26, 10, 6), yel, M, x, z, 1.02, rot, kind="nocol", local=tr(0, 0.95, 0))
    put(bm_sphere(0.5, 16, 9), yel, M, x, z, 1.55, rot, kind="nocol", local=tr(0, -0.55, 0))
    put(bm_ellipsoid(0.26, 0.24, 0.1, 10, 5), beak, M, x, z, 1.44, rot, kind="nocol", local=tr(0, -1.02, 0))
    pillar(M, x, z, 0.8, 1.0, 2.45, rot)
    for sx in (-1, 1):
        put(bm_sphere(0.07, 8, 5), C["ink"], M, x, z, 1.7, rot, kind="nocol", local=tr(sx * 0.2, -0.98, 0))
        put(bm_sphere(0.025, 5, 3), C["white"], M, x, z, 1.73, rot, kind="nocol", local=tr(sx * 0.2 + 0.02, -1.04, 0))
        put(bm_ellipsoid(0.12, 0.08, 0.05, 8, 4), C["pink"], M, x, z, 1.52, rot, kind="nocol", local=tr(sx * 0.33, -0.9, 0))
        wing = bm_ellipsoid(0.14, 0.5, 0.3, 10, 6)
        put(wing, C["duck_wing"], M, x, z, 0.75, rot, kind="nocol", local=tr(sx * 0.8, 0.1, 0))


def whale(M, x, z, rot=0.0):
    """풍선 고래(키 ≈ 2.0 m). 로컬 -Y 가 머리.

    둥근 옆구리(1.3 m 이상)는 지면 점프로 올라설 수 있어 산울타리 옆에서 발판이 됐다
    → 겉모습은 nocol, 충돌은 보이지 않는 타원 기둥(윗면 2.4 m: 쿨러 뚜껑 0.86 m 에서도 닿지 않음).
    """
    body, belly = C["aqua"], C["white"]
    put(bm_ellipsoid(0.9, 1.3, 0.8, 18, 10), body, M, x, z, 0.8, rot, kind="nocol")
    put(bm_ellipsoid(0.72, 0.9, 0.45, 14, 7), belly, M, x, z, 0.5, rot, kind="nocol", local=tr(0, -0.25, 0))
    tail = bm_ellipsoid(0.22, 0.5, 0.18, 10, 6)
    transform(tail, rot_x(-50))
    put(tail, body, M, x, z, 1.35, rot, kind="nocol", local=tr(0, 1.3, 0))
    pillar(M, x, z, 0.82, 1.22, 2.4, rot)
    for sx in (-1, 1):
        fl = bm_ellipsoid(0.45, 0.2, 0.1, 10, 5)
        transform(fl, rot_y(sx * 35))
        put(fl, body, M, x, z, 1.55, rot, kind="nocol", local=tr(sx * 0.35, 1.52, 0))
        put(bm_sphere(0.07, 8, 5), C["ink"], M, x, z, 1.0, rot, kind="nocol", local=tr(sx * 0.55, -0.9, 0))
        put(bm_ellipsoid(0.12, 0.05, 0.08, 8, 4), C["pink"], M, x, z, 0.85, rot, kind="nocol", local=tr(sx * 0.62, -0.95, 0))
    for k, (dx, dy, r) in enumerate(((0.0, 1.72, 0.1), (0.12, 1.9, 0.08), (-0.12, 1.92, 0.08), (0.0, 2.05, 0.07))):
        put(bm_sphere(r, 8, 5), "Water", M, x, z, dy, rot, kind="nocol", local=tr(dx, -0.4, 0))


def leaning_raft(M, x, z, rot=0.0):
    """세워서 기대 둔 줄무늬 에어매트(2.0 × 0.85 m, 충돌) + A자 거치대."""
    bm = bm_rbox(0.85, 0.2, 2.0, r=0.09, segs=2, base=False)
    bisect_stripes(bm, 2, 0.4, -1.0, 1.0, offset=0.2)
    transform(bm, rot_x(-10))
    put(bm, lambda c, n: C["coral"] if math.floor((c.z - 0.2) / 0.4) % 2 == 0 else C["white"], M, x, z, 1.07, rot)
    for sx in (-0.34, 0.34):
        put(bm_tube([(sx, 0.55, 0.0), (sx, 0.12, 1.75)], 0.04, 6), C["white"], M, x, z, 0.0, rot)
    put(bm_ellipsoid(0.34, 0.1, 0.12, 10, 5), C["white"], M, x, z, 1.9, rot, kind="nocol", local=tr(0, -0.2, 0))


def shrub(M, x, z, r=1.2):
    """큰 둥근 관목(충돌, 키 ≈ 2.3 m)."""
    put(bm_ellipsoid(r, r, r * 0.85, 20, 12), C["leaf3"], M, x, z, r * 0.8)
    put(bm_ellipsoid(r * 0.62, r * 0.62, r * 0.55, 16, 9), C["leaf"], M, x + r * 0.45, z - r * 0.3, r * 1.45)
    put(bm_ellipsoid(r * 0.55, r * 0.55, r * 0.5, 16, 9), C["leaf2"], M, x - r * 0.5, z + r * 0.2, r * 1.3)
    rnd = random.Random(int(abs(x) * 5 + abs(z) * 9))
    pts = []
    for k in range(5):
        a, e = rnd.uniform(0, math.tau), rnd.uniform(-0.3, 0.9)
        pts.append((x + math.cos(a) * math.cos(e) * r, z + math.sin(a) * math.cos(e) * r, r * 0.8 + math.sin(e) * r * 0.85))
    flowers(M, pts, [C["white"], C["pink"], C["sun"]], r=0.09)


def topiary(M, x, z):
    """화분에 심은 동글동글 토피어리(키 ≈ 2.6 m) — 대각선 긴 시야를 끊는 엄폐."""
    prof = fillet([(0, 0), (0.5, 0, 0.06), (0.62, 0.55, 0.06), (0.68, 0.6, 0.03), (0.68, 0.7, 0.03), (0.56, 0.7), (0, 0.7)],
                  0.04, 1)
    put(bm_lathe(prof, 16), C["white"], M, x, z, kind="nocol")
    put(bm_cyl(0.1, 0.5, 8, 0.0), C["trunk"], M, x, z, 0.65, kind="nocol")
    put(bm_ellipsoid(0.82, 0.82, 0.74, 20, 12), C["hedge"], M, x, z, 1.4, kind="nocol")
    put(bm_ellipsoid(0.56, 0.56, 0.5, 16, 9), C["hedge_hi"], M, x, z, 2.35, kind="nocol")
    put(bm_sphere(0.24, 14, 8), C["hedge"], M, x, z, 2.95, kind="nocol")
    # 동글동글 층을 밟고 3 m 꼭대기까지 오르지 못하게 충돌은 수직 기둥 하나
    pillar(M, x, z, 0.7, 0.7, 3.0)
    rnd = random.Random(int(abs(x) * 7 + abs(z) * 3))
    pts = []
    for k in range(4):
        a, e = rnd.uniform(0, math.tau), rnd.uniform(-0.6, 0.9)
        pts.append((x + math.cos(a) * math.cos(e) * 0.83, z + math.sin(a) * math.cos(e) * 0.83, 1.4 + math.sin(e) * 0.74))
    flowers(M, pts, [C["pink"], C["white"]], r=0.08)


def bunting(M, x, z0, z1, y, colors):
    pts = [G(x, z0 + (z1 - z0) * k / 12, y - 0.35 * math.sin(math.pi * k / 12)) for k in range(13)]
    put(bm_tube(pts, 0.015, 5, caps=False), C["white"], M, 0, 0, kind="nocol")
    n = 14
    for k in range(n):
        t = (k + 0.5) / n
        zz = z0 + (z1 - z0) * t
        yy = y - 0.35 * math.sin(math.pi * t) - 0.02
        tri = fillet_closed([(-0.2, 0.0), (0.0, -0.34), (0.2, 0.0)], 0.03, 1)
        bm = bm_prism(tri, -0.01, 0.01)
        transform(bm, rot_x(90))
        transform(bm, rot_z(90))
        put(bm, colors[k % len(colors)], M, x, zz, yy, kind="nocol")


def team_sign(M, x, z, y, team):
    tcol = C["team0"] if team == 0 else C["team1"]
    bm = bm_cyl(0.75, 0.06, 28, 0.02)
    transform(bm, rot_y(90))
    put(bm, tcol, M, x, z, y, kind="nocol")
    drop = fillet_closed([(0.0, 0.42), (-0.28, -0.05), (-0.2, -0.3), (0.2, -0.3), (0.28, -0.05)], 0.14, 3)
    bm = bm_prism(drop, 0.0, 0.03)
    transform(bm, rot_x(90))
    transform(bm, rot_z(90))
    put(bm, C["white"], M, x + 0.05, z, y, kind="nocol")


def outdoor_rug(M, x, z, y, team):
    """스폰 앞 파티오 바닥의 야외 러그(충돌 없음): 팀 연색·흰 줄무늬."""
    tl = C["team0_lt"] if team == 0 else C["team1_lt"]
    bm = bm_rbox(2.0, 3.0, 0.03, r=0.012, segs=1)
    bisect_stripes(bm, 1, 0.5, -1.5, 1.5)
    put(bm, lambda c, n: (tl if math.floor(c.y / 0.5) % 2 == 0 else C["white"]) if n.z > 0.5 else tl, M, x, z, y,
        kind="nocol")
    for sy in (-1, 1):
        put(bm_tube([(-0.95, sy * 1.52, 0.012), (0.95, sy * 1.52, 0.012)], 0.02, 5), C["white"], M, x, z, y, kind="nocol")


def patio_props(M, team):
    y = 1.0
    # BBQ 는 파티오 뒤(펜스 쪽)에 둔다 — 안쪽 가장자리에 두면 뚜껑 위에 올라서서 가림막 너머를 내려다본다.
    # 파라솔에서도 3 m 이상 떨어뜨린다(뚜껑 2.0 m 에서 캐노피·가림막에 닿지 않게)
    bbq(M, -23.55, -5.6, y, rot=90)
    umbrella_table(M, -22.9, 0.0, y, team)
    # 안쪽 가장자리 가림막: 북쪽 격자 z∈[3, 8] + 남쪽 격자 z∈[-7.5, -1] → 가운데 4 m 출구만 열린다
    # (파티오↔파티오·적 전망대↔스폰 시야를 끊는다, design-synthesis §10)
    lattice(M, -18.4, 5.5, 5.0, y)
    lattice(M, -18.4, -4.25, 6.5, y)
    # 북쪽 격자는 자기 전망대 데크(3.6 m)에서 3 m 거리라 윗살(2.8 m)에 뛰어내려 스폰을 내려다볼 수 있었다
    # → 데크·난간에서 닿지 않는 6.0 m 까지 윗면을 덮는다(격자 위 좁은 띠라 사선 사격 영향은 작다)
    anti_perch_cap(M, -18.4, 5.5, 0.3, 5.0, y + 1.8, 6.0)
    tkey = "team0" if team == 0 else "team1"
    planter(M, -23.55, 7.3, y=y, flower=C[tkey])
    planter(M, -23.55, -7.3, y=y, flower=C[tkey])
    tc = [C[tkey], C["white"], C[tkey + "_lt"]]
    bunting(M, -24.25, -7.6, 7.6, y + 2.25, tc)
    team_sign(M, -24.3, 0.0, y + 1.25, team)
    outdoor_rug(M, -20.9, 0.0, y, team)


def curtain_wall(sx, sy, h, axis):
    """커튼 벽: 두께 방향으로 사인 주름(진폭 0.035, 주기 0.5 m — 줄무늬 경계가 마디)."""
    bm = bm_rbox(sx, sy, h, r=0.05, segs=1)
    L = sy if axis == 1 else sx
    bisect_stripes(bm, axis, 0.125, -L / 2, L / 2)
    for v in bm.verts:
        s_ = v.co[axis]
        d = 0.035 * math.sin(math.tau * s_ / 0.5)
        if axis == 1:
            v.co.x += d
        else:
            v.co.y += d
    return bm


def cabana(M, x, z):
    """3 × 4 m 카바나(서쪽 판: 열린 면 = 동쪽 +x). 벽은 산호색·흰색 세로 줄무늬 커튼(주름)."""
    put(bm_rbox(3.2, 4.2, 0.08, r=0.04, segs=1), C["white"], M, x, z)

    def stripes_y(c, n):
        return C["coral"] if math.floor(c.y / 0.5) % 2 == 0 else C["white"]

    def stripes_x(c, n):
        return C["coral"] if math.floor(c.x / 0.5) % 2 == 0 else C["white"]
    put(curtain_wall(0.14, 3.72, 2.2, 1), stripes_y, M, x - 1.43, z)
    for sz in (-1, 1):
        put(curtain_wall(2.72, 0.14, 2.2, 0), stripes_x, M, x, z + sz * 1.93)
        for px in (-1.45, 1.45):
            put(bm_cyl(0.1, 2.25, 12, 0.03), C["white"], M, x + px, z + sz * 1.93)
        # 열린 쪽 양옆의 묶은 커튼 자락 + 끈
        put(bm_ellipsoid(0.12, 0.18, 0.9, 12, 8), C["coral"], M, x + 1.36, z + sz * 1.7, 1.22, kind="nocol")
        put(bm_torus(0.15, 0.025, 12, 4), C["white"], M, x + 1.36, z + sz * 1.7, 1.05, kind="nocol")
    # 커튼 봉(벽 윗단 바깥 둘레 + 열린 면)
    rod = [G(x + 1.45, z - 1.93 - 0.1, 2.12), G(x - 1.43 - 0.1, z - 1.93 - 0.1, 2.12), G(x - 1.43 - 0.1, z + 1.93 + 0.1, 2.12),
           G(x + 1.45, z + 1.93 + 0.1, 2.12), G(x + 1.45, z - 1.93 - 0.1, 2.12)]
    B.add(bm_tube(rod, 0.05, 8, caps=False), C["white"], M, kind="nocol")
    roof = bm_rbox(3.5, 4.5, 0.42, r=0.2, segs=3)
    bisect_stripes(roof, 1, 0.5, -2.25, 2.25)
    put(roof, lambda c, n: (C["coral"] if math.floor(c.y / 0.5) % 2 == 0 else C["white"]) if n.z > 0.5 else C["white"],
        M, x, z, 2.2)
    for k in range(9):
        zz = z - 2.0 + 4.0 * k / 8
        put(bm_ellipsoid(0.07, 0.24, 0.2, 8, 4), C["coral"] if k % 2 == 0 else C["white"], M, x + 1.74, zz, 2.22, kind="nocol")
    put(bm_sphere(0.14, 10, 6), C["lemon"], M, x, z, 2.68)
    put(bm_rbox(0.95, 3.0, 0.36, r=0.1, segs=2), C["white"], M, x - 0.86, z, 0.08)
    put(bm_rbox(0.9, 2.9, 0.13, r=0.06, segs=2), C["mint"], M, x - 0.86, z, 0.44)
    for sz in (-1.1, 1.1):
        put(bm_ellipsoid(0.16, 0.3, 0.16, 10, 6), C["pink"], M, x - 1.12, z + sz, 0.7, kind="nocol")


def tiki_bar(M, x, z):
    """4 × 2 m 티키 바(북쪽 판: 카운터가 수영장(남쪽 = 로컬 +Y) 쪽)."""
    put(bm_rbox(4.0, 0.75, 1.03, r=0.08, segs=2), C["wood_dark"], M, x, z, 0.0, local=tr(0, 0.62, 0))
    put(bm_rbox(4.3, 0.98, 0.09, r=0.04, segs=2), C["wood"], M, x, z, 1.02, local=tr(0, 0.62, 0))
    for k in range(21):
        bx = -1.95 + 3.9 * k / 20
        put(bm_cyl(0.09, 1.0, 6, 0.0), C["bamboo"] if k % 3 else C["thatch2"], M, x, z, 0.0, kind="nocol",
            local=tr(bx, 1.0, 0))
    # 뒷벽(바깥쪽, 지붕까지 막힘) + 선반 + 병 + 메뉴판
    bm = bm_rbox(4.0, 0.22, 2.25, r=0.06, segs=2)
    bisect_stripes(bm, 0, 0.26, -2.0, 2.0)
    put(bm, lambda c, n: C["bamboo"] if math.floor(c.x / 0.26) % 2 == 0 else C["thatch2"], M, x, z, 0.0,
        local=tr(0, -0.89, 0))
    put(bm_rbox(3.6, 0.18, 0.07, r=0.03, segs=1), C["wood"], M, x, z, 1.35, local=tr(0, -0.7, 0))
    cols = [C["mint"], C["pink"], C["lemon"], C["aqua"], C["coral"]]
    for k in range(9):
        bx = -1.6 + 3.2 * k / 8
        put(bm_cyl(0.05, 0.24, 6, 0.0, r_top=0.025), cols[k % 5], M, x, z, 1.42, kind="nocol", local=tr(bx, -0.7, 0))
    put(bm_rbox(1.3, 0.05, 0.6, r=0.04, segs=1), C["white"], M, x, z, 0.55, kind="nocol", local=tr(-0.9, -0.76, 0))
    for k, col in enumerate((C["coral"], C["mint"], C["sun"])):
        put(bm_rbox(0.8 - 0.15 * k, 0.03, 0.07, r=0.0, segs=0), col, M, x, z, 0.98 - 0.15 * k, kind="nocol",
            local=tr(-0.95, -0.735, 0))
    for (px, py) in ((-1.92, 0.95), (1.92, 0.95), (-1.92, -0.95), (1.92, -0.95)):
        put(bm_cyl(0.08, 2.3, 8, 0.03), C["bamboo"], M, x, z, 0.0, local=tr(px, py, 0))
    prof = fillet([(0, 0), (1.0, 0, 0.0), (1.02, 0.08, 0.04), (0.55, 0.42, 0.12), (0.16, 0.62, 0.1), (0, 0.66)], 0.08, 2)
    roof = bm_lathe(prof, 16, phase=math.pi / 16)
    transform(roof, Matrix.Diagonal((2.55, 1.6, 1.0, 1.0)))
    put(roof, C["thatch"], M, x, z, 2.2)
    fringe = bm_torus(1.0, 0.06, 32, 6)
    transform(fringe, Matrix.Diagonal((2.55, 1.6, 1.0, 1.0)))
    put(fringe, C["thatch2"], M, x, z, 2.22, kind="nocol")
    # 초가지붕 위(2.3~2.9 m)는 산울타리 위에서 뛰어 닿아 수영장 한가운데를 내려다보는 자리였다
    # → 지붕 윤곽을 따라 산울타리(1.7 m)에서 닿지 않는 3.4 m 까지 채운다(보이는 지붕 꼭대기보다 0.5 m 위까지만)
    pillar(M, x, z, 2.62, 1.66, 1.2, y=2.2, segs=20)
    for k, col in enumerate((C["pink"], C["lemon"], C["mint"])):
        put(bm_sphere(0.16, 8, 5), col, M, x, z, 1.95, kind="nocol", local=tr(-1.2 + 1.2 * k, 1.35, 0))
    for sx in (-1, 1):
        put(bm_cyl(0.04, 1.6, 8, 0.01), C["bamboo"], M, x, z, 0.0, kind="nocol", local=tr(sx * 2.35, 1.2, 0))
        put(bm_ellipsoid(0.1, 0.1, 0.16, 8, 5), C["sun"], M, x, z, 1.65, kind="nocol", local=tr(sx * 2.35, 1.2, 0))


def flamingo(M, x, z, rot, swan=False):
    """수영장에 떠 있는 홍학(팀 0 쪽)/백조(팀 1 쪽) 튜브(정적, 충돌). 로컬 +X 가 머리 쪽.

    두 마리가 같은 형태로 원점 대칭 자리(±2.2, ±0.9)에 떠 있어 수영장 한가운데(봇 물 보충 목표 = 수면 중심)는
    비어 있다. 색만 다르다.
    """
    body, wing, beak = (C["white"], C["lavender"], C["coral"]) if swan else (C["pink"], C["rose"], C["lemon"])
    put(bm_ellipsoid(0.95, 0.62, 0.42, 20, 10), body, M, x, z, 0.08, rot)
    for sy in (-1, 1):
        put(bm_ellipsoid(0.55, 0.14, 0.2, 12, 6), wing, M, x, z, 0.22, rot, kind="nocol", local=tr(-0.1, sy * 0.52, 0))
    # 목·머리는 장식이고 가는 보이지 않는 기둥(윗면 2.15 m)이 대신 막는다: 목을 타고 머리(1.95 m)에 올라
    # 티키 바 지붕으로 건너뛰는 길이 있었다
    neck = [(0.55, 0, 0.3), (0.78, 0, 0.72), (0.62, 0, 1.12), (0.5, 0, 1.45), (0.62, 0, 1.72)]
    put(bm_tube(neck, 0.13, 10, radii=[0.17, 0.13, 0.12, 0.11, 0.11]), body, M, x, z, 0.0, rot, kind="nocol")
    put(bm_ellipsoid(0.22, 0.17, 0.18, 12, 7), body, M, x, z, 1.8, rot, kind="nocol", local=tr(0.68, 0, 0))
    put(bm_tube([(0.85, 0, 1.8), (1.0, 0, 1.74), (1.1, 0, 1.64)], 0.06, 8, radii=[0.08, 0.06, 0.04]), beak, M, x, z, 0, rot,
        kind="nocol")
    pillar(M, x, z, 0.3, 0.26, 1.85, rot, y=0.3, segs=12, local=tr(0.68, 0, 0))
    put(bm_sphere(0.045, 8, 5), C["ink"], M, x, z, 1.63, rot, local=tr(1.11, 0, 0))
    for sy in (-1, 1):
        put(bm_sphere(0.04, 8, 5), C["ink"], M, x, z, 1.86, rot, kind="nocol", local=tr(0.78, sy * 0.13, 0))
    tail = bm_ellipsoid(0.26, 0.16, 0.12, 10, 6)
    transform(tail, rot_y(-40))
    put(tail, wing, M, x, z, 0.46, rot, kind="nocol", local=tr(-0.88, 0, 0))


def donut(x, z, icing):
    put(bm_torus(0.5, 0.2, 20, 8), C["lemon"], I4, x, z, -0.02, kind="nocol")
    put(bm_torus(0.5, 0.215, 20, 5, 20, 160, close=False), icing, I4, x, z, -0.02, kind="nocol")
    rnd = random.Random(int(abs(x) * 10 + abs(z)))
    cols = [C["white"], C["aqua"], C["mint"], C["sun"]]
    for k in range(14):
        a = rnd.uniform(0, math.tau)
        b = rnd.uniform(0.3, 1.2)
        rr = 0.5 + 0.215 * math.cos(b)
        put(bm_rbox(0.08, 0.025, 0.025, r=0.0, segs=0), cols[k % 4], I4, x + math.cos(a) * rr, z + math.sin(a) * rr,
            -0.02 + 0.215 * math.sin(b), rot=rnd.uniform(0, 180), kind="nocol")


def beach_ball(x, z, y=0.12, r=0.32):
    cols = [C["coral"], C["white"], C["lemon"], C["white"], C["aqua"], C["white"]]
    put(bm_sphere(r, 18, 10), lambda c, n: cols[int(((math.atan2(c.y, c.x) + math.tau) % math.tau) / (math.tau / 6)) % 6],
        I4, x, z, y, kind="nocol")


# ---------------------------------------------------------------- 전망대(북서 트리하우스 / 남동 놀이터)

TOWER_X, TOWER_Z, TOWER_TOP = -14.0, 12.0, 3.6
RAMP_Z, RAMP_W = 11.6, 1.6          # 경사로 중심 z, 폭
RAMP_X0 = TOWER_X + 2.0             # 경사로 윗끝(데크 동쪽 가장자리)
RAMP_RUN = TOWER_TOP / math.tan(math.radians(32))   # 32° 경사 → 수평 5.76 m
RAMP_X1 = RAMP_X0 + RAMP_RUN        # 경사로 아랫끝
CRATE_Z0, CRATE_Z1 = 11.0, 13.0     # 상자 계단 z 범위(서쪽)
TRUNK_X, TRUNK_Z = -17.3, 15.3
# 점프대 J1 착지 목표(게임 x, z). 데크 한가운데(-14, 12)보다 북서쪽 깊숙이: 비행 중 어떤 방향키를 누르고 있어도
# (공중 조작으로 수평 속도가 줄어 2.45 m 짧게 떨어진다) 데크 앞 난간에 걸리지 않고 데크에 내린다
# (입력 없음·앞·뒤·좌·우·앞±20°·앞±45° 9가지 모두 데크 착지를 PlayerBody 로 확인). J2 는 원점 대칭.
JUMP_TARGET = (-15.4, 13.1)


def hut_face_decor(M, cx, cz, y0, style):
    """오두막/놀이집 남쪽 면(데크를 보는 면) 장식: 둥근 문 + 둥근 창 + 화분 상자."""
    face_z = cz - 1.0 - 0.01   # 남쪽 면(게임 -z 쪽)
    pts = [(-0.42, 0.0), (0.42, 0.0)] + [(0.42 * math.cos(math.radians(a)), 1.05 + 0.42 * math.sin(math.radians(a)))
                                         for a in range(0, 181, 30)]
    bm = bm_prism(pts, 0.0, 0.05)
    transform(bm, rot_x(90))  # XY 외곽 → XZ 평면, 두께는 -Y
    door_col = C["wood_dark"] if style == "tree" else C["coral"]
    put(bm, door_col, M, cx - 0.9, face_z, y0, kind="nocol", local=tr(0, 0.05, 0))
    put(bm_sphere(0.05, 8, 5), C["sun"], M, cx - 0.62, face_z - 0.06, y0 + 0.7, kind="nocol")
    ring = bm_torus(0.34, 0.06, 20, 6)
    transform(ring, rot_x(90))
    put(ring, C["white"], M, cx + 0.8, face_z - 0.02, y0 + 1.2, kind="nocol")
    glass = bm_cyl(0.3, 0.03, 20, 0.0)
    transform(glass, rot_x(90))
    put(glass, C["glass"], M, cx + 0.8, face_z, y0 + 1.2, kind="nocol")
    put(bm_rbox(0.9, 0.22, 0.2, r=0.05, segs=1), C["wood_dark"], M, cx + 0.8, face_z - 0.1, y0 + 0.72, kind="nocol")
    flowers(M, [(cx + 0.8 + dx, face_z - 0.12, y0 + 0.97) for dx in (-0.3, -0.1, 0.1, 0.3)],
            [C["pink"], C["sun"], C["coral"], C["white"]], r=0.07)
    if style == "play":
        wheel = bm_torus(0.32, 0.04, 20, 6)
        transform(wheel, rot_x(90))
        put(wheel, C["butter"], M, cx - 0.05, face_z - 0.12, y0 + 1.05, kind="nocol")
        for k in range(4):
            sp = bm_tube([(-0.3, 0, 0), (0.3, 0, 0)], 0.025, 5)
            transform(sp, rot_y(45 * k))
            put(sp, C["butter"], M, cx - 0.05, face_z - 0.12, y0 + 1.05, kind="nocol")


def gable_roof(M, cx, cz, y0, length, depth, height, col, rot=0.0):
    """둥근 박공지붕(로컬 X 방향으로 뻗음)."""
    prof = fillet_closed([(-depth / 2, 0.0), (depth / 2, 0.0), (0.0, height)], 0.22, 3)
    bm = bm_prism(prof, -length / 2, length / 2, bevel=0.06, segs=1, bevel_bottom=True)
    # (u, v, w) → Blender (w, u, v)
    transform(bm, Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    put(bm, col, M, cx, cz, y0, rot)


def tower(M, style):
    """북서 트리하우스(style='tree') 를 M 으로 배치. M = Rz(180°) + style='play' 면 남동 놀이터."""
    play = style == "play"
    cx, cz, top = TOWER_X, TOWER_Z, TOWER_TOP

    # 데크(4 × 4, 윗면 3.6) — 널판 무늬
    bm = bm_rbox(4.0, 4.0, 0.3, r=0.1, segs=2)
    bisect_stripes(bm, 1, 0.4, -2, 2)
    da, db = (C["wood"], C["wood_light"]) if not play else (C["wood_light"], C["peach"])
    put(bm, lambda c, n: (da if math.floor(c.y / 0.4) % 2 == 0 else db) if (n.z > 0.9 and c.z > 0.25) else C["wood_dark"],
        M, cx, cz, top - 0.3)

    # 기둥(네 모서리). 놀이터 기둥의 데크 위 연장부·공은 장식(충돌 없음) — 공을 발판 삼아 놀이집 지붕에 오르지 못하게
    pcols = [C["coral"], C["butter"], C["mint"], C["aqua"]] if play else [C["wood_dark"]] * 4
    posts = [(cx + 1.7, cz - 1.7), (cx - 1.7, cz - 1.7), (cx + 1.7, cz + 1.7), (cx - 1.7, cz + 1.7)]
    for i, (px, pz) in enumerate(posts):
        put(bm_cyl(0.16, top - 0.28, 12, 0.04), pcols[i], M, px, pz)
        if play:
            put(bm_sphere(0.2, 12, 8), pcols[(i + 1) % 4], M, px, pz, top + 0.62, kind="nocol")
            put(bm_cyl(0.07, 0.7, 8, 0.02), pcols[i], M, px, pz, top, kind="nocol")
    # 데크 밑 북·동·서 둘레 판자(높이 1.9): 뒤 레인으로만 열린 막다른 공간을 막는다(남쪽은 아래 가림막)
    for (sx_, sz_, rot_) in ((cx, cz + 1.85, 90), (cx + 1.85, cz, 0), (cx - 1.85, cz, 0)):
        bm = bm_rbox(0.08, 3.3, 1.9, r=0.03, segs=1)
        bisect_stripes(bm, 1, 0.33, -1.65, 1.65)
        ka, kb = (C["wood"], C["wood_dark"]) if not play else (C["mint"], C["white"])
        put(bm, lambda c, n, ka=ka, kb=kb: ka if math.floor(c.y / 0.33) % 2 == 0 else kb, M, sx_, sz_, 0.0, rot_)
    # 난간(0.5 m, 엄폐 아님): 경사로·상자 쪽은 열려 있다
    rail_col = C["white"] if not play else C["butter"]
    rh = 0.5
    rails = [((cx - 1.9, cz - 1.9), (cx + 1.9, cz - 1.9)),                       # 남
             ((cx + 1.9, cz - 1.9), (cx + 1.9, RAMP_Z - RAMP_W / 2 - 0.05)),     # 동(경사로 남쪽)
             ((cx + 1.9, RAMP_Z + RAMP_W / 2 + 0.05), (cx + 1.9, cz + 1.9)),     # 동(경사로 북쪽)
             ((cx - 1.9, cz - 1.9), (cx - 1.9, CRATE_Z0 - 0.05)),                 # 서(상자 남쪽)
             ((cx - 1.9, CRATE_Z1 + 0.05), (cx - 1.9, cz + 1.9))]                 # 서(상자 북쪽)
    for (x0, z0), (x1, z1) in rails:
        L = math.hypot(x1 - x0, z1 - z0)
        n = max(2, math.ceil(L / 0.8) + 1)
        for k in range(n):
            t = k / (n - 1)
            put(bm_cyl(0.045, rh, 6, 0.0), rail_col, M, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, top)
        put(bm_tube([G(x0, z0, top + rh), G(x1, z1, top + rh)], 0.055, 8), rail_col, M, 0, 0)

    # 데크 아래 남쪽 가림막(트리하우스 = 격자, 놀이터 = 암벽): 레인 대각선 시야 차단 + 엄폐
    lattice(M, cx, cz - 1.85, 3.1, 0.0, rot=90, style="climb" if play else "lattice")

    # 경사로(32°) — 트리하우스는 널판 경사로, 놀이터는 미끄럼틀(걸어서도 오른다)
    p_top, p_bot = G(RAMP_X0, RAMP_Z, top), G(RAMP_X1, RAMP_Z, 0.0)
    length = (p_bot - p_top).length
    L = length + 0.4
    thick = 0.18
    bm = bm_rbox(L, RAMP_W, thick, r=0.05, segs=2, base=False)
    if not play:
        bisect_stripes(bm, 0, 0.32, -L / 2, L / 2)
        ramp_mat = (lambda c, n: (C["wood"] if math.floor(c.x / 0.32) % 2 == 0 else C["wood_light"]) if n.z > 0.5
                    else C["wood_dark"])
    else:
        ramp_mat = lambda c, n: C["butter"] if n.z > 0.5 else C["coral"]  # noqa: E731
    B.add(bm, ramp_mat, M @ slope_mtx(p_top, p_bot, L, thick))
    # 경사로 아래를 막는 받침(아래로 기어들어가 끼지 않게)
    under = bm_prism([(RAMP_X0, -0.1), (RAMP_X0 + (top - 0.13) / math.tan(math.radians(32)), -0.1), (RAMP_X0, top - 0.23)],
                     -(RAMP_W - 0.12) / 2, (RAMP_W - 0.12) / 2, bevel=0.04, segs=2, bevel_bottom=True)
    bisect_stripes(under, 0, 0.4, RAMP_X0, RAMP_X1)
    sa, sb = (C["wood_dark"], C["wood"]) if not play else (C["coral"], C["white"])
    under_mat = (lambda c, n: (sa if math.floor(c.x / 0.4) % 2 == 0 else sb) if abs(n.z) > 0.7 else sa)
    B.add(under, under_mat, M @ Matrix(((1, 0, 0, 0), (0, 0, -1, -RAMP_Z), (0, 1, 0, 0), (0, 0, 0, 1))))
    _, xax, yax, zax = slope_frame(p_top, p_bot)
    if not play:
        # 손잡이 난간
        for sd in (-1, 1):
            n = 6
            tops = []
            for k in range(n):
                t = (k + 0.3) / n
                p = p_top + (p_bot - p_top) * t + yax * sd * (RAMP_W / 2 - 0.08)
                bm = bm_cyl(0.04, 0.72, 6, 0.0)
                transform(bm, Matrix.Translation(p))
                B.add(bm, C["white"], M)
                tops.append(p + Vector((0, 0, 0.72)))
            B.add(bm_tube(tops, 0.045, 8), C["white"], M)
    else:
        # 미끄럼틀 옆벽
        for sd in (-1, 1):
            bm = bm_rbox(L, 0.1, 0.42, r=0.045, segs=2, base=False)
            B.add(bm, C["coral"], M @ slope_mtx(p_top, p_bot, L, 0.42, lift=0.36, side=sd * (RAMP_W / 2 - 0.05)))

    # 상자 계단(0.9 m × 3단 + 데크) — 서쪽
    cols = [C["coral"], C["butter"], C["mint"], C["aqua"], C["pink"], C["lavender"]]
    ci = 0
    for col_i, levels in enumerate((3, 2, 1)):
        bx = cx - 2.5 - col_i
        for lv in range(levels):
            bm = bm_rbox(0.98, 1.98, 0.88, r=0.1 if play else 0.07, segs=2)
            zc = (CRATE_Z0 + CRATE_Z1) / 2
            if play:
                put(bm, cols[ci % len(cols)], M, bx, zc, lv * 0.9 + 0.01)
                for sx in (-1, 1):
                    d = bm_cyl(0.3, 0.02, 12, 0.0)
                    transform(d, rot_y(90 * sx))
                    put(d, C["white"], M, bx + sx * 0.49, zc, lv * 0.9 + 0.45, kind="nocol")
            else:
                bisect_stripes(bm, 2, 0.22, 0, 0.88)
                put(bm, lambda c, n: C["wood_light"] if n.z > 0.5 else (C["wood"] if math.floor(c.z / 0.22) % 2 == 0
                                                                          else C["wood_dark"]),
                    M, bx, zc, lv * 0.9 + 0.01)
            ci += 1

    # 뒤쪽 오두막/놀이집(데크 북쪽, 위에 올라갈 수 없음)
    hx, hz = cx, cz + 3.05
    y0 = top - 0.3
    wall = C["wood"] if not play else C["mint"]
    bm = bm_rbox(3.6, 2.0, 2.2, r=0.14, segs=2, bulge=0.04)
    if not play:
        bisect_stripes(bm, 2, 0.3, 0, 2.2)
        put(bm, lambda c, n: C["wood"] if math.floor(c.z / 0.3) % 2 == 0 else C["wood_light"], M, hx, hz, y0)
    else:
        put(bm, wall, M, hx, hz, y0)
    gable_roof(M, hx, hz, y0 + 2.1, 4.2, 2.9, 1.15, C["coral"] if not play else C["pink"])
    # 지붕 위에 서지 못하게 지붕 전체를 감싸는 보이지 않는 상자(처마 5.3 m ~ 10 m)
    put(bm_rbox(4.4, 3.1, 4.7, r=0.0, segs=0), "Invisible", M, hx, hz, y0 + 2.0, kind="col")
    hut_face_decor(M, hx, hz, top, style)
    put(bm_cyl(0.03, 1.4, 6, 0.0), C["white"], M, hx + 1.6, hz, y0 + 3.0)
    flag = fillet_closed([(0.0, 0.0), (0.7, -0.22), (0.0, -0.44)], 0.04, 1)
    fb = bm_prism(flag, -0.015, 0.015)
    transform(fb, rot_x(90))
    put(fb, C["lemon"] if not play else C["coral"], M, hx + 1.6, hz, y0 + 4.38, kind="nocol")
    for px in (hx - 1.6, hx + 1.6):
        put(bm_cyl(0.13, y0 + 0.05, 10, 0.03), pcols[1], M, px, hz + 0.75)

    if not play:
        # 큰 나무: 줄기 + 둥근 수관(충돌)
        prof = fillet([(0, 0), (0.95, 0, 0.3), (0.74, 0.35, 0.3), (0.62, 1.2, 0.4), (0.56, 4.0), (0.5, 6.3, 0.2),
                       (0, 6.6)], 0.2, 2)
        put(bm_lathe(prof, 24), C["trunk"], M, TRUNK_X, TRUNK_Z)
        # 가지는 장식(충돌 없음): 40° 경사라 난간에서 뛰어 올라타 수관 위로 걸어 오를 수 있었다
        for (bx, bz, by) in ((-19.2, 13.9, 6.4), (-15.2, 16.4, 6.6)):
            put(bm_tube([G(TRUNK_X, TRUNK_Z, 4.6), G(bx, bz, by)], 0.22, 12, radii=[0.3, 0.16]), C["trunk"], M, 0, 0,
                kind="nocol")
        for (x, z, y, r, col) in ((-17.3, 15.3, 8.3, 2.7, C["leaf"]), (-14.6, 16.9, 7.8, 2.0, C["leaf2"]),
                                  (-19.8, 13.9, 7.1, 1.8, C["leaf3"]), (-16.6, 14.3, 9.9, 1.8, C["leaf2"]),
                                  (-19.6, 16.9, 8.8, 1.9, C["leaf"])):
            put(bm_ellipsoid(r, r, r * 0.86, 16, 9), col, M, x, z, y)
        rnd = random.Random(5)
        pts = []
        for k in range(7):
            a, e = rnd.uniform(0, math.tau), rnd.uniform(-0.2, 0.9)
            pts.append((-17.3 + math.cos(a) * math.cos(e) * 2.75, 15.3 + math.sin(a) * math.cos(e) * 2.75,
                        8.3 + math.sin(e) * 2.35))
        flowers(M, pts, [C["pink"], C["white"]], r=0.14)
    else:
        # 야자수(둥근 화단 + 열대 덤불) + 코코넛
        prof = fillet([(0, 0), (1.0, 0, 0.1), (1.0, 0.45, 0.12), (0.86, 0.45), (0, 0.45)], 0.08, 1)
        put(bm_lathe(prof, 20), C["stone"], M, TRUNK_X, TRUNK_Z)
        for (dx, dz, r, col) in ((0.38, -0.25, 0.55, C["leaf3"]), (-0.35, 0.3, 0.55, C["leaf"]), (0.15, 0.42, 0.5, C["leaf2"]),
                                 (-0.3, -0.38, 0.5, C["leaf2"])):
            put(bm_ellipsoid(r, r, r * 1.15, 14, 9), col, M, TRUNK_X + dx, TRUNK_Z + dz, 0.45 + r * 0.9)
        path = [G(TRUNK_X, TRUNK_Z, 0.0), G(TRUNK_X + 0.1, TRUNK_Z + 0.2, 2.2), G(TRUNK_X - 0.2, TRUNK_Z + 0.6, 4.4),
                G(TRUNK_X - 0.7, TRUNK_Z + 0.8, 6.6)]
        put(bm_tube(path, 0.3, 16, radii=[0.5, 0.34, 0.28, 0.24]), C["deck_trim"], M, 0, 0)
        crown = G(TRUNK_X - 0.7, TRUNK_Z + 0.8, 6.7)
        for k in range(9):
            a = math.tau * k / 9
            d = Vector((math.cos(a), math.sin(a), 0))
            fr = bm_ellipsoid(1.5, 0.42, 0.08, 10, 5)
            transform(fr, Matrix.Translation((1.35, 0, -0.35)) @ rot_y(18))
            transform(fr, Matrix.Rotation(a, 4, "Z"))
            transform(fr, Matrix.Translation(crown))
            B.add(fr, C["leaf"] if k % 2 else C["leaf3"], M, kind="nocol")
        for k in range(3):
            a = math.tau * k / 3 + 0.4
            p = crown + Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, -0.3))
            bm = bm_sphere(0.2, 10, 6)
            transform(bm, Matrix.Translation(p))
            B.add(bm, C["wood_dark"], M)


def shed(M, x, z, rot, body, roof):
    """정원 창고(모서리 채움 + 시야 차단). 정면(로컬 -Y) 에 문."""
    put(bm_rbox(3.4, 3.1, 2.3, r=0.14, segs=2, bulge=0.05), body, M, x, z, 0.0, rot)
    gable_roof(M, x, z, 2.2, 3.9, 3.7, 1.1, roof, rot=rot)
    m = M @ at(x, z, 0.0, rot)
    for sx in (-0.42, 0.42):
        bm = bm_rbox(0.8, 0.06, 1.8, r=0.03, segs=1)
        B.add(bm, C["white"], m @ tr(sx, -1.57, 0.02), kind="nocol")
    ring = bm_torus(0.32, 0.06, 18, 6)
    transform(ring, rot_y(90))
    B.add(ring, C["white"], m @ tr(-1.72, 0.0, 1.4), kind="nocol")
    glass = bm_cyl(0.28, 0.03, 18, 0.0)
    transform(glass, rot_y(-90))
    B.add(glass, C["glass"], m @ tr(-1.7, 0.0, 1.4), kind="nocol")
    B.add(bm_rbox(0.24, 0.9, 0.22, r=0.05, segs=1), C["wood_dark"], m @ tr(-1.82, 0.0, 0.88), kind="nocol")
    for k, col in enumerate((C["pink"], C["sun"], C["coral"], C["white"])):
        bm = bm_sphere(0.08, 6, 4)
        B.add(bm, col, m @ tr(-1.84, -0.33 + 0.22 * k, 1.12), kind="nocol")


# ---------------------------------------------------------------- 잔디 디테일(충돌 없음)

GROUND_TUFTS, TUFT_BLADES, FLOWER_PATCHES = 48, 3, 5


def ground_detail():
    """잔디 풀포기·작은 꽃밭. '디테일은 가장자리로': 펜스 밑 0.6 m 띠, 산울타리 끝, 소품 밑동 1 m 안에만 둔다
    (넓은 잔디 한가운데 흩뿌리면 가까이선 가시, 멀리선 흙점처럼 보였다).
    충돌 메시(BVH, 보이지 않는 기둥 포함)를 위에서 쏘아 빈 잔디(y≈0)인 곳에만 둔다.
    """
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for b in B.buckets.values():
        if b["kind"] not in ("solid", "col"):
            continue
        off = len(verts)
        verts.extend(b["verts"])
        polys.extend([[off + i for i in f] for f in b["faces"]])
    bvh = BVHTree.FromPolygons(verts, polys)
    rnd = random.Random(77)

    def free(x, z, clear=0.35):
        if DECK_SDF(x, -z) < 0.4:
            return False
        for dx, dz in ((0, 0), (clear, 0), (-clear, 0), (0, clear), (0, -clear)):
            hit = bvh.ray_cast(G(x + dx, z + dz, 6.0), Vector((0, 0, -1)), 7.0)
            if hit[0] is None or hit[0].z > 0.02:
                return False
        return True

    half_props = [(-8.0, 14.2), (13.2, 12.2), (-15.5, -7.5),     # 쿨러
                  (13.8, 8.4),                                   # 토피어리
                  (-3.5, 15.3), (10.3, 15.0), (-9.3, -4.6),      # 고래·오리·튜브 더미
                  (6.0, 14.0)]                                   # 분수(수반 밖, 보충 링 근처)
    props = half_props + [(-x, -z) for x, z in half_props]
    hedge_ends = [(sx * e, sz * 9.0) for sx in (-1, 1) for sz in (-1, 1) for e in (3.0, 9.0)]

    def candidate(allow_props=True):
        u = rnd.random()
        if u < 0.45:                       # 펜스 밑 띠(보이지 않는 벽 안쪽 0.1~0.6 m)
            side = rnd.randrange(4)
            d = rnd.uniform(0.1, 0.6)
            if side < 2:
                return rnd.uniform(-24.0, 24.0), (1 if side == 0 else -1) * (18.3 - d)
            return (1 if side == 2 else -1) * (24.3 - d), rnd.uniform(-18.0, 18.0)
        if u < 0.72 or not allow_props:    # 산울타리 끝(바깥 방향)
            ex, ez = rnd.choice(hedge_ends)
            out = math.copysign(1.0, ex) * (1.0 if abs(ex) > 6 else -1.0)
            return ex + out * rnd.uniform(0.25, 0.9), ez + rnd.uniform(-0.55, 0.55)
        px, pz = rnd.choice(props)         # 소품 밑동
        a, rr = rnd.uniform(0, math.tau), rnd.uniform(0.75, 1.5)
        return px + math.cos(a) * rr, pz + math.sin(a) * rr

    # 풀잎: 5면 + 가운데 링으로 끝을 뭉툭하게(3면 뾰족 원뿔은 가까이서 검은 가시처럼 보였다)
    blade = bm_lathe([(0.032, 0.0), (0.02, 0.17), (0.0, 0.25)], 5)
    placed = 0
    tries = 0
    while placed < GROUND_TUFTS and tries < 4000:
        tries += 1
        x, z = candidate()
        if not free(x, z, 0.3):
            continue
        placed += 1
        for k in range(TUFT_BLADES):
            bm = blade.copy()
            transform(bm, Matrix.Diagonal((1, 1, rnd.uniform(0.75, 1.3), 1)))
            transform(bm, rot_y(rnd.uniform(-22, 22)))
            transform(bm, rot_z(rnd.uniform(0, 360)))
            B.add(bm, C["grass2"], at(x + rnd.uniform(-0.08, 0.08), z + rnd.uniform(-0.08, 0.08), 0.0), kind="nocol")
    blade.free()
    patches = 0
    tries = 0
    while patches < FLOWER_PATCHES and tries < 3000:
        tries += 1
        x, z = candidate(allow_props=False)
        if not free(x, z, 0.5):
            continue
        patches += 1
        cols = rnd.choice(([C["white"], C["sun"]], [C["pink"], C["white"]], [C["lavender"], C["white"]],
                           [C["coral"], C["sun"]]))
        pts = [(x + rnd.uniform(-0.35, 0.35), z + rnd.uniform(-0.35, 0.35), 0.06) for _ in range(5)]
        flowers(I4, pts, cols, r=0.07)


# ---------------------------------------------------------------- 담장 밖 배경(충돌 없음, 싸게)

def house(x, z, rot, w, d, h, body, roof, door=None, roof_k=0.55):
    """담장 밖 이웃집(배경). 벽은 지평선색 쪽으로 25% 섞고 지붕 채도는 15% 낮춰 대기 원근처럼 물러나 보이게 한다."""
    body = mix_hex(body, C["horizon"], 0.25)
    roof = desat_hex(roof, 0.85)
    m = at(x, z, 0.0, rot)
    B.add(bm_rbox(w, d, h, r=0.35, segs=2, bulge=0.25), body, m, kind="nocol")
    prof = fillet_closed([(-d / 2 - 0.6, 0.0), (d / 2 + 0.6, 0.0), (0.0, h * roof_k)], 0.45, 3)
    bm = bm_prism(prof, -w / 2 - 0.4, w / 2 + 0.4, bevel=0.1, segs=1, bevel_bottom=True)
    transform(bm, Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    B.add(bm, roof, m @ tr(0, 0, h - 0.25), kind="nocol")
    B.add(bm_rbox(0.8, 0.8, 1.6, r=0.12, segs=1), roof, m @ tr(w * 0.28, 0.6, h + 0.2), kind="nocol")
    front = -d / 2 - 0.02
    pts = [(-0.55, 0.0), (0.55, 0.0)] + [(0.55 * math.cos(math.radians(a)), 1.5 + 0.55 * math.sin(math.radians(a)))
                                         for a in range(0, 181, 30)]
    bm = bm_prism(pts, 0.0, 0.08)
    transform(bm, rot_x(90))
    B.add(bm, door or C["wood_dark"], m @ tr(0, front + 0.04, 0.0), kind="nocol")
    for sx in (-1, 1):
        for row in ((h * 0.36,) if h < 5.8 else (h * 0.3, h * 0.66)):
            wx = sx * w * 0.3
            ring = bm_torus(0.55, 0.1, 12, 3)
            transform(ring, rot_x(90))
            B.add(ring, C["white"], m @ tr(wx, front, row), kind="nocol")
            gl = bm_cyl(0.5, 0.04, 12, 0.0)
            transform(gl, rot_x(90))
            B.add(gl, C["glass"], m @ tr(wx, front + 0.02, row), kind="nocol")
    # (집 앞 덤불은 뺐다: 펜스에 가려 마당에서는 거의 보이지 않았다)


def lollipop_tree(x, z, s=1.0, col=None):
    m = at(x, z, 0.0, 0.0)
    B.add(bm_cyl(0.28 * s, 2.4 * s, 10, 0.05, r_top=0.2 * s), C["trunk"], m, kind="nocol")
    B.add(bm_ellipsoid(1.8 * s, 1.8 * s, 1.65 * s, 16, 9), col or C["leaf"], m @ tr(0, 0, 3.6 * s), kind="nocol")
    B.add(bm_ellipsoid(1.05 * s, 1.05 * s, 0.95 * s, 10, 6), C["leaf2"], m @ tr(0.7 * s, -0.4 * s, 4.6 * s), kind="nocol")


def bush(x, z, s=1.0):
    m = at(x, z, 0.0, 0.0)
    B.add(bm_ellipsoid(0.9 * s, 0.9 * s, 0.7 * s, 12, 8), C["leaf3"], m @ tr(0, 0, 0.45 * s), kind="nocol")
    B.add(bm_ellipsoid(0.6 * s, 0.6 * s, 0.5 * s, BUSH_SUB[0], BUSH_SUB[1]), C["leaf"], m @ tr(0.6 * s, 0.2 * s, 0.4 * s),
          kind="nocol")
    B.add(bm_ellipsoid(0.55 * s, 0.55 * s, 0.45 * s, BUSH_SUB[0], BUSH_SUB[1]), C["leaf2"],
          m @ tr(-0.5 * s, -0.3 * s, 0.35 * s), kind="nocol")


BUSH_SUB = (8, 5)
BUSH_COUNT = 12   # 펜스(1.7 m) 뒤라 마당에서는 윗부분만 보인다 → 개수를 줄이고 분할을 올렸다


def backdrop():
    # 펜스에서 4 m 더 물려(레인·모서리 시야를 덜 채우게) z ±32.5 / x ±37.5 에 둔다.
    # 키 큰 두 집(6.2 m)은 지붕 경사를 낮춰(0.55 → 0.42) 비스듬히 솟아 보이던 인상을 줄였다.
    houses = [(-17, 32.5, 180, 8.0, 7.0, 5.4, C["peach"], C["coral"]),
              (0.5, 33.5, 180, 9.0, 7.0, 6.2, C["mint"], C["roof_teal"], None, 0.42),
              (17.5, 32.0, 180, 7.5, 7.0, 5.0, C["lemon"], C["roof_peach"]),
              (-16.5, -32.5, 0, 8.0, 7.0, 5.6, C["lavender"], C["roof_lav"]),
              (1.0, -33.5, 0, 9.0, 7.0, 6.2, C["pink"], C["roof_pink"], None, 0.42),
              (17.5, -32.0, 0, 7.5, 7.0, 5.1, C["mint_lt"], C["coral"]),
              (37.5, 8.0, -90, 8.0, 7.0, 5.4, C["aqua"], C["roof_peach"]),
              (38.0, -9.5, -90, 7.0, 7.0, 5.0, C["peach"], C["roof_teal"]),
              (-37.5, -8.0, 90, 8.0, 7.0, 5.4, C["lemon"], C["roof_pink"]),
              (-38.0, 9.5, 90, 7.0, 7.0, 5.0, C["mint_lt"], C["coral"])]
    for h in houses:
        house(*h)
    rnd = random.Random(42)
    trees = [(-27.5, 22.5), (-8.5, 24.0), (9.0, 23.5), (27.5, 21.0), (-27.0, -21.5), (-8.0, -23.5), (9.5, -24.0),
             (28.0, -22.5), (29.0, 0.5), (-29.0, -0.5), (30.0, 16.5), (-30.0, -16.5), (-31.0, 17.5), (31.5, -17.0)]
    for (x, z) in trees:
        lollipop_tree(x, z, rnd.uniform(0.85, 1.25), rnd.choice([C["leaf"], C["leaf2"], C["leaf3"]]))
    for k in range(BUSH_COUNT):
        t = k / BUSH_COUNT
        per = 2 * (49 + 37)
        s = t * per
        if s < 49:
            x, z = -24.5 + s, 19.6
        elif s < 49 + 37:
            x, z = 25.6, 18.5 - (s - 49)
        elif s < 98 + 37:
            x, z = 24.5 - (s - 86), -19.6
        else:
            x, z = -25.6, -18.5 + (s - 135)
        bush(x + rnd.uniform(-0.6, 0.6), z, rnd.uniform(0.8, 1.2))
    # 3D 구름은 두지 않는다: 툰 셰이딩 아래 단계 때문에 베이지 덩어리로 떠 보였고 스카이돔 구름과 겹쳤다
    for k in range(8):
        a = math.tau * k / 8 + 0.3
        rr = 118
        m = at(math.cos(a) * rr, math.sin(a) * rr, -6.0, math.degrees(a))
        B.add(bm_ellipsoid(40, 24, 16, 14, 6), C["grass_out"] if k % 2 else C["leaf2"], m, kind="nocol")


# ---------------------------------------------------------------- 파티오(팀 진영)

def build_patio(M, team):
    """서쪽 파티오(x ∈ [-24.7, -18], z ∈ [-8, 8], 윗면 +1.0)를 M 으로 배치."""
    bm = bm_rbox(6.7, 16.0, 1.3, r=0.12, segs=2)
    bisect_stripes(bm, 0, 1.0, -3.4, 3.4, offset=0.35)
    bisect_stripes(bm, 1, 1.0, -8.0, 8.0)

    def patio_mat(c, n):
        if n.z > 0.95 and c.z > 1.25:
            return C["patio"] if (math.floor(c.x - 0.35) + math.floor(c.y)) % 2 == 0 else C["patio2"]
        if n.z > 0.2:
            return C["patio_lip"]
        # 옆면: 1 m 간격 세로 판자 두 톤(16 m 민짜 벽이 비어 보였다)
        k = math.floor(c.y) if abs(n.x) > 0.5 else math.floor(c.x - 0.35)
        return C["patio_side"] if k % 2 == 0 else C["wood_dark"]
    put(bm, patio_mat, M, -21.35, 0, -0.3)

    # 북·남 계단(보이는 계단 4단 + 그 위 보이지 않는 경사로)
    for sgn in (1, -1):
        for k in range(1, 5):
            top = 1.0 - 0.25 * k
            zc = sgn * (8 + 0.5 * k - 0.25)
            put(bm_rbox(3.0, 0.5, top + 0.1, r=0.06, segs=2), by_normal(C["patio_lip"], C["patio_side"]), M, -21, zc, -0.1)
        put(bm_wedge(3.3, 2.0, 1.0), "Invisible", M, -21, sgn * 8.0, 0.0, rot=180 if sgn > 0 else 0, kind="col")


# ---------------------------------------------------------------- 경계(펜스 + 보이지 않는 벽)

FENCE_X = 24.45
FENCE_Z = 18.45


def picket_bm():
    """피켓 널판(폭 0.16, 두께 0.045): 끝은 늘리지 않은 7점 반원(30° 간격 — 뾰족한 첨두 X).

    펜스를 따라 놓으면 로컬 -Y 가 마당 쪽이다(build_fence 의 rot). 바닥면만 생략한다.
    널판이 350여 개라 간격(0.5 m)은 삼각형 예산에 맞춘 값이다.
    """
    w, h, t = 0.16, 1.72, 0.045
    r = w / 2
    outline = [(-r, 0.0), (r, 0.0)] + [(r * math.cos(math.radians(a)), h + r * math.sin(math.radians(a)))
                                       for a in range(0, 181, 30)]
    bm = bmesh.new()
    front = [bm.verts.new((x, -t / 2, y)) for x, y in outline]
    back = [bm.verts.new((x, t / 2, y)) for x, y in outline]
    bm.faces.new(front)                    # XZ 에서 반시계 → 법선 -Y(마당 쪽)
    bm.faces.new(list(reversed(back)))     # 뒷면(외곽선 헐이 실루엣을 그리려면 닫혀 있어야 한다)
    n = len(outline)
    for i in range(1, n):                  # i = 0 은 바닥 변(땅에 묻혀 보이지 않음)
        j = (i + 1) % n
        bm.faces.new((front[i], back[i], back[j], front[j]))
    return bm


def fence_floor(x, z):
    return 1.0 if abs(x) > 18 and abs(z) <= 8.05 else 0.0


def build_fence():
    pk = picket_bm()
    spacing = 0.5
    # (시작점, 끝점) 게임 좌표
    sides = [((-FENCE_X, FENCE_Z), (FENCE_X, FENCE_Z)), ((FENCE_X, -FENCE_Z), (-FENCE_X, -FENCE_Z)),
             ((FENCE_X, FENCE_Z), (FENCE_X, -FENCE_Z)), ((-FENCE_X, -FENCE_Z), (-FENCE_X, FENCE_Z))]
    for (x0, z0), (x1, z1) in sides:
        length = math.hypot(x1 - x0, z1 - z0)
        dx, dz = (x1 - x0) / length, (z1 - z0) / length
        rot = math.degrees(math.atan2(dx, dz)) + 90  # 널판 면이 펜스 선과 나란하도록
        count = int(length / spacing)
        for i in range(count + 1):
            s = i * length / count
            x, z = x0 + dx * s, z0 + dz * s
            put(pk.copy(), C["fence"], I4, x, z, fence_floor(x, z), rot=rot, kind="nocol")
        # 가로대: 바닥 높이가 같은 구간마다 한 개씩
        cuts = [0.0]
        for i in range(1, 400):
            s = length * i / 400
            if fence_floor(x0 + dx * s, z0 + dz * s) != fence_floor(x0 + dx * (s - length / 400), z0 + dz * (s - length / 400)):
                cuts.append(s)
        cuts.append(length)
        for sa, sb in zip(cuts, cuts[1:]):
            xm, zm = x0 + dx * (sa + sb) / 2, z0 + dz * (sa + sb) / 2
            y = fence_floor(xm, zm)
            for hy in (0.45, 1.35):
                put(bm_rbox(sb - sa, 0.07, 0.1, r=0.03, segs=1), C["fence"], I4, xm, zm, y + hy, rot=rot, kind="nocol",
                    local=tr(0, 0.06, 0))
        nseg = max(1, round(length / 4.5))
        for i in range(nseg + 1):
            s = i * length / nseg
            xa, za = x0 + dx * s, z0 + dz * s
            yp = fence_floor(xa, za)
            put(bm_rbox(0.17, 0.17, 1.95, r=0.04, segs=1), C["fence"], I4, xa, za, yp, rot=rot, kind="nocol")
            put(bm_sphere(0.11, 8, 4), C["fence"], I4, xa, za, yp + 2.02, kind="nocol")
    pk.free()

    # 보이지 않는 경계벽(펜스 2 m + 8 m 이상). 안쪽 면 = ±24.3 / ±18.3
    for (x, z, sx, sz) in ((0, 18.5, 50, 0.4), (0, -18.5, 50, 0.4), (24.5, 0, 0.4, 38), (-24.5, 0, 0.4, 38)):
        put(bm_rbox(sx, sz, 12.0, r=0.0, segs=0), "Invisible", I4, x, z, -2.0, kind="col")


# ---------------------------------------------------------------- 마커

def facing_rot(x, z, tx=0.0, tz=0.0):
    """(x, z) 에서 (tx, tz) 를 바라보는 Empty Z 회전(라디안). Empty 의 로컬 -Y 가 정면."""
    dx, dz = tx - x, tz - z
    return math.atan2(dx, dz)


# 스폰 12곳: 파티오 4곳씩(팀 0 서쪽, 팀 1 동쪽) + 레인 4곳(공용). (x, y, z, team)
# spawn_01/05 는 (∓21, ±2) 였을 때 가림막 사이 출구로 적 전망대 데크 전체(64점, 37~39 m)에 보였다
# → 북쪽 격자 뒤 (∓20.6, ±4.8) 로 옮겨 적 데크·적 파티오 어느 점에서도 보이지 않는다(--audit 스폰 노출 0).
SPAWNS = [(-20.6, 1.0, 4.8, 0), (-21, 1.0, -2, 0), (-21, 1.0, 6, 0), (-21, 1.0, -6, 0),
          (20.6, 1.0, -4.8, 1), (21, 1.0, 2, 1), (21, 1.0, -6, 1), (21, 1.0, 6, 1),
          (-10, 0.0, 16, -1), (10, 0.0, -16, -1), (14, 0.0, 15, -1), (-14, 0.0, -15, -1)]


def build_markers(root):
    for i, (x, y, z, team) in enumerate(SPAWNS, 1):
        # 파티오 스폰은 가림막 사이 출구(서 (-17.5, 1) / 동 (17.5, -1))를, 레인 스폰은 맵 중앙을 본다
        tx, tz = ((-17.5, 1.0) if x < 0 else (17.5, -1.0)) if team >= 0 else (0.0, 0.0)
        empty(f"spawn_{i:02d}", loc=G(x, z, y), parent=root, rot=(0, 0, facing_rot(x, z, tx, tz)), size=0.5,
              extras={"team": team})
    for i, (x, z) in enumerate(((6, 14), (-6, -14)), 1):
        empty(f"fountain_{i:02d}", loc=G(x, z, 0.0), parent=root, size=0.5, extras={"radius": 1.5})
    tx0, tz0 = JUMP_TARGET
    for i, (px, pz, tx, tz) in enumerate(((-7, 5, tx0, tz0), (7, -5, -tx0, -tz0)), 1):
        empty(f"jumppad_{i:02d}", loc=G(px, pz, PAD_TOP), parent=root, size=0.5,
              extras={"target": f"jumptarget_{i:02d}", "radius": 1.1})
        empty(f"jumptarget_{i:02d}", loc=G(tx, tz, 3.6), parent=root, size=0.5)
    empty("bounds", loc=G(0, 0, 0), parent=root, size=1.0,
          extras={"minX": -24.3, "maxX": 24.3, "minZ": -18.3, "maxZ": 18.3, "killY": -6.0})
    for wid, (x, y, z, links) in WAYPOINTS.items():
        empty(wid, loc=G(x, z, y), parent=root, size=0.3, extras={"links": ",".join(links)})


PAD_TOP = 0.13

# 봇 웨이포인트(서쪽 절반 + 수영장). 이름 뒤 a = 이 좌표, b = 원점 대칭(180°) 짝.
# 간선은 봇이 똑바로 걸어갈 수 있는 곳만(경사로 OK, 점프대·낮은 가구·울타리 피함). --audit 로 검사.
WP_HALF = {
    # 파티오 출구 쪽(가장자리에서 1.6 m): 봇은 목표가 3 m 안이고 0.6 m 이상 높을 때만 뛰므로 출구 밖 잔디에서
    # 파티오(+1.0)로 뛰어오를 수 있게 가장자리 가까이 둔다
    "A1": ((-19.6, 1.0, 1.0), ["A34a", "A35a", "A39a"]),  # 서쪽 파티오(출구 앞)
    "A4": ((-21.0, 0.0, 11.0), ["A34a", "A7a", "A15a"]),  # 북쪽 계단 아래
    "A5": ((-21.0, 0.0, -11.0), ["A35a", "A25a", "A38a", "A40a"]),  # 남쪽 계단 아래
    "A7": ((-15.5, 0.0, 8.5), ["A4a", "A33a", "A16a", "A22a", "A41a"]),
    "A8": ((-15.3, 0.0, -5.0), ["A33a", "A30a", "A32a"]),
    "A9": ((-10.0, 0.0, 16.6), ["A11a", "A15a", "A37a"]),  # 북쪽 레인(스폰)
    "A11": ((0.0, 0.0, 11.0), ["A9a", "A12a", "A17a", "A23a", "A28b"]),
    "A12": ((-5.4, 0.0, 11.6), ["A11a", "A13a", "A17a"]),  # 트리하우스 경사로 아래
    "A13": ((-13.4, 3.6, 11.7), ["A12a"]),                 # 트리하우스 데크
    "A15": ((-20.2, 0.0, 16.8), ["A4a", "A9a"]),          # 북서 모서리
    "A16": ((-10.5, 0.0, 9.9), ["A7a", "A17a", "A22a", "A41a"]),
    "A17": ((-5.4, 0.0, 10.1), ["A16a", "A12a", "A11a"]),  # 울타리·경사로 사이 통로
    "A18": ((-8.3, 0.0, 0.6), ["A19a", "A22a", "A32a", "P1a", "A21a", "A42a"]),  # 수영장 데크 서쪽 끝
    "A19": ((-5.2, 0.0, 4.4), ["A18a", "A20a", "A36a"]),
    "A20": ((0.0, 0.0, 3.55), ["A19a", "A31b"]),           # 티키 바 앞 데크
    "A21": ((-10.0, 0.0, 2.0), ["A18a"]),                  # 카바나 안(뒷벽에서 떨어뜨림)
    "A22": ((-8.5, 0.0, 6.9), ["A7a", "A16a", "A18a", "A23a", "A36a", "A41a"]),
    "A23": ((0.0, 0.0, 7.6), ["A11a", "A22a", "A24b", "A36a"]),  # 티키 바 뒤
    "A24": ((-8.5, 0.0, -7.3), ["A30a", "A31a", "A23b"]),
    "A25": ((-14.5, 0.0, -14.2), ["A5a", "A26a", "A40a"]),  # 남서(스폰)
    "A26": ((-7.0, 0.0, -11.3), ["A25a", "A30a", "A28a"]),  # 분수 F2 북쪽
    "A28": ((-2.4, 0.0, -15.0), ["A26a", "A11b"]),
    "A30": ((-10.9, 0.0, -9.4), ["A8a", "A24a", "A26a", "A32a", "A40a"]),
    "A31": ((-5.2, 0.0, -4.4), ["A24a", "A20b", "A42a"]),
    "A32": ((-11.3, 0.0, -2.8), ["A8a", "A18a", "A30a", "A33a"]),
    # 레벨 디자인 검토에서 '가장 가까운 웨이포인트가 벽 너머'였던 빈 곳을 채운 점들
    "A33": ((-14.6, 0.0, 1.8), ["A7a", "A8a", "A32a", "A39a"]),  # 서쪽 파티오 출구 앞
    "A34": ((-21.3, 1.0, 5.2), ["A1a", "A4a"]),            # 파티오 북쪽(스폰 사이)
    "A35": ((-21.3, 1.0, -5.2), ["A1a", "A5a"]),           # 파티오 남쪽
    "A36": ((-5.5, 0.0, 7.4), ["A19a", "A22a", "A23a"]),   # 울타리 남쪽 통로
    "A37": ((-9.3, 0.0, 13.4), ["A9a"]),                   # 트리하우스 경사로 북쪽 빈 곳
    # 2차: 격자 점에서 nearest() 가 벽·소품 너머였던 곳(지면 1 m 격자 1.8% → 목표 0%)
    "A38": ((-19.6, 0.0, -16.2), ["A5a"]),                 # 남서 창고와 관목 사이 구석
    "A39": ((-16.4, 0.0, 1.0), ["A1a", "A33a"]),           # 서쪽 파티오 출구 밖 잔디(파티오로 뛰어오름)
    "A40": ((-15.6, 0.0, -10.2), ["A5a", "A25a", "A30a"]),  # 남서 쿨러 남쪽
    "A41": ((-10.8, 0.0, 5.4), ["A7a", "A16a", "A22a"]),   # 카바나 북쪽 벽 밖
    "A42": ((-8.6, 0.0, -3.6), ["A18a", "A31a"]),          # 에어매트·튜브 더미 사이
    # 수영장 바닥: 홍학(−2.2, 0.9)·백조(2.2, −0.9)를 비껴 지나간다
    "P1": ((-4.3, -0.65, 0.0), ["A18a", "P2a"]),
    "P2": ((0.0, -0.65, -1.7), ["P1a", "P2b"]),
}


def _build_waypoints():
    flip = {"a": "b", "b": "a"}
    full = {}
    for key, ((x, y, z), links) in WP_HALF.items():
        full[key + "a"] = ((x, y, z), links)
        full[key + "b"] = ((-x, y, -z), [l[:-1] + flip[l[-1]] for l in links])
    order = sorted(full, key=lambda k: (k[-1], int(k[1:-1]) + (100 if k[0] == "P" else 0)))
    names = {k: f"wp_{i:02d}" for i, k in enumerate(order, 1)}
    out = {}
    for k in order:
        (x, y, z), links = full[k]
        out[names[k]] = (x, y, z, sorted({names[l] for l in links}))
    return out


WAYPOINTS = _build_waypoints()


# ---------------------------------------------------------------- 검사(--audit, 출력만)

def _collision_bvh():
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for b in B.buckets.values():
        if b["kind"] not in ("solid", "col"):
            continue
        off = len(verts)
        verts.extend(b["verts"])
        polys.extend([[off + i for i in f] for f in b["faces"]])
    return BVHTree.FromPolygons(verts, polys)


def run_audit():
    """시야선(눈높이 1.42 m, 2 m 격자, 올라설 수 있는 바닥만)과 웨이포인트 간선(바닥 연속·캡슐 여유)을 검사한다.

    런타임 물리로 걷는 검사는 tests/map.test.ts 가 맡고, 여기서는 기하 조건만 빠르게 본다.
    """
    bvh = _collision_bvh()
    down, up = Vector((0, 0, -1)), Vector((0, 0, 1))
    eye = 1.42
    pts = []
    for x in range(-23, 24, 2):
        for z in range(-17, 18, 2):
            top = 12.0
            for _ in range(6):
                loc, nrm, _i, _d = bvh.ray_cast(G(x, z, top), down, 30.0)
                if loc is None:
                    break
                fy = loc.z
                reachable = -0.7 < fy < 1.05 or abs(fy - TOWER_TOP) < 0.05
                if abs(nrm.z) >= 0.64 and reachable and bvh.ray_cast(G(x, z, fy + 0.05), up, 1.7)[0] is None:
                    pts.append((G(x, z, fy + eye), f"({x},{fy:.1f},{z})"))
                top = fy - 0.05
    buckets = {}
    long_lines = []
    for i in range(len(pts)):
        a, ta = pts[i]
        for j in range(i + 1, len(pts)):
            b, tb = pts[j]
            d = (b - a).length
            vis = bvh.ray_cast(a, (b - a) / d, d - 0.05)[0] is None
            k = int(d // 5) * 5
            n, v = buckets.get(k, (0, 0))
            buckets[k] = (n + 1, v + (1 if vis else 0))
            if vis and d > 35:
                long_lines.append((d, ta, tb, a, b))
    print(f"[audit] sight points={len(pts)}")
    for k in sorted(buckets):
        n, v = buckets[k]
        print(f"[audit]   {k:2d}-{k + 5:2d} m: pairs={n:6d} visible={v:6d} ({100 * v / n:5.1f}%)")
    long_lines.sort(key=lambda r: -r[0])
    print(f"[audit] visible sightlines > 35 m: {len(long_lines)}")
    for d, ta, tb, _a, _b in long_lines[:10]:
        print(f"[audit]   {d:.1f} m  {ta} <-> {tb}")
    _spawn_exposure(bvh)
    _suggest_blockers(bvh, long_lines)

    problems = 0
    seen = set()
    jump_links = set()
    pads = [(-7.0, 5.0), (7.0, -5.0)]
    for wid, (x, y, z, links) in WAYPOINTS.items():
        for other in links:
            key = tuple(sorted((wid, other)))
            if key in seen:
                continue
            seen.add(key)
            x2, y2, z2, _ = WAYPOINTS[other]
            length = math.hypot(x2 - x, z2 - z)
            n = max(2, math.ceil(length / 0.25))
            prev = y
            bad = None
            steep = 0
            step_at = None
            for k in range(n + 1):
                t = k / n
                px, pz = x + (x2 - x) * t, z + (z2 - z) * t
                start = max(prev, y + (y2 - y) * t) + 1.2
                loc, nrm, _i, _d = bvh.ray_cast(G(px, pz, start), down, start + 2.0)
                if loc is None:
                    bad = f"바닥 없음 @({px:.1f},{pz:.1f})"
                    break
                # 베벨 이음매의 한 점은 봐준다(연속 2점 이상 가파르면 실패)
                steep = steep + 1 if abs(nrm.z) < 0.64 else 0
                if steep >= 2:
                    bad = f"가파름 @({px:.1f},{pz:.1f})"
                    break
                if k and abs(loc.z - prev) > 0.2:
                    # 봇은 목표가 3 m 안이고 0.6 m 이상 높으면 뛴다(bots.ts followPath) → 1 m 턱은 높은 쪽 끝이
                    # 3 m 안이면 '점프 간선'으로 인정(파티오 출구). 반대 방향은 그냥 걸어 내려간다.
                    hx, hz = (x2, z2) if y2 > y else (x, z)
                    if abs(loc.z - prev) <= 1.05 and math.hypot(px - hx, pz - hz) < 2.8 and abs(y2 - y) >= 0.6:
                        jump_links.add(key)
                        step_at = (px, pz)
                        prev = loc.z
                        continue
                    bad = f"단차 {loc.z - prev:+.2f} m @({px:.1f},{pz:.1f})"
                    break
                prev = loc.z
                if step_at and math.hypot(px - step_at[0], pz - step_at[1]) < 0.7:
                    continue  # 점프 턱 바로 옆은 캡슐이 턱에 닿는 게 정상
                for h in (0.5, 0.95, 1.4):
                    near = bvh.find_nearest(G(px, pz, loc.z + h), 0.37)
                    if near[0] is not None:
                        bad = f"막힘(h={h}) @({px:.1f},{pz:.1f})"
                        break
                if bad:
                    break
            for (qx, qz) in pads:
                dx, dz = x2 - x, z2 - z
                tt = max(0.0, min(1.0, ((qx - x) * dx + (qz - z) * dz) / max(1e-9, dx * dx + dz * dz)))
                if math.hypot(x + dx * tt - qx, z + dz * tt - qz) < 1.3:
                    bad = bad or "점프대 위를 지나감"
            if bad:
                problems += 1
                print(f"[audit] link {wid} - {other}: {bad}")
    print(f"[audit] waypoint links={len(seen)} problems={problems} jump-up links={len(jump_links)} "
          f"({', '.join('-'.join(k) for k in sorted(jump_links))})")


def _spawn_exposure(bvh):
    """팀 스폰(눈높이)이 적 전망대 데크(0.5 m 격자)·적 파티오(1 m 격자)에서 보이는 점 수, 스폰끼리·파티오끼리 시야."""
    eye = 1.42

    def vis(a, b):
        d = (b - a).length
        return bvh.ray_cast(a, (b - a) / d, d - 0.05)[0] is None

    def deck_pts(sign):
        return [G(sign * (TOWER_X - 1.75 + 0.5 * i), sign * (TOWER_Z - 1.75 + 0.5 * j), TOWER_TOP + eye)
                for i in range(8) for j in range(8)]

    def patio_pts(sign):
        return [G(sign * (-23.5 + i), sign * (-7.5 + j), 1.0 + eye) for i in range(6) for j in range(16)]
    total = 0
    for i, (x, y, z, team) in enumerate(SPAWNS, 1):
        if team < 0:
            continue
        e = G(x, z, y + eye)
        # 팀 0(서쪽)의 적 = 동쪽(남동 전망대·동쪽 파티오) = 서쪽 자료의 원점 대칭(-1)
        tw = sum(vis(e, p) for p in deck_pts(-1 if team == 0 else 1))
        pt = sum(vis(e, p) for p in patio_pts(-1 if team == 0 else 1))
        total += tw + pt
        print(f"[audit]   spawn_{i:02d} ({x},{z}) team {team}: seen from enemy deck pts={tw}/64, enemy patio pts={pt}/96")
    pairs = 0
    for i, (x, y, z, t) in enumerate(SPAWNS):
        for j, (x2, y2, z2, t2) in enumerate(SPAWNS):
            if j <= i or t < 0 or t2 < 0 or t == t2:
                continue
            if vis(G(x, z, y + eye), G(x2, z2, y2 + eye)):
                pairs += 1
                print(f"[audit]   spawn_{i + 1:02d} <-> spawn_{j + 1:02d} visible")
    pp = sum(vis(a, b) for a in patio_pts(1) for b in patio_pts(-1))
    print(f"[audit] spawn exposure total={total} enemy-spawn pairs visible={pairs} patio<->patio visible pairs={pp}/{96 * 96}")


def _suggest_blockers(bvh, long_lines, top=8):
    """35 m 넘는 시야선을 가장 많이 끊는 차단물 자리(원점 대칭 쌍, 높이 2.2 m·반지름 0.6 m 기둥 가정)를 욕심껏 고른다.

    후보는 1 m 격자 중 빈 잔디/데크(주변 0.9 m 안 0.3~2 m 높이에 충돌체 없음). 출력만 하고 맵은 바꾸지 않는다.
    """
    down = Vector((0, 0, -1))
    cands = []
    for x in range(-22, 23):
        for z in range(-16, 17):
            loc = bvh.ray_cast(G(x, z, 6.0), down, 8.0)[0]
            if loc is None or abs(loc.z) > 0.05 or DECK_SDF(x, -z) < 0.0:
                continue
            if any(bvh.find_nearest(G(x, z, h), 0.9)[0] is not None for h in (1.0, 1.7)):
                continue
            cands.append((x, z))
    remaining = list(range(len(long_lines)))

    def hits(cx, cz, idxs):
        out = []
        for i in idxs:
            a, b = long_lines[i][3], long_lines[i][4]
            dx, dy = b.x - a.x, b.y - a.y
            L2 = dx * dx + dy * dy
            t = max(0.0, min(1.0, ((cx - a.x) * dx + (-cz - a.y) * dy) / L2))
            if math.hypot(a.x + dx * t - cx, a.y + dy * t + cz) < 0.6 and a.z + (b.z - a.z) * t < 2.2:
                out.append(i)
        return out
    print(f"[audit] blocker suggestions (symmetric pairs, greedy; {len(cands)} free cells):")
    for _ in range(top):
        best, best_hits = None, []
        for (cx, cz) in cands:
            h = set(hits(cx, cz, remaining)) | set(hits(-cx, -cz, remaining))
            if len(h) > len(best_hits):
                best, best_hits = (cx, cz), list(h)
        if not best or not best_hits:
            break
        remaining = [i for i in remaining if i not in set(best_hits)]
        print(f"[audit]   ({best[0]:+d}, {best[1]:+d}) & ({-best[0]:+d}, {-best[1]:+d}): -{len(best_hits)} → {len(remaining)} left")


# ---------------------------------------------------------------- 미리보기

def render_top(png_path, root):
    """위에서 본 직교 미리보기(북쪽 = 위). 마커는 임시 도형으로 표시."""
    png_path = os.path.abspath(png_path)
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    tmp = []
    mk_sp = material("_dbg_spawn", "#FF3355")
    mk_wp = material("_dbg_wp", "#2244FF")
    mk_ln = material("_dbg_link", "#3355FF")
    for o in root.children:
        if o.type != "EMPTY":
            continue
        p = o.matrix_world.translation
        if o.name.startswith("spawn_"):
            bm = bm_cyl(0.45, 0.2, 12, 0.0)
            transform(bm, Matrix.Translation(p + Vector((0, 0, 0.05))))
            tip = o.matrix_world.to_3x3() @ Vector((0, -1.2, 0))
            me = bpy.data.meshes.new("dbg")
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new("dbg_" + o.name, me)
            bpy.context.scene.collection.objects.link(ob)
            ob.data.materials.append(mk_sp)
            tmp.append(ob)
            bm = bm_tube([p + Vector((0, 0, 0.3)), p + tip + Vector((0, 0, 0.3))], 0.12, 6)
            me = bpy.data.meshes.new("dbg")
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new("dbg_dir_" + o.name, me)
            bpy.context.scene.collection.objects.link(ob)
            ob.data.materials.append(mk_sp)
            tmp.append(ob)
        elif o.name.startswith("wp_"):
            bm = bm_sphere(0.35, 8, 5)
            transform(bm, Matrix.Translation(p + Vector((0, 0, 0.3))))
            for l in str(o.get("links", "")).split(","):
                other = bpy.data.objects.get(l)
                if other is None or l < o.name:
                    continue
                q = other.matrix_world.translation
                tb = bm_tube([p + Vector((0, 0, 0.3)), q + Vector((0, 0, 0.3))], 0.07, 5, caps=False)
                me2 = bpy.data.meshes.new("dbgl")
                tb.to_mesh(me2)
                tb.free()
                ob2 = bpy.data.objects.new("dbgl", me2)
                bpy.context.scene.collection.objects.link(ob2)
                ob2.data.materials.append(mk_ln)
                tmp.append(ob2)
            me = bpy.data.meshes.new("dbg")
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new("dbg_" + o.name, me)
            bpy.context.scene.collection.objects.link(ob)
            ob.data.materials.append(mk_wp)
            tmp.append(ob)
    for o in root.children:
        if o.type == "MESH" and o.name.startswith("col_"):
            o.hide_render = True
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "MATERIAL"
    sh.show_object_outline = True
    sh.object_outline_color = (0.17, 0.18, 0.26)
    sh.show_cavity = True
    sh.cavity_type = "WORLD"
    sh.show_shadows = False
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 1500, 1150
    scene.render.filepath = png_path
    cam_data = bpy.data.cameras.new("TopCam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 54
    cam_data.clip_end = 500
    cam = bpy.data.objects.new("TopCam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, 0, 120)
    cam.rotation_euler = (0, 0, 0)
    scene.camera = cam
    # 위에서 본 화면은 +z(북)가 아래로 가므로, 스케매틱처럼 북쪽이 위(+x 오른쪽)가 되도록 합성기에서 세로로 뒤집는다
    scene.use_nodes = True
    nt = scene.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    rl = nt.nodes.new("CompositorNodeRLayers")
    flip = nt.nodes.new("CompositorNodeFlip")
    flip.axis = "Y"
    comp = nt.nodes.new("CompositorNodeComposite")
    nt.links.new(rl.outputs["Image"], flip.inputs["Image"])
    nt.links.new(flip.outputs["Image"], comp.inputs["Image"])
    bpy.ops.render.render(write_still=True)
    print(f"[preview] {png_path}")
    for o in tmp:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    for o in root.children:
        if o.type == "MESH":
            o.hide_render = False


# ---------------------------------------------------------------- main

STATS = {}


class stage:
    """main 의 빌드 단계별 삼각형 수를 모은다(예산 확인용, 빌드 로그에 출력)."""

    def __init__(self, label):
        self.label = label

    def __enter__(self):
        self.t0 = B.tris()

    def __exit__(self, *exc):
        STATS[self.label] = STATS.get(self.label, 0) + B.tris() - self.t0


def main():
    args = parse_args(lambda p: p.add_argument("--audit", action="store_true"))
    reset_scene()
    random.seed(20260925)
    root = bpy.data.objects.new("Map", None)
    bpy.context.scene.collection.objects.link(root)

    with stage("ground+pool"):
        build_ground_and_pool()
    for M, team in ((I4, 0), (R180, 1)):
        with stage("patio"):
            build_patio(M, team)
            patio_props(M, team)
        with stage("cabana"):
            cabana(M, -11.0, 2.0)
        with stage("tiki"):
            tiki_bar(M, 0.0, 5.5)
        with stage("hedge"):
            hedge(M, -9.0, -3.0, 9.0)
            hedge(M, 3.0, 9.0, 9.0)
        with stage("jumppad"):
            jump_pad(M, -7.0, 5.0, *JUMP_TARGET)
        with stage("fountain"):
            fountain(M, 6.0, 14.0)
        with stage("laundry+rack"):
            laundry(M, -6.0, -1.0, 13.0)
            towel_rack(M, 0.0, 16.0)
        with stage("tower"):
            tower(M, "tree" if team == 0 else "play")
        with stage("shed"):
            if team == 0:
                shed(M, 22.6, 16.75, 180, C["mint_lt"], C["coral"])
            else:
                shed(M, 22.6, 16.75, 180, C["peach"], C["roof_teal"])
        with stage("props"):
            float_stack(M, -9.3, -4.6)
            leaning_raft(M, -9.6, -2.8, 0)
            # 쿨러 뚜껑(0.86 m)은 산울타리에서 4 m 넘게 떨어뜨린다(뚜껑에서 뛰어 울타리 위로 올라서지 못하게)
            cooler(M, -8.0, 14.2, 15, C["aqua"] if team == 0 else C["coral"])
            cooler(M, 13.2, 12.2, 80, C["mint"] if team == 0 else C["butter"])
            cooler(M, -15.5, -7.5, 10, C["pink"] if team == 0 else C["aqua"])
            lounger(M, 5.4, 16.6, 90, C["aqua"])
            lounger(M, 7.2, 16.6, 90, C["peach"])
            rubber_duck(M, 10.3, 15.0, 120)
            # 고래는 북쪽(스폰) 레인 빨랫줄 옆: 산울타리 사이에 두면 두 울타리를 잇는 징검다리가 됐다
            whale(M, -3.5, 15.3, 90)
        with stage("plants"):
            shrub(M, -22.8, 14.2, 1.15)
            # (전망대 앞 토피어리·바나나 화분은 뺐다: 데크에서 뛰어 꼭대기에 올라 카바나 지붕·울타리로 번지는 길이 됐다)
            topiary(M, 13.8, 8.4)
            shrub(M, 17.2, 16.2, 1.25)
        with stage("pool toys"):
            flamingo(M, -2.2, 0.9, 25, swan=team == 1)
    with stage("pool toys"):
        donut(-4.4, -1.4, C["pink"])
        donut(4.4, 1.4, C["aqua"])
        beach_ball(-0.6, -2.1)
    with stage("fence"):
        build_fence()
    with stage("ground detail"):
        ground_detail()
    with stage("backdrop"):
        backdrop()

    objs = B.finish(root)
    build_markers(root)
    print(f"[map] objects={len(objs)} tris={B.tris()} (solid={B.tris(('solid',))} col={B.tris(('col',))} "
          f"nocol={B.tris(('nocol',))} water={B.tris(('water',))}) waypoints={len(WAYPOINTS)}")
    print("[map] tris by stage: " + ", ".join(f"{k}={v}" for k, v in STATS.items()))
    export_glb(args.out, roots=[root])
    if args.preview:
        render_top(args.preview, root)
    if args.audit:
        run_audit()


main()
