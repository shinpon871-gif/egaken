import json
import os
import pickle
import sys
from typing import Optional

import numpy as np
import torch
import torch.nn as nn

SCRIPT_DIR_CANDIDATES = [
    os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else None,
    os.getcwd(),
    "/content",
    "/content/scripts",
]
for script_dir in SCRIPT_DIR_CANDIDATES:
    if script_dir and script_dir not in sys.path:
        sys.path.insert(0, script_dir)

try:
    from create_skirt_body_context import (
        FEATURE_VERSION,
        build_feature_tensor,
        compute_contact_features,
        feature_schema,
        load_pickle,
        require_feature_schema,
        resample_sequence,
        resolve_body_motion,
        validate_animation_geometry,
        validate_context_scale,
    )
except ModuleNotFoundError:
    FEATURE_VERSION = "skirt_cloth_teacher_v1"
    TRAINING_DATA_VERSION = 1
    STAGE_NAMES = ("standing", "descending", "contact", "settling", "seated")
    CONTACT_DISTANCE_RATIO = 0.025
    K_NEIGHBORS = 8
    EPSILON = 1.0e-8

    def load_pickle(path: str) -> dict:
        with open(path, "rb") as file:
            value = pickle.load(file)
        if not isinstance(value, dict):
            raise TypeError(f"PKLの内容がdictではありません: {path}")
        return value

    def ensure_vertices(name: str, value: np.ndarray, dtype=np.float32) -> np.ndarray:
        array = np.asarray(value, dtype=dtype)
        if array.ndim != 2 or array.shape[1] != 3:
            raise ValueError(f"{name}は(頂点数, 3)が必要です: {array.shape}")
        if not np.isfinite(array).all():
            raise ValueError(f"{name}にNaNまたはInfがあります。")
        return array

    def ensure_vertex_sequence(name: str, value: np.ndarray, vertex_count: Optional[int] = None, dtype=np.float32) -> np.ndarray:
        array = np.asarray(value, dtype=dtype)
        if array.ndim != 3 or array.shape[2] != 3:
            raise ValueError(f"{name}は(フレーム数, 頂点数, 3)が必要です: {array.shape}")
        if vertex_count is not None and array.shape[1] != vertex_count:
            raise ValueError(f"{name}の頂点数が一致しません: {array.shape[1]} != {vertex_count}")
        if array.shape[0] < 2:
            raise ValueError(f"{name}は2フレーム以上必要です。")
        if not np.isfinite(array).all():
            raise ValueError(f"{name}にNaNまたはInfがあります。")
        return array

    def mesh_extent(vertices: np.ndarray) -> float:
        vertices = np.asarray(vertices, dtype=np.float64)
        return float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0)))

    def scale_reference_metrics(base_vertices: np.ndarray) -> dict:
        base = np.asarray(base_vertices, dtype=np.float64)
        size = base.max(axis=0) - base.min(axis=0)
        return {
            "extent": float(np.linalg.norm(size)),
            "width": float(max(size[0], EPSILON)),
            "height": float(max(size[1], EPSILON)),
            "depth": float(max(size[2], EPSILON)),
            "center": base.mean(axis=0).astype(np.float32),
            "min": base.min(axis=0).astype(np.float32),
            "max": base.max(axis=0).astype(np.float32),
        }

    def validate_context_scale(base_vertices: np.ndarray, context: dict, label: str = "base_skirt_pc") -> None:
        if "skirt_base_vertices" not in context:
            return
        context_vertices = ensure_vertices("context['skirt_base_vertices']", context["skirt_base_vertices"], dtype=np.float64)
        base_extent = mesh_extent(base_vertices)
        context_extent = mesh_extent(context_vertices)
        if abs(base_extent - context_extent) > 0.2 * max(context_extent, EPSILON):
            raise RuntimeError(
                f"{label}の縮尺がbody_context PKLのskirt_base_verticesと一致しません。\n"
                f"{label}対角長: {base_extent:.6f}, PKL skirt_base_vertices対角長: {context_extent:.6f}\n"
                "スケール推測補正は行いません。PKL由来のskirt_base_vertices/skirt_facesを使い直してください。"
            )

    def broadcast_motion(motion: np.ndarray, vertex_count: int, name: str = "body_motion") -> np.ndarray:
        motion = np.asarray(motion, dtype=np.float32)
        if motion.ndim == 2 and motion.shape[1] == 3:
            motion = motion[:, None, :]
        if motion.ndim != 3 or motion.shape[2] != 3:
            raise ValueError(f"{name}は(F, 3)または(F, 頂点数, 3)が必要です: {motion.shape}")
        if motion.shape[1] != vertex_count:
            motion = np.mean(motion, axis=1, keepdims=True)
        return np.broadcast_to(motion, (motion.shape[0], vertex_count, 3)).copy()

    def resolve_body_motion(context: dict, vertex_count: int) -> np.ndarray:
        if "skirt_vertex_body_motion" in context:
            motion = np.asarray(context["skirt_vertex_body_motion"], dtype=np.float32)
            if motion.ndim == 3 and motion.shape[1:] == (vertex_count, 3):
                return motion
            print(
                "[warn] skirt_vertex_body_motionの形状が不正なため、従来のbody_motionへフォールバックします。"
                f" 形状: {motion.shape}, 期待値: (フレーム数, {vertex_count}, 3)"
            )
        if "body_motion" in context:
            return broadcast_motion(context["body_motion"], vertex_count, "body_motion")
        if {"body_base_vertices", "skinned_vertices"}.issubset(context):
            body_base = ensure_vertices("body_base_vertices", context["body_base_vertices"], dtype=np.float64)
            skinned = ensure_vertex_sequence("skinned_vertices", context["skinned_vertices"], body_base.shape[0], dtype=np.float64)
            return broadcast_motion(np.mean(skinned - body_base[None, :, :], axis=1), vertex_count, "body_motion")
        raise KeyError("身体特徴量にskirt_vertex_body_motion、body_motion、body_base_vertices/skinned_verticesのいずれもありません。")

    def resample_sequence(values: np.ndarray, target_progress: np.ndarray, source_progress: Optional[np.ndarray] = None) -> np.ndarray:
        values = np.asarray(values, dtype=np.float32)
        target_progress = np.asarray(target_progress, dtype=np.float32).reshape(-1)
        source_progress = np.linspace(0.0, 1.0, values.shape[0], dtype=np.float32) if source_progress is None else np.asarray(source_progress, dtype=np.float32).reshape(-1)
        flat = values.reshape(values.shape[0], -1)
        out = np.empty((len(target_progress), flat.shape[1]), dtype=np.float32)
        for column in range(flat.shape[1]):
            out[:, column] = np.interp(target_progress, source_progress, flat[:, column])
        return out.reshape((len(target_progress),) + values.shape[1:])

    def stages_from_progress(progress: np.ndarray) -> np.ndarray:
        progress = np.asarray(progress, dtype=np.float32).reshape(-1)
        stages = np.zeros((len(progress), len(STAGE_NAMES)), dtype=np.float32)
        for index, value in enumerate(progress):
            stage_index = 0 if value < 0.08 else 1 if value < 0.55 else 2 if value < 0.78 else 3 if value < 0.95 else 4
            stages[index, stage_index] = 1.0
        return stages

    def body_vertex_positions(context: dict) -> Optional[np.ndarray]:
        if {"body_base_vertices", "body_motion_per_vertex"}.issubset(context):
            base = ensure_vertices("body_base_vertices", context["body_base_vertices"], dtype=np.float32)
            motion = ensure_vertex_sequence("body_motion_per_vertex", context["body_motion_per_vertex"], base.shape[0], dtype=np.float32)
            return base[None, :, :] + motion
        if {"body_base_vertices", "skinned_vertices"}.issubset(context):
            base = ensure_vertices("body_base_vertices", context["body_base_vertices"], dtype=np.float32)
            return ensure_vertex_sequence("skinned_vertices", context["skinned_vertices"], base.shape[0], dtype=np.float32)
        return None

    def compute_contact_features(base_vertices: np.ndarray, context: dict, progress: np.ndarray) -> np.ndarray:
        base_vertices = ensure_vertices("base_vertices", base_vertices, dtype=np.float32)
        progress = np.asarray(progress, dtype=np.float32).reshape(-1)
        metrics = scale_reference_metrics(base_vertices)
        body_positions = body_vertex_positions(context)
        if body_positions is None:
            return np.zeros((len(progress), len(base_vertices), 8), dtype=np.float32)
        body_base = body_positions[0].astype(np.float64)
        distances_squared = np.sum((base_vertices[:, None, :].astype(np.float64) - body_base[None, :, :]) ** 2, axis=2)
        neighbor_count = min(K_NEIGHBORS, body_base.shape[0])
        neighbor_indices = np.argpartition(distances_squared, neighbor_count - 1, axis=1)[:, :neighbor_count]
        neighbor_distances_squared = np.take_along_axis(distances_squared, neighbor_indices, axis=1)
        weights = 1.0 / (neighbor_distances_squared + 1.0e-6)
        weights /= np.sum(weights, axis=1, keepdims=True)
        body_resampled = resample_sequence(body_positions, progress)
        neighbors = body_resampled[:, neighbor_indices, :]
        nearest_points = np.sum(neighbors * weights[None, :, :, None].astype(np.float32), axis=2)
        vectors_to_body = nearest_points - base_vertices[None, :, :]
        distances = np.linalg.norm(vectors_to_body, axis=2, keepdims=True)
        directions = vectors_to_body / np.maximum(distances, EPSILON)
        contact = (distances <= max(metrics["extent"] * CONTACT_DISTANCE_RATIO, 1.0e-4)).astype(np.float32)
        normalized_distance = distances / max(metrics["extent"], EPSILON)
        relative = (base_vertices - metrics["center"][None, :]).astype(np.float32)
        height = ((relative[:, 1:2] - float(metrics["min"][1] - metrics["center"][1])) / max(metrics["height"], EPSILON)).astype(np.float32)
        front = (relative[:, 2:3] / max(metrics["depth"], EPSILON)).astype(np.float32)
        side = (relative[:, 0:1] / max(metrics["width"], EPSILON)).astype(np.float32)
        region = np.broadcast_to(np.concatenate([height, front, side], axis=1), (len(progress), len(base_vertices), 3)).copy()
        return np.concatenate([normalized_distance, directions.astype(np.float32), contact, region], axis=2).astype(np.float32)

    def build_feature_tensor(base_vertices, body_motion, progress, contact_features, previous_displacement, previous_velocity):
        base_vertices = ensure_vertices("base_vertices", base_vertices, dtype=np.float32)
        frame_count = len(progress)
        vertex_count = len(base_vertices)
        body_motion = ensure_vertex_sequence("body_motion", body_motion, vertex_count, dtype=np.float32)
        previous_displacement = ensure_vertex_sequence("previous_displacement", previous_displacement, vertex_count, dtype=np.float32)
        previous_velocity = ensure_vertex_sequence("previous_velocity", previous_velocity, vertex_count, dtype=np.float32)
        metrics = scale_reference_metrics(base_vertices)
        extent = max(metrics["extent"], EPSILON)
        normalized_base = (base_vertices - metrics["center"][None, :]) / extent
        progress_column = np.broadcast_to(progress.reshape(frame_count, 1, 1), (frame_count, vertex_count, 1)).astype(np.float32)
        stages = np.broadcast_to(stages_from_progress(progress)[:, None, :], (frame_count, vertex_count, len(STAGE_NAMES))).astype(np.float32)
        base_column = np.broadcast_to(normalized_base[None, :, :], (frame_count, vertex_count, 3)).astype(np.float32)
        body_position = (base_vertices[None, :, :] + body_motion - metrics["center"][None, None, :]) / extent
        return np.concatenate([progress_column, stages, base_column, body_motion / extent, body_position, contact_features, previous_displacement / extent, previous_velocity / extent], axis=2).astype(np.float32)

    def feature_schema(input_feature_count: int) -> dict:
        return {"feature_version": FEATURE_VERSION, "training_data_version": TRAINING_DATA_VERSION, "input_feature_count": int(input_feature_count)}

    def require_feature_schema(metadata: dict, expected_feature_count: int) -> None:
        if metadata.get("feature_version") != FEATURE_VERSION or int(metadata.get("input_feature_count", -1)) != int(expected_feature_count):
            raise RuntimeError("DNNモデルの特徴量スキーマが現在の推論コードと一致しません。")

    def edges_from_faces(faces: np.ndarray) -> np.ndarray:
        edges = set()
        for a, b, c in np.asarray(faces, dtype=np.int64):
            edges.add(tuple(sorted((int(a), int(b)))))
            edges.add(tuple(sorted((int(b), int(c)))))
            edges.add(tuple(sorted((int(c), int(a)))))
        return np.asarray(sorted(edges), dtype=np.int64)

    def validate_animation_geometry(vertices, faces, base_vertices, contact_features=None):
        vertices = ensure_vertex_sequence("vertices", vertices, len(base_vertices), dtype=np.float32)
        base_vertices = ensure_vertices("base_vertices", base_vertices, dtype=np.float32)
        metrics = scale_reference_metrics(base_vertices)
        displacement = vertices - base_vertices[None, :, :]
        displacement_norm = np.linalg.norm(displacement, axis=2)
        edge_ratio_max = 0.0
        edges = edges_from_faces(faces)
        if len(edges) > 0:
            base_edge = np.maximum(np.linalg.norm(base_vertices[edges[:, 0]] - base_vertices[edges[:, 1]], axis=1), EPSILON)
            for frame_vertices in vertices:
                edge = np.linalg.norm(frame_vertices[edges[:, 0]] - frame_vertices[edges[:, 1]], axis=1)
                edge_ratio_max = max(edge_ratio_max, float(np.max(edge / base_edge)))
        hem_mask = base_vertices[:, 1] <= np.quantile(base_vertices[:, 1], 0.25)
        hem_up_max = float(np.max(displacement[:, hem_mask, 1])) if np.any(hem_mask) else float(np.max(displacement[:, :, 1]))
        diagnostics = {
            "max_displacement": float(np.max(displacement_norm)),
            "mean_displacement": float(np.mean(displacement_norm)),
            "max_displacement_ratio": float(np.max(displacement_norm) / max(metrics["extent"], EPSILON)),
            "max_edge_stretch_ratio": edge_ratio_max,
            "hem_upward_displacement_max": hem_up_max,
            "hem_upward_displacement_ratio": float(hem_up_max / max(metrics["height"], EPSILON)),
        }
        if diagnostics["max_displacement_ratio"] > 5.0 or diagnostics["max_edge_stretch_ratio"] > 4.0 or diagnostics["hem_upward_displacement_ratio"] > 0.55:
            raise RuntimeError(f"スカートアニメーション診断で異常を検出しました: {diagnostics}")
        return diagnostics


# ============================================================
# 必須データ
# ============================================================
# 同じColabカーネルで次の変数を用意してから実行する。
#   model: 9次元または12次元で学習済みのPyTorchモデル
#   base_skirt_pc: (頂点数, 3)の立位スカート頂点
#
# 身体特徴量PKLは、create_skirt_body_context.pyで作成した
# skirt_body_context_for_dnn.pklを使用する。
# ============================================================

BODY_CONTEXT_PATH = str(
    globals().get(
        "DNN_BODY_CONTEXT_PATH",
        "/content/public/models/skirt_body_context_for_dnn.pkl",
    )
)
TEACHER_DATASET_PATH = str(
    globals().get(
        "DNN_TEACHER_DATASET_PATH",
        "/content/public/models/skirt_teacher_dataset.pkl",
    )
)
CONTEXT_PATH = TEACHER_DATASET_PATH if os.path.isfile(TEACHER_DATASET_PATH) else BODY_CONTEXT_PATH
OUTPUT_PATH = str(
    globals().get(
        "DNN_PREDICTION_OUTPUT_PATH",
        "/content/public/models/skirt_deformation.json",
    )
)

# Colabの%run -iはセルを再実行してもカーネルの変数(globals())が残り続ける。
# 「まだ無ければ読み込む」だと、前回の実行(あるいは別のPKLに対する実行)で
# 残った古いbase_skirt_pcを誤って使い回してしまうため、PKLが存在する限り
# 常にそちらを正として読み直す。
if os.path.isfile(CONTEXT_PATH):
    skirt_context = load_pickle(CONTEXT_PATH)
    if isinstance(skirt_context, dict) and "skirt_base_vertices" in skirt_context:
        base_skirt_pc = np.asarray(skirt_context["skirt_base_vertices"], dtype=np.float64)

if "model" not in globals():
    raise RuntimeError(
        "学習済みmodelがありません。先にtrain_skirt_sitting_dnn.pyを実行してください。"
    )
if "base_skirt_pc" not in globals():
    raise RuntimeError("base_skirt_pcがありません。")

base_vertices = np.asarray(
    globals()["base_skirt_pc"],
    dtype=np.float64,
)
if base_vertices.ndim != 2 or base_vertices.shape[1] != 3:
    raise ValueError(
        "base_skirt_pcは(頂点数, 3)で指定してください。"
    )
num_points = int(base_vertices.shape[0])

# base_skirt_pcがColabカーネルに残っている別スケール・別ソースのメッシュだと、
# 同じPKLのbody_motion(実測cm単位)と縮尺が食い違ったままDNNへ入力される。
# スケールを推測して補正せず、縮尺不一致を明確なエラーで検出する。
if os.path.isfile(CONTEXT_PATH):
    scale_check_context = load_pickle(CONTEXT_PATH)
    validate_context_scale(base_vertices, scale_check_context)


def model_input_count(model_module):
    for module in model_module.modules():
        if isinstance(module, nn.Linear):
            return int(module.in_features)
    for name in ("input_center", "coordinate_center"):
        value = getattr(model_module, name, None)
        if value is not None and value.ndim == 2:
            return int(value.shape[1])
    raise RuntimeError("modelの入力特徴量数を特定できません。")


def fit_similarity(source, target):
    source = np.asarray(source, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    source_center = np.mean(source, axis=0)
    target_center = np.mean(target, axis=0)
    source_centered = source - source_center
    target_centered = target - target_center
    covariance = source_centered.T @ target_centered
    u, _, vt = np.linalg.svd(covariance)
    rotation = u @ vt
    if np.linalg.det(rotation) < 0.0:
        u[:, -1] *= -1.0
        rotation = u @ vt
    rotated = source_centered @ rotation
    denominator = float(np.sum(source_centered * source_centered))
    if denominator <= 1.0e-20:
        raise RuntimeError("身体座標のSimilarity Transformを計算できません。")
    scale = float(np.sum(rotated * target_centered) / denominator)
    if not np.isfinite(scale) or scale <= 0.0:
        raise RuntimeError("身体座標のSimilarity Transformが不正です。")
    return source_center, target_center, rotation, scale


def transform(vertices, source_center, target_center, rotation, scale):
    vertices = np.asarray(vertices, dtype=np.float64)
    return (vertices - source_center) @ rotation * scale + target_center


def broadcast_body_motion(motion):
    motion = np.asarray(motion, dtype=np.float64)
    if motion.ndim == 2 and motion.shape[1] == 3:
        motion = motion[:, None, :]
    if motion.ndim != 3 or motion.shape[2] != 3:
        raise ValueError("身体移動は(F, 3)または(F, 頂点, 3)が必要です。")
    if motion.shape[1] != num_points:
        motion = np.mean(motion, axis=1, keepdims=True)
    return np.broadcast_to(
        motion,
        (motion.shape[0], num_points, 3),
    ).copy()


def load_body_motion():
    # Colabの%run -iはセルを再実行してもglobals()が残るため、DNN_BODY_MOTIONの
    # 手動オーバーライドをPKL読み込みより優先すると、train_skirt_sitting_dnn.py
    # 等の前回実行で残った古い値を誤って使い回してしまう。
    # PKLファイルが存在する限り、常にそちらを正として最優先で使う。
    if not os.path.isfile(CONTEXT_PATH):
        direct = globals().get("DNN_BODY_MOTION", None)
        if direct is not None:
            motion = np.asarray(direct, dtype=np.float64)
            return broadcast_body_motion(motion)
        raise FileNotFoundError(
            "身体特徴量PKLがありません: " + CONTEXT_PATH
        )
    context = load_pickle(CONTEXT_PATH)
    if not isinstance(context, dict):
        raise TypeError("身体特徴量PKLの内容がdictではありません。")

    if "skirt_vertex_body_motion" in context:
        motion = np.asarray(context["skirt_vertex_body_motion"], dtype=np.float64)
        if motion.ndim != 3 or motion.shape[1:] != (num_points, 3):
            print(
                "[warn] skirt_vertex_body_motionの形状が不正なため、"
                "従来の平均body_motionにフォールバックします。"
                f" 形状: {motion.shape}, 期待値: (フレーム数, {num_points}, 3)"
            )
            motion = None
    else:
        motion = None
    # "body_motion"(全SKIN頂点の平均変位)を全スカート頂点にそのまま
    # broadcastすると空間的な変形が失われ、剛体的な平行移動になる。
    # スカート頂点ごとの変位を持つskirt_vertex_body_motionを優先する。
    if motion is None and "body_motion" in context:
        motion = np.asarray(context["body_motion"], dtype=np.float64)
    elif motion is None and {"body_base_vertices", "skinned_vertices"}.issubset(context):
        body_base = np.asarray(context["body_base_vertices"], dtype=np.float64)
        skinned = np.asarray(context["skinned_vertices"], dtype=np.float64)
        if body_base.ndim != 2 or body_base.shape[1] != 3:
            raise ValueError("PKLのbody_base_verticesの形状が不正です。")
        if skinned.ndim != 3 or skinned.shape[1:] != body_base.shape:
            raise ValueError("PKLのskinned_verticesの形状が一致しません。")
        motion = np.mean(skinned, axis=1) - np.mean(body_base, axis=0)
    elif motion is None:
        raise KeyError(
            "PKLにbody_motionまたはbody_base_vertices/skinned_verticesがありません。"
        )

    return broadcast_body_motion(motion)


def interpolate_frames(values, progress):
    source_index = float(np.clip(progress, 0.0, 1.0)) * (values.shape[0] - 1)
    lower = int(np.floor(source_index))
    upper = min(lower + 1, values.shape[0] - 1)
    weight = source_index - lower
    return (1.0 - weight) * values[lower] + weight * values[upper]


model = globals()["model"]
input_features = model_input_count(model)
if input_features not in (9, 12):
    require_feature_schema(feature_schema(input_features), input_features)
    print(f"新スカート布DNN特徴量を使用します: {FEATURE_VERSION}, input_features={input_features}")

max_sit_angle = float(
    globals().get("max_sit_angle", np.deg2rad(75.0))
)
test_pose = np.asarray(
    globals().get(
        "test_pose",
        [0.0, max_sit_angle, 0.0],
    ),
    dtype=np.float32,
).reshape(-1)
if test_pose.size != 3:
    raise ValueError("test_poseは3次元で指定してください。")

context_for_prediction = load_pickle(CONTEXT_PATH) if os.path.isfile(CONTEXT_PATH) else {}
body_motion = resolve_body_motion(context_for_prediction, num_points) if input_features not in (9, 12) else load_body_motion()
progress = float(np.clip(test_pose[1] / max_sit_angle, 0.0, 1.0))
if input_features in (9, 12):
    body_motion_frame = interpolate_frames(body_motion, progress)
    body_position_frame = base_vertices + body_motion_frame
    pose_rows = np.repeat(test_pose.reshape(1, 3), num_points, axis=0)

    if input_features == 9:
        model_input = np.concatenate(
            [pose_rows, base_vertices, body_motion_frame],
            axis=1,
        )
        body_schema = "body_motion"
    else:
        model_input = np.concatenate(
            [pose_rows, base_vertices, body_position_frame, body_motion_frame],
            axis=1,
        )
        body_schema = "body_position + body_motion"
else:
    rollout_count = int(globals().get("DNN_ROLLOUT_FRAMES", 61))
    rollout_progress = np.linspace(0.0, progress, max(2, rollout_count), dtype=np.float32)
    body_motion_resampled = resample_sequence(body_motion, rollout_progress)
    contact_features = compute_contact_features(base_vertices, context_for_prediction, rollout_progress)
    previous_displacement = np.zeros((1, num_points, 3), dtype=np.float32)
    previous_velocity = np.zeros_like(previous_displacement)
    prediction = None
    first_parameter = next(model.parameters(), None)
    device = first_parameter.device if first_parameter is not None else torch.device("cpu")
    dtype = first_parameter.dtype if first_parameter is not None else torch.float32
    for frame_index, frame_progress in enumerate(rollout_progress):
        model_input_sequence = build_feature_tensor(
            base_vertices.astype(np.float32),
            body_motion_resampled[frame_index:frame_index + 1],
            np.asarray([frame_progress], dtype=np.float32),
            contact_features[frame_index:frame_index + 1],
            previous_displacement,
            previous_velocity,
        )
        model_input = model_input_sequence[0]
        if model_input.shape != (num_points, input_features):
            raise RuntimeError(
                "推論時特徴量の形状が不正です。"
                f"期待値: ({num_points}, {input_features}), 実際: {model_input.shape}"
            )
        with torch.inference_mode():
            output = model(torch.from_numpy(model_input).to(device=device, dtype=dtype))
        if isinstance(output, (tuple, list)):
            output = output[0]
        prediction = output.detach().cpu().numpy().astype(np.float32)
        delta_progress = max(float(frame_progress - rollout_progress[max(frame_index - 1, 0)]), 1.0 / max(len(rollout_progress) - 1, 1))
        previous_velocity = ((prediction[None, :, :] - previous_displacement) / delta_progress).astype(np.float32)
        previous_displacement = prediction[None, :, :]
    body_schema = "cloth_teacher_contact_temporal"

if input_features in (9, 12) and model_input.shape != (num_points, input_features):
    raise RuntimeError(
        "モデル入力形状が不正です。"
        f"期待値: ({num_points}, {input_features}), 実際: {model_input.shape}"
    )

model.eval()
if input_features in (9, 12):
    first_parameter = next(model.parameters(), None)
    if first_parameter is not None:
        device = first_parameter.device
        dtype = first_parameter.dtype
    else:
        device = torch.device("cpu")
        dtype = torch.float32

    with torch.inference_mode():
        prediction = model(
            torch.from_numpy(model_input.astype(np.float32)).to(
                device=device,
                dtype=dtype,
            )
        )

    if isinstance(prediction, (tuple, list)):
        prediction = prediction[0]
    prediction = prediction.detach().cpu().numpy().astype(np.float32)
if prediction.shape == (1, num_points, 3):
    prediction = prediction[0]
if prediction.shape != (num_points, 3):
    raise RuntimeError(
        "モデル出力形状が不正です。"
        f"期待値: ({num_points}, 3), 実際: {prediction.shape}"
    )
if not np.isfinite(prediction).all():
    raise RuntimeError("モデル出力にNaNまたはInfがあります。")
if "skirt_faces" in context_for_prediction:
    validate_animation_geometry(
        np.stack(
            [
                base_vertices,
                base_vertices + prediction,
            ],
            axis=0,
        ).astype(np.float32),
        np.asarray(context_for_prediction["skirt_faces"], dtype=np.int64),
        base_vertices.astype(np.float32),
    )

output_data = {
    "pose": test_pose.tolist(),
    "progress": progress,
    "input_feature_count": input_features,
    "body_feature_schema": body_schema,
    "feature_version": FEATURE_VERSION if input_features not in (9, 12) else "legacy_body_motion_v2",
    "vertex_count": num_points,
    "displacements": prediction.tolist(),
}
os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
with open(OUTPUT_PATH, "w", encoding="utf-8") as file:
    json.dump(output_data, file, indent=2, ensure_ascii=False)

print("変形データを保存しました: " + OUTPUT_PATH)
print(f"入力特徴量数: {input_features}")
print(f"身体特徴量: {body_schema}")
print(f"姿勢進捗: {progress:.6f}")
print(f"頂点数: {num_points:,}")
print(
    "最大変位: "
    f"{np.max(np.linalg.norm(prediction, axis=1)):.6f}"
)
print(
    "平均変位: "
    f"{np.mean(np.linalg.norm(prediction, axis=1)):.6f}"
)
