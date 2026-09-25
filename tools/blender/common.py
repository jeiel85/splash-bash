"""Splash Bash 에셋 스크립트 공통 헬퍼 (Blender 4.5).

사용법(각 에셋 스크립트 안에서):
    import sys, os; sys.path.insert(0, os.path.dirname(__file__))
    from common import *
    args = parse_args()
    reset_scene()
    ... 모델링 ...
    export_glb(args.out, roots=[root])
    if args.preview: render_preview(args.preview)

규약은 docs/ASSETS.md 참고. 이 파일은 여러 에셋 스크립트가 공유하므로
새 헬퍼는 도메인 전용 모듈(예: char_parts.py)에 두고 여기는 범용 기능만 둔다.
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler


# ---------------------------------------------------------------- args / scene

def parse_args(extra=None):
    """`blender -b -P script.py -- --out x.glb [--preview y.png]` 인자 파싱."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True, help="출력 GLB 경로")
    p.add_argument("--preview", default=None, help="미리보기 PNG 경로(선택)")
    if extra:
        extra(p)
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def hex_rgba(hex_str: str, alpha: float = 1.0):
    h = hex_str.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    # Principled Base Color 는 linear 값 → sRGB hex 를 linear 로 변환해야
    # glTF 로 내보낸 뒤 원래 hex 와 같은 색이 나온다.
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


_MAT_CACHE: dict[str, bpy.types.Material] = {}


def material(name: str, hex_color: str = "#FFFFFF", roughness: float = 0.6, alpha: float = 1.0):
    """이름 규약 머티리얼(Tint, Water, Eye ...)이나 일반 색 머티리얼을 만든다(이름당 1개)."""
    if name in _MAT_CACHE and _MAT_CACHE[name].name in bpy.data.materials:
        return _MAT_CACHE[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(hex_color, alpha)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else mat.blend_method
    mat.diffuse_color = hex_rgba(hex_color, alpha)  # Workbench 미리보기용
    _MAT_CACHE[name] = mat
    return mat


def color_mat(hex_color: str, roughness: float = 0.6):
    """색 이름 머티리얼(예: `C_FFA552`). 같은 색은 재사용."""
    return material("C_" + hex_color.lstrip("#").upper(), hex_color, roughness)


# ---------------------------------------------------------------- objects

def link(obj, parent=None):
    if obj.name not in bpy.context.scene.collection.objects and not obj.users_collection:
        bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def set_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def empty(name: str, loc=(0, 0, 0), parent=None, rot=(0, 0, 0), size=0.1, extras: dict | None = None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = size
    e.location = loc
    e.rotation_euler = rot
    link(e, parent)
    if extras:
        for k, v in extras.items():
            e[k] = v
    return e


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def subsurf(obj, levels: int = 2):
    m = obj.modifiers.new("Subsurf", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    return obj


def bevel(obj, width: float = 0.02, segments: int = 3):
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(30)
    m.harden_normals = False
    return obj


def apply_modifiers(obj):
    set_active(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    return obj


def apply_transform(obj, location=False, rotation=True, scale=True):
    set_active(obj)
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)
    return obj


def uv_sphere(name, radius=0.5, loc=(0, 0, 0), scale=(1, 1, 1), segments=32, rings=16, mat=None, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    o.scale = scale
    smooth(o)
    if mat:
        assign(o, mat)
    if parent:
        o.parent = parent
    return o


def rounded_box(name, size=(1, 1, 1), loc=(0, 0, 0), radius=0.05, segments=3, mat=None, parent=None):
    """모서리가 둥근 박스(Bevel 적용 전 상태로 반환 — apply_modifiers 로 확정)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    o.scale = size
    apply_transform(o, rotation=False, scale=True)
    bevel(o, width=min(radius, min(size) * 0.49), segments=segments)
    smooth(o)
    if mat:
        assign(o, mat)
    if parent:
        o.parent = parent
    return o


def cylinder(name, radius=0.5, depth=1.0, loc=(0, 0, 0), rot=(0, 0, 0), vertices=32, mat=None, parent=None, bevel_w=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    if bevel_w > 0:
        bevel(o, width=bevel_w, segments=3)
    smooth(o)
    if mat:
        assign(o, mat)
    if parent:
        o.parent = parent
    return o


def torus(name, major=0.5, minor=0.1, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, parent=None, major_seg=48, minor_seg=16):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rot,
                                     major_segments=major_seg, minor_segments=minor_seg)
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    smooth(o)
    if mat:
        assign(o, mat)
    if parent:
        o.parent = parent
    return o


def join(objs, name):
    """여러 메시를 하나로 합친다(첫 오브젝트 기준). 모디파이어는 먼저 적용해 둘 것."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    return o


def triangle_count(objs=None) -> int:
    objs = objs or [o for o in bpy.context.scene.objects if o.type == "MESH"]
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        total += sum(len(p.vertices) - 2 for p in me.polygons)
        ev.to_mesh_clear()
    return total


# ---------------------------------------------------------------- export / preview

def export_glb(out_path: str, roots=None):
    """모디파이어 적용 + extras 포함 GLB 내보내기. roots 가 있으면 그 계층만 내보낸다."""
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    use_selection = False
    if roots:
        use_selection = True
        for r in roots:
            r.select_set(True)
            for c in r.children_recursive:
                c.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=use_selection,
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
    )
    print(f"[export] {out_path}  tris={triangle_count()}")


def render_preview(png_path: str, target=(0, 0, 0.8), distance=4.0, yaw_deg=-30.0, pitch_deg=15.0,
                   res=(900, 700), ortho_scale=None):
    """Workbench 로 빠른 미리보기 PNG 렌더(머티리얼 색 사용). 최종 확인은 dev/viewer.html."""
    png_path = os.path.abspath(png_path)
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_cavity = False
    shading.show_object_outline = True
    shading.object_outline_color = (0.17, 0.18, 0.26)
    shading.show_shadows = True
    scene.display.shadow_shift = 0.1
    world = bpy.data.worlds.new("PreviewWorld") if not scene.world else scene.world
    scene.world = world
    world.color = (0.66, 0.88, 1.0)
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.film_transparent = False
    scene.render.filepath = png_path

    cam_data = bpy.data.cameras.new("PreviewCam")
    if ortho_scale:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho_scale
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    t = Vector(target)
    # Blender 정면(-Y)에서 바라보는 것이 yaw=0
    cam.location = t + Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch))) * distance
    direction = t - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    print(f"[preview] {png_path}")
