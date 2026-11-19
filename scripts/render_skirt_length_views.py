# scripts/render_skirt_length_views.py
"""スカートLength候補の画像QA用レンダリングスクリプト

概要
- context PKL の Body(SKIN)姿勢列と、base・各Length候補のスカート教師頂点列を読み込む
- 立位・遷移・座位の正面/側面の6視点を候補ごとにPNGで保存する

使い方
    python scripts/render_skirt_length_views.py [context.pkl] [出力ディレクトリ]
    (Blender が PATH 上にある場合。無ければ BLENDER_BIN で指定する)

出力ファイル名は {候補名}_{pose}_{view}.png。候補名には base も含む。
"""

import os
import pickle
import shutil
import subprocess
import sys

POSES = (("standing", 0.0), ("transition", 0.5), ("seated", 1.0))
VIEWS = (("front", (0.0, 0.0, 1.0)), ("side", (1.0, 0.0, 0.0)))


def render_in_blender(context_path, output_dir):
    import bpy
    from mathutils import Matrix, Vector

    with open(context_path, "rb") as file:
        context = pickle.load(file)
    sequences = {"base": context["skirt_geometric_teacher_vertices"]}
    sequences.update(context["skirt_length_teacher_vertices"])
    body_frames = context["skinned_vertices"]
    body_triangles = context["body_skin_triangles"]
    skirt_faces = context["skirt_faces"]
    frame_count = len(body_frames)
    os.makedirs(output_dir, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_backface_culling = False
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("QAWorld")
    scene.world.color = (0.9, 0.92, 0.95)

    def make_material(name, color):
        material = bpy.data.materials.new(name)
        material.diffuse_color = (*color, 1.0)
        return material

    body_material = make_material("QABody", (0.93, 0.78, 0.66))
    skirt_material = make_material("QASkirt", (0.18, 0.28, 0.62))

    def make_object(name, vertices, faces, material):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in vertices], [], [tuple(f) for f in faces])
        mesh.update()
        mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj

    camera_data = bpy.data.cameras.new("QACamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("QACamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    scene.camera = camera

    reference = body_frames[0]
    ys = [v[1] for v in reference]
    center = Vector((
        sum(v[0] for v in reference) / len(reference),
        (min(ys) + max(ys)) / 2.0,
        sum(v[2] for v in reference) / len(reference),
    ))
    # スカート周辺(腰〜膝)を中心に写す。全身だと裾の様子が小さすぎる。
    skirt_ys = [v[1] for v in sequences["base"][0]]
    focus_y = (min(skirt_ys) + max(skirt_ys)) / 2.0 - (max(skirt_ys) - min(skirt_ys)) * 0.15
    center.y = focus_y
    camera_data.ortho_scale = (max(skirt_ys) - min(skirt_ys)) * 3.2

    for name, sequence in sequences.items():
        for pose, ratio in POSES:
            index = min(frame_count - 1, int(round(ratio * (frame_count - 1))))
            body = make_object("Body", body_frames[index], body_triangles, body_material)
            skirt = make_object("Skirt", sequence[index], skirt_faces, skirt_material)
            for view, direction in VIEWS:
                camera.location = center + Vector(direction) * 400.0
                # to_track_quatはワールドZを上にするため、Y上の体には使えない。
                # カメラの-Zが被写体を向き、+Yが体の上方向になる基準を直接組む。
                backward = Vector(direction).normalized()
                right = Vector((0.0, 1.0, 0.0)).cross(backward).normalized()
                upward = backward.cross(right)
                camera.rotation_euler = Matrix(
                    ((right.x, upward.x, backward.x),
                     (right.y, upward.y, backward.y),
                     (right.z, upward.z, backward.z))
                ).to_euler()
                scene.render.filepath = os.path.join(output_dir, f"{name}_{pose}_{view}.png")
                bpy.ops.render.render(write_still=True)
            bpy.data.objects.remove(body, do_unlink=True)
            bpy.data.objects.remove(skirt, do_unlink=True)
        print(f"[render] done {name}", flush=True)


def main():
    if "--" in sys.argv:
        context_path, output_dir = sys.argv[sys.argv.index("--") + 1:][:2]
    elif len(sys.argv) >= 3:
        context_path, output_dir = sys.argv[1:3]
    else:
        raise SystemExit("usage: render_skirt_length_views.py context.pkl output_dir")
    try:
        import bpy  # noqa: F401
    except ModuleNotFoundError:
        blender = shutil.which("blender") or os.environ.get("BLENDER_BIN")
        if not blender:
            raise SystemExit("Blender が見つかりません。BLENDER_BIN を指定してください。")
        subprocess.run(
            [blender, "--background", "--python-exit-code", "1",
             "--python", os.path.abspath(__file__), "--",
             os.path.abspath(context_path), os.path.abspath(output_dir)],
            check=True,
        )
        return
    render_in_blender(context_path, output_dir)


main()
