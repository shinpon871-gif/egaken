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
    os.environ.get("DNN_TRUNCATE_AFTER_MOTION_PEAK", "0"),
]


def get_arguments():
    if "--" in sys.argv:
        arguments = sys.argv[sys.argv.index("--") + 1:]
    elif len(sys.argv[1:]) >= 5:
        arguments = sys.argv[1:]
    else:
        arguments = DEFAULT_ARGUMENTS
    if len(arguments) < 5:
        raise RuntimeError(
            "FBX 出力PKL 頂点数 フレーム数 進捗上限が必要です。"
        )
    if len(arguments) < 6:
        arguments = [*arguments[:5], "0"]
    return arguments[:6]


def blender_source():
    return r'''import bpy
import math
import os
import pickle
import sys


def vector_sub(left, right):
    return [left[axis] - right[axis] for axis in range(3)]


def vector_norm(values):
    return math.sqrt(sum(value * value for value in values))


def mean_vector(vectors):
    count = len(vectors)
    if count == 0:
        return [0.0, 0.0, 0.0]
    return [
        sum(vector[axis] for vector in vectors) / count
        for axis in range(3)
    ]


def percentile(sorted_values, percent):
    if not sorted_values:
        return 0.0
    position = (len(sorted_values) - 1) * percent / 100.0
    lower = int(math.floor(position))
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return (
        sorted_values[lower] * (1.0 - weight)
        + sorted_values[upper] * weight
    )


def bbox_extent(points):
    if not points:
        raise RuntimeError("空の頂点列のbboxは計算できません。")
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    return minimum, maximum

args = sys.argv[sys.argv.index("--") + 1:]
fbx_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
requested_vertex_count = int(args[2])
frame_count = int(args[3])
progress_limit = float(args[4])
truncate_after_motion_peak = args[5].lower() in {"1", "true", "yes", "on"}
print("[diag] body_context_worker_version=numpy_free_v2")
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
if (
    requested_vertex_count > 0
    and len(body_vertex_indices) != requested_vertex_count
):
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

skin_min, skin_max = bbox_extent(body_base_vertices)
skirt_min, skirt_max = bbox_extent(skirt_base_vertices)
print(
    f"[diag] Body/SKIN vertices: {len(body_base_vertices)}, "
    f"bbox min={skin_min}, max={skin_max}"
)
print(
    f"[diag] Body/Bottoms vertices: {len(skirt_base_vertices)}, "
    f"bbox min={skirt_min}, max={skirt_max}"
)

armature_modifier = next(
    (
        modifier
        for modifier in body_object.modifiers
        if modifier.type == "ARMATURE"
    ),
    None,
)
armature_object = armature_modifier.object if armature_modifier else None
body_action = getattr(
    getattr(body_object.animation_data, 'action', None),
    'name',
    None,
)
print(f"[diag] body_object.animation_data.action: "
      f"{body_action}")
armature_name = armature_object.name if armature_object else None
print(f"[diag] armature modifier target: {armature_name}")
if armature_object is not None:
    armature_action = getattr(
        getattr(armature_object.animation_data, 'action', None),
        'name',
        None,
    )
    print(
        f"[diag] armature_object.animation_data.action: "
        f"{armature_action}"
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
    print(
        f"[diag] using driving_action='{driving_action.name}' "
        "for frame range"
    )
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
print(
    f"[diag] animation_start={animation_start:.3f}, "
    f"animation_end={animation_end:.3f}"
)

skinned_vertices = []
sampled_body_progresses = []
sampled_source_frames = []
for index in range(frame_count):
    progress = index / float(frame_count - 1)
    body_progress = max(0.0, min(1.0, progress)) * progress_limit
    source_frame = animation_start + (
        animation_end - animation_start
    ) * body_progress
    sampled_body_progresses.append(float(body_progress))
    sampled_source_frames.append(float(source_frame))
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

# per-vertex, per-frame displacement: (frames, vertices, 3)
per_vertex_motion = [
    [
        vector_sub(vertex, body_base_vertices[vertex_index])
        for vertex_index, vertex in enumerate(frame_vertices)
    ]
    for frame_vertices in skinned_vertices
]
# per-frame mean displacement across vertices: (frames, 3)
body_motion_preview = [
    mean_vector(frame_motion)
    for frame_motion in per_vertex_motion
]
motion_norms = [vector_norm(motion) for motion in body_motion_preview]
per_vertex_norms_max = [
    max(vector_norm(motion) for motion in frame_motion)
    for frame_motion in per_vertex_motion
]
# 切り捨て後もsource_frame表示が元のサンプリング刻みと対応するよう、
# 切り捨て前のframe_countを別名で保持しておく。
original_frame_count = frame_count

# DNN入力姿勢はランタイムで表示するFBX姿勢系列と一致させる必要がある。
# 以前はbody_motionの平均ノルムがピークに達した後を切り捨てていたが、
# その場合GLB最終PoseがランタイムのUI 100%姿勢ではなく途中姿勢に対応し、
# スカートと人体の姿勢定義が一致しなくなる。
# 旧挙動が必要な検証時のみ、明示フラグで切り捨てを有効化する。
peak_index = max(
    range(len(motion_norms)),
    key=lambda index: motion_norms[index],
)
if truncate_after_motion_peak and peak_index < frame_count - 1:
    print(
        f"[diag] body_motion norm がidx={peak_index:03d}でピークに達した後"
        "減少しています。以降のフレームを切り捨てます "
        f"(採用フレーム数: {peak_index + 1}/{frame_count})。"
    )
    skinned_vertices = skinned_vertices[: peak_index + 1]
    per_vertex_motion = per_vertex_motion[: peak_index + 1]
    body_motion_preview = body_motion_preview[: peak_index + 1]
    motion_norms = motion_norms[: peak_index + 1]
    per_vertex_norms_max = per_vertex_norms_max[: peak_index + 1]
    sampled_body_progresses = sampled_body_progresses[: peak_index + 1]
    sampled_source_frames = sampled_source_frames[: peak_index + 1]
    frame_count = peak_index + 1
elif peak_index < frame_count - 1:
    print(
        f"[diag] body_motion norm はidx={peak_index:03d}でピークに達した後"
        "減少していますが、ランタイム表示姿勢との同期を保つため"
        "切り捨てません。"
    )
if frame_count < 2:
    raise RuntimeError(
        "body_motionが最初のフレームでピークになり単調な区間がありません。"
        "アニメーションまたはprogress_limitを見直してください。"
    )

print(
    f"[diag] body_motion mean-norm: min={min(motion_norms):.6f}, "
    f"mean={sum(motion_norms) / len(motion_norms):.6f}, "
    f"max={max(motion_norms):.6f}"
)
print(
    f"[diag] per-vertex motion max-norm per-frame: "
    f"min={min(per_vertex_norms_max):.6f}, "
    f"mean={sum(per_vertex_norms_max) / len(per_vertex_norms_max):.6f}, "
    f"max={max(per_vertex_norms_max):.6f}"
)
# show percentiles to detect outliers
motion_norm_values = sorted(
    vector_norm(motion)
    for frame_motion in per_vertex_motion
    for motion in frame_motion
)
percentiles = [
    percentile(motion_norm_values, percent)
    for percent in (50, 90, 95, 99)
]
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
    # progress/source_frameは生成時と同じ分母(original_frame_count)で
    # 計算しないと、切り捨て後の表示上のsource_frameが実際に評価した
    # フレームとズレてしまう。
    sample_progress = sample_index / float(original_frame_count - 1)
    sample_body_progress = max(0.0, min(1.0, sample_progress)) * progress_limit
    sample_source_frame = animation_start + (
        animation_end - animation_start
    ) * sample_body_progress
    print(
        f"[diag]   idx={sample_index:03d} "
        f"progress={sample_progress * 100:5.1f}% "
        f"source_frame={sample_source_frame:8.2f} "
        f"norm={motion_norms[sample_index]:.6f}"
    )

# body_motion(全SKIN頂点の平均変位)を全スカート頂点にそのままbroadcastすると、
# スカートの全頂点が同一の変位ベクトルを受け取ることになり、スカート形状の
# 相対的な変形(前後左右で異なる沈み込み方)が一切表現できず、スカート全体が
# 剛体のようにただ下へ平行移動するだけの不自然なアニメーションになる。
# これを避けるため、スカート各頂点に近いBody/SKIN頂点を対応付け、
# その頂点の変位系列をスカート頂点ごとの身体特徴量として個別に保存する。
#
# ただし「最も近い1頂点だけ」を対応付ける方式(最近傍法)は、Body/SKINの
# 頂点密度・三角形分割がスカートと異なるため、隣接するスカート頂点同士が
# 全く異なるBody頂点にスナップされることがある。これにより変位場が
# 空間的に不連続(ノイズ状)になり、DNNの出力もその不連続さを引き継いで
# スカート形状がギザギザに尖った/つぶれた異常な見た目になる。
# そこで近傍K点の逆距離二乗重み付き平均を取り、滑らかに変化する
# 変位場を作る。
neighbor_count = min(8, len(body_base_vertices))
neighbor_indices = []
neighbor_weights = []
for skirt_vertex in skirt_base_vertices:
    distances = []
    for body_index, body_vertex in enumerate(body_base_vertices):
        distance_squared = sum(
            (skirt_vertex[axis] - body_vertex[axis]) ** 2
            for axis in range(3)
        )
        distances.append((distance_squared, body_index))
    nearest = sorted(distances)[:neighbor_count]
    weights = [1.0 / (distance + 1.0e-6) for distance, _ in nearest]
    weight_sum = sum(weights)
    neighbor_indices.append([body_index for _, body_index in nearest])
    neighbor_weights.append([weight / weight_sum for weight in weights])

skirt_vertex_body_motion = []
for frame_motion in per_vertex_motion:
    skirt_frame_motion = []
    for indices, weights in zip(neighbor_indices, neighbor_weights):
        weighted = [0.0, 0.0, 0.0]
        for body_index, weight in zip(indices, weights):
            motion = frame_motion[body_index]
            for axis in range(3):
                weighted[axis] += motion[axis] * weight
        skirt_frame_motion.append(weighted)
    skirt_vertex_body_motion.append(skirt_frame_motion)

nearest_body_indices = [indices[0] for indices in neighbor_indices]
print(
    "[diag] skirt_vertex_body_motion: shape="
    f"({len(skirt_vertex_body_motion)}, "
    f"{len(skirt_vertex_body_motion[0])}, 3), "
    f"neighbor_count={neighbor_count}, "
    f"unique nearest body vertices={len(set(nearest_body_indices))}"
)

os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "body_base_vertices": body_base_vertices,
            "body_vertex_indices": body_vertex_indices,
            "skinned_vertices": skinned_vertices,
            # 保存は従来互換のフレームごとの平均変位 (frames, 3)
            # 注意: 空間的な変化が失われるため、学習時は
            # skirt_vertex_body_motionが優先して使われる。
            "body_motion": body_motion_preview,
            # 追加: フレーム×頂点の生の変位データ (frames, vertices, 3)
            "body_motion_per_vertex": per_vertex_motion,
            # 追加: スカート頂点ごとに近傍Body/SKIN頂点を逆距離二乗重み付き
            # 平均した変位 (frames, skirt_vertices, 3)。単純な最近傍法と違い
            # 空間的に滑らかで、スカートの空間的な変形を学習可能にする。
            "skirt_vertex_body_motion": skirt_vertex_body_motion,
            "skirt_vertex_nearest_body_index": nearest_body_indices,
            "skirt_base_vertices": skirt_base_vertices,
            "skirt_faces": skirt_faces,
            "skirt_vertex_indices": skirt_vertex_indices,
            "animation_start": animation_start,
            "animation_end": animation_end,
            "progress_limit": progress_limit,
            "truncate_after_motion_peak": truncate_after_motion_peak,
            "motion_norm_peak_index": peak_index,
            "motion_norm_peak_body_progress": (
                sampled_body_progresses[peak_index]
            ),
            "motion_norm_peak_source_frame": sampled_source_frames[peak_index],
            "original_frame_count": original_frame_count,
            "adopted_frame_count": frame_count,
            "source_body_progresses": sampled_body_progresses,
            "source_frames": sampled_source_frames,
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
