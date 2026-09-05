import argparse
import hashlib
import importlib
import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from typing import Iterable, Optional, Tuple

import numpy as np


# ============================================================
# 実行順
# ============================================================
# 1. create_skirt_body_context.py を通常実行し、skirt_body_context_for_dnn.pkl を作る。
# 2. 実スカート教師データを使う場合だけ、同じファイルを teacher サブコマンドで実行し、
#    skirt_teacher_dataset.pkl を作る。
# 3. train_skirt_sitting_dnn.py を実行する。teacher PKL があれば新しい布教師特徴量、
#    無ければ既存の9/12次元legacy特徴量で学習する。
# 4. skirt_animation_dnn_morph_fixed.py を実行し、NPZ/GLB/BLENDを書き出す。
# 5. 生成済みNPZだけを検査する場合は、skirt_animation_dnn_morph_fixed.py --validate-only を実行する。
#
# teacherサブコマンド例:
#   python create_skirt_body_context.py teacher \
#     --manifest /content/public/models/skirt_teacher_manifest.json \
#     --body-context /content/public/models/skirt_body_context_for_dnn.pkl \
#     --output /content/public/models/skirt_teacher_dataset.pkl
# ============================================================


FEATURE_VERSION = "skirt_cloth_teacher_v1"
TRAINING_DATA_VERSION = 1
STAGE_NAMES = ("standing", "descending", "contact", "settling", "seated")
CONTACT_DISTANCE_RATIO = 0.025
K_NEIGHBORS = 8
EPSILON = 1.0e-8


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

DEFAULT_TEACHER_MANIFEST_PATH = "/content/public/models/skirt_teacher_manifest.json"
DEFAULT_TEACHER_OUTPUT_PATH = "/content/public/models/skirt_teacher_dataset.pkl"


def load_pickle(path: str) -> dict:
    with open(path, "rb") as file:
        value = pickle.load(file)
    if not isinstance(value, dict):
        raise TypeError(f"PKLの内容がdictではありません: {path}")
    return value


def save_pickle(path: str, value: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as file:
        pickle.dump(value, file, protocol=4)


def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise TypeError(f"JSONの内容がdictではありません: {path}")
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


def interpolate_sequence(values: np.ndarray, progress: float) -> np.ndarray:
    index = float(np.clip(progress, 0.0, 1.0)) * (len(values) - 1)
    lower = int(np.floor(index))
    upper = min(lower + 1, len(values) - 1)
    weight = index - lower
    return (1.0 - weight) * values[lower] + weight * values[upper]


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


def allowed_license_name(value: str) -> bool:
    normalized = value.strip().lower()
    allowed_tokens: Iterable[str] = ("cc0", "cc-by", "cc-by-sa", "public domain", "custom-permission")
    return any(token in normalized for token in allowed_tokens)


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
import site
import sys

for path in [site.getusersitepackages(), f"/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages"]:
    if path and os.path.isdir(path) and path not in sys.path:
        sys.path.insert(0, path)

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

def find_pose_bone(patterns):
    if armature_object is None or not getattr(armature_object, "pose", None):
        return None
    lowered = [(bone.name.lower(), bone) for bone in armature_object.pose.bones]
    for pattern in patterns:
        for name, bone in lowered:
            if pattern in name:
                return bone
    return None


pose_feature_bones = {
    "hip": find_pose_bone(["hips", "pelvis", "j_bip_c_hips"]),
    "pelvis": find_pose_bone(["pelvis", "hips", "j_bip_c_hips"]),
    "left_thigh": find_pose_bone(["leftupleg", "left thigh", "j_bip_l_upperleg", "l_upperleg"]),
    "right_thigh": find_pose_bone(["rightupleg", "right thigh", "j_bip_r_upperleg", "r_upperleg"]),
    "left_knee": find_pose_bone(["leftleg", "left knee", "j_bip_l_lowerleg", "l_lowerleg"]),
    "right_knee": find_pose_bone(["rightleg", "right knee", "j_bip_r_lowerleg", "r_lowerleg"]),
}


def sample_pose_features():
    features = {}
    for key, bone in pose_feature_bones.items():
        if bone is None or armature_object is None:
            features[key] = None
            continue
        matrix = armature_object.matrix_world @ bone.matrix
        location = matrix.to_translation()
        rotation = matrix.to_quaternion()
        features[key] = {
            "location": [float(location.x), float(location.y), float(location.z)],
            "rotation_quaternion": [float(rotation.w), float(rotation.x), float(rotation.y), float(rotation.z)],
        }
    return features


skinned_vertices = []
body_pose_features = []
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
    body_pose_features.append(sample_pose_features())

skinned_array = np.asarray(skinned_vertices, dtype=np.float64)
base_array = np.asarray(body_base_vertices, dtype=np.float64)
# per-vertex, per-frame displacement: (frames, vertices, 3)
per_vertex_motion = skinned_array - base_array[None, :, :]
# per-frame mean displacement across vertices: (frames, 3)
body_motion_preview = np.mean(per_vertex_motion, axis=1)
motion_norms = np.linalg.norm(body_motion_preview, axis=1)
per_vertex_norms_max = np.linalg.norm(per_vertex_motion, axis=2).max(axis=1)
# 切り捨て後もsource_frame表示が元のサンプリング刻みと対応するよう、
# 切り捨て前のframe_countを別名で保持しておく。
original_frame_count = frame_count

# body_motionが山型になり途中から戻ると、学習側はprogress(=フレームindex/
# frame_count)と実際の座り込み量が単調対応すると仮定しているため対応が
# 崩れ、推論時に座りすぎた後に立ち上がる方向へ戻るなど異常な結果になる。
# ピーク(最大変位)以降の減少区間は切り捨てて単調な区間だけを採用する。
peak_index = int(np.argmax(motion_norms))
if peak_index < frame_count - 1:
    print(
        f"[diag] body_motion norm がidx={peak_index:03d}でピークに達した後"
        "減少しています。以降のフレームを切り捨てます "
        f"(採用フレーム数: {peak_index + 1}/{frame_count})。"
    )
    skinned_vertices = skinned_vertices[: peak_index + 1]
    body_pose_features = body_pose_features[: peak_index + 1]
    skinned_array = skinned_array[: peak_index + 1]
    per_vertex_motion = per_vertex_motion[: peak_index + 1]
    body_motion_preview = body_motion_preview[: peak_index + 1]
    motion_norms = motion_norms[: peak_index + 1]
    per_vertex_norms_max = per_vertex_norms_max[: peak_index + 1]
    frame_count = peak_index + 1
if frame_count < 2:
    raise RuntimeError(
        "body_motionが最初のフレームでピークになり単調な区間がありません。"
        "アニメーションまたはprogress_limitを見直してください。"
    )

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
    # progress/source_frameは生成時と同じ分母(original_frame_count)で
    # 計算しないと、切り捨て後の表示上のsource_frameが実際に評価した
    # フレームとズレてしまう。
    sample_progress = sample_index / float(original_frame_count - 1)
    sample_body_progress = max(0.0, min(1.0, sample_progress)) * progress_limit
    sample_source_frame = animation_start + (
        animation_end - animation_start
    ) * sample_body_progress
    print(
        f"[diag]   idx={sample_index:03d} progress={sample_progress * 100:5.1f}% "
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
skirt_base_array = np.asarray(skirt_base_vertices, dtype=np.float64)
distances_squared = np.sum(
    (skirt_base_array[:, None, :] - base_array[None, :, :]) ** 2,
    axis=2,
)
neighbor_count = min(8, base_array.shape[0])
neighbor_indices = np.argpartition(
    distances_squared, neighbor_count - 1, axis=1
)[:, :neighbor_count]
neighbor_distances_squared = np.take_along_axis(
    distances_squared, neighbor_indices, axis=1
)
neighbor_weights = 1.0 / (neighbor_distances_squared + 1.0e-6)
neighbor_weights /= np.sum(neighbor_weights, axis=1, keepdims=True)
# (frames, skirt_vertices, neighbor_count, 3): 近傍Body/SKIN頂点ごとの変位
neighbor_motion = per_vertex_motion[:, neighbor_indices, :]
# (frames, skirt_vertices, 3): 逆距離二乗重み付き平均による滑らかな変位場
skirt_vertex_body_motion = np.sum(
    neighbor_motion * neighbor_weights[None, :, :, None],
    axis=2,
)
nearest_body_indices = neighbor_indices[:, 0]
print(
    "[diag] skirt_vertex_body_motion: shape="
    f"{skirt_vertex_body_motion.shape}, neighbor_count={neighbor_count}, "
    f"unique nearest body vertices={len(set(nearest_body_indices.tolist()))}"
)

os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "body_base_vertices": body_base_vertices,
            "body_vertex_indices": body_vertex_indices,
            "skinned_vertices": skinned_vertices,
            # 各フレームに対応する身体姿勢。DNN教師データ側のprogressや接触状態と
            # 紐づけて、hip/pelvis/thigh/knee回転を特徴量へ追加できるよう保存する。
            "body_pose_features": body_pose_features,
            # 保存は従来互換のフレームごとの平均変位 (frames, 3)
            # 注意: 空間的な変化が失われるため、学習時は
            # skirt_vertex_body_motionが優先して使われる。
            "body_motion": body_motion_preview.tolist(),
            # 追加: フレーム×頂点の生の変位データ (frames, vertices, 3)
            "body_motion_per_vertex": per_vertex_motion.tolist(),
            # 追加: スカート頂点ごとに近傍Body/SKIN頂点を逆距離二乗重み付き
            # 平均した変位 (frames, skirt_vertices, 3)。単純な最近傍法と違い
            # 空間的に滑らかで、スカートの空間的な変形を学習可能にする。
            "skirt_vertex_body_motion": skirt_vertex_body_motion.tolist(),
            "skirt_vertex_nearest_body_index": nearest_body_indices.tolist(),
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


def blender_python_executable(blender_command):
    result = subprocess.run(
        [
            blender_command,
            "--background",
            "--python-exit-code",
            "1",
            "--python-expr",
            "import sys; print('PYTHON_EXECUTABLE=' + sys.executable)",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "BlenderのPython実行パスを取得できませんでした。\n"
            f"--- Blender output ---\n{result.stdout}"
        )
    for line in result.stdout.splitlines():
        if line.startswith("PYTHON_EXECUTABLE="):
            executable = line.split("=", 1)[1].strip()
            if executable:
                return executable
    raise RuntimeError(
        "BlenderのPython実行パスを出力から特定できませんでした。\n"
        f"--- Blender output ---\n{result.stdout}"
    )


def blender_python_search_paths(blender_python):
    result = subprocess.run(
        [
            blender_python,
            "-c",
            (
                "import os, site, sys; "
                "paths=[site.getusersitepackages(), "
                "f'/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages']; "
                "print(os.pathsep.join(p for p in paths if p))"
            ),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        return []
    return [path for path in result.stdout.strip().split(os.pathsep) if path]


def blender_environment(blender_command):
    env = os.environ.copy()
    search_paths = blender_python_search_paths(blender_python_executable(blender_command))
    if search_paths:
        current_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = os.pathsep.join(search_paths + ([current_pythonpath] if current_pythonpath else []))
    return env


def run_from_colab(arguments):
    blender_command = shutil.which("blender")
    if blender_command is None:
        raise RuntimeError(
            "Blenderが見つかりません。先にColabで"
            " !apt-get update -qq && !apt-get install -y -qq blender"
            " を実行してください。"
        )
    env = blender_environment(blender_command)
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
            env=env,
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

if __name__ == "__main__":
    main()
