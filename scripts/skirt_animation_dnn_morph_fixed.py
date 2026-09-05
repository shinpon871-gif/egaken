import json
import os
import pickle
import subprocess
import sys
import tempfile
import urllib.request
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

# Blender付属Pythonのsite-packagesにColab環境のdist-packagesを参照させる.pthファイルを作成
blender_site_packages = "/usr/bin/3.0/python/lib/python3.10/site-packages"
colab_site_packages = f"/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages"

if os.path.exists(blender_site_packages) and os.path.exists(colab_site_packages):
    pth_file_path = os.path.join(blender_site_packages, "colab_packages.pth")
    with open(pth_file_path, "w", encoding="utf-8") as f:
        f.write(colab_site_packages + "\n")

# StandToSit_model.fbx の Bottoms 抽出結果を base_skirt_pc/base_skirt_faces に用意して実行する。
# model は train_skirt_sitting_dnn.py で学習した9次元または12次元モデル。
num_animation_frames = int(globals().get("DNN_ANIMATION_FRAMES", 120))
temporal_smoothing_passes = int(globals().get("DNN_TEMPORAL_SMOOTHING_PASSES", 2))
temporal_smoothing_alpha = float(globals().get("DNN_TEMPORAL_SMOOTHING_ALPHA", 0.35))
max_sit_angle = float(globals().get("max_sit_angle", np.deg2rad(75.0)))
output_dir = str(globals().get("DNN_OUTPUT_DIR", "/content/public/models"))
body_context_path = str(globals().get(
    "DNN_BODY_CONTEXT_PATH",
    os.path.join(output_dir, "skirt_body_context_for_dnn.pkl"),
))
teacher_dataset_path = str(globals().get(
    "DNN_TEACHER_DATASET_PATH",
    os.path.join(output_dir, "skirt_teacher_dataset.pkl"),
))
context_path = teacher_dataset_path if os.path.isfile(teacher_dataset_path) else body_context_path
glb_path = str(globals().get(
    "DNN_GLB_OUTPUT_PATH",
    os.path.join(output_dir, "skirt_mesh_sitting_animation.glb"),
))
blend_path = str(globals().get(
    "DNN_BLEND_OUTPUT_PATH",
    os.path.join(output_dir, "skirt_mesh_sitting_animation.blend"),
))
npz_path = os.path.join(output_dir, "skirt_animation_vertices.npz")
blender_data_path = os.path.join(output_dir, "skirt_animation_vertices_for_blender.pkl")

if "--validate-only" in sys.argv or bool(globals().get("DNN_VALIDATE_ONLY", False)):
    validate_npz_path = str(globals().get("DNN_SKIRT_ANIMATION_NPZ", npz_path))
    if "--npz" in sys.argv:
        npz_index = sys.argv.index("--npz")
        if npz_index + 1 >= len(sys.argv):
            raise RuntimeError("--npz の後にNPZパスを指定してください。")
        validate_npz_path = sys.argv[npz_index + 1]
    data = np.load(validate_npz_path)
    if "vertices" not in data or "faces" not in data:
        raise RuntimeError("NPZにはverticesとfacesが必要です。")
    validate_vertices = np.asarray(data["vertices"], dtype=np.float32)
    validate_faces = np.asarray(data["faces"], dtype=np.int64)
    validate_progresses = np.asarray(
        data["progresses"] if "progresses" in data else np.linspace(0.0, 1.0, len(validate_vertices)),
        dtype=np.float32,
    )
    validate_context = load_pickle(context_path) if os.path.isfile(context_path) else {}
    validate_base_vertices = np.asarray(validate_context.get("skirt_base_vertices", validate_vertices[0]), dtype=np.float32)
    validate_contact_features = compute_contact_features(validate_base_vertices, validate_context, validate_progresses) if validate_context else None
    diagnostics = validate_animation_geometry(validate_vertices, validate_faces, validate_base_vertices, validate_contact_features)
    print("スカートアニメーション診断OK")
    for key, value in diagnostics.items():
        print(f"{key}: {value:.6f}" if isinstance(value, float) else f"{key}: {value}")
    raise SystemExit(0)

# Colabの%run -iはセルを再実行してもカーネルの変数(globals())が残り続ける。
# 「まだ無ければ読み込む」だと、前回の実行(あるいは別のPKLに対する実行)で
# 残った古いbase_skirt_pcを誤って使い回してしまうため、PKLが存在する限り
# 常にそちらを正として読み直す。
if os.path.isfile(context_path):
    skirt_context = load_pickle(context_path)
    if isinstance(skirt_context, dict) and {
        "skirt_base_vertices",
        "skirt_faces",
    }.issubset(skirt_context):
        base_skirt_pc = np.asarray(skirt_context["skirt_base_vertices"], dtype=np.float32)
        base_skirt_faces = np.asarray(skirt_context["skirt_faces"], dtype=np.int32)

if "model" not in globals() or not isinstance(globals()["model"], nn.Module):
    raise RuntimeError("学習済みmodelがありません。")
if "base_skirt_pc" not in globals() or "base_skirt_faces" not in globals():
    raise RuntimeError(
        "StandToSit_model.fbxのBody/Bottomsマテリアル面から、"
        "base_skirt_pcとbase_skirt_facesを先に作成してください。"
    )

base_vertices = np.asarray(globals()["base_skirt_pc"], dtype=np.float32)
faces = np.asarray(globals()["base_skirt_faces"], dtype=np.int32)
if base_vertices.ndim != 2 or base_vertices.shape[1] != 3:
    raise ValueError("base_skirt_pcは(頂点数, 3)が必要です。")
if faces.ndim != 2 or faces.shape[1] != 3:
    raise ValueError("base_skirt_facesは三角形の(面数, 3)が必要です。")
if np.min(faces) < 0 or np.max(faces) >= len(base_vertices):
    raise ValueError("base_skirt_facesに範囲外の頂点があります。")

model = globals()["model"].eval()
first_parameter = next(model.parameters(), None)
device = first_parameter.device if first_parameter is not None else torch.device("cpu")
dtype = first_parameter.dtype if first_parameter is not None else torch.float32
input_features = next(
    (module.in_features for module in model.modules() if isinstance(module, nn.Linear)),
    None,
)
if input_features not in (9, 12):
    require_feature_schema(feature_schema(input_features), input_features)
    print(f"新スカート布DNN特徴量を使用します: {FEATURE_VERSION}, input_features={input_features}")

context = load_pickle(context_path)
# base_skirt_pc(Colabカーネルの既存変数、または上でこのpklから読み込んだもの)と
# body_motion(このpklのskirt_vertex_body_motion/body_motion)が異なる縮尺・
# 別ソースのメッシュだと、スケールを推測して/100等の補正をかけるその場しのぎの
# 変換は「たまたま近い値」を作るだけで根本解決にならず、実際には数十万倍もの
# 出力破綻を招く(スキップ接続がbody_motionをそのまま出力へ加算するため)。
# ここではbase_vertices自身とこのpkl由来のskirt_base_verticesの対角長を比較し、
# 縮尺が一致しない場合は推測変換をせずに明確なエラーで停止する。
context_skirt_extent = float(np.linalg.norm(
    np.asarray(context["skirt_base_vertices"], dtype=np.float64).max(axis=0)
    - np.asarray(context["skirt_base_vertices"], dtype=np.float64).min(axis=0)
))
base_vertices_extent = float(np.linalg.norm(
    base_vertices.max(axis=0).astype(np.float64) - base_vertices.min(axis=0).astype(np.float64)
))
if abs(base_vertices_extent - context_skirt_extent) > 0.2 * max(context_skirt_extent, 1.0e-8):
    validate_context_scale(base_vertices, context)
# "body_motion"(全SKIN頂点の平均変位)を全スカート頂点にそのまま
# broadcastすると空間的な変形が失われ、スカートが剛体的に平行移動する
# だけになる。スカート頂点ごとに最近傍Body/SKIN頂点を対応付けた
# "skirt_vertex_body_motion"(空間的に変化する特徴量)を優先して使う。
if "skirt_vertex_body_motion" in context:
    body_motion = np.asarray(context["skirt_vertex_body_motion"], dtype=np.float32)
    if body_motion.ndim != 3 or body_motion.shape[1:] != (len(base_vertices), 3):
        print(
            "[warn] skirt_vertex_body_motionの形状が不正なため、"
            "従来の平均body_motionにフォールバックします。"
            f" 形状: {body_motion.shape}, 期待値: (フレーム数, {len(base_vertices)}, 3)"
        )
        body_motion = np.asarray(context["body_motion"], dtype=np.float32)
else:
    body_motion = np.asarray(context["body_motion"], dtype=np.float32)
# optional per-vertex motion for diagnostics (frames, vertices, 3)
body_motion_per_vertex = None
if "body_motion_per_vertex" in context:
    body_motion_per_vertex = np.asarray(context["body_motion_per_vertex"], dtype=np.float32)
if body_motion.ndim == 2 and body_motion.shape[1] == 3:
    body_motion = body_motion[:, None, :]
if body_motion.ndim != 3 or body_motion.shape[2] != 3:
    raise ValueError("body_motionの形状が不正です。")
body_motion = np.broadcast_to(
    body_motion,
    (body_motion.shape[0], len(base_vertices), 3),
).copy()

if input_features not in (9, 12):
    body_motion = resolve_body_motion(context, len(base_vertices))


def interpolate(values, progress):
    index = np.clip(progress, 0.0, 1.0) * (len(values) - 1)
    lower = int(np.floor(index))
    upper = min(lower + 1, len(values) - 1)
    return (1.0 - (index - lower)) * values[lower] + (index - lower) * values[upper]


def predict_vertices(progress):
    angle = float(progress * max_sit_angle)
    pose = np.repeat(np.asarray([[0.0, angle, 0.0]], dtype=np.float32), len(base_vertices), axis=0)
    motion = interpolate(body_motion, progress)
    position = base_vertices + motion
    if input_features == 9:
        inputs = np.concatenate([pose, base_vertices, motion], axis=1)
    else:
        inputs = np.concatenate([pose, base_vertices, position, motion], axis=1)
    with torch.inference_mode():
        output = model(torch.from_numpy(inputs).to(device=device, dtype=dtype))
    if isinstance(output, (tuple, list)):
        output = output[0]
    prediction = output.detach().cpu().numpy().astype(np.float32)
    if prediction.shape != base_vertices.shape:
        raise RuntimeError(f"DNN出力形状が不正です: {prediction.shape}")
    return base_vertices + prediction


def predict_vertices_sequence(progress_values):
    progress_values = np.asarray(progress_values, dtype=np.float32).reshape(-1)
    if input_features in (9, 12):
        return np.asarray([predict_vertices(float(progress)) for progress in progress_values], dtype=np.float32)

    body_motion_resampled = resample_sequence(body_motion, progress_values)
    contact_features = compute_contact_features(base_vertices, context, progress_values)
    previous_displacement = np.zeros((1, len(base_vertices), 3), dtype=np.float32)
    previous_velocity = np.zeros_like(previous_displacement)
    predicted_vertices = []
    last_progress = float(progress_values[0])
    for frame_index, progress in enumerate(progress_values):
        features = build_feature_tensor(
            base_vertices,
            body_motion_resampled[frame_index:frame_index + 1],
            np.asarray([progress], dtype=np.float32),
            contact_features[frame_index:frame_index + 1],
            previous_displacement,
            previous_velocity,
        )
        if features.shape[2] != input_features:
            raise RuntimeError(
                "推論時特徴量の次元が学習済みモデルと一致しません。"
                f" generated={features.shape[2]}, model={input_features}"
            )
        with torch.inference_mode():
            output = model(torch.from_numpy(features[0]).to(device=device, dtype=dtype))
        if isinstance(output, (tuple, list)):
            output = output[0]
        displacement = output.detach().cpu().numpy().astype(np.float32)
        if displacement.shape != base_vertices.shape:
            raise RuntimeError(f"DNN出力形状が不正です: {displacement.shape}")
        current_vertices = base_vertices + displacement
        predicted_vertices.append(current_vertices)
        delta_progress = max(float(progress) - last_progress, 1.0 / max(len(progress_values) - 1, 1))
        previous_velocity = ((displacement[None, :, :] - previous_displacement) / delta_progress).astype(np.float32)
        previous_displacement = displacement[None, :, :]
        last_progress = float(progress)
    return np.asarray(predicted_vertices, dtype=np.float32)


def smooth_vertices_temporally(values, passes, alpha):
    smoothed = np.asarray(values, dtype=np.float32).copy()
    if passes <= 0 or alpha <= 0 or smoothed.shape[0] < 3:
        return smoothed

    blend = float(np.clip(alpha, 0.0, 1.0))
    first_frame = smoothed[0].copy()
    last_frame = smoothed[-1].copy()
    for _ in range(passes):
        previous = smoothed.copy()
        smoothed[1:-1] = (
            (1.0 - blend) * previous[1:-1]
            + blend * 0.5 * (previous[:-2] + previous[2:])
        )
        smoothed[0] = first_frame
        smoothed[-1] = last_frame
    return smoothed


progresses = np.linspace(0.0, 1.0, num_animation_frames, dtype=np.float32)
vertices = predict_vertices_sequence(progresses)
vertices[0] = base_vertices
vertices = smooth_vertices_temporally(vertices, temporal_smoothing_passes, temporal_smoothing_alpha)
vertices[0] = base_vertices
if not np.isfinite(vertices).all():
    raise RuntimeError("DNN出力にNaNまたはInfがあります。")

# 異常に大きい変位はThree.jsのバウンディングボックスをモーフ込みで
# 極端に膨張させ、ビューアでモデルが見えなくなる原因になる。
base_extent = float(np.linalg.norm(base_vertices.max(axis=0) - base_vertices.min(axis=0)))
displacement_norms = np.linalg.norm(vertices - base_vertices[None, :, :], axis=2)
max_displacement = float(displacement_norms.max())
max_displacement_ratio = max_displacement / max(base_extent, 1.0e-8)
if max_displacement_ratio > 5.0:
    worst_frame = int(np.argmax(displacement_norms.max(axis=1)))

    # modelは学習時の入力分布をinput_center/input_scaleバッファに保持している。
    # 今回の入力がその分布から極端に外れているなら、body_motion側ではなく
    # 「学習し直していない古いmodelを使っている」ことが原因である可能性が高い。
    stale_model_hint = ""
    input_center = getattr(model, "input_center", None)
    input_scale = getattr(model, "input_scale", None)
    if input_center is not None and input_scale is not None:
        worst_progress = float(progresses[worst_frame])
        worst_pose = np.repeat(
            np.asarray([[0.0, worst_progress * max_sit_angle, 0.0]], dtype=np.float32),
            len(base_vertices),
            axis=0,
        )
        worst_motion = interpolate(body_motion, worst_progress)
        worst_position = base_vertices + worst_motion
        if input_features == 9:
            worst_inputs = np.concatenate([worst_pose, base_vertices, worst_motion], axis=1)
        else:
            worst_inputs = np.concatenate([worst_pose, base_vertices, worst_position, worst_motion], axis=1)
        center_np = input_center.detach().cpu().numpy().reshape(-1)
        scale_np = input_scale.detach().cpu().numpy().reshape(-1)
        max_z_score = float(np.max(np.abs((worst_inputs - center_np) / scale_np)))
        if max_z_score > 8.0:
            stale_model_hint = (
                "\nこの入力はmodelの学習時分布から大きく外れています"
                f"（最大 {max_z_score:.1f}\u03c3）。\n"
                "現在のmodelは古いbody_motionデータで学習された可能性が高いです。\n"
                "train_skirt_sitting_dnn.pyを再実行してmodelを再学習してから、"
                "このセルを再実行してください。"
            )

    raise RuntimeError(
        "DNN出力の変位が異常に大きく、GLBのバウンディングボックスが破綻します。\n"
        f"基準メッシュの対角長: {base_extent:.6f}\n"
        f"最大変位: {max_displacement:.6f} (フレーム {worst_frame})\n"
        f"変位/対角長の比: {max_displacement_ratio:.2f}倍\n"
        "モデルの学習データ・入力スケール・body_motionの変換係数を見直してください。"
        f"{stale_model_hint}"
    )

geometry_diagnostics = validate_animation_geometry(
    vertices,
    faces,
    base_vertices,
    compute_contact_features(base_vertices, context, progresses) if input_features not in (9, 12) else None,
)
print(f"スカートアニメーション診断: {geometry_diagnostics}")

os.makedirs(output_dir, exist_ok=True)
np.savez(npz_path, vertices=vertices, faces=faces, progresses=progresses)
with open(blender_data_path, "wb") as file:
    pickle.dump(
        {"vertices": vertices.tolist(), "faces": faces.tolist()},
        file,
        protocol=4,
    )

# BlenderのPython環境にnumpyをインストールするロジックを再導入
print("BlenderのPython環境にnumpyが利用可能か確認しています...")

blender_python_executable = None
blender_extra_python_paths: list[str] = []
try:
    # BlenderのPythonインタプリタの実際のパスを取得
    blender_python_executable_output = subprocess.run([
        "blender", "--background", "--python-expr", "import sys; print('PYTHON_EXECUTABLE=' + sys.executable)"
    ], capture_output=True, text=True, check=True)
    # Blenderの起動メッセージが混入するため、明示ラベル行だけを取得する
    for output_line in blender_python_executable_output.stdout.splitlines():
        if output_line.startswith("PYTHON_EXECUTABLE="):
            blender_python_executable = output_line.split("=", 1)[1].strip()
            break
    print(f"BlenderのPython実行可能パス: {blender_python_executable}")

    if not blender_python_executable or not os.path.exists(blender_python_executable):
        raise RuntimeError("BlenderのPython実行可能パスを取得できませんでした。")

    blender_site_path_result = subprocess.run([
        blender_python_executable,
        "-c",
        (
            "import os, site, sys; "
            "paths=[site.getusersitepackages(), "
            "f'/root/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages', "
            "f'/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages']; "
            "print(os.pathsep.join(p for p in paths if p and os.path.isdir(p)))"
        ),
    ], check=False, text=True, capture_output=True)
    if blender_site_path_result.returncode == 0:
        blender_extra_python_paths = [
            path for path in blender_site_path_result.stdout.strip().split(os.pathsep)
            if path
        ]

    # numpyが既にインストールされているかBlenderのPythonでチェック
    check_numpy_script = """
import os
import site
import sys

for path in [
    site.getusersitepackages(),
    f"/root/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages",
    f"/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages",
]:
    if path and os.path.isdir(path) and path not in sys.path:
        sys.path.insert(0, path)

try:
    import numpy
    print("Numpy is already installed for Blender's Python.")
    sys.exit(0)
except ImportError:
    print("Numpy not found for Blender's Python.")
    sys.exit(1)
"""
    # 一時ファイルにスクリプトを書き込み、BlenderのPythonで実行
    with tempfile.NamedTemporaryFile(mode="w", suffix="_check_numpy.py", delete=False, encoding="utf-8") as tmp_check_numpy_script_file:
        tmp_check_numpy_script_file.write(check_numpy_script)
        tmp_check_numpy_script_path = tmp_check_numpy_script_file.name

    check_numpy_result = subprocess.run([
        blender_python_executable, tmp_check_numpy_script_path
    ], check=False, text=True, capture_output=True)

    os.unlink(tmp_check_numpy_script_path) # Clean up temporary file

    print(check_numpy_result.stdout)
    if check_numpy_result.returncode == 0:
        print("BlenderのPython環境にnumpyが既にインストールされているため、スキップします。")
    else:
        print("BlenderのPython環境にnumpyをインストールします。")
        
        # pipがインストールされているか確認し、インストールされていなければget-pip.pyでインストール
        # get-pip.pyをダウンロード
        get_pip_path = os.path.join(tempfile.gettempdir(), "get-pip.py")
        if not os.path.exists(get_pip_path):
            print(f"get-pip.pyをダウンロードしています: {get_pip_path}")
            urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", get_pip_path)
            print("get-pip.pyダウンロード完了。")

        # pipをBlenderのPython環境にインストール
        print("BlenderのPython環境にpipをインストールしています...")
        pip_install_result = subprocess.run([
            blender_python_executable, get_pip_path
        ], check=False, text=True, capture_output=True)
        print("Blender Python pip install Stdout:")
        print(pip_install_result.stdout)
        print("Blender Python pip install Stderr:")
        print(pip_install_result.stderr)

        if pip_install_result.returncode != 0:
             # get-pip.pyが既にpipがインストールされているために失敗することがあるため、エラーメッセージを確認
            if "Requirement already satisfied" not in pip_install_result.stderr and \
               "Requirement already satisfied" not in pip_install_result.stdout:
                raise RuntimeError(f"BlenderのPython環境にpipをインストールできませんでした。")
        print("BlenderのPython環境にpipがインストール済み、またはインストールされました。")
        if os.path.exists(get_pip_path):
            os.unlink(get_pip_path) # Clean up get-pip.py

        # numpyをインストール
        print("BlenderのPython環境にnumpyをインストールしています...")
        install_numpy_result = subprocess.run([
            blender_python_executable, "-m", "pip", "install", "numpy"
        ], check=False, text=True, capture_output=True)
        print("Blender Python numpy install Stdout:")
        print(install_numpy_result.stdout)
        print("Blender Python numpy install Stderr:")
        print(install_numpy_result.stderr)
        if install_numpy_result.returncode != 0:
            raise RuntimeError(f"BlenderのPython環境にnumpyをインストールできませんでした。")
        print("BlenderのPython環境にnumpyがインストールされました。")

except subprocess.CalledProcessError as e:
    print(f"BlenderのPython実行可能パスの取得中にエラーが発生しました: {e.stderr}")
    raise RuntimeError("BlenderのPython環境へのnumpyインストール準備に失敗しました。")
except Exception as e:
    print(f"BlenderのPython環境へのnumpyインストール中に予期せぬエラーが発生しました: {e}")
    raise RuntimeError("BlenderのPython環境へのnumpyインストールに失敗しました。")

print("Numpyインストール処理完了。")

# Blender起動スクリプトの先頭でsys.pathにBlender/Colabのライブラリパスを追加
blender_script = r'''
import os
import site
import sys

for path in [
    site.getusersitepackages(),
    f"/root/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages",
    f"/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages",
]:
    if path and os.path.isdir(path) and path not in sys.path:
        sys.path.insert(0, path)

import pickle
import bpy

if "--" not in sys.argv:
    raise RuntimeError("引数がありません。")
args = sys.argv[sys.argv.index("--") + 1:]
if len(args) != 4:
    raise RuntimeError("Blender用PKL / GLB / BLEND / frame数が必要です。")
blender_data_path, glb_path, blend_path, frame_count_text = args
frame_count = int(frame_count_text)

with open(blender_data_path, "rb") as file:
    data = pickle.load(file)
vertices = data["vertices"]
faces = data["faces"]
if len(vertices) != frame_count or not vertices or not vertices[0] or len(vertices[0][0]) != 3:
    raise RuntimeError("頂点アニメーション形状が不正です。")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
mesh = bpy.data.meshes.new("BottomsSkirtAnimationMesh")
mesh.from_pydata(vertices[0], [], faces)
mesh.update()
obj = bpy.data.objects.new("Skirt_Animated_Bottoms", mesh)
bpy.context.collection.objects.link(obj)
obj.shape_key_add(name="Basis")
for frame_index in range(1, frame_count):
    key = obj.shape_key_add(name=f"Delta_{frame_index:03d}")
    previous_vertices = vertices[frame_index - 1]
    current_vertices = vertices[frame_index]
    for vertex_index, basis_vertex in enumerate(vertices[0]):
        key.data[vertex_index].co = tuple(
            float(basis_vertex[axis] + current_vertices[vertex_index][axis] - previous_vertices[vertex_index][axis])
            for axis in range(3)
        )

shape_keys = obj.data.shape_keys.key_blocks
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = frame_count
for key in shape_keys:
    key.value = 0.0
for timeline_index in range(frame_count):
    frame = timeline_index + 1
    for delta_index in range(1, frame_count):
        key = shape_keys[f"Delta_{delta_index:03d}"]
        key.value = 1.0 if delta_index <= timeline_index else 0.0
        key.keyframe_insert(data_path="value", frame=frame)
if obj.data.shape_keys.animation_data and obj.data.shape_keys.animation_data.action:
    for curve in obj.data.shape_keys.animation_data.action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
scene.frame_set(1)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", use_selection=True, export_animations=True, export_morph=True, export_skins=False)
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
'''

with tempfile.NamedTemporaryFile(mode="w", suffix="_create_skirt_glb.py", delete=False, encoding="utf-8") as file:
    file.write(blender_script)
    blender_script_path = file.name
blender_env = os.environ.copy()
if blender_extra_python_paths:
    current_pythonpath = blender_env.get("PYTHONPATH", "")
    blender_env["PYTHONPATH"] = os.pathsep.join(
        blender_extra_python_paths + ([current_pythonpath] if current_pythonpath else [])
    )
try:
    result = subprocess.run([
        "blender", "--background", "--python-exit-code", "1",
        "--python", blender_script_path, "--", blender_data_path, glb_path,
        blend_path, str(num_animation_frames),
    ], check=False, env=blender_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
finally:
    os.unlink(blender_script_path)
if result.returncode != 0:
    raise RuntimeError(
        "BlenderによるスカートGLB生成に失敗しました: "
        f"{result.returncode}\n--- Blender output ---\n{result.stdout}"
    )
if not os.path.isfile(glb_path) or os.path.getsize(glb_path) == 0:
    raise RuntimeError(f"GLBが生成されませんでした: {glb_path}")
print(f"スカートGLBを保存しました: {glb_path}")
print(f"頂点数: {len(base_vertices):,}, 面数: {len(faces):,}, フレーム数: {num_animation_frames}")