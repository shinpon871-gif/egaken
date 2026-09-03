import os
import pickle
import subprocess
import numpy as np
import torch
import torch.nn as nn

# ------------------------------------------------------------
# 設定
# ------------------------------------------------------------

num_animation_frames = 120
body_animation_sample_progress_limit = 0.85
body_context_vertex_count = 1259

output_dir = '/content/public/models'
os.makedirs(output_dir, exist_ok=True)

fbx_path = os.path.join(
    output_dir,
    'StandToSit.fbx'
)

glb_path = os.path.join(
    output_dir,
    'skirt_mesh_sitting_animation.glb'
)

blend_path = os.path.join(
    output_dir,
    'skirt_mesh_sitting_animation.blend'
)

npz_path = os.path.join(
    output_dir,
    'skirt_animation_vertices.npz'
)

blender_data_path = os.path.join(
    output_dir,
    'skirt_animation_vertices_for_blender.pkl'
)

body_context_path = os.path.join(
    output_dir,
    'skirt_body_context_for_dnn.pkl'
)

blender_script_path = '/content/create_skirt_animation.py'

body_context_script_path = '/content/create_skirt_body_context.py'

# Python側とBlender側の両方で使用する閾値。
# Blenderスクリプトは別Pythonプロセスなので、
# 外側のPython変数を直接参照してはいけない。
alignment_rms_ratio_limit = 1.0e-4
alignment_max_ratio_limit = 5.0e-4

nonrigid_tolerance_ratio = 1.0e-6
nonrigid_tolerance_absolute = 1.0e-7

# ------------------------------------------------------------
# 入力データ確認
# ------------------------------------------------------------

if not os.path.isfile(fbx_path):
    raise FileNotFoundError(
        f"元FBXファイルが見つかりません: {fbx_path}"
    )

if "base_skirt_pc" not in globals():
    raise RuntimeError(
        "base_skirt_pc が存在しません。"
    )

if "base_skirt_faces" not in globals():
    raise RuntimeError(
        "base_skirt_faces が存在しません。"
    )

if "model" not in globals():
    raise RuntimeError(
        "学習済みmodelが存在しません。\n"
        "DNNの学習済みモデルを作成またはロードしたセルを先に実行してください。"
    )

if model.__class__.__name__ == "DummyModel":
    raise RuntimeError(
        "現在のmodelはDummyModelです。\n"
        "学習済みモデルを再作成または再ロードしてください。"
    )

if not isinstance(model, nn.Module):
    raise TypeError(
        "modelはtorch.nn.Moduleを継承したモデルである必要があります: "
        f"{type(model).__name__}"
    )

if "max_sit_angle" not in globals():
    max_sit_angle = np.deg2rad(75.0)

max_sit_angle = float(max_sit_angle)

if not np.isfinite(max_sit_angle):
    raise ValueError(
        "max_sit_angleが有限値ではありません。"
    )

base_skirt_pc = np.asarray(
    base_skirt_pc,
    dtype=np.float32
)

base_skirt_faces = np.asarray(
    base_skirt_faces,
    dtype=np.int32
)

if (
    base_skirt_pc.ndim != 2
    or base_skirt_pc.shape[1] != 3
):
    raise ValueError(
        "base_skirt_pcの形状は(頂点数, 3)である必要があります: "
        f"{base_skirt_pc.shape}"
    )

if (
    base_skirt_faces.ndim != 2
    or base_skirt_faces.shape[1] != 3
):
    raise ValueError(
        "base_skirt_facesの形状は(面数, 3)である必要があります: "
        f"{base_skirt_faces.shape}"
    )

if not np.all(np.isfinite(base_skirt_pc)):
    raise ValueError(
        "base_skirt_pcにNaNまたはInfが含まれています。"
    )

num_points = int(base_skirt_pc.shape[0])
num_faces = int(base_skirt_faces.shape[0])

if num_points == 0:
    raise RuntimeError(
        "スカートの頂点数が0です。"
    )

if num_faces == 0:
    raise RuntimeError(
        "スカートの面数が0です。"
    )

if (
    np.min(base_skirt_faces) < 0
    or np.max(base_skirt_faces) >= num_points
):
    raise ValueError(
        "base_skirt_facesに頂点範囲外のインデックスがあります。"
    )

if num_animation_frames < 2:
    raise ValueError(
        "num_animation_framesは2以上である必要があります。"
    )


def infer_model_input_feature_count(model_module):

    for module in model_module.modules():

        if isinstance(module, nn.Linear):
            return int(module.in_features)

    for parameter in model_module.parameters():

        if parameter.ndim >= 2:
            return int(parameter.shape[1])

    raise RuntimeError(
        "modelの入力特徴量数を特定できません。"
    )


model_input_feature_count = infer_model_input_feature_count(
    model
)

if model_input_feature_count <= 6:

    raise RuntimeError(
        "現在のmodelは身体アニメーション情報を受け取れません。\n"
        f"検出された入力特徴量数: {model_input_feature_count}\n"
        "必要な入力例: 9次元 = [pose(3), point(3), body_motion(3)]\n"
        "または 12次元 = [pose(3), point(3), body_position(3), body_motion(3)]\n"
        "腰/腿/膝またはスキニング済みd026差分を含む特徴量でDNNを再学習してください。"
    )

if model_input_feature_count not in (9, 12):

    raise RuntimeError(
        "このスクリプトが対応しているDNN入力特徴量数は9または12です。\n"
        f"検出された入力特徴量数: {model_input_feature_count}"
    )


def run_body_context_sampling():

    body_context_script = r'''
import bpy
import math
import os
import pickle
import sys

if "--" not in sys.argv:
    raise RuntimeError("Blenderに引数が渡されていません。")

args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 5:
    raise RuntimeError("FBX / 出力PKL / 頂点数 / フレーム数 / 進捗上限 が必要です。")

fbx_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
vertex_count = int(args[2])
frame_count = int(args[3])
progress_limit = float(args[4])

if not os.path.isfile(fbx_path):
    raise FileNotFoundError(f"FBXが見つかりません: {fbx_path}")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(
    filepath=fbx_path,
    use_anim=True,
    use_image_search=False
)

d026_objects = [
    obj
    for obj in bpy.context.scene.objects
    if obj.type == "MESH"
    and obj.name.lower().startswith("d026")
    and len(obj.data.vertices) == vertex_count
]

if not d026_objects:
    raise RuntimeError(
        "頂点数が一致するd026メッシュを取得できませんでした。"
    )

d026_object = d026_objects[0]
d026_vertices = [
    [float(vertex.co.x), float(vertex.co.y), float(vertex.co.z)]
    for vertex in d026_object.data.vertices
]

action_ranges = [
    (float(action.frame_range[0]), float(action.frame_range[1]))
    for action in bpy.data.actions
]

if action_ranges:
    animation_start = min(item[0] for item in action_ranges)
    animation_end = max(item[1] for item in action_ranges)
else:
    animation_start = float(bpy.context.scene.frame_start)
    animation_end = float(bpy.context.scene.frame_end)

if animation_end <= animation_start:
    raise RuntimeError("有効な身体アニメーション範囲を取得できませんでした。")


def sample_vertices(progress):

    body_progress = max(0.0, min(1.0, progress)) * progress_limit
    source_frame = (
        animation_start
        +
        (animation_end - animation_start)
        *
        body_progress
    )
    frame_floor = math.floor(source_frame)
    subframe = source_frame - frame_floor

    bpy.context.scene.frame_set(int(frame_floor), subframe=float(subframe))
    bpy.context.view_layer.update()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_object = d026_object.evaluated_get(depsgraph)
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph
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

    return vertices


skinned_vertices = []
for frame_index in range(frame_count):
    progress = frame_index / float(frame_count - 1)
    skinned_vertices.append(sample_vertices(progress))

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
'''

    with open(
        body_context_script_path,
        'w',
        encoding='utf-8'
    ) as file:

        file.write(body_context_script)

    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env["PYTHONNOUSERSITE"] = "1"

    result = subprocess.run(
        [
            "blender",
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            body_context_script_path,
            "--",
            fbx_path,
            body_context_path,
            str(body_context_vertex_count),
            str(num_animation_frames),
            f"{body_animation_sample_progress_limit:.9f}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )

    print(result.stdout)

    if result.returncode != 0:

        raise RuntimeError(
            "身体アニメーション特徴量の抽出に失敗しました。\n"
            f"終了コード: {result.returncode}"
        )


run_body_context_sampling()

with open(body_context_path, "rb") as file:
    body_context = pickle.load(file)

body_d026_vertices = np.asarray(
    body_context["d026_vertices"],
    dtype=np.float64
)

body_skinned_vertices = np.asarray(
    body_context["skinned_vertices"],
    dtype=np.float64
)

if body_d026_vertices.ndim != 2 or body_d026_vertices.shape[1] != 3:
    raise RuntimeError("d026身体特徴量の形状が不正です。")

if body_skinned_vertices.shape != (
    num_animation_frames,
    body_d026_vertices.shape[0],
    3
):
    raise RuntimeError("スキニング済み身体特徴量の形状が不正です。")

body_motion_for_dnn = np.mean(
    body_skinned_vertices,
    axis=1,
) - np.mean(
    body_d026_vertices,
    axis=0,
)
body_motion_scale = (
    np.ptp(base_skirt_pc.astype(np.float64), axis=0)
    /
    np.maximum(np.ptp(body_d026_vertices, axis=0), 1.0e-8)
)
body_motion_for_dnn *= body_motion_scale
body_motion_for_dnn = np.broadcast_to(
    body_motion_for_dnn[:, None, :],
    (num_animation_frames, num_points, 3),
).astype(np.float32, copy=True)

body_position_for_dnn = (
    base_skirt_pc.reshape(1, num_points, 3)
    + body_motion_for_dnn
).astype(np.float32, copy=False)

if model_input_feature_count == 9:
    body_context_features_for_dnn = body_motion_for_dnn
else:
    body_context_features_for_dnn = np.concatenate(
        [body_position_for_dnn, body_motion_for_dnn],
        axis=2,
    ).astype(np.float32, copy=False)

print()
print("=" * 70)
print("DNN身体入力特徴量")
print("=" * 70)
print(f"DNN入力特徴量数: {model_input_feature_count}")
print(f"身体特徴量形状: {body_context_features_for_dnn.shape}")

# ------------------------------------------------------------
# モデル情報確認
# ------------------------------------------------------------

model.eval()

first_parameter = next(
    model.parameters(),
    None
)

if first_parameter is not None:
    device = first_parameter.device
    model_dtype = first_parameter.dtype
else:
    first_buffer = next(
        model.buffers(),
        None
    )

    if first_buffer is not None:
        device = first_buffer.device
        model_dtype = first_buffer.dtype
    else:
        device = torch.device("cpu")
        model_dtype = torch.float32

if not model_dtype.is_floating_point:
    model_dtype = torch.float32

parameter_count = sum(
    int(parameter.numel())
    for parameter in model.parameters()
)

print("=" * 70)
print("立位 → 座位 DNNアニメーション生成")
print("=" * 70)
print(f"使用モデル       : {model.__class__.__name__}")
print(f"パラメータ数     : {parameter_count:,}")
print(f"モデルデバイス   : {device}")
print(f"モデルdtype      : {model_dtype}")
print(f"入力特徴量数     : {model_input_feature_count}")
print(f"頂点数           : {num_points:,}")
print(f"面数             : {num_faces:,}")
print(f"フレーム数       : {num_animation_frames}")
print(
    f"最大座位角度     : "
    f"{np.rad2deg(max_sit_angle):.1f}度"
)
print(f"元FBX            : {fbx_path}")

# ------------------------------------------------------------
# 単一Linearモデル拒否
# ------------------------------------------------------------

leaf_modules = [
    module
    for module in model.modules()
    if module is not model
    and len(list(module.children())) == 0
]

parameterized_leaf_modules = [
    module
    for module in leaf_modules
    if any(
        parameter.numel() > 0
        for parameter in module.parameters(
            recurse=False
        )
    )
]

is_direct_linear_6_to_3 = (
    isinstance(model, nn.Linear)
    and model.in_features == 6
    and model.out_features == 3
)

is_wrapped_single_linear_6_to_3 = (
    len(parameterized_leaf_modules) == 1
    and isinstance(
        parameterized_leaf_modules[0],
        nn.Linear
    )
    and parameterized_leaf_modules[0].in_features == 6
    and parameterized_leaf_modules[0].out_features == 3
)

if (
    is_direct_linear_6_to_3
    or is_wrapped_single_linear_6_to_3
):
    raise RuntimeError(
        "modelが単一のnn.Linear(6, 3)だけで構成されています。\n"
        "非剛体変形を生成できないため、"
        "学習済みDNNモデルを使用してください。"
    )

# ------------------------------------------------------------
# DNN推論
# ------------------------------------------------------------

def unwrap_model_output(output):

    if isinstance(output, dict):

        preferred_keys = (
            "displacements",
            "displacement",
            "prediction",
            "predictions",
            "output"
        )

        selected = None

        for key in preferred_keys:

            if key in output:
                selected = output[key]
                break

        if selected is None:

            if len(output) == 1:
                selected = next(
                    iter(output.values())
                )
            else:
                raise RuntimeError(
                    "modelの出力dictから変位テンソルを特定できません。"
                )

        output = selected

    if isinstance(
        output,
        (tuple, list)
    ):

        if len(output) == 0:
            raise RuntimeError(
                "modelの出力が空です。"
            )

        output = output[0]

    if not torch.is_tensor(output):
        raise TypeError(
            "modelの出力はtorch.Tensorである必要があります: "
            f"{type(output).__name__}"
        )

    return output


def predict_dnn_values(pose, frame_index):

    pose = np.asarray(
        pose,
        dtype=np.float32
    ).reshape(-1)

    if pose.size != 3:
        raise ValueError(
            "poseは3次元である必要があります: "
            f"{pose.shape}"
        )

    pose_repeated = np.repeat(
        pose.reshape(1, 3),
        num_points,
        axis=0
    )

    frame_index = int(frame_index)
    if frame_index < 0 or frame_index >= num_animation_frames:
        raise ValueError(
            "frame_indexが範囲外です: "
            f"{frame_index}"
        )

    point_input = np.concatenate(
        [
            pose_repeated,
            base_skirt_pc,
            body_context_features_for_dnn[frame_index],
        ],
        axis=1
    ).astype(np.float32, copy=False)

    if point_input.shape[1] != model_input_feature_count:
        raise RuntimeError(
            "DNN入力特徴量数がmodelと一致しません。\n"
            f"model入力特徴量数: {model_input_feature_count}\n"
            f"実際の入力特徴量数: {point_input.shape[1]}"
        )

    input_tensor = torch.from_numpy(
        point_input
    ).to(
        device=device,
        dtype=model_dtype
    )

    output = unwrap_model_output(
        model(input_tensor)
    )

    if (
        output.ndim == 3
        and output.shape[0] == 1
        and tuple(output.shape[1:]) == (
            num_points,
            3
        )
    ):
        output = output[0]

    if tuple(output.shape) != (
        num_points,
        3
    ):
        raise RuntimeError(
            "DNNの出力形状が不正です。\n"
            f"期待形状: ({num_points}, 3)\n"
            f"実際形状: {tuple(output.shape)}"
        )

    predicted = (
        output
        .detach()
        .to(
            device="cpu",
            dtype=torch.float32
        )
        .numpy()
    )

    if not np.all(
        np.isfinite(predicted)
    ):
        raise RuntimeError(
            "DNN出力にNaNまたはInfが含まれています。"
        )

    return predicted


standing_pose = np.zeros(
    3,
    dtype=np.float32
)

animation_poses = []
animation_displacements = []
animation_vertices = []

with torch.inference_mode():

    standing_prediction = predict_dnn_values(
        standing_pose,
        0
    )

    for frame in range(
        num_animation_frames
    ):

        t = frame / float(
            num_animation_frames - 1
        )

        angle = t * max_sit_angle

        pose = np.array(
            [
                0.0,
                angle,
                0.0
            ],
            dtype=np.float32
        )

        current_prediction = (
            predict_dnn_values(
                pose,
                frame
            )
        )

        relative_displacement = (
            current_prediction
            -
            standing_prediction
        ).astype(
            np.float32,
            copy=False
        )

        if frame == 0:
            relative_displacement = np.zeros_like(
                base_skirt_pc,
                dtype=np.float32
            )

        predicted_vertices = (
            base_skirt_pc
            +
            relative_displacement
        ).astype(
            np.float32,
            copy=False
        )

        animation_poses.append(
            pose
        )

        animation_displacements.append(
            relative_displacement
        )

        animation_vertices.append(
            predicted_vertices
        )

        if (
            frame == 0
            or frame == num_animation_frames - 1
            or (frame + 1) % 20 == 0
        ):

            displacement_norm = np.linalg.norm(
                relative_displacement,
                axis=1
            )

            print(
                f"フレーム "
                f"{frame + 1:3d}/"
                f"{num_animation_frames}: "
                f"角度={np.rad2deg(angle):6.2f}度, "
                f"最大変位={np.max(displacement_norm):.6f}, "
                f"平均変位={np.mean(displacement_norm):.6f}"
            )

animation_poses = np.asarray(
    animation_poses,
    dtype=np.float32
)

animation_displacements = np.asarray(
    animation_displacements,
    dtype=np.float32
)

animation_vertices = np.asarray(
    animation_vertices,
    dtype=np.float32
)

expected_shape = (
    num_animation_frames,
    num_points,
    3
)

if animation_vertices.shape != expected_shape:
    raise RuntimeError(
        "アニメーション頂点データの形状が不正です: "
        f"{animation_vertices.shape}"
    )

if animation_displacements.shape != expected_shape:
    raise RuntimeError(
        "アニメーション変位データの形状が不正です: "
        f"{animation_displacements.shape}"
    )

# ------------------------------------------------------------
# 非剛体変形の検証
# ------------------------------------------------------------

def create_unique_edges(faces):

    edges = np.concatenate(
        [
            faces[:, [0, 1]],
            faces[:, [1, 2]],
            faces[:, [2, 0]]
        ],
        axis=0
    )

    edges = np.sort(
        edges,
        axis=1
    )

    return np.unique(
        edges,
        axis=0
    )


def edge_lengths(
    vertices,
    edges
):

    vectors = (
        vertices[edges[:, 0]]
        -
        vertices[edges[:, 1]]
    )

    return np.linalg.norm(
        vectors,
        axis=1
    )


def best_fit_rigid_residual(
    source_vertices,
    target_vertices
):

    source = np.asarray(
        source_vertices,
        dtype=np.float64
    )

    target = np.asarray(
        target_vertices,
        dtype=np.float64
    )

    source_center = np.mean(
        source,
        axis=0
    )

    target_center = np.mean(
        target,
        axis=0
    )

    source_centered = (
        source
        -
        source_center
    )

    target_centered = (
        target
        -
        target_center
    )

    covariance = (
        source_centered.T
        @
        target_centered
    )

    u, _, vt = np.linalg.svd(
        covariance,
        full_matrices=False
    )

    rotation = u @ vt

    if np.linalg.det(
        rotation
    ) < 0.0:

        u[:, -1] *= -1.0

        rotation = u @ vt

    aligned_source = (
        source_centered
        @
        rotation
        +
        target_center
    )

    residual = (
        target
        -
        aligned_source
    )

    return np.linalg.norm(
        residual,
        axis=1
    )


standing_vertices = (
    animation_vertices[0]
)

sitting_vertices = (
    animation_vertices[-1]
)

final_displacement = (
    sitting_vertices
    -
    standing_vertices
)

final_displacement_norm = np.linalg.norm(
    final_displacement,
    axis=1
)

mean_translation = np.mean(
    final_displacement,
    axis=0
)

translation_removed_displacement = (
    final_displacement
    -
    mean_translation
)

translation_removed_norm = np.linalg.norm(
    translation_removed_displacement,
    axis=1
)

unique_edges = create_unique_edges(
    base_skirt_faces
)

standing_edge_lengths = edge_lengths(
    standing_vertices,
    unique_edges
)

sitting_edge_lengths = edge_lengths(
    sitting_vertices,
    unique_edges
)

edge_length_change = np.abs(
    sitting_edge_lengths
    -
    standing_edge_lengths
)

rigid_residual_norm = best_fit_rigid_residual(
    standing_vertices,
    sitting_vertices
)

bounding_box_size = np.linalg.norm(
    np.max(
        standing_vertices,
        axis=0
    )
    -
    np.min(
        standing_vertices,
        axis=0
    )
)

nonrigid_tolerance = max(
    float(bounding_box_size)
    *
    nonrigid_tolerance_ratio,
    nonrigid_tolerance_absolute
)

max_displacement = float(
    np.max(final_displacement_norm)
)

mean_displacement = float(
    np.mean(final_displacement_norm)
)

max_translation_removed = float(
    np.max(translation_removed_norm)
)

max_rigid_residual = float(
    np.max(rigid_residual_norm)
)

rms_rigid_residual = float(
    np.sqrt(
        np.mean(
            rigid_residual_norm ** 2
        )
    )
)

max_edge_length_change = float(
    np.max(edge_length_change)
)

mean_edge_length_change = float(
    np.mean(edge_length_change)
)

print()
print("=" * 70)
print("DNN変形検証")
print("=" * 70)

print(
    f"座位時最大変位             : "
    f"{max_displacement:.9e}"
)

print(
    f"座位時平均変位             : "
    f"{mean_displacement:.9e}"
)

print(
    "平均平行移動ベクトル       : "
    f"[{mean_translation[0]:.9e}, "
    f"{mean_translation[1]:.9e}, "
    f"{mean_translation[2]:.9e}]"
)

print(
    f"平行移動除去後最大変位     : "
    f"{max_translation_removed:.9e}"
)

print(
    f"最適剛体変換除去後最大残差 : "
    f"{max_rigid_residual:.9e}"
)

print(
    f"最適剛体変換除去後RMS      : "
    f"{rms_rigid_residual:.9e}"
)

print(
    f"最大辺長変化               : "
    f"{max_edge_length_change:.9e}"
)

print(
    f"平均辺長変化               : "
    f"{mean_edge_length_change:.9e}"
)

print(
    f"非剛体変形判定閾値         : "
    f"{nonrigid_tolerance:.9e}"
)

if max_displacement <= nonrigid_tolerance:
    raise RuntimeError(
        "DNNが有意な頂点移動を生成していません。"
    )

if max_translation_removed <= nonrigid_tolerance:
    raise RuntimeError(
        "DNN出力が全頂点でほぼ同一です。"
    )

if max_rigid_residual <= nonrigid_tolerance:
    raise RuntimeError(
        "DNN出力が実質的に剛体変換だけです。"
    )

print(
    "判定: DNNによる非剛体の頂点変形を確認しました。"
)

# ------------------------------------------------------------
# NumPyデータ保存
# ------------------------------------------------------------

np.savez(
    npz_path,
    vertices=animation_vertices,
    displacements=animation_displacements,
    poses=animation_poses,
    faces=base_skirt_faces,
    frame_count=np.int32(
        num_animation_frames
    ),
    vertex_count=np.int32(
        num_points
    ),
    max_rigid_residual=np.float64(
        max_rigid_residual
    ),
    max_edge_length_change=np.float64(
        max_edge_length_change
    )
)

print()
print(
    "アニメーション頂点データを保存:"
)
print(npz_path)

# ------------------------------------------------------------
# Blender受け渡し用PKL
# ------------------------------------------------------------

blender_data = {
    "vertices": animation_vertices.tolist(),
    "faces": base_skirt_faces.tolist(),
    "frame_count": int(
        num_animation_frames
    ),
    "vertex_count": int(
        num_points
    ),
    "face_count": int(
        num_faces
    )
}

with open(
    blender_data_path,
    'wb'
) as f:

    pickle.dump(
        blender_data,
        f,
        protocol=4
    )

del blender_data

# ------------------------------------------------------------
# Blender用NumPy確認
# ------------------------------------------------------------

blender_numpy_site_packages = (
    "/usr/lib/python3/dist-packages"
)


def check_blender_numpy():

    check_expression = (
        "import sys;"
        f"sys.path.insert(0, "
        f"{blender_numpy_site_packages!r});"
        "import numpy as np;"
        "print('BLENDER_NUMPY_VERSION=' "
        "+ np.__version__);"
        "print('BLENDER_NUMPY_PATH=' "
        "+ np.__file__)"
    )

    check_env = os.environ.copy()

    check_env.pop(
        "PYTHONPATH",
        None
    )

    check_env[
        "PYTHONNOUSERSITE"
    ] = "1"

    return subprocess.run(
        [
            "blender",
            "--background",
            "--python-exit-code",
            "1",
            "--python-expr",
            check_expression
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=check_env
    )


blender_numpy_check = (
    check_blender_numpy()
)

if blender_numpy_check.returncode != 0:

    print()
    print(
        "Blender用NumPyをインストールしています..."
    )

    apt_update_result = subprocess.run(
        [
            "apt-get",
            "update",
            "-qq"
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    if apt_update_result.returncode != 0:
        raise RuntimeError(
            "apt-get updateに失敗しました。\n"
            +
            apt_update_result.stdout
        )

    apt_install_result = subprocess.run(
        [
            "apt-get",
            "install",
            "-y",
            "-qq",
            "python3-numpy"
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    if apt_install_result.returncode != 0:
        raise RuntimeError(
            "Blender用python3-numpyのインストールに失敗しました。\n"
            +
            apt_install_result.stdout
        )

    blender_numpy_check = (
        check_blender_numpy()
    )

if blender_numpy_check.returncode != 0:

    raise RuntimeError(
        "BlenderからNumPyを読み込めませんでした。\n"
        +
        blender_numpy_check.stdout
    )

for output_line in (
    blender_numpy_check.stdout.splitlines()
):

    if output_line.startswith(
        "BLENDER_NUMPY_"
    ):
        print(output_line)

# ------------------------------------------------------------
# Blenderスクリプト
# ------------------------------------------------------------

blender_script = r'''
import bpy
import os
import pickle
import sys
import math

BLENDER_NUMPY_SITE_PACKAGES = (
    "/usr/lib/python3/dist-packages"
)

if BLENDER_NUMPY_SITE_PACKAGES not in sys.path:
    sys.path.insert(
        0,
        BLENDER_NUMPY_SITE_PACKAGES
    )

import numpy as np

# ============================================================
# Blender側で使用する閾値
# 外側Pythonの変数へ依存しない
# ============================================================

ALIGNMENT_RMS_RATIO_LIMIT = 1.0e-4
ALIGNMENT_MAX_RATIO_LIMIT = 5.0e-4
BODY_ANIMATION_SAMPLE_PROGRESS_LIMIT = 0.85

# ============================================================
# 引数
# ============================================================

if "--" not in sys.argv:
    raise RuntimeError(
        "Blenderに引数が渡されていません。"
    )

args = sys.argv[
    sys.argv.index("--") + 1:
]

if len(args) < 4:
    raise RuntimeError(
        "PKL / FBX / GLB / BLEND の4引数が必要です。"
    )

blender_data_path = os.path.abspath(
    args[0]
)

fbx_path = os.path.abspath(
    args[1]
)

glb_path = os.path.abspath(
    args[2]
)

blend_path = os.path.abspath(
    args[3]
)

# ============================================================
# データ読み込み
# ============================================================

if not os.path.isfile(
    blender_data_path
):
    raise FileNotFoundError(
        "Blender用アニメーションデータが見つかりません: "
        +
        blender_data_path
    )

if not os.path.isfile(
    fbx_path
):
    raise FileNotFoundError(
        "基準FBXが見つかりません: "
        +
        fbx_path
    )

with open(
    blender_data_path,
    "rb"
) as f:

    data = pickle.load(f)

vertices_all = np.asarray(
    data["vertices"],
    dtype=np.float64
)

faces = np.asarray(
    data["faces"],
    dtype=np.int32
)

frame_count = int(
    data["frame_count"]
)

vertex_count = int(
    data["vertex_count"]
)

face_count = int(
    data["face_count"]
)

print(
    "=" * 70
)

print(
    "Blender アニメーション生成"
)

print(
    "=" * 70
)

print(
    "入力頂点形状:",
    vertices_all.shape
)

print(
    "入力面形状:",
    faces.shape
)

# ============================================================
# 入力検証
# ============================================================

if vertices_all.ndim != 3:
    raise RuntimeError(
        "verticesは(フレーム, 頂点, 3)である必要があります。"
    )

if vertices_all.shape[0] != frame_count:
    raise RuntimeError(
        "フレーム数が一致しません。"
    )

if vertices_all.shape[1] != vertex_count:
    raise RuntimeError(
        "頂点数が一致しません。"
    )

if vertices_all.shape[2] != 3:
    raise RuntimeError(
        "XYZの3次元頂点データではありません。"
    )

if len(faces) != face_count:
    raise RuntimeError(
        "面数が一致しません。"
    )

if (
    not np.all(
        np.isfinite(vertices_all)
    )
):
    raise RuntimeError(
        "アニメーション頂点にNaNまたはInfがあります。"
    )

# ============================================================
# FBX読み込み
# ============================================================

print()
print(
    "基準FBXを読み込んでいます..."
)

bpy.ops.object.select_all(
    action="SELECT"
)

bpy.ops.object.delete(
    use_global=False
)

bpy.ops.import_scene.fbx(
    filepath=fbx_path,
    use_anim=True,
    use_image_search=False
)

# ============================================================
# d026メッシュ探索
# ============================================================

d026_objects = []

for object in bpy.context.scene.objects:

    if object.type != 'MESH':
        continue

    if object.name.lower().startswith(
        "d026"
    ):
        d026_objects.append(
            object
        )

if not d026_objects:
    raise RuntimeError(
        "元FBXからd026メッシュを取得できませんでした。"
    )

print()
print(
    "検出されたd026メッシュ:"
)

for object in d026_objects:

    print(
        f"  {object.name}: "
        f"vertices={len(object.data.vertices)}, "
        f"polygons={len(object.data.polygons)}"
    )

# ============================================================
# 最も頂点数が一致するd026を選択
# ============================================================

matching_d026_objects = [
    object
    for object in d026_objects
    if len(object.data.vertices)
    == vertex_count
]

if len(matching_d026_objects) == 0:

    raise RuntimeError(
        "DNN側頂点数と一致するd026メッシュがありません。\n"
        f"DNN頂点数: {vertex_count}"
    )

if len(matching_d026_objects) > 1:

    print()
    print(
        "警告: 頂点数一致d026が複数あります。"
        "最初のメッシュを使用します。"
    )

d026_object = matching_d026_objects[0]

print()
print(
    "基準メッシュ:",
    d026_object.name
)

print(
    "基準メッシュ頂点数:",
    len(d026_object.data.vertices)
)

print(
    "基準メッシュPolygon数:",
    len(d026_object.data.polygons)
)

# ============================================================
# d026頂点をローカル座標で取得
# ============================================================

d026_vertices = np.asarray(
    [
        [
            vertex.co.x,
            vertex.co.y,
            vertex.co.z
        ]
        for vertex in d026_object.data.vertices
    ],
    dtype=np.float64
)

if not np.all(
    np.isfinite(d026_vertices)
):
    raise RuntimeError(
        "d026頂点にNaNまたはInfが含まれています。"
    )

source_scene_frame_start = int(
    bpy.context.scene.frame_start
)

source_scene_frame_end = int(
    bpy.context.scene.frame_end
)

action_frame_ranges = []

for action in bpy.data.actions:

    frame_range = action.frame_range

    action_frame_ranges.append(
        (
            float(frame_range[0]),
            float(frame_range[1])
        )
    )

if action_frame_ranges:

    animation_frame_start = min(
        frame_range[0]
        for frame_range in action_frame_ranges
    )

    animation_frame_end = max(
        frame_range[1]
        for frame_range in action_frame_ranges
    )

else:

    animation_frame_start = float(
        source_scene_frame_start
    )

    animation_frame_end = float(
        source_scene_frame_end
    )

if animation_frame_end <= animation_frame_start:

    raise RuntimeError(
        "StandToSit.fbxから有効な身体アニメーション範囲を取得できませんでした。"
    )

print()
print(
    "身体アニメーション範囲:"
)
print(
    "  scene.frame_start/end = "
    f"{source_scene_frame_start} / {source_scene_frame_end}"
)
print(
    "  action range           = "
    f"{animation_frame_start:.6f} / {animation_frame_end:.6f}"
)


def get_evaluated_d026_vertices_at_progress(progress):

    progress = float(
        np.clip(
            progress,
            0.0,
            1.0
        )
    )

    body_progress = progress * BODY_ANIMATION_SAMPLE_PROGRESS_LIMIT

    source_frame = (
        animation_frame_start
        +
        (
            animation_frame_end
            -
            animation_frame_start
        )
        *
        body_progress
    )

    frame_floor = math.floor(
        source_frame
    )

    subframe = source_frame - frame_floor

    bpy.context.scene.frame_set(
        int(frame_floor),
        subframe=float(subframe)
    )

    bpy.context.view_layer.update()

    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_object = d026_object.evaluated_get(
        depsgraph
    )
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph
    )

    try:

        vertices = np.asarray(
            [
                [
                    float((evaluated_object.matrix_world @ vertex.co).x),
                    float((evaluated_object.matrix_world @ vertex.co).y),
                    float((evaluated_object.matrix_world @ vertex.co).z)
                ]
                for vertex in evaluated_mesh.vertices
            ],
            dtype=np.float64
        )

    finally:

        evaluated_object.to_mesh_clear()

    if vertices.shape != (
        vertex_count,
        3
    ):

        raise RuntimeError(
            "スキニング済みd026頂点数が一致しません。\n"
            f"期待形状: ({vertex_count}, 3)\n"
            f"実際形状: {vertices.shape}"
        )

    if not np.all(
        np.isfinite(vertices)
    ):

        raise RuntimeError(
            "スキニング済みd026頂点にNaNまたはInfがあります。"
        )

    return vertices

# ============================================================
# 面はDNN側のfacesをそのまま使用
#
# d026のPolygon数はトライアングル数ではなく、
# N-gonを含むため、単純比較しない。
# 重要なのは頂点番号対応。
# ============================================================

print()
print(
    "d026のPolygon数:",
    len(d026_object.data.polygons)
)

print(
    "DNN側面数:",
    face_count
)

# ============================================================
# DNN立位 -> d026ローカル座標
#
# Similarity Transform:
#
# target ~= source @ R * scale + translation
#
# これで約200倍以上のスケール差と座標軸差を吸収する。
# ============================================================

source = vertices_all[0].copy()
target = d026_vertices.copy()

full_garment_vertex_mode = source.shape != target.shape

source_center = np.mean(source, axis=0)
source_centered = source - source_center
source_rms = float(
    np.sqrt(np.mean(np.sum(source_centered ** 2, axis=1)))
)
if source_rms <= 1.0e-12:
    raise RuntimeError("DNN側立位メッシュの大きさがほぼ0です。")

if full_garment_vertex_mode:
    target_center = np.mean(target, axis=0)
    target_centered = target - target_center
    target_rms = float(
        np.sqrt(np.mean(np.sum(target_centered ** 2, axis=1)))
    )
    if target_rms <= 1.0e-12:
        raise RuntimeError("d026メッシュの大きさがほぼ0です。")
    rotation = np.eye(3, dtype=np.float64)
    similarity_scale = target_rms / source_rms
    translation = target_center - source_center * similarity_scale
    alignment_rms = 0.0
    alignment_max = 0.0
    alignment_rms_ratio = 0.0
    alignment_max_ratio = 0.0
    print("全体ワンピースモード: d026の重心・RMSサイズへ変換します。")
else:
    target_center = np.mean(target, axis=0)
    target_centered = target - target_center
    target_rms = float(
        np.sqrt(np.mean(np.sum(target_centered ** 2, axis=1)))
    )
    if target_rms <= 1.0e-12:
        raise RuntimeError("d026メッシュの大きさがほぼ0です。")
    covariance = source_centered.T @ target_centered
    u, _, vt = np.linalg.svd(covariance)
    rotation = u @ vt
    if np.linalg.det(rotation) < 0.0:
        u[:, -1] *= -1.0
        rotation = u @ vt
    rotated_source = source_centered @ rotation
    denominator = float(np.sum(source_centered * source_centered))
    if denominator <= 1.0e-20:
        raise RuntimeError("Similarity Transformの計算に失敗しました。")
    similarity_scale = float(
        np.sum(rotated_source * target_centered) / denominator
    )
    if not math.isfinite(similarity_scale) or similarity_scale <= 0.0:
        raise RuntimeError("Similarity Transformの尺度が不正です。")
    translation = target_center - source_center @ rotation * similarity_scale

# ============================================================
# 座標合わせ検証
# ============================================================

if full_garment_vertex_mode:
    alignment_rms = 0.0
    alignment_max = 0.0
    alignment_rms_ratio = 0.0
    alignment_max_ratio = 0.0
else:
    aligned_standing = (
        (source - source_center)
        @ rotation
        * similarity_scale
        + target_center
    )
    alignment_error = target - aligned_standing
    alignment_error_norm = np.linalg.norm(alignment_error, axis=1)
    alignment_reference_size = max(target_rms, 1.0e-12)
    alignment_rms = float(
        np.sqrt(np.mean(alignment_error_norm ** 2))
    )
    alignment_max = float(np.max(alignment_error_norm))
    alignment_rms_ratio = alignment_rms / alignment_reference_size
    alignment_max_ratio = alignment_max / alignment_reference_size

print()
print(
    "=" * 70
)

print(
    "DNN → d026 座標変換"
)

print(
    "=" * 70
)

print(
    f"DNN側立位RMSサイズ        : "
    f"{source_rms:.9e}"
)

print(
    f"d026側RMSサイズ           : "
    f"{target_rms:.9e}"
)

print(
    f"推定スケール              : "
    f"{similarity_scale:.9e}"
)

print(
    f"推定スケール逆比          : "
    f"{1.0 / similarity_scale:.9e}"
)

print(
    "回転行列:"
)

for row in rotation:

    print(
        "  ",
        " ".join(
            f"{value:.9e}"
            for value in row
        )
    )

print(
    "平行移動:"
)

print(
    "  ",
    [
        float(value)
        for value in translation
    ]
)

print(
    f"立位座標合わせRMS誤差      : "
    f"{alignment_rms:.9e}"
)

print(
    f"立位座標合わせ最大誤差     : "
    f"{alignment_max:.9e}"
)

print(
    f"RMS誤差比                  : "
    f"{alignment_rms_ratio:.9e}"
)

print(
    f"最大誤差比                 : "
    f"{alignment_max_ratio:.9e}"
)

if (
    alignment_rms_ratio
    >
    ALIGNMENT_RMS_RATIO_LIMIT
):

    raise RuntimeError(
        "DNN側頂点列とd026頂点列を"
        "十分な精度で一致させられませんでした。\n"
        f"RMS誤差比: {alignment_rms_ratio:.9e}\n"
        f"許容RMS誤差比: {ALIGNMENT_RMS_RATIO_LIMIT:.9e}\n"
        "base_skirt_pcとd026の頂点番号対応を確認してください。"
    )

if (
    alignment_max_ratio
    >
    ALIGNMENT_MAX_RATIO_LIMIT
):

    raise RuntimeError(
        "DNN側頂点列とd026頂点列の最大対応誤差が大きすぎます。\n"
        f"最大誤差比: {alignment_max_ratio:.9e}\n"
        f"許容最大誤差比: {ALIGNMENT_MAX_RATIO_LIMIT:.9e}\n"
        "base_skirt_pcとd026の頂点番号対応を確認してください。"
    )

print(
    "判定: d026と同じモデル座標系へ整合しました。"
)

# ============================================================
# 全フレームをd026座標系へ変換
# ============================================================

def transform_vertices(
    vertices
):

    vertices = np.asarray(
        vertices,
        dtype=np.float64
    )

    centered = (
        vertices
        -
        source_center
    )

    transformed = (
        centered
        @
        rotation
        *
        similarity_scale
        +
        target_center
    )

    return transformed


transformed_vertices_all = np.empty_like(
    vertices_all,
    dtype=np.float64
)

for frame_index in range(
    frame_count
):

    transformed_vertices_all[
        frame_index
    ] = transform_vertices(
        vertices_all[
            frame_index
        ]
    )

skinned_d026_vertices_all = np.empty_like(
    np.empty(
        (
            frame_count,
            d026_vertices.shape[0],
            3
        ),
        dtype=np.float64
    ),
    dtype=np.float64
)

for frame_index in range(
    frame_count
):

    progress = frame_index / float(
        frame_count - 1
    )

    skinned_d026_vertices_all[
        frame_index
    ] = get_evaluated_d026_vertices_at_progress(
        progress
    )

skinned_source = skinned_d026_vertices_all[0].copy()
skinned_target = d026_vertices.copy()

skinned_source_center = np.mean(
    skinned_source,
    axis=0
)

skinned_target_center = np.mean(
    skinned_target,
    axis=0
)

skinned_source_centered = (
    skinned_source
    -
    skinned_source_center
)

skinned_target_centered = (
    skinned_target
    -
    skinned_target_center
)

skinned_source_rms = float(
    np.sqrt(
        np.mean(
            np.sum(
                skinned_source_centered ** 2,
                axis=1
            )
        )
    )
)

if skinned_source_rms <= 1.0e-12:

    raise RuntimeError(
        "0%のスキニング済みd026メッシュの大きさがほぼ0です。"
    )

skinned_covariance = (
    skinned_source_centered.T
    @
    skinned_target_centered
)

skinned_u, _, skinned_vt = np.linalg.svd(
    skinned_covariance
)

skinned_rotation = (
    skinned_u
    @
    skinned_vt
)

if np.linalg.det(
    skinned_rotation
) < 0.0:

    skinned_u[:, -1] *= -1.0

    skinned_rotation = (
        skinned_u
        @
        skinned_vt
    )

skinned_rotated_source = (
    skinned_source_centered
    @
    skinned_rotation
)

skinned_scale_denominator = float(
    np.sum(
        skinned_source_centered
        *
        skinned_source_centered
    )
)

if skinned_scale_denominator <= 1.0e-20:

    raise RuntimeError(
        "スキニング済みd026座標変換のスケール計算に失敗しました。"
    )

skinned_scale = float(
    np.sum(
        skinned_rotated_source
        *
        skinned_target_centered
    )
    /
    skinned_scale_denominator
)

if (
    not math.isfinite(skinned_scale)
    or
    skinned_scale <= 0.0
):

    raise RuntimeError(
        "スキニング済みd026座標変換のスケールが不正です: "
        f"{skinned_scale}"
    )


def transform_skinned_vertices_to_d026_local(vertices):

    vertices = np.asarray(
        vertices,
        dtype=np.float64
    )

    return (
        (
            vertices
            -
            skinned_source_center
        )
        @
        skinned_rotation
        *
        skinned_scale
        +
        skinned_target_center
    )


skinned_motion_offsets = (
    skinned_d026_vertices_all
    -
    skinned_d026_vertices_all[0]
)

skinned_motion_offsets_local = (
    skinned_motion_offsets
    @
    skinned_rotation
    *
    skinned_scale
)

nonrigid_offsets_all = (
    transformed_vertices_all
    -
    transformed_vertices_all[0]
)

if full_garment_vertex_mode:
    body_following_vertices_all = transformed_vertices_all
else:
    body_following_vertices_all = (
        d026_vertices.reshape(
            1,
            vertex_count,
            3
        )
        +
        skinned_motion_offsets_local
        +
        nonrigid_offsets_all
    )

if not np.all(
    np.isfinite(body_following_vertices_all)
):

    raise RuntimeError(
        "身体アニメーション追従後の頂点にNaNまたはInfがあります。"
    )

body_follow_standing_center = np.mean(
    body_following_vertices_all[0],
    axis=0
)

body_follow_sitting_center = np.mean(
    body_following_vertices_all[-1],
    axis=0
)

body_follow_center_delta = (
    body_follow_sitting_center
    -
    body_follow_standing_center
)

skinned_standing_center = np.mean(
    d026_vertices,
    axis=0
)

skinned_sitting_center = np.mean(
    d026_vertices
    +
    skinned_motion_offsets_local[-1],
    axis=0
)

skinned_center_delta = (
    skinned_sitting_center
    -
    skinned_standing_center
)

skinned_center_delta_norm = float(
    np.linalg.norm(
        skinned_center_delta
    )
)

skinned_bbox_size = np.linalg.norm(
    np.max(
        d026_vertices,
        axis=0
    )
    -
    np.min(
        d026_vertices,
        axis=0
    )
)

skinned_motion_tolerance = max(
    float(skinned_bbox_size) * 1.0e-6,
    1.0e-7
)

if skinned_center_delta_norm <= skinned_motion_tolerance:

    raise RuntimeError(
        "StandToSit.fbxの身体アニメーションがスキニング済みd026に反映されていません。"
    )

print()
print(
    "=" * 70
)
print(
    "身体アニメーション追従合成"
)
print(
    "=" * 70
)
print(
    f"身体サンプル進捗上限: {BODY_ANIMATION_SAMPLE_PROGRESS_LIMIT:.6f}"
)
print(
    f"スキニング済みd026→d026ローカル スケール: {skinned_scale:.9e}"
)
print(
    "各フレームのスキニング済みd026を基準にし、"
    "DNNの立位基準からの非剛体変形量だけを加算します。"
)
skinned_motion_offsets_max = float(
    np.max(
        np.linalg.norm(
            skinned_motion_offsets_local,
            axis=2
        )
    )
)
print(
    "スキニング済みd026移動差分 最大:"
    f" {skinned_motion_offsets_max:.9e}"
)
print(
    "スキニング済みd026中心 立位:",
    skinned_standing_center.tolist()
)
print(
    "スキニング済みd026中心 座位:",
    skinned_sitting_center.tolist()
)
print(
    "スキニング済みd026中心移動:",
    skinned_center_delta.tolist()
)
print(
    "出力スカート中心 立位:",
    body_follow_standing_center.tolist()
)
print(
    "出力スカート中心 座位:",
    body_follow_sitting_center.tolist()
)
print(
    "出力スカート中心移動:",
    body_follow_center_delta.tolist()
)

# ============================================================
# Basisを0%のスキニング済みd026と比較
# ============================================================

transformed_basis = (
    body_following_vertices_all[0]
)

basis_reference = (
    transformed_basis
    if full_garment_vertex_mode
    else d026_vertices
)

basis_error = (
    transformed_basis
    -
    basis_reference
)

basis_error_norm = np.linalg.norm(
    basis_error,
    axis=1
)

basis_rms = float(
    np.sqrt(
        np.mean(
            basis_error_norm ** 2
        )
    )
)

basis_max = float(
    np.max(
        basis_error_norm
    )
)

print()
print(
    "=" * 70
)

print(
    "0%スキニング済みd026とのBasis一致確認"
)

print(
    "=" * 70
)

print(
    f"Basis RMS誤差 : {basis_rms:.9e}"
)

print(
    f"Basis最大誤差 : {basis_max:.9e}"
)

if (
    basis_rms
    >
    target_rms * ALIGNMENT_RMS_RATIO_LIMIT
):

    raise RuntimeError(
        "GLB Basisを静止d026へ十分な精度で一致させられませんでした。"
    )

# ============================================================
# 座位変形が残っているか確認
# ============================================================

transformed_standing = (
    body_following_vertices_all[0]
)

transformed_sitting = (
    body_following_vertices_all[-1]
)

transformed_difference = (
    transformed_sitting
    -
    transformed_standing
)

transformed_difference_norm = np.linalg.norm(
    transformed_difference,
    axis=1
)

transformed_bbox_size = np.linalg.norm(
    np.max(
        transformed_standing,
        axis=0
    )
    -
    np.min(
        transformed_standing,
        axis=0
    )
)

transformed_tolerance = max(
    transformed_bbox_size * 1.0e-6,
    1.0e-7
)

transformed_max_difference = float(
    np.max(
        transformed_difference_norm
    )
)

if (
    transformed_max_difference
    <=
    transformed_tolerance
):

    raise RuntimeError(
        "身体アニメーション追従後に座位変形が残っていません。"
    )

print(
    f"変換後座位最大変位: "
    f"{transformed_max_difference:.9e}"
)

# ============================================================
# glTFエクスポート用の事前座標変換
#
# BlenderのglTFエクスポータは、Blender座標をWeb/glTF座標として
# X, Y, Z -> X, Z, -Y の向きに変換して書き出す。
# ここまでで得た transformed_vertices_all は d026 のFBXローカル座標なので、
# GLBをThree.jsで読んだ時にも d026 と同じ座標になるよう、
# Blenderへ渡す直前に逆変換 X, Y, Z -> X, -Z, Y を適用する。
# ============================================================

def to_blender_pre_export_coordinates(vertices):

    vertices = np.asarray(
        vertices,
        dtype=np.float64
    )

    converted = np.empty_like(
        vertices,
        dtype=np.float64
    )

    converted[..., 0] = vertices[..., 0]
    converted[..., 1] = -vertices[..., 2]
    converted[..., 2] = vertices[..., 1]

    return converted


export_vertices_all = to_blender_pre_export_coordinates(
    body_following_vertices_all
)

if not np.all(np.isfinite(export_vertices_all)):
    raise RuntimeError(
        "GLB出力頂点にNaNまたはInfが含まれています。"
    )

export_basis_size = np.ptp(export_vertices_all[0], axis=0)
export_motion_max = float(
    np.max(
        np.linalg.norm(
            export_vertices_all - export_vertices_all[0:1],
            axis=2,
        )
    )
)
export_basis_diagonal = float(np.linalg.norm(export_basis_size))
if export_basis_diagonal <= 1.0e-12:
    raise RuntimeError("GLB出力Basisの大きさがほぼ0です。")

export_axis_floor = export_basis_diagonal * 0.05
export_sample_indices = sorted(
    set(
        [
            0,
            frame_count // 4,
            frame_count // 2,
            (frame_count * 3) // 4,
            frame_count - 1,
        ]
    )
)
export_max_axis_ratio = 0.0
export_max_diagonal_ratio = 0.0

for sample_index in export_sample_indices:
    sample_size = np.ptp(
        export_vertices_all[sample_index],
        axis=0,
    )
    sample_diagonal = float(
        np.linalg.norm(
            sample_size
        )
    )
    sample_axis_ratio = float(
        np.max(
            sample_size
            /
            np.maximum(
                export_basis_size,
                export_axis_floor
            )
        )
    )
    sample_diagonal_ratio = sample_diagonal / export_basis_diagonal
    export_max_axis_ratio = max(
        export_max_axis_ratio,
        sample_axis_ratio
    )
    export_max_diagonal_ratio = max(
        export_max_diagonal_ratio,
        sample_diagonal_ratio
    )

if export_motion_max > export_basis_diagonal * 2.0:
    raise RuntimeError(
        "DNNモーフ変位がBasisサイズに対して異常に大きいため、"
        "GLB出力を中止しました。\n"
        f"Basis対角長: {export_basis_diagonal:.9e}\n"
        f"最大モーフ変位: {export_motion_max:.9e}"
    )

if (
    export_max_axis_ratio > 2.5
    or
    export_max_diagonal_ratio > 2.0
):
    raise RuntimeError(
        "DNNモーフ再生時の形状サイズが異常なため、"
        "GLB出力を中止しました。\n"
        f"最大軸サイズ比: {export_max_axis_ratio:.9e}\n"
        f"最大対角サイズ比: {export_max_diagonal_ratio:.9e}"
    )

export_basis = export_vertices_all[0]

export_basis_min = np.min(
    export_basis,
    axis=0
)

export_basis_max = np.max(
    export_basis,
    axis=0
)

print()
print(
    "=" * 70
)
print(
    "glTFエクスポート前座標確認"
)
print(
    "=" * 70
)
print(
    "Blender投入前Basis中心:",
    np.mean(
        export_basis,
        axis=0
    ).tolist()
)
print(
    "Blender投入前Basisサイズ:",
    (
        export_basis_max
        -
        export_basis_min
    ).tolist()
)
print(
    "全フレーム座標範囲:",
    (np.min(export_vertices_all.reshape(-1, 3), axis=0)).tolist(),
    (np.max(export_vertices_all.reshape(-1, 3), axis=0)).tolist(),
)
print(
    f"最大モーフ変位: {export_motion_max:.9e}"
)
print(
    f"最大軸サイズ比: {export_max_axis_ratio:.9e}"
)
print(
    f"最大対角サイズ比: {export_max_diagonal_ratio:.9e}"
)

expected_gltf_basis = np.empty_like(
    export_basis,
    dtype=np.float64
)

expected_gltf_basis[:, 0] = export_basis[:, 0]
expected_gltf_basis[:, 1] = export_basis[:, 2]
expected_gltf_basis[:, 2] = -export_basis[:, 1]

expected_gltf_reference = (
    transformed_basis
    if full_garment_vertex_mode
    else d026_vertices
)
expected_gltf_error = expected_gltf_basis - expected_gltf_reference
expected_gltf_error_norm = np.linalg.norm(
    expected_gltf_error,
    axis=1
)
expected_gltf_rms = float(
    np.sqrt(
        np.mean(
            expected_gltf_error_norm ** 2
        )
    )
)
expected_gltf_max = float(
    np.max(
        expected_gltf_error_norm
    )
)

print(
    f"Three.js読込想定Basis RMS誤差 : {expected_gltf_rms:.9e}"
)
print(
    f"Three.js読込想定Basis最大誤差 : {expected_gltf_max:.9e}"
)

if (
    expected_gltf_rms
    >
    target_rms * ALIGNMENT_RMS_RATIO_LIMIT
):

    raise RuntimeError(
        "glTFエクスポート後のBasisがd026座標と一致しない想定です。"
    )

if (
    expected_gltf_max
    >
    target_rms * ALIGNMENT_MAX_RATIO_LIMIT
):

    raise RuntimeError(
        "glTFエクスポート後のBasis最大誤差が大きすぎる想定です。"
    )

# ============================================================
# 新規メッシュ作成
#
# export_vertices_allはglTFエクスポート後にd026ローカル座標へ戻るよう
# 事前変換済み。オブジェクトTransformはIdentityのままにする。
# ============================================================

bpy.ops.object.select_all(
    action="DESELECT"
)

d026_object.hide_viewport = True
d026_object.hide_render = True

mesh = bpy.data.meshes.new(
    "SkirtAnimationMesh"
)

mesh.from_pydata(
    export_vertices_all[0].tolist(),
    [],
    faces.tolist()
)

mesh.update()

obj = bpy.data.objects.new(
    "Skirt_Animated",
    mesh
)

bpy.context.collection.objects.link(
    obj
)

bpy.context.view_layer.objects.active = obj
obj.select_set(True)

# ============================================================
# オブジェクトTransformはIdentity
# ============================================================

obj.location = (
    0.0,
    0.0,
    0.0
)

obj.rotation_euler = (
    0.0,
    0.0,
    0.0
)

obj.scale = (
    1.0,
    1.0,
    1.0
)

# ============================================================
# Shape Keys
# ============================================================

obj.shape_key_add(
    name="Basis"
)

print()
print(
    "Basis Shape Keyを作成しました。"
)

for frame_index in range(
    1,
    frame_count
):

    shape_key = obj.shape_key_add(
        name=f"Pose_{frame_index:03d}"
    )

    target_vertices = (
        export_vertices_all[
            frame_index
        ]
    )

    for vertex_index, vertex in enumerate(
        target_vertices
    ):

        shape_key.data[
            vertex_index
        ].co = (
            float(vertex[0]),
            float(vertex[1]),
            float(vertex[2])
        )

    if (
        frame_index % 20 == 0
        or frame_index == frame_count - 1
    ):

        print(
            f"Shape Key作成: "
            f"{frame_index}/"
            f"{frame_count - 1}"
        )

# ============================================================
# Shape Keyアニメーション
# ============================================================

if obj.data.shape_keys is None:

    raise RuntimeError(
        "Shape Keyが作成されませんでした。"
    )

key_blocks = (
    obj.data.shape_keys.key_blocks
)

for key_block in key_blocks:
    key_block.value = 0.0

scene = bpy.context.scene

scene.frame_start = 1
scene.frame_end = frame_count

for frame_index in range(
    1,
    frame_count
):

    key_name = (
        f"Pose_{frame_index:03d}"
    )

    key_block = (
        key_blocks[key_name]
    )

    blender_frame = (
        frame_index
        +
        1
    )

    key_block.value = 0.0

    key_block.keyframe_insert(
        data_path="value",
        frame=blender_frame - 1
    )

    key_block.value = 1.0

    key_block.keyframe_insert(
        data_path="value",
        frame=blender_frame
    )

    if blender_frame < frame_count:

        key_block.value = 0.0

        key_block.keyframe_insert(
            data_path="value",
            frame=blender_frame + 1
        )

# ============================================================
# Linear補間
# ============================================================

if obj.data.shape_keys.animation_data:

    action = (
        obj.data.shape_keys
        .animation_data
        .action
    )

    if action:

        for fcurve in action.fcurves:

            for keyframe in (
                fcurve.keyframe_points
            ):

                keyframe.interpolation = (
                    "LINEAR"
                )

# ============================================================
# Scene設定
# ============================================================

scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = frame_count

scene.frame_set(1)

# ============================================================
# GLB出力
# ============================================================

os.makedirs(
    os.path.dirname(glb_path),
    exist_ok=True
)

print()
print(
    "GLBを書き出しています..."
)

bpy.ops.object.select_all(
    action="DESELECT"
)

obj.select_set(True)

bpy.context.view_layer.objects.active = obj

result = bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format="GLB",
    use_selection=True,
    export_animations=True,
    export_morph=True,
    export_skins=False
)

print(
    "GLB Export結果:",
    result
)

if "FINISHED" not in result:

    raise RuntimeError(
        f"GLBの書き出しに失敗しました: {result}"
    )

if not os.path.isfile(
    glb_path
):

    raise FileNotFoundError(
        "GLBが生成されませんでした: "
        +
        glb_path
    )

glb_size = os.path.getsize(
    glb_path
)

if glb_size <= 0:

    raise RuntimeError(
        "生成されたGLBが空です。"
    )

# ============================================================
# BLEND保存
# ============================================================

print(
    "BLENDファイルを保存しています..."
)

bpy.ops.wm.save_as_mainfile(
    filepath=blend_path
)

print()
print("=" * 70)
print(
    "アニメーション付きGLB生成成功"
)
print("=" * 70)

print(
    f"GLB                : {glb_path}"
)

print(
    f"BLEND              : {blend_path}"
)

print(
    f"サイズ             : {glb_size:,} bytes"
)

print(
    f"フレーム数         : {frame_count}"
)

print(
    f"頂点数             : {vertex_count:,}"
)

print(
    f"d026基準メッシュ   : {d026_object.name}"
)

print(
    f"Similarity Scale    : "
    f"{similarity_scale:.9e}"
)

print(
    f"Basis RMS誤差      : "
    f"{basis_rms:.9e}"
)

print(
    "GLB座標系: d026のFBXローカル座標系"
)

print(
    "GLBオブジェクトTransform: "
    "位置=(0,0,0), 回転=(0,0,0), スケール=(1,1,1)"
)
'''

blender_script = blender_script.replace(
    "BODY_ANIMATION_SAMPLE_PROGRESS_LIMIT = 0.85",
    "BODY_ANIMATION_SAMPLE_PROGRESS_LIMIT = "
    f"{body_animation_sample_progress_limit:.9f}"
)

# ------------------------------------------------------------
# Blenderスクリプト保存
# ------------------------------------------------------------

with open(
    blender_script_path,
    'w',
    encoding='utf-8'
) as f:

    f.write(
        blender_script
    )

# ------------------------------------------------------------
# Blender実行
# ------------------------------------------------------------

print()
print("=" * 70)
print(
    "Blenderでd026座標系へ変換してGLB生成"
)
print("=" * 70)

if os.path.isfile(
    glb_path
):

    os.remove(
        glb_path
    )

if os.path.isfile(
    blend_path
):

    os.remove(
        blend_path
    )

blender_env = os.environ.copy()

blender_env.pop(
    "PYTHONPATH",
    None
)

blender_env[
    "PYTHONNOUSERSITE"
] = "1"

result = subprocess.run(
    [
        "blender",
        "--background",
        "--python-exit-code",
        "1",
        "--python",
        blender_script_path,
        "--",
        blender_data_path,
        fbx_path,
        glb_path,
        blend_path
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    env=blender_env
)

print(
    result.stdout
)

if result.returncode != 0:

    raise RuntimeError(
        "BlenderによるGLB生成に失敗しました。\n"
        f"終了コード: {result.returncode}"
    )

if not os.path.isfile(
    glb_path
):

    raise FileNotFoundError(
        f"アニメーションGLBが生成されませんでした: "
        f"{glb_path}"
    )

glb_size = os.path.getsize(
    glb_path
)

if glb_size <= 0:

    raise RuntimeError(
        f"アニメーションGLBが空です: "
        f"{glb_path}"
    )

print()
print("=" * 70)
print(
    "立位 → 座位 アニメーション生成成功"
)
print("=" * 70)

print(
    f"出力GLB   : {glb_path}"
)

print(
    f"出力BLEND : {blend_path}"
)

print(
    f"サイズ    : {glb_size:,} bytes"
)

print(
    f"フレーム数: {num_animation_frames}"
)

print(
    f"頂点数    : {num_points:,}"
)

print()
print(
    "DNNメッシュをd026のローカル座標系へ"
    "Similarity Transformで変換してから"
    "StandToSit.fbxのスキニング済みd026各フレームへ合成し、"
    "Shape KeyアニメーションとしてGLB化しました。"
)
