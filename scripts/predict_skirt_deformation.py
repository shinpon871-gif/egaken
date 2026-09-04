import json
import os
import pickle

import numpy as np
import torch
import torch.nn as nn


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
if os.path.isfile(BODY_CONTEXT_PATH):
    with open(BODY_CONTEXT_PATH, "rb") as file:
        skirt_context = pickle.load(file)
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
if os.path.isfile(BODY_CONTEXT_PATH):
    with open(BODY_CONTEXT_PATH, "rb") as file:
        scale_check_context = pickle.load(file)
    if isinstance(scale_check_context, dict) and "skirt_base_vertices" in scale_check_context:
        pkl_skirt_vertices = np.asarray(
            scale_check_context["skirt_base_vertices"], dtype=np.float64
        )
        pkl_skirt_extent = float(np.linalg.norm(
            pkl_skirt_vertices.max(axis=0) - pkl_skirt_vertices.min(axis=0)
        ))
        base_skirt_extent = float(np.linalg.norm(
            base_vertices.max(axis=0) - base_vertices.min(axis=0)
        ))
        if abs(base_skirt_extent - pkl_skirt_extent) > 0.2 * max(pkl_skirt_extent, 1.0e-8):
            raise RuntimeError(
                "base_skirt_pcの縮尺がbody_context PKLのskirt_base_verticesと"
                "一致しません。\n"
                f"base_skirt_pc対角長: {base_skirt_extent:.6f}, "
                f"PKL skirt_base_vertices対角長: {pkl_skirt_extent:.6f}\n"
                "base_skirt_pcがColabカーネルに残っている別スケール・別ソースの"
                f"メッシュの可能性があります。base_skirt_pcの変数を削除してから、"
                f"{BODY_CONTEXT_PATH} のskirt_base_verticesを使い直してください。"
            )


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
    if not os.path.isfile(BODY_CONTEXT_PATH):
        direct = globals().get("DNN_BODY_MOTION", None)
        if direct is not None:
            motion = np.asarray(direct, dtype=np.float64)
            return broadcast_body_motion(motion)
        raise FileNotFoundError(
            "身体特徴量PKLがありません: " + BODY_CONTEXT_PATH
        )
    with open(BODY_CONTEXT_PATH, "rb") as file:
        context = pickle.load(file)
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
    raise RuntimeError(
        "この予測スクリプトは9次元または12次元モデルに対応しています。"
        f"検出値: {input_features}"
    )

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

body_motion = load_body_motion()
progress = float(np.clip(test_pose[1] / max_sit_angle, 0.0, 1.0))
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

if model_input.shape != (num_points, input_features):
    raise RuntimeError(
        "モデル入力形状が不正です。"
        f"期待値: ({num_points}, {input_features}), 実際: {model_input.shape}"
    )

model.eval()
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

output_data = {
    "pose": test_pose.tolist(),
    "progress": progress,
    "input_feature_count": input_features,
    "body_feature_schema": body_schema,
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
