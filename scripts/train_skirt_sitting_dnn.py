import json
import os
import pickle
import random
import sys
from typing import Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

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
        edges_from_faces,
        feature_schema,
        load_pickle,
        progress_from_motion,
        require_feature_schema,
        resample_sequence,
        resolve_body_motion as resolve_body_motion_v1,
        temporal_derivatives,
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

    def resolve_body_motion_v1(context: dict, vertex_count: int) -> np.ndarray:
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
        if source_progress is None:
            source_progress = np.linspace(0.0, 1.0, values.shape[0], dtype=np.float32)
        else:
            source_progress = np.asarray(source_progress, dtype=np.float32).reshape(-1)
        flat = values.reshape(values.shape[0], -1)
        out = np.empty((len(target_progress), flat.shape[1]), dtype=np.float32)
        for column in range(flat.shape[1]):
            out[:, column] = np.interp(target_progress, source_progress, flat[:, column])
        return out.reshape((len(target_progress),) + values.shape[1:])

    def progress_from_motion(motion: np.ndarray) -> np.ndarray:
        norms = np.linalg.norm(np.mean(motion, axis=1), axis=1)
        if float(norms.max() - norms.min()) <= EPSILON:
            return np.linspace(0.0, 1.0, motion.shape[0], dtype=np.float32)
        monotonic = np.maximum.accumulate(norms)
        return ((monotonic - monotonic[0]) / max(monotonic[-1] - monotonic[0], EPSILON)).astype(np.float32)

    def stages_from_progress(progress: np.ndarray) -> np.ndarray:
        progress = np.asarray(progress, dtype=np.float32).reshape(-1)
        stages = np.zeros((len(progress), len(STAGE_NAMES)), dtype=np.float32)
        for index, value in enumerate(progress):
            if value < 0.08:
                stage_index = 0
            elif value < 0.55:
                stage_index = 1
            elif value < 0.78:
                stage_index = 2
            elif value < 0.95:
                stage_index = 3
            else:
                stage_index = 4
            stages[index, stage_index] = 1.0
        return stages

    def temporal_derivatives(vertices: np.ndarray, progress: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        vertices = ensure_vertex_sequence("skirt_teacher_vertices", vertices)
        progress = np.asarray(progress, dtype=np.float32).reshape(-1)
        if len(progress) != vertices.shape[0]:
            raise ValueError("progressのフレーム数がverticesと一致しません。")
        motion = (vertices - vertices[0:1]).astype(np.float32)
        velocity = np.zeros_like(motion)
        acceleration = np.zeros_like(motion)
        for frame in range(1, vertices.shape[0]):
            dt = max(float(progress[frame] - progress[frame - 1]), 1.0 / max(vertices.shape[0] - 1, 1))
            velocity[frame] = (motion[frame] - motion[frame - 1]) / dt
        for frame in range(1, vertices.shape[0]):
            dt = max(float(progress[frame] - progress[frame - 1]), 1.0 / max(vertices.shape[0] - 1, 1))
            acceleration[frame] = (velocity[frame] - velocity[frame - 1]) / dt
        return motion, velocity.astype(np.float32), acceleration.astype(np.float32)

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
        contact_threshold = max(metrics["extent"] * CONTACT_DISTANCE_RATIO, 1.0e-4)
        contact = (distances <= contact_threshold).astype(np.float32)
        normalized_distance = distances / max(metrics["extent"], EPSILON)

        relative = (base_vertices - metrics["center"][None, :]).astype(np.float32)
        height = ((relative[:, 1:2] - float(metrics["min"][1] - metrics["center"][1])) / max(metrics["height"], EPSILON)).astype(np.float32)
        front = (relative[:, 2:3] / max(metrics["depth"], EPSILON)).astype(np.float32)
        side = (relative[:, 0:1] / max(metrics["width"], EPSILON)).astype(np.float32)
        region = np.broadcast_to(np.concatenate([height, front, side], axis=1), (len(progress), len(base_vertices), 3)).copy()
        return np.concatenate([normalized_distance, directions.astype(np.float32), contact, region], axis=2).astype(np.float32)

    def build_feature_tensor(
        base_vertices: np.ndarray,
        body_motion: np.ndarray,
        progress: np.ndarray,
        contact_features: np.ndarray,
        previous_displacement: np.ndarray,
        previous_velocity: np.ndarray,
    ) -> np.ndarray:
        base_vertices = ensure_vertices("base_vertices", base_vertices, dtype=np.float32)
        frame_count = len(progress)
        vertex_count = len(base_vertices)
        body_motion = ensure_vertex_sequence("body_motion", body_motion, vertex_count, dtype=np.float32)
        contact_features = np.asarray(contact_features, dtype=np.float32)
        if contact_features.shape[:2] != (frame_count, vertex_count):
            raise ValueError(f"contact_featuresの形状が不正です: {contact_features.shape}")
        previous_displacement = ensure_vertex_sequence("previous_displacement", previous_displacement, vertex_count, dtype=np.float32)
        previous_velocity = ensure_vertex_sequence("previous_velocity", previous_velocity, vertex_count, dtype=np.float32)
        if body_motion.shape[0] != frame_count or previous_displacement.shape[0] != frame_count or previous_velocity.shape[0] != frame_count:
            raise ValueError("特徴量のフレーム数が一致しません。")

        metrics = scale_reference_metrics(base_vertices)
        extent = max(metrics["extent"], EPSILON)
        normalized_base = (base_vertices - metrics["center"][None, :]) / extent
        normalized_body_motion = body_motion / extent
        body_position = (base_vertices[None, :, :] + body_motion - metrics["center"][None, None, :]) / extent
        previous_displacement = previous_displacement / extent
        previous_velocity = previous_velocity / extent
        progress_column = np.broadcast_to(progress.reshape(frame_count, 1, 1), (frame_count, vertex_count, 1)).astype(np.float32)
        stages = np.broadcast_to(stages_from_progress(progress)[:, None, :], (frame_count, vertex_count, len(STAGE_NAMES))).astype(np.float32)
        base_column = np.broadcast_to(normalized_base[None, :, :], (frame_count, vertex_count, 3)).astype(np.float32)
        return np.concatenate(
            [
                progress_column,
                stages,
                base_column,
                normalized_body_motion.astype(np.float32),
                body_position.astype(np.float32),
                contact_features.astype(np.float32),
                previous_displacement.astype(np.float32),
                previous_velocity.astype(np.float32),
            ],
            axis=2,
        ).astype(np.float32)

    def feature_schema(input_feature_count: int) -> dict:
        return {
            "feature_version": FEATURE_VERSION,
            "training_data_version": TRAINING_DATA_VERSION,
            "input_feature_count": int(input_feature_count),
            "stage_names": list(STAGE_NAMES),
            "layout": [
                {"name": "progress", "size": 1},
                {"name": "stage_one_hot", "size": len(STAGE_NAMES)},
                {"name": "normalized_base_vertex", "size": 3},
                {"name": "normalized_body_motion", "size": 3},
                {"name": "normalized_body_follow_position", "size": 3},
                {"name": "contact_distance_direction_flag_region", "size": 8},
                {"name": "previous_skirt_displacement", "size": 3},
                {"name": "previous_skirt_velocity", "size": 3},
            ],
        }

    def require_feature_schema(metadata: dict, expected_feature_count: int) -> None:
        feature_version = metadata.get("feature_version")
        input_feature_count = int(metadata.get("input_feature_count", -1))
        if feature_version != FEATURE_VERSION or input_feature_count != int(expected_feature_count):
            raise RuntimeError(
                "DNNモデルの特徴量スキーマが現在の推論コードと一致しません。\n"
                f"model feature_version={feature_version}, expected={FEATURE_VERSION}\n"
                f"model input_feature_count={input_feature_count}, expected={expected_feature_count}"
            )

    def edges_from_faces(faces: np.ndarray) -> np.ndarray:
        faces = np.asarray(faces, dtype=np.int64)
        edges = set()
        for a, b, c in faces:
            edges.add(tuple(sorted((int(a), int(b)))))
            edges.add(tuple(sorted((int(b), int(c)))))
            edges.add(tuple(sorted((int(c), int(a)))))
        return np.asarray(sorted(edges), dtype=np.int64)

    def validate_animation_geometry(vertices: np.ndarray, faces: np.ndarray, base_vertices: np.ndarray, contact_features: Optional[np.ndarray] = None) -> dict:
        vertices = ensure_vertex_sequence("vertices", vertices, len(base_vertices), dtype=np.float32)
        faces = np.asarray(faces, dtype=np.int64)
        base_vertices = ensure_vertices("base_vertices", base_vertices, dtype=np.float32)
        metrics = scale_reference_metrics(base_vertices)
        displacement = vertices - base_vertices[None, :, :]
        displacement_norm = np.linalg.norm(displacement, axis=2)
        edges = edges_from_faces(faces)
        edge_ratio_max = 0.0
        if len(edges) > 0:
            base_edge = np.linalg.norm(base_vertices[edges[:, 0]] - base_vertices[edges[:, 1]], axis=1)
            base_edge = np.maximum(base_edge, EPSILON)
            for frame_vertices in vertices:
                edge = np.linalg.norm(frame_vertices[edges[:, 0]] - frame_vertices[edges[:, 1]], axis=1)
                edge_ratio_max = max(edge_ratio_max, float(np.max(edge / base_edge)))
        up_axis_displacement = displacement[:, :, 1]
        hem_y_limit = np.quantile(base_vertices[:, 1], 0.25)
        hem_mask = base_vertices[:, 1] <= hem_y_limit
        hem_up_max = float(np.max(up_axis_displacement[:, hem_mask])) if np.any(hem_mask) else float(np.max(up_axis_displacement))
        diagnostics = {
            "max_displacement": float(np.max(displacement_norm)),
            "mean_displacement": float(np.mean(displacement_norm)),
            "max_displacement_ratio": float(np.max(displacement_norm) / max(metrics["extent"], EPSILON)),
            "max_edge_stretch_ratio": edge_ratio_max,
            "hem_upward_displacement_max": hem_up_max,
            "hem_upward_displacement_ratio": float(hem_up_max / max(metrics["height"], EPSILON)),
        }
        if contact_features is not None and contact_features.shape[:2] == vertices.shape[:2]:
            diagnostics["contact_vertex_ratio"] = float(np.mean(contact_features[:, :, 4] > 0.5))
        if diagnostics["max_displacement_ratio"] > 5.0:
            raise RuntimeError(f"DNN出力の最大変位が大きすぎます: {diagnostics}")
        if diagnostics["max_edge_stretch_ratio"] > 4.0:
            raise RuntimeError(f"隣接頂点間の局所伸縮が大きすぎます: {diagnostics}")
        if diagnostics["hem_upward_displacement_ratio"] > 0.55:
            raise RuntimeError(
                "裾周辺が過度に上方へ移動しています。太もも周辺のめくれ上がり回帰の可能性があります: "
                f"{diagnostics}"
            )
        return diagnostics

# ============================================================
# 使い方
# ============================================================
# 1. create_skirt_body_context.py で skirt_body_context_for_dnn.pkl を作成する。
# 2. 実スカート教師を使う場合は create_skirt_body_context.py teacher で
#    skirt_teacher_dataset.pkl を作成する。manifestには公開ライセンス/許諾URLを必ず記録する。
# 3. base_skirt_pc と base_skirt_faces はPKLから自動読込される。手動指定する場合も同じColabカーネルで作成する。
# 4. 身体特徴量を DNN_BODY_MOTION または DNN_BODY_CONTEXT に用意する。
#    DNN_BODY_MOTION: (フレーム数, 頂点数, 3)
#      base_skirt_pc と同じ座標系での、立位Body/SKINからの身体頂点差分。
#    DNN_BODY_CONTEXT: dict形式の場合は次のどちらか。
#      {"body_motion": ndarray[F, N, 3]}
#      {"body_position": ndarray[F, N, 3],
#       "body_motion": ndarray[F, N, 3]}
#    DNN_BODY_CONTEXT_FEATURES を直接渡す場合は
#      (フレーム数, 頂点数, 3 または 6) を使用できる。
#    変数を用意しない場合は、DNN_BODY_CONTEXT_PATHのPKLを読み込む。
# 5. 必要なら DNN_INPUT_FEATURES を 9 または 12 に設定する。
# 6. 次を実行する。
#      %run -i /content/train_skirt_sitting_dnn.py
# 7. 実行後、学習済みモデルが model に入り、
#    skirt_animation_dnn_morph_fixed.py から利用できる。
#
# 9次元:  [pose(3), point(3), body_motion(3)]
# 12次元: [pose(3), point(3), body_position(3), body_motion(3)]
#
# モデルは「まず入力末尾3列のbody_motion(身体側の実変位)にそのまま追従し、
# その上でDNNが学習した残差(布のたわみ等)を加える」skip接続構造。
# body_motionと無関係な絶対変位を直接学習させると、身体側の変位が
# スカート各頂点で大きく異なる場合に学習が不安定になり、過剰な変形や
# 崩れた形状を出力しやすくなるため、この構造で安定させている。
# ============================================================

RANDOM_SEED = int(globals().get("DNN_RANDOM_SEED", 20260903))
INPUT_FEATURES = int(globals().get("DNN_INPUT_FEATURES", 9))
MAX_SIT_ANGLE_DEGREES = float(
    globals().get("DNN_MAX_SIT_ANGLE_DEGREES", 75.0)
)
NUM_POSE_SAMPLES = int(globals().get("DNN_NUM_POSE_SAMPLES", 61))
HIDDEN_SIZE = int(globals().get("DNN_HIDDEN_SIZE", 192))
LEARNING_RATE = float(globals().get("DNN_LEARNING_RATE", 1.0e-3))
WEIGHT_DECAY = float(globals().get("DNN_WEIGHT_DECAY", 1.0e-6))
PRINT_INTERVAL = int(globals().get("DNN_PRINT_INTERVAL", 100))
TRAIN_STEPS_OVERRIDE = globals().get("DNN_TRAIN_STEPS", None)
BATCH_SIZE_OVERRIDE = globals().get("DNN_BATCH_SIZE", None)
GEOMETRY_REGULARIZATION_FRAME_BATCH = int(globals().get("DNN_GEOMETRY_REGULARIZATION_FRAME_BATCH", 2))
HEM_UPWARD_SOFT_LIMIT_RATIO = float(globals().get("DNN_HEM_UPWARD_SOFT_LIMIT_RATIO", 0.20))
HEM_UPWARD_LOSS_WEIGHT = float(globals().get("DNN_HEM_UPWARD_LOSS_WEIGHT", 0.25))
EDGE_STRETCH_SOFT_LIMIT_RATIO = float(globals().get("DNN_EDGE_STRETCH_SOFT_LIMIT_RATIO", 2.20))
EDGE_STRETCH_LOSS_WEIGHT = float(globals().get("DNN_EDGE_STRETCH_LOSS_WEIGHT", 0.05))
GEOMETRY_SELECTION_LOSS_WEIGHT = float(globals().get("DNN_GEOMETRY_SELECTION_LOSS_WEIGHT", 0.10))
OUTPUT_DIR = str(
    globals().get("DNN_OUTPUT_DIR", "/content/public/models")
)
BODY_CONTEXT_PATH = str(
    globals().get(
        "DNN_BODY_CONTEXT_PATH",
        os.path.join(OUTPUT_DIR, "skirt_body_context_for_dnn.pkl"),
    )
)
TEACHER_DATASET_PATH = str(
    globals().get(
        "DNN_TEACHER_DATASET_PATH",
        os.path.join(OUTPUT_DIR, "skirt_teacher_dataset.pkl"),
    )
)
CONTEXT_PATH = TEACHER_DATASET_PATH if os.path.isfile(TEACHER_DATASET_PATH) else BODY_CONTEXT_PATH
os.makedirs(OUTPUT_DIR, exist_ok=True)

if not os.path.isfile(TEACHER_DATASET_PATH) and INPUT_FEATURES not in (9, 12):
    raise ValueError(
        "DNN_INPUT_FEATURES は9または12にしてください。"
    )

# Colabの%run -iはセルを再実行してもカーネルの変数(globals())が残り続ける。
# 「まだ無ければ読み込む」だと、前回の実行(あるいは別のPKLに対する実行)で
# 残った古いbase_skirt_pcを誤って使い回してしまうため、PKLが存在する限り
# 常にそちらを正として読み直す。
if os.path.isfile(CONTEXT_PATH):
    import pickle

    with open(CONTEXT_PATH, "rb") as file:
        skirt_context = pickle.load(file)
    if isinstance(skirt_context, dict) and {
        "skirt_base_vertices",
        "skirt_faces",
    }.issubset(skirt_context):
        base_skirt_pc = np.asarray(skirt_context["skirt_base_vertices"], dtype=np.float32)
        base_skirt_faces = np.asarray(skirt_context["skirt_faces"], dtype=np.int64)

random.seed(RANDOM_SEED)
np.random.seed(RANDOM_SEED)
torch.manual_seed(RANDOM_SEED)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(RANDOM_SEED)

if "base_skirt_pc" not in globals():
    raise RuntimeError(
        "base_skirt_pc が存在しません。立位スカートの頂点配列を先に作成してください。"
    )
if "base_skirt_faces" not in globals():
    raise RuntimeError(
        "base_skirt_faces が存在しません。面インデックスを先に作成してください。"
    )

base_skirt_pc = np.asarray(
    globals()["base_skirt_pc"],
    dtype=np.float32,
)
base_skirt_faces = np.asarray(
    globals()["base_skirt_faces"],
    dtype=np.int64,
)
if base_skirt_pc.ndim != 2 or base_skirt_pc.shape[1] != 3:
    raise ValueError(f"base_skirt_pc は (頂点数, 3) が必要です: {base_skirt_pc.shape}")
if base_skirt_faces.ndim != 2 or base_skirt_faces.shape[1] != 3:
    raise ValueError(
        "base_skirt_faces は (面数, 3) が必要です: "
        f"{base_skirt_faces.shape}"
    )
if not np.isfinite(base_skirt_pc).all():
    raise ValueError("base_skirt_pc にNaNまたはInfがあります。")

num_points = int(base_skirt_pc.shape[0])
num_faces = int(base_skirt_faces.shape[0])
if num_points < 4 or num_faces < 1:
    raise ValueError("スカートの頂点数または面数が不足しています。")
if np.min(base_skirt_faces) < 0 or np.max(base_skirt_faces) >= num_points:
    raise ValueError("base_skirt_facesに範囲外の頂点インデックスがあります。")

# base_skirt_pcがColabカーネルに残っている別スケール・別ソースのメッシュだと、
# 同じPKLのbody_motion(実測cm単位)と縮尺が食い違ったまま学習が進み、
# 学習済みモデルの出力スケールごと破綻する。ここで両者の対角長を比較し、
# 縮尺が一致しない場合はスケールを推測して補正せず、明確なエラーで停止する。
if os.path.isfile(CONTEXT_PATH):
    scale_check_context = load_pickle(CONTEXT_PATH)
    validate_context_scale(base_skirt_pc, scale_check_context)


def fit_similarity(source: np.ndarray, target: np.ndarray):
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
        raise ValueError("身体座標のSimilarity Transformを計算できません。")
    scale = float(np.sum(rotated * target_centered) / denominator)
    if not np.isfinite(scale) or scale <= 0.0:
        raise ValueError("身体座標のSimilarity Transformが不正です。")
    return source_center, target_center, rotation, scale


def transform_vertices(
    vertices: np.ndarray,
    source_center: np.ndarray,
    target_center: np.ndarray,
    rotation: np.ndarray,
    scale: float,
) -> np.ndarray:
    return (
        (vertices - source_center) @ rotation * scale + target_center
    )


def broadcast_body_motion(motion: np.ndarray) -> np.ndarray:
    motion = np.asarray(motion, dtype=np.float32)
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


def body_motion_from_context(context: dict) -> np.ndarray:
    # body_base_verticesとbase_skirt_pcは同じBodyメッシュ・同じ座標系から
    # 抽出されるため、軸ごとの範囲比によるスケール変換は不要かつ有害。
    body_base = np.asarray(context["body_base_vertices"], dtype=np.float64)
    skinned = np.asarray(context["skinned_vertices"], dtype=np.float64)
    if body_base.ndim != 2 or body_base.shape[1] != 3:
        raise ValueError("身体PKLのbody_base_verticesの形状が不正です。")
    if skinned.ndim != 3 or skinned.shape[1:] != body_base.shape:
        raise ValueError("身体PKLのskinned_verticesの形状が不正です。")
    body_motion = (np.mean(skinned, axis=1) - np.mean(body_base, axis=0)).astype(np.float32)
    return broadcast_body_motion(body_motion)


def resolve_motion_from_context(context: dict) -> np.ndarray:
    # "body_motion"(全SKIN頂点の平均変位)をそのままbroadcastすると、
    # スカートの全頂点が同一の変位ベクトルになり、相対的な形状変化が
    # 失われて剛体的に平行移動するだけになる。スカート頂点ごとに最近傍の
    # Body/SKIN頂点を対応付けた"skirt_vertex_body_motion"(空間的に変化する
    # 特徴量)が存在する場合はそちらを優先する。
    if "skirt_vertex_body_motion" in context:
        motion = np.asarray(context["skirt_vertex_body_motion"], dtype=np.float32)
        if motion.ndim == 3 and motion.shape[1:] == (num_points, 3):
            return motion
        print(
            "[warn] skirt_vertex_body_motionの形状が不正なため、"
            "従来の平均body_motionにフォールバックします。"
            f" 形状: {motion.shape}, 期待値: (フレーム数, {num_points}, 3)"
        )
    if "body_motion" in context:
        return np.asarray(context["body_motion"], dtype=np.float32)
    if {"body_base_vertices", "skinned_vertices"}.issubset(context):
        return body_motion_from_context(context)
    raise KeyError(
        "身体特徴量にskirt_vertex_body_motion、body_motion、"
        "body_base_vertices/skinned_verticesのいずれもありません。"
    )


def get_body_features() -> np.ndarray:
    # Colabの%run -iはセルを再実行してもglobals()が残るため、DNN_BODY_MOTION等の
    # 手動オーバーライドをこのPKL読み込みより優先すると、前回このスクリプトを
    # 実行した際にget_body_features()自身が(誤って同名で)書き戻した古い値や、
    # 別のPKLに対する古いオーバーライドを再利用してしまう。
    # PKLファイルが存在する限り、常にそちらを正として最優先で使う。
    if os.path.isfile(CONTEXT_PATH):
        import pickle

        with open(CONTEXT_PATH, "rb") as file:
            context = pickle.load(file)
        if not isinstance(context, dict):
            raise TypeError("身体特徴量PKLの内容がdictではありません。")
        motion = resolve_motion_from_context(context)
        motion = broadcast_body_motion(motion)
        print(f"身体特徴量の入力元: {CONTEXT_PATH}")
        if INPUT_FEATURES == 9:
            return motion
        position = base_skirt_pc[None, :, :] + motion
        return np.concatenate([position, motion], axis=2)

    direct = globals().get("DNN_BODY_CONTEXT_FEATURES", None)
    if direct is not None:
        features = np.asarray(direct, dtype=np.float32)
        # Add this line to broadcast the motion if its shape is (frames, 3)
        features = broadcast_body_motion(features)
        expected_channels = 3 if INPUT_FEATURES == 9 else 6
        if features.ndim != 3 or features.shape[1:] != (
            num_points,
            expected_channels,
        ):
            raise ValueError(
                "DNN_BODY_CONTEXT_FEATURESの形状が不正です。"
                f"期待値: (フレーム数, {num_points}, {expected_channels}), "
                f"実際: {features.shape}"
            )
        return features

    context = globals().get("DNN_BODY_CONTEXT", None)
    if context is not None:
        if not isinstance(context, dict):
            raise TypeError("DNN_BODY_CONTEXTはdictで指定してください。")
        motion = resolve_motion_from_context(context)
        motion = broadcast_body_motion(motion)
        if INPUT_FEATURES == 9:
            return motion
        if "body_position" not in context:
            raise ValueError(
                "12次元入力にはDNN_BODY_CONTEXT['body_position']が必要です。"
            )
        position = broadcast_body_motion(context["body_position"])
        return np.concatenate([position, motion], axis=2)

    motion = globals().get("DNN_BODY_MOTION", None)
    if motion is None:
        raise RuntimeError(
            "身体特徴量がありません。\n"
            "DNN_BODY_MOTION、DNN_BODY_CONTEXT、"
            "DNN_BODY_CONTEXT_FEATURESのいずれかを設定するか、\n"
            f"次のPKLを先に生成してください: {BODY_CONTEXT_PATH}\n"
            "Colabではcreate_skirt_body_context.pyを実行してください。"
        )
    motion = broadcast_body_motion(motion)
    if INPUT_FEATURES == 9:
        return motion
    position = base_skirt_pc[None, :, :] + motion
    return np.concatenate([position, motion], axis=2)


teacher_context = load_pickle(TEACHER_DATASET_PATH) if os.path.isfile(TEACHER_DATASET_PATH) else None
teacher_feature_tensor = None
teacher_contact_features = None
teacher_progress = None
if teacher_context is not None and "skirt_teacher_vertices" in teacher_context:
    validate_context_scale(base_skirt_pc, teacher_context)
    teacher_progress = np.asarray(
        teacher_context.get("skirt_teacher_progress", []),
        dtype=np.float32,
    ).reshape(-1)
    if len(teacher_progress) == 0:
        teacher_progress = progress_from_motion(resolve_body_motion_v1(teacher_context, num_points))
    body_motion_for_teacher = resample_sequence(
        resolve_body_motion_v1(teacher_context, num_points),
        teacher_progress,
    )
    teacher_vertices_for_features = np.asarray(
        teacher_context["skirt_teacher_vertices"],
        dtype=np.float32,
    )
    if teacher_vertices_for_features.shape[0] != len(teacher_progress):
        teacher_vertices_for_features = resample_sequence(
            teacher_vertices_for_features,
            teacher_progress,
            np.linspace(0.0, 1.0, teacher_vertices_for_features.shape[0], dtype=np.float32),
        )
    teacher_motion_for_features, teacher_velocity_for_features, _ = temporal_derivatives(
        teacher_vertices_for_features,
        teacher_progress,
    )
    previous_displacement = np.zeros_like(teacher_motion_for_features)
    previous_velocity = np.zeros_like(teacher_velocity_for_features)
    previous_displacement[1:] = teacher_motion_for_features[:-1]
    previous_velocity[1:] = teacher_velocity_for_features[:-1]
    teacher_contact_features = np.asarray(
        teacher_context.get("skirt_contact_features", []),
        dtype=np.float32,
    )
    if teacher_contact_features.shape[:2] != teacher_vertices_for_features.shape[:2]:
        teacher_contact_features = compute_contact_features(
            base_skirt_pc,
            teacher_context,
            teacher_progress,
        )
    teacher_feature_tensor = build_feature_tensor(
        base_skirt_pc,
        body_motion_for_teacher,
        teacher_progress,
        teacher_contact_features,
        previous_displacement,
        previous_velocity,
    )
    INPUT_FEATURES = int(teacher_feature_tensor.shape[2])
    require_feature_schema(feature_schema(INPUT_FEATURES), INPUT_FEATURES)
    print(f"実スカート教師データを使用します: {TEACHER_DATASET_PATH}")
    print(f"特徴量バージョン: {FEATURE_VERSION}, 入力次元: {INPUT_FEATURES}")

body_features = None if teacher_feature_tensor is not None else get_body_features()
# 注意: DNN_BODY_CONTEXT_FEATURES/DNN_BODY_MOTIONという名前でここに書き戻すと、
# それらは get_body_features() 自身が「手動オーバーライド」として最優先で
# 読みに行く名前と衝突する。Colabの%run -iはセルを再実行してもglobals()が
# 残るため、前回このスクリプトを実行した際の結果が次回の実行で誤って
# 「手動オーバーライド」として再利用され、新しいPKLを再生成しても
# 古い身体特徴量のまま学習し続けてしまう。そのためオーバーライド名とは
# 別名で公開する。
if body_features is not None:
    DNN_BODY_CONTEXT_FEATURES_RESOLVED = body_features.copy()
    DNN_BODY_MOTION_RESOLVED = (
        body_features[:, :, :3]
        if INPUT_FEATURES == 9
        else body_features[:, :, 3:6]
    ).copy()
    if body_features.shape[0] < 2:
        raise ValueError("身体特徴量は2フレーム以上必要です。")
    if not np.isfinite(body_features).all():
        raise ValueError("身体特徴量にNaNまたはInfがあります。")

provided_training_vertices = globals().get("DNN_TRAINING_VERTICES", None)
provided_sitting_vertices = globals().get("DNN_SITTING_VERTICES", None)
provided_pose_angles = globals().get("DNN_TRAINING_POSE_ANGLES", None)
max_sit_angle = float(np.deg2rad(MAX_SIT_ANGLE_DEGREES))


def smoothstep(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def make_teacher(vertices: np.ndarray, progress: float) -> np.ndarray:
    center = np.mean(vertices, axis=0)
    centered = vertices - center
    vertical = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    height = max(float(np.ptp(centered @ vertical)), 1.0e-6)
    normalized_height = np.clip((centered @ vertical) / height + 0.5, 0.0, 1.0)
    sit = float(smoothstep(np.asarray(progress)))
    front_extent = max(float(np.ptp(centered[:, 2])), 1.0e-6)
    front = np.clip(centered[:, 2] / front_extent, -1.0, 1.0)
    lower = smoothstep((normalized_height - 0.05) / 0.95)
    result = centered.copy()
    result[:, 1] -= sit * height * lower * (0.16 + 0.08 * front)
    result[:, 2] += (
        sit * height * lower * (0.12 + 0.06 * np.maximum(front, 0.0))
    )
    result[:, 0] *= 1.0 + sit * 0.05 * lower
    return (center + result).astype(np.float32)


if teacher_feature_tensor is not None:
    teacher_vertices = np.asarray(teacher_context["skirt_teacher_vertices"], dtype=np.float32)
    if teacher_vertices.shape[0] != len(teacher_progress):
        teacher_vertices = resample_sequence(
            teacher_vertices,
            teacher_progress,
            np.linspace(0.0, 1.0, teacher_vertices.shape[0], dtype=np.float32),
        )
    teacher_vertices[0] = base_skirt_pc
    pose_angles = (teacher_progress * max_sit_angle).astype(np.float32)
    frame_count = int(teacher_vertices.shape[0])
    target_source = "licensed_external_skirt_teacher"
elif provided_training_vertices is not None:
    teacher_vertices = np.asarray(provided_training_vertices, dtype=np.float32)
    if (
        teacher_vertices.ndim != 3
        or teacher_vertices.shape[1:] != (num_points, 3)
    ):
        raise ValueError("DNN_TRAINING_VERTICESは(F, 頂点数, 3)が必要です。")
    frame_count = int(teacher_vertices.shape[0])
    if provided_pose_angles is None:
        pose_angles = np.linspace(
            0.0,
            max_sit_angle,
            frame_count,
            dtype=np.float32,
        )
    else:
        pose_angles = np.asarray(
            provided_pose_angles,
            dtype=np.float32,
        ).reshape(-1)
        if len(pose_angles) != frame_count:
            raise ValueError("DNN_TRAINING_POSE_ANGLESの長さが一致しません。")
    teacher_vertices = (
        base_skirt_pc[None, :, :] + teacher_vertices - teacher_vertices[0:1]
    ).astype(np.float32)
    teacher_vertices[0] = base_skirt_pc
    target_source = "provided_animation_vertices"
elif provided_sitting_vertices is not None:
    sitting = np.asarray(provided_sitting_vertices, dtype=np.float32)
    if sitting.shape != (num_points, 3):
        raise ValueError("DNN_SITTING_VERTICESの形状が一致しません。")
    pose_angles = np.linspace(
        0.0,
        max_sit_angle,
        NUM_POSE_SAMPLES,
        dtype=np.float32,
    )
    teacher_vertices = np.asarray(
        [
            base_skirt_pc
            + float(smoothstep(np.asarray(angle / max_sit_angle)))
            * (sitting - base_skirt_pc)
            for angle in pose_angles
        ],
        dtype=np.float32,
    )
    target_source = "provided_sitting_vertices"
else:
    pose_angles = np.linspace(
        0.0,
        max_sit_angle,
        NUM_POSE_SAMPLES,
        dtype=np.float32,
    )
    teacher_vertices = np.asarray(
        [
            make_teacher(base_skirt_pc, float(angle / max_sit_angle))
            for angle in pose_angles
        ],
        dtype=np.float32,
    )
    target_source = "geometry_aware_synthetic_teacher"

frame_count = int(teacher_vertices.shape[0])
teacher_displacements = teacher_vertices - base_skirt_pc[None, :, :]
teacher_displacements[0] = 0.0

target_progress = np.asarray(pose_angles / max_sit_angle, dtype=np.float32)
if teacher_feature_tensor is None:
    # 身体特徴量を教師フレーム数へ線形補間する。
    source_progress = np.linspace(0.0, 1.0, body_features.shape[0])
    resampled_body = np.empty(
        (frame_count, num_points, body_features.shape[2]),
        dtype=np.float32,
    )
    for point_index in range(num_points):
        for channel_index in range(body_features.shape[2]):
            resampled_body[:, point_index, channel_index] = np.interp(
                target_progress,
                source_progress,
                body_features[:, point_index, channel_index],
            )
else:
    resampled_body = teacher_feature_tensor

teacher_displacements = (
    teacher_vertices
    - base_skirt_pc[None, :, :]
).astype(np.float32)
teacher_displacements[0] = 0.0

# resampled_bodyの末尾3チャンネルは常にmotion(9次元入力ならそのまま、
# 12次元入力ならposition+motionのmotion側)。SkirtDeformationDNN.forward()は
# 「motion_baseline(=motion) + eased*network(x)*output_scale」を出力するため、
# 学習ターゲットは絶対変位teacher_displacementsのままでよい
# (forward()内のskip接続が自動的にmotionを差し引いた分だけnetworkに学習させる)。
# ここでresidual_displacements(=teacher-motion)を計算するのは、
# 「networkが実際に学習すべき残差の大きさ」に output_scale を合わせるためだけ。
# これをtarget_rows_allにもそのまま使うと、forward()が加算するmotionと
# 二重に相殺され、学習が破綻する(推論時に出力が桁違いに爆発する)。
if teacher_feature_tensor is None:
    resampled_motion = resampled_body[:, :, -3:]
else:
    resampled_motion = np.zeros_like(teacher_displacements)

if target_source == "geometry_aware_synthetic_teacher":
    # 実スカート教師が無い場合でも、裾まで身体変位をそのまま足すと
    # 太もも周辺と裾が脚の上方移動へ単純追従し、今回のめくれ上がりを
    # 教師データ自身が作ってしまう。腰側は身体へ追従させつつ、裾側ほど
    # 追従を弱め、上向き成分は特に抑える。
    skirt_y = base_skirt_pc[:, 1]
    height = max(float(np.ptp(skirt_y)), 1.0e-6)
    height01 = ((skirt_y - float(np.min(skirt_y))) / height).astype(np.float32)
    body_follow_weight = (0.10 + 0.90 * smoothstep((height01 - 0.25) / 0.70)).astype(np.float32)
    synthetic_body_follow = resampled_motion * body_follow_weight[None, :, None]
    upward = np.maximum(synthetic_body_follow[:, :, 1], 0.0)
    synthetic_body_follow[:, :, 1] -= upward * (1.0 - body_follow_weight[None, :])
    teacher_displacements = teacher_displacements + synthetic_body_follow

# resampled_bodyの末尾3チャンネルは常にmotion(9次元入力ならそのまま、
# 12次元入力ならposition+motionのmotion側)。SkirtDeformationDNN.forward()は
# 「motion_baseline(=motion) + eased*network(x)*output_scale」を出力するため、
# 学習ターゲットは絶対変位teacher_displacementsのままでよい
# (forward()内のskip接続が自動的にmotionを差し引いた分だけnetworkに学習させる)。
# ここでresidual_displacements(=teacher-motion)を計算するのは、
# 「networkが実際に学習すべき残差の大きさ」に output_scale を合わせるためだけ。
# これをtarget_rows_allにもそのまま使うと、forward()が加算するmotionと
# 二重に相殺され、学習が破綻する(推論時に出力が桁違いに爆発する)。
residual_displacements = (teacher_displacements - resampled_motion).astype(np.float32)
if teacher_feature_tensor is not None:
    validate_animation_geometry(teacher_vertices, base_skirt_faces, base_skirt_pc, teacher_contact_features)

pose_rows_all = []
input_rows_all = []
target_rows_all = []
frame_indices_all = []
for frame_index, angle in enumerate(pose_angles):
    if teacher_feature_tensor is None:
        pose = np.repeat(
            np.asarray([[0.0, float(angle), 0.0]], dtype=np.float32),
            num_points,
            axis=0,
        )
        rows = np.concatenate(
            [pose, base_skirt_pc, resampled_body[frame_index]],
            axis=1,
        )
    else:
        pose = np.repeat(
            np.asarray([[0.0, float(angle), 0.0]], dtype=np.float32),
            num_points,
            axis=0,
        )
        rows = teacher_feature_tensor[frame_index]
    pose_rows_all.append(pose)
    input_rows_all.append(rows.astype(np.float32))
    target_rows_all.append(teacher_displacements[frame_index])
    frame_indices_all.append(np.full(num_points, frame_index, dtype=np.int64))

all_inputs = np.concatenate(input_rows_all, axis=0)
all_targets = np.concatenate(target_rows_all, axis=0)
all_frame_indices = np.concatenate(frame_indices_all, axis=0)
if all_inputs.shape[1] != INPUT_FEATURES:
    raise RuntimeError(f"構成された入力次元が不正です: {all_inputs.shape}")

validation_frame_mask = np.zeros(frame_count, dtype=bool)
validation_frame_mask[1:-1:5] = True
sample_validation_mask = validation_frame_mask[all_frame_indices]
if not sample_validation_mask.any():
    sample_validation_mask[:num_points] = True
sample_training_mask = ~sample_validation_mask
train_inputs_np = all_inputs[sample_training_mask]
train_targets_np = all_targets[sample_training_mask]
validation_inputs_np = all_inputs[sample_validation_mask]
validation_targets_np = all_targets[sample_validation_mask]

input_center = np.mean(train_inputs_np, axis=0).astype(np.float32)
input_scale = np.std(train_inputs_np, axis=0).astype(np.float32)
input_scale = np.maximum(input_scale, np.float32(1.0e-6))
# output_scaleは「DNNが学習すべき残差(襞の変形)」の大きさに合わせる。
# body_motionという絶対変位そのままの大きさで正規化すると、残差(通常は
# body_motionより小さい)に対してeased*output_scaleが過大な自由度を持ち、
# 学習・外挿が不安定になる。
output_scale = float(
    max(
        np.max(np.linalg.norm(residual_displacements, axis=2)),
        1.0e-6,
    )
)


class SkirtDeformationDNN(nn.Module):
    def __init__(
        self,
        center: np.ndarray,
        scale: np.ndarray,
        output_scale_value: float,
    ):
        super().__init__()
        self.register_buffer(
            "input_center",
            torch.as_tensor(center).reshape(1, -1),
        )
        self.register_buffer(
            "input_scale",
            torch.as_tensor(scale).reshape(1, -1),
        )
        self.register_buffer("output_scale", torch.tensor(output_scale_value))
        self.network = nn.Sequential(
            nn.Linear(INPUT_FEATURES, HIDDEN_SIZE),
            nn.SiLU(),
            nn.Linear(HIDDEN_SIZE, HIDDEN_SIZE),
            nn.SiLU(),
            nn.Linear(HIDDEN_SIZE, HIDDEN_SIZE // 2),
            nn.SiLU(),
            nn.Linear(HIDDEN_SIZE // 2, 3),
        )

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        normalized = (inputs - self.input_center) / self.input_scale
        if self.input_center.shape[1] == 9 or self.input_center.shape[1] == 12:
            normalized_progress = torch.clamp(
                inputs[:, 1:2] / float(max_sit_angle), 0.0, 1.0
            )
        else:
            normalized_progress = torch.clamp(inputs[:, 0:1], 0.0, 1.0)
        residual = self.network(normalized)
        eased = (
            normalized_progress
            * normalized_progress
            * (3.0 - 2.0 * normalized_progress)
        )
        if self.input_center.shape[1] == 9 or self.input_center.shape[1] == 12:
            # legacyモデルでは末尾3列がbody_motion。互換性維持のためskip接続を残す。
            motion_baseline = inputs[:, -3:]
            return motion_baseline + eased * residual * self.output_scale
        # 新モデルは「前フレーム布状態 + 身体/接触状態 -> 現フレーム布変位」を直接学習する。
        # 身体変位をそのまま足し込まないため、太もも周辺の裾が身体に単純追従して
        # 上方へめくれる挙動を教師データ側で否定できる。
        return eased * residual * self.output_scale


device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
train_steps = int(
    TRAIN_STEPS_OVERRIDE
    or (3000 if device.type == "cuda" else 1800)
)
batch_size = int(
    BATCH_SIZE_OVERRIDE
    or (8192 if device.type == "cuda" else 4096)
)
batch_size = max(32, min(batch_size, len(train_inputs_np)))
model = SkirtDeformationDNN(input_center, input_scale, output_scale).to(device)
train_inputs = torch.from_numpy(train_inputs_np)
train_targets = torch.from_numpy(train_targets_np)
validation_inputs = torch.from_numpy(validation_inputs_np)
validation_targets = torch.from_numpy(validation_targets_np)
all_inputs_by_frame = torch.from_numpy(all_inputs.reshape(frame_count, num_points, INPUT_FEATURES))
base_vertices_device = torch.from_numpy(base_skirt_pc.astype(np.float32)).to(device)
base_height = max(float(np.ptp(base_skirt_pc[:, 1])), 1.0e-6)
hem_vertex_indices_np = np.flatnonzero(base_skirt_pc[:, 1] <= np.quantile(base_skirt_pc[:, 1], 0.25)).astype(np.int64)
hem_vertex_indices = torch.from_numpy(hem_vertex_indices_np).to(device)
edge_indices_np = edges_from_faces(base_skirt_faces).astype(np.int64)
edge_indices = torch.from_numpy(edge_indices_np).to(device)
base_edge_lengths = torch.empty(0, device=device)
if len(edge_indices_np) > 0:
    base_edge_lengths = torch.linalg.norm(
        base_vertices_device[edge_indices[:, 0]] - base_vertices_device[edge_indices[:, 1]],
        dim=1,
    ).clamp_min(float(EPSILON))


def geometry_regularization_loss(prediction_frames: torch.Tensor) -> torch.Tensor:
    predicted_vertices = base_vertices_device[None, :, :] + prediction_frames
    losses = []

    if len(hem_vertex_indices_np) > 0 and HEM_UPWARD_LOSS_WEIGHT > 0:
        hem_upward = predicted_vertices[:, hem_vertex_indices, 1] - base_vertices_device[hem_vertex_indices, 1]
        hem_limit = HEM_UPWARD_SOFT_LIMIT_RATIO * base_height
        losses.append(HEM_UPWARD_LOSS_WEIGHT * torch.mean(torch.relu(hem_upward - hem_limit) ** 2))

    if len(edge_indices_np) > 0 and EDGE_STRETCH_LOSS_WEIGHT > 0:
        edge_lengths = torch.linalg.norm(
            predicted_vertices[:, edge_indices[:, 0]] - predicted_vertices[:, edge_indices[:, 1]],
            dim=2,
        )
        edge_ratios = edge_lengths / base_edge_lengths[None, :]
        losses.append(EDGE_STRETCH_LOSS_WEIGHT * torch.mean(torch.relu(edge_ratios - EDGE_STRETCH_SOFT_LIMIT_RATIO) ** 2))

    if not losses:
        return torch.zeros((), device=device)
    return sum(losses)


def predict_frame_batch(frame_indices: torch.Tensor) -> torch.Tensor:
    frame_inputs = all_inputs_by_frame[frame_indices.cpu().numpy()].reshape(-1, INPUT_FEATURES).to(device)
    return model(frame_inputs).reshape(len(frame_indices), num_points, 3)

optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LEARNING_RATE,
    weight_decay=WEIGHT_DECAY,
)

best_selection_score = float("inf")
best_validation_rmse = float("inf")
best_state = None
for step in range(1, train_steps + 1):
    model.train()
    indices = torch.randint(len(train_inputs), (batch_size,))
    batch_inputs = train_inputs[indices].to(device)
    batch_targets = train_targets[indices].to(device)
    optimizer.zero_grad(set_to_none=True)
    prediction = model(batch_inputs)
    loss = (
        0.8 * F.smooth_l1_loss(prediction, batch_targets)
        + 0.2 * F.mse_loss(prediction, batch_targets)
    )
    if GEOMETRY_REGULARIZATION_FRAME_BATCH > 0:
        frame_batch_size = min(GEOMETRY_REGULARIZATION_FRAME_BATCH, frame_count)
        regularization_frames = torch.randint(frame_count, (frame_batch_size,), device=device)
        loss = loss + geometry_regularization_loss(predict_frame_batch(regularization_frames))
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    optimizer.step()

    if step == 1 or step == train_steps or step % PRINT_INTERVAL == 0:
        model.eval()
        with torch.inference_mode():
            validation_prediction = model(validation_inputs.to(device))
            validation_error = (
                validation_prediction
                - validation_targets.to(device)
            )
            rmse = float(torch.sqrt(torch.mean(validation_error ** 2)).item())
            evaluation_frames = torch.arange(frame_count, device=device)
            geometry_eval = float(geometry_regularization_loss(predict_frame_batch(evaluation_frames)).item())
            selection_score = rmse + GEOMETRY_SELECTION_LOSS_WEIGHT * geometry_eval
        if selection_score < best_selection_score:
            best_selection_score = selection_score
            best_validation_rmse = rmse
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
        print(
            f"step {step:5d}/{train_steps}: "
            f"loss={float(loss.item()):.8e}, val_RMSE={rmse:.8e}, "
            f"geometry={geometry_eval:.8e}"
        )

if best_state is None:
    raise RuntimeError("学習済み重みを取得できませんでした。")
model.load_state_dict(best_state)
model.eval()

with torch.inference_mode():
    trained_prediction = predict_frame_batch(torch.arange(frame_count, device=device)).detach().cpu().numpy()
trained_vertices = (base_skirt_pc[None, :, :] + trained_prediction).astype(np.float32)
training_geometry_diagnostics = validate_animation_geometry(
    trained_vertices,
    base_skirt_faces,
    base_skirt_pc,
    teacher_contact_features if teacher_feature_tensor is not None else None,
)
print(f"学習済みモデルの幾何診断: {training_geometry_diagnostics}")

checkpoint_path = os.path.join(
    OUTPUT_DIR,
    "skirt_deformation_dnn_checkpoint.pth",
)
torchscript_path = os.path.join(
    OUTPUT_DIR,
    "skirt_deformation_dnn_scripted.pt",
)
metadata_path = os.path.join(OUTPUT_DIR, "skirt_deformation_dnn_metadata.json")
torch.save(
    {
        "format_version": 3 if teacher_feature_tensor is not None else 2,
        "model_class": "SkirtDeformationDNN",
        "feature_version": FEATURE_VERSION if teacher_feature_tensor is not None else "legacy_body_motion_v2",
        "training_data_version": 1,
        "input_feature_count": INPUT_FEATURES,
        "feature_schema": feature_schema(INPUT_FEATURES) if teacher_feature_tensor is not None else None,
        "model_state_dict": {
            name: value.cpu()
            for name, value in model.state_dict().items()
        },
        "vertex_count": num_points,
        "face_count": num_faces,
        "target_source": target_source,
        "teacher_dataset_path": TEACHER_DATASET_PATH if teacher_feature_tensor is not None else None,
        "training_geometry_diagnostics": training_geometry_diagnostics,
    },
    checkpoint_path,
)
model_cpu = model.to("cpu").eval()
example_input = torch.zeros(
    (8, INPUT_FEATURES),
    dtype=torch.float32,
)
traced_model = torch.jit.trace(model_cpu, example_input)
traced_model.save(torchscript_path)
model = model_cpu.to(device).eval()

with open(metadata_path, "w", encoding="utf-8") as file:
    json.dump(
        {
            "format_version": 3 if teacher_feature_tensor is not None else 2,
            "feature_version": FEATURE_VERSION if teacher_feature_tensor is not None else "legacy_body_motion_v2",
            "training_data_version": 1,
            "input_feature_count": INPUT_FEATURES,
            "feature_schema": feature_schema(INPUT_FEATURES) if teacher_feature_tensor is not None else None,
            "body_feature_schema": (
                "cloth_teacher_contact_temporal"
                if teacher_feature_tensor is not None
                else (
                    "body_motion"
                    if INPUT_FEATURES == 9
                    else "body_position_and_body_motion"
                )
            ),
            "vertex_count": num_points,
            "face_count": num_faces,
            "training_pose_count": frame_count,
            "target_source": target_source,
            "teacher_dataset_path": TEACHER_DATASET_PATH if teacher_feature_tensor is not None else None,
            "best_validation_rmse": best_validation_rmse,
            "best_selection_score": best_selection_score,
            "training_geometry_diagnostics": training_geometry_diagnostics,
            "checkpoint_path": checkpoint_path,
            "torchscript_path": torchscript_path,
        },
        file,
        indent=2,
        ensure_ascii=False,
    )

print("=" * 70)
print("身体特徴量付きスカートDNNの学習と保存が完了しました。")
print(f"入力特徴量数: {INPUT_FEATURES}")
body_schema = (
    "cloth_teacher_contact_temporal"
    if teacher_feature_tensor is not None
    else (
        "body_motion"
        if INPUT_FEATURES == 9
        else "body_position + body_motion"
    )
)
print(f"身体特徴量: {body_schema}")
print(f"チェックポイント: {checkpoint_path}")
print(f"TorchScript: {torchscript_path}")
print(f"メタデータ: {metadata_path}")
print("続けて skirt_animation_dnn_morph_fixed.py を実行してください。")