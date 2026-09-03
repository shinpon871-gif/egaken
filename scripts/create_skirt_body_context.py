import importlib
import os
import shutil
import subprocess
import sys
import tempfile


DEFAULT_ARGUMENTS = [
    os.environ.get(
        "DNN_BODY_FBX_PATH",
        "/content/public/models/StandToSit.fbx",
    ),
    os.environ.get(
        "DNN_BODY_CONTEXT_PATH",
        "/content/public/models/skirt_body_context_for_dnn.pkl",
    ),
    os.environ.get("DNN_BODY_VERTEX_COUNT", "1259"),
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

args = sys.argv[sys.argv.index("--") + 1:]
fbx_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
vertex_count = int(args[2])
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
candidates = [
    obj for obj in bpy.context.scene.objects
    if obj.type == "MESH"
    and obj.name.lower().startswith("d026")
    and len(obj.data.vertices) == vertex_count
]
if not candidates:
    raise RuntimeError(
        "頂点数が一致するd026メッシュを取得できませんでした。"
    )
d026_object = candidates[0]
d026_vertices = [
    [float(vertex.co.x), float(vertex.co.y), float(vertex.co.z)]
    for vertex in d026_object.data.vertices
]
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
if animation_end <= animation_start:
    raise RuntimeError("有効な身体アニメーション範囲がありません。")

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
    evaluated_object = d026_object.evaluated_get(depsgraph)
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph,
    )
    try:
        vertices = [
            [
                float((evaluated_object.matrix_world @ vertex.co).x),
                float((evaluated_object.matrix_world @ vertex.co).y),
                float((evaluated_object.matrix_world @ vertex.co).z),
            ]
            for vertex in evaluated_mesh.vertices
        ]
    finally:
        evaluated_object.to_mesh_clear()
    if len(vertices) != vertex_count:
        raise RuntimeError("評価後d026頂点数が一致しません。")
    skinned_vertices.append(vertices)

os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "d026_vertices": d026_vertices,
            "skinned_vertices": skinned_vertices,
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
        )
    finally:
        try:
            os.unlink(worker_file.name)
        except FileNotFoundError:
            pass
    if result.returncode != 0:
        raise RuntimeError(
            "Blenderで身体特徴量を作成できませんでした。"
            f" 終了コード: {result.returncode}"
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
