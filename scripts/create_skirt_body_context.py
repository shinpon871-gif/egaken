import importlib
import os
import shutil
import subprocess
import sys
import tempfile


DEFAULT_ARGUMENTS = [
    os.environ.get(
        "DNN_BODY_FBX_PATH",
        "/content/public/models/StandToSit_model.fbx",
    ),
    os.environ.get(
        "DNN_BODY_CONTEXT_PATH",
        "/content/public/models/skirt_body_context_for_dnn.pkl",
    ),
    os.environ.get("DNN_BODY_VERTEX_COUNT", "0"),
    os.environ.get("DNN_BODY_FRAME_COUNT", "120"),
    os.environ.get("DNN_BODY_PROGRESS_LIMIT", "0.85"),
]


def get_arguments():
    if "--" in sys.argv:
        arguments = sys.argv[sys.argv.index("--") + 1:]
    elif len(sys.argv[1:]) == 5:
        arguments = sys.argv[1:]
    else:
        arguments = DEFAULT_ARGUMENTS
    if len(arguments) < 5:
        raise RuntimeError(
            "FBX 出力PKL 頂点数 フレーム数 進捗上限が必要です。"
        )
    return arguments[:5]


def blender_source():
    return r'''import bpy
import math
import os
import pickle
import sys
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
fbx_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
requested_vertex_count = int(args[2])
frame_count = int(args[3])
progress_limit = float(args[4])
if frame_count < 2:
    raise RuntimeError("フレーム数は2以上にしてください。")
if not os.path.isfile(fbx_path):
    raise FileNotFoundError("FBXが見つかりません: " + fbx_path)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(
    filepath=fbx_path,
    use_anim=True,
    use_image_search=False,
)
body_candidates = [
    obj for obj in bpy.context.scene.objects
    if obj.type == "MESH" and obj.name.lower() == "body"
]
if not body_candidates:
    raise RuntimeError("Bodyメッシュを取得できませんでした。")
body_object = body_candidates[0]
skin_material_indices = {
    index for index, slot in enumerate(body_object.material_slots)
    if slot.material and "skin" in slot.material.name.lower()
}
body_vertex_indices = sorted({
    vertex_index
    for polygon in body_object.data.polygons
    if polygon.material_index in skin_material_indices
    for vertex_index in polygon.vertices
})
body_object.data.calc_loop_triangles()
bottom_material_indices = {
    index for index, slot in enumerate(body_object.material_slots)
    if slot.material and "bottom" in slot.material.name.lower()
}
bottom_triangles = [
    tuple(loop_triangle.vertices)
    for loop_triangle in body_object.data.loop_triangles
    if body_object.data.polygons[loop_triangle.polygon_index].material_index
    in bottom_material_indices
]
skirt_vertex_indices = sorted({
    vertex_index for triangle in bottom_triangles for vertex_index in triangle
})
skirt_vertex_remap = {
    source_index: target_index
    for target_index, source_index in enumerate(skirt_vertex_indices)
}
skirt_faces = [
    [skirt_vertex_remap[index] for index in triangle]
    for triangle in bottom_triangles
]
if len(skirt_vertex_indices) < 4 or not skirt_faces:
    raise RuntimeError("BodyのBottoms面からスカートを抽出できませんでした。")
skirt_base_vertices = [
    [float(body_object.data.vertices[index].co.x),
     float(body_object.data.vertices[index].co.y),
     float(body_object.data.vertices[index].co.z)]
    for index in skirt_vertex_indices
]
if requested_vertex_count > 0 and len(body_vertex_indices) != requested_vertex_count:
    raise RuntimeError(
        "SKIN面の頂点数が指定値と一致しません: "
        f"{len(body_vertex_indices)} != {requested_vertex_count}"
    )
if len(body_vertex_indices) < 4:
    raise RuntimeError("BodyのSKIN面から十分な頂点を抽出できませんでした。")
body_base_vertices = [
    [float(body_object.data.vertices[index].co.x),
     float(body_object.data.vertices[index].co.y),
     float(body_object.data.vertices[index].co.z)]
    for index in body_vertex_indices
]
vertex_count = len(body_vertex_indices)


def bbox_extent(points):
    array = np.asarray(points, dtype=np.float64)
    return (array.min(axis=0).tolist(), array.max(axis=0).tolist())


skin_min, skin_max = bbox_extent(body_base_vertices)
skirt_min, skirt_max = bbox_extent(skirt_base_vertices)
print(f"[diag] Body/SKIN vertices: {len(body_base_vertices)}, bbox min={skin_min}, max={skin_max}")
print(f"[diag] Body/Bottoms vertices: {len(skirt_base_vertices)}, bbox min={skirt_min}, max={skirt_max}")

armature_modifier = next(
    (modifier for modifier in body_object.modifiers if modifier.type == "ARMATURE"),
    None,
)
armature_object = armature_modifier.object if armature_modifier else None
print(f"[diag] body_object.animation_data.action: "
      f"{getattr(getattr(body_object.animation_data, 'action', None), 'name', None)}")
print(f"[diag] armature modifier target: {armature_object.name if armature_object else None}")
if armature_object is not None:
    print(
        f"[diag] armature_object.animation_data.action: "
        f"{getattr(getattr(armature_object.animation_data, 'action', None), 'name', None)}"
    )
print(f"[diag] bpy.data.actions ({len(bpy.data.actions)}):")
for action in bpy.data.actions:
    print(
        f"[diag]   action='{action.name}' frame_range="
        f"({action.frame_range[0]:.2f}, {action.frame_range[1]:.2f})"
    )

driving_action = None
if armature_object is not None and armature_object.animation_data is not None:
    driving_action = armature_object.animation_data.action
if driving_action is None and body_object.animation_data is not None:
    driving_action = body_object.animation_data.action

if driving_action is not None:
    # 実際にBodyを駆動しているアクションだけを範囲対象にする。
    # bpy.data.actions全体のmin/maxを取ると、無関係な別アクション
    # (Idle等)が混入してprogress_limitの意味がズレる。
    animation_start = float(driving_action.frame_range[0])
    animation_end = float(driving_action.frame_range[1])
    print(f"[diag] using driving_action='{driving_action.name}' for frame range")
else:
    action_ranges = [
        (float(action.frame_range[0]), float(action.frame_range[1]))
        for action in bpy.data.actions
    ]
    animation_start = min(
        (item[0] for item in action_ranges),
        default=float(bpy.context.scene.frame_start),
    )
    animation_end = max(
        (item[1] for item in action_ranges),
        default=float(bpy.context.scene.frame_end),
    )
    print(
        "[diag] no driving action found on body/armature; "
        "falling back to min/max across all actions"
    )
if animation_end <= animation_start:
    raise RuntimeError("有効な身体アニメーション範囲がありません。")
print(f"[diag] animation_start={animation_start:.3f}, animation_end={animation_end:.3f}")

skinned_vertices = []
for index in range(frame_count):
    progress = index / float(frame_count - 1)
    body_progress = max(0.0, min(1.0, progress)) * progress_limit
    source_frame = animation_start + (
        animation_end - animation_start
    ) * body_progress
    frame_floor = math.floor(source_frame)
    bpy.context.scene.frame_set(
        int(frame_floor),
        subframe=float(source_frame - frame_floor),
    )
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_object = body_object.evaluated_get(depsgraph)
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph,
    )
    try:
        # body_base_vertices/skirt_base_verticesと同じローカル座標系に揃える。
        # matrix_worldを掛けるとFBXのスケール・位置オフセットが混入し、
        # body_motionが実際のポーズ変化ではなくその定数ズレ主体になってしまう。
        vertices = [[
            float(evaluated_mesh.vertices[index].co.x),
            float(evaluated_mesh.vertices[index].co.y),
            float(evaluated_mesh.vertices[index].co.z),
        ] for index in body_vertex_indices]
    finally:
        evaluated_object.to_mesh_clear()
    if len(vertices) != vertex_count:
        raise RuntimeError("評価後Body/SKIN頂点数が一致しません。")
    skinned_vertices.append(vertices)

skinned_array = np.asarray(skinned_vertices, dtype=np.float64)
base_array = np.asarray(body_base_vertices, dtype=np.float64)
# per-vertex, per-frame displacement: (frames, vertices, 3)
per_vertex_motion = skinned_array - base_array[None, :, :]
# per-frame mean displacement across vertices: (frames, 3)
body_motion_preview = np.mean(per_vertex_motion, axis=1)
motion_norms = np.linalg.norm(body_motion_preview, axis=1)
per_vertex_norms_max = np.linalg.norm(per_vertex_motion, axis=2).max(axis=1)
print(
    f"[diag] body_motion mean-norm: min={motion_norms.min():.6f}, "
    f"mean={motion_norms.mean():.6f}, max={motion_norms.max():.6f}"
)
print(
    f"[diag] per-vertex motion max-norm per-frame: min={per_vertex_norms_max.min():.6f}, "
    f"mean={per_vertex_norms_max.mean():.6f}, max={per_vertex_norms_max.max():.6f}"
)
# show percentiles to detect outliers
percentiles = np.percentile(np.linalg.norm(per_vertex_motion, axis=2).ravel(), [50, 90, 95, 99])
print(
    f"[diag] per-vertex motion percentiles (50,90,95,99): "
    f"{percentiles[0]:.6f},{percentiles[1]:.6f},{percentiles[2]:.6f},{percentiles[3]:.6f}"
)
# body_motionが単調に増加/収束しているか、途中で山型になって戻っていないかを
# progress(=このPKLのフレームindex/frame_count)の刻みで確認する。
sample_indices = sorted({
    int(round(ratio * (frame_count - 1)))
    for ratio in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
})
print("[diag] body_motion norm curve (index: progress%, source_frame, norm):")
for sample_index in sample_indices:
    sample_progress = sample_index / float(frame_count - 1)
    sample_body_progress = max(0.0, min(1.0, sample_progress)) * progress_limit
    sample_source_frame = animation_start + (
        animation_end - animation_start
    ) * sample_body_progress
    print(
        f"[diag]   idx={sample_index:03d} progress={sample_progress * 100:5.1f}% "
        f"source_frame={sample_source_frame:8.2f} "
        f"norm={motion_norms[sample_index]:.6f}"
    )

os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "body_base_vertices": body_base_vertices,
            "body_vertex_indices": body_vertex_indices,
            "skinned_vertices": skinned_vertices,
            # 保存は従来互換のフレームごとの平均変位 (frames, 3)
            "body_motion": body_motion_preview.tolist(),
            # 追加: フレーム×頂点の生の変位データ (frames, vertices, 3)
            "body_motion_per_vertex": per_vertex_motion.tolist(),
            "skirt_base_vertices": skirt_base_vertices,
            "skirt_faces": skirt_faces,
            "skirt_vertex_indices": skirt_vertex_indices,
            "animation_start": animation_start,
            "animation_end": animation_end,
            "progress_limit": progress_limit,
        },
        file,
        protocol=4,
    )
print("身体特徴量を保存しました: " + output_path)
'''


def run_from_colab(arguments):
    blender_command = shutil.which("blender")
    if blender_command is None:
        raise RuntimeError(
            "Blenderが見つかりません。先にColabで"
            " !apt-get update -qq && !apt-get install -y -qq blender"
            " を実行してください。"
        )
    worker_file = tempfile.NamedTemporaryFile(
        mode="w",
        suffix="_body_context.py",
        delete=False,
        encoding="utf-8",
    )
    try:
        worker_file.write(blender_source())
        worker_file.close()
        result = subprocess.run(
            [
                blender_command,
                "--background",
                "--python-exit-code",
                "1",
                "--python",
                worker_file.name,
                "--",
                *arguments,
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    finally:
        try:
            os.unlink(worker_file.name)
        except FileNotFoundError:
            pass
    # Blender出力を表示して詳細診断をユーザに渡す
    try:
        output = result.stdout
    except Exception:
        output = None
    if output:
        print("--- Blender output start ---")
        print(output)
        print("--- Blender output end ---")
    if result.returncode != 0:
        raise RuntimeError(
            "Blenderで身体特徴量を作成できませんでした。"
            f" 終了コード: {result.returncode}\n--- Blender output ---\n{output}"
        )
    print("Blenderでの身体特徴量作成が完了しました。")


def main():
    arguments = get_arguments()
    try:
        importlib.import_module("bpy")
    except ModuleNotFoundError:
        run_from_colab(arguments)
        return
    raise RuntimeError(
        "このファイルはBlender内ではなく、Colabまたは通常のPythonから"
        "実行してください。"
    )


main()
