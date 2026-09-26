"""캐릭터 + 모자 조합 확인용(개발 도구, 게임 에셋 아님).

character.glb 와 hats.glb 를 Blender 로 불러와 캐릭터를 모자 수만큼 복제하고,
각 캐릭터의 HatAnchor 에 모자를 런타임과 똑같이(로컬 위치·회전 0) 붙인다.
결과를 스크래치 GLB 로 내보내 dev/viewer.html 에서 툰 셰이딩으로 보거나(권장),
--preview 로 Workbench PNG 를 렌더한다.

  blender -b --factory-startup --python tools/blender/char_with_hat_preview.py -- \
      --out public/assets/models/_scratch_hats.glb --hats cap,duck,flower \
      [--preview tools/blender/previews/char_hats.png]
  node tools/screenshot.mjs "/dev/viewer.html?file=_scratch_hats.glb&yaw=20" tools/blender/previews/char_hats_web.png

스크래치 GLB(public/assets/models/_scratch_*.glb)는 확인 후 반드시 지운다.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: E402,F401
from mathutils import Matrix  # noqa: E402

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "assets", "models")
SPACING = 1.25


def extra_args(p):
    p.add_argument("--hats", default="cap,duck,flower,crown,frog,bucket", help="쉼표 구분 모자 id 목록")
    p.add_argument("--character", default=os.path.join(MODELS, "character.glb"))
    p.add_argument("--hatfile", default=os.path.join(MODELS, "hats.glb"))
    p.add_argument("--gun", default="", help="GunAnchor 에 붙여 볼 무기 노드(예: gun_pistol). 비우면 생략")
    p.add_argument("--weaponfile", default=os.path.join(MODELS, "weapons.glb"))


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    return [o for o in bpy.data.objects if o not in before]


def merge_duplicate_materials():
    """두 파일에 같은 이름 머티리얼(Pupil, Eye …)이 있으면 'X.001' 로 들어온다 → 원래 이름으로 합친다.
    (런타임 툰 변환이 머티리얼 이름으로 동작하므로 이름이 바뀌면 미리보기가 게임과 달라진다.)"""
    for m in list(bpy.data.materials):
        mm = re.match(r"^(.*)\.\d{3}$", m.name)
        if mm and mm.group(1) in bpy.data.materials:
            m.user_remap(bpy.data.materials[mm.group(1)])
            bpy.data.materials.remove(m)


def duplicate_tree(obj, parent=None):
    c = obj.copy()  # 메시 데이터는 공유
    bpy.context.scene.collection.objects.link(c)
    c.parent = parent
    if parent is not None:
        c.matrix_parent_inverse = obj.matrix_parent_inverse.copy()
    for ch in obj.children:
        duplicate_tree(ch, c)
    return c


def find_in(root, name):
    for o in [root, *root.children_recursive]:
        if o.name == name or o.name.startswith(name + "."):
            return o
    return None


def main():
    args = parse_args(extra_args)
    reset_scene()
    char_objs = import_glb(args.character)
    char = next(o for o in char_objs if o.name == "Character")
    hat_objs = import_glb(args.hatfile)
    gun_objs = import_glb(args.weaponfile) if args.gun else []
    merge_duplicate_materials()
    hats = {o.name: o for o in hat_objs if o.parent is None}
    gun = next((o for o in gun_objs if o.name == args.gun), None)
    if args.gun and gun is None:
        raise SystemExit(f"gun not found: {args.gun}")

    ids = [h.strip() for h in args.hats.split(",") if h.strip()]
    missing = [h for h in ids if f"hat_{h}" not in hats]
    if missing:
        raise SystemExit(f"hat not found: {missing} (have {sorted(hats)})")
    # 모자를 붙이기 전에 먼저 모두 복제(복제본에 앞 캐릭터의 모자가 따라오지 않게)
    chars = [char] + [duplicate_tree(char) for _ in ids[1:]]
    roots = []
    for i, (hid, c) in enumerate(zip(ids, chars)):
        key = f"hat_{hid}"
        c.location = ((i - (len(ids) - 1) / 2) * SPACING, 0.0, 0.0)
        anchor = find_in(c, "HatAnchor")
        h = duplicate_tree(hats[key])
        h.parent = anchor
        h.matrix_parent_inverse = Matrix.Identity(4)
        h.location = (0.0, 0.0, 0.0)
        h.rotation_euler = (0.0, 0.0, 0.0)
        if gun is not None:  # 런타임 setWeapon 과 같게: GunAnchor 자식, 로컬 변환 0
            g = duplicate_tree(gun)
            g.parent = find_in(c, "GunAnchor")
            g.matrix_parent_inverse = Matrix.Identity(4)
            g.location = (0.0, 0.0, 0.0)
            g.rotation_euler = (0.0, 0.0, 0.0)
        roots.append(c)
    for o in hat_objs + gun_objs:
        bpy.data.objects.remove(o, do_unlink=True)

    export_glb(args.out, roots=roots)
    if args.preview:
        render_preview(args.preview, target=(0, 0, 0.95), distance=2.6 + 1.1 * len(ids), yaw_deg=-20,
                       pitch_deg=10, res=(1400, 700))


main()
