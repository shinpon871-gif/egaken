import json
import os
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# ============================================================
# 使い方
# ============================================================
# 1. base_skirt_pc と base_skirt_faces を同じColabカーネルで作成する。
# 2. 身体特徴量を DNN_BODY_MOTION または DNN_BODY_CONTEXT に用意する。
#    DNN_BODY_MOTION: (フレーム数, 頂点数, 3)
#      base_skirt_pc と同じ座標系での、立位d026からの身体頂点差分。
#    DNN_BODY_CONTEXT: dict形式の場合は次のどちらか。
#      {"body_motion": ndarray[F, N, 3]}
#      {"body_position": ndarray[F, N, 3],
#       "body_motion": ndarray[F, N, 3]}
#    DNN_BODY_CONTEXT_FEATURES を直接渡す場合は
#      (フレーム数, 頂点数, 3 または 6) を使用できる。
#    変数を用意しない場合は、DNN_BODY_CONTEXT_PATHのPKLを読み込む。
# 3. 必要なら DNN_INPUT_FEATURES を 9 または 12 に設定する。
# 4. 次を実行する。
#      %run -i /content/train_skirt_sitting_dnn.py
# 5. 実行後、学習済みモデルが model に入り、
#    skirt_animation_dnn_morph_fixed.py から利用できる。
#
# 9次元:  [pose(3), point(3), body_motion(3)]
# 12次元: [pose(3), point(3), body_position(3), body_motion(3)]
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
OUTPUT_DIR = str(
    globals().get("DNN_OUTPUT_DIR", "/content/public/models")
)
BODY_CONTEXT_PATH = str(
    globals().get(
        "DNN_BODY_CONTEXT_PATH",
        os.path.join(OUTPUT_DIR, "skirt_body_context_for_dnn.pkl"),
    )
)
os.makedirs(OUTPUT_DIR, exist_ok=True)

if INPUT_FEATURES not in (9, 12):
    raise ValueError(
        "DNN_INPUT_FEATURES は9または12にしてください。"
    )

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


def convert_body_motion_to_garment_space(
    body_motion: np.ndarray,
    body_base: np.ndarray,
) -> np.ndarray:
    body_motion = np.asarray(body_motion, dtype=np.float64)
    body_base = np.asarray(body_base, dtype=np.float64)
    body_extent = np.ptp(body_base, axis=0)
    garment_extent = np.ptp(base_skirt_pc.astype(np.float64), axis=0)
    scale = garment_extent / np.maximum(body_extent, 1.0e-8)
    converted = body_motion * scale
    return converted.astype(np.float32)


def body_motion_from_context(context: dict) -> np.ndarray:
    d026 = np.asarray(context["d026_vertices"], dtype=np.float64)
    skinned = np.asarray(context["skinned_vertices"], dtype=np.float64)
    if d026.ndim != 2 or d026.shape[1] != 3:
        raise ValueError("身体PKLのd026_verticesの形状が不正です。")
    if skinned.ndim != 3 or skinned.shape[1:] != d026.shape:
        raise ValueError("身体PKLのskinned_verticesの形状が不正です。")
    body_motion = np.mean(skinned, axis=1) - np.mean(d026, axis=0)
    body_motion = convert_body_motion_to_garment_space(
        body_motion,
        d026,
    )
    return broadcast_body_motion(body_motion)


def get_body_features() -> np.ndarray:
    direct = globals().get("DNN_BODY_CONTEXT_FEATURES", None)
    if direct is not None:
        features = np.asarray(direct, dtype=np.float32)
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
        motion = np.asarray(context["body_motion"], dtype=np.float32)
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
        if os.path.isfile(BODY_CONTEXT_PATH):
            import pickle

            with open(BODY_CONTEXT_PATH, "rb") as file:
                context = pickle.load(file)
            if not isinstance(context, dict):
                raise TypeError("身体特徴量PKLの内容がdictではありません。")
            if "body_motion" in context:
                motion = np.asarray(
                    context["body_motion"],
                    dtype=np.float32,
                )
                if "d026_vertices" in context:
                    motion = convert_body_motion_to_garment_space(
                        motion,
                        context["d026_vertices"],
                    )
            elif {
                "d026_vertices",
                "skinned_vertices",
            }.issubset(context):
                motion = body_motion_from_context(context)
            else:
                raise KeyError(
                    "身体特徴量PKLにbody_motionまたは"
                    "d026_vertices/skinned_verticesがありません。"
                )
            if INPUT_FEATURES == 9:
                print(
                    "身体特徴量の入力元: "
                    f"{BODY_CONTEXT_PATH}"
                )
                return motion
            position = base_skirt_pc[None, :, :] + motion
            print(
                "身体特徴量の入力元: "
                f"{BODY_CONTEXT_PATH}"
            )
            return np.concatenate([position, motion], axis=2)
        raise RuntimeError(
            "身体特徴量がありません。\n"
            "DNN_BODY_MOTION、DNN_BODY_CONTEXT、"
            "DNN_BODY_CONTEXT_FEATURESのいずれかを設定するか、\n"
            f"次のPKLを先に生成してください: {BODY_CONTEXT_PATH}\n"
            "Colabではcreate_skirt_body_context.pyを実行してください。"
        )
    motion = broadcast_body_motion(motion)
    motion = broadcast_body_motion(motion)
    if INPUT_FEATURES == 9:
        return motion
    position = base_skirt_pc[None, :, :] + motion
    return np.concatenate([position, motion], axis=2)


body_features = get_body_features()
DNN_BODY_CONTEXT_FEATURES = body_features.copy()
DNN_BODY_MOTION = (
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


if provided_training_vertices is not None:
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

# 身体特徴量を教師フレーム数へ線形補間する。
source_progress = np.linspace(0.0, 1.0, body_features.shape[0])
target_progress = np.asarray(pose_angles / max_sit_angle, dtype=np.float32)
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

teacher_displacements = (
    teacher_vertices
    - base_skirt_pc[None, :, :]
).astype(np.float32)
teacher_displacements[0] = 0.0

pose_rows_all = []
input_rows_all = []
target_rows_all = []
frame_indices_all = []
for frame_index, angle in enumerate(pose_angles):
    pose = np.repeat(
        np.asarray([[0.0, float(angle), 0.0]], dtype=np.float32),
        num_points,
        axis=0,
    )
    rows = np.concatenate(
        [pose, base_skirt_pc, resampled_body[frame_index]],
        axis=1,
    )
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
output_scale = float(
    max(
        np.max(np.linalg.norm(teacher_displacements, axis=2)),
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
        normalized_progress = torch.clamp(
            inputs[:, 1:2] / float(max_sit_angle), 0.0, 1.0
        )
        output = self.network(normalized)
        eased = (
            normalized_progress
            * normalized_progress
            * (3.0 - 2.0 * normalized_progress)
        )
        return eased * output * self.output_scale


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
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LEARNING_RATE,
    weight_decay=WEIGHT_DECAY,
)

best_rmse = float("inf")
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
        if rmse < best_rmse:
            best_rmse = rmse
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
        print(
            f"step {step:5d}/{train_steps}: "
            f"loss={float(loss.item()):.8e}, val_RMSE={rmse:.8e}"
        )

if best_state is None:
    raise RuntimeError("学習済み重みを取得できませんでした。")
model.load_state_dict(best_state)
model.eval()

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
        "format_version": 2,
        "model_class": "SkirtDeformationDNN",
        "input_feature_count": INPUT_FEATURES,
        "model_state_dict": {
            name: value.cpu()
            for name, value in model.state_dict().items()
        },
        "vertex_count": num_points,
        "face_count": num_faces,
        "target_source": target_source,
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
            "format_version": 2,
            "input_feature_count": INPUT_FEATURES,
            "body_feature_schema": (
                "body_motion"
                if INPUT_FEATURES == 9
                else "body_position_and_body_motion"
            ),
            "vertex_count": num_points,
            "face_count": num_faces,
            "training_pose_count": frame_count,
            "target_source": target_source,
            "best_validation_rmse": best_rmse,
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
    "body_motion"
    if INPUT_FEATURES == 9
    else "body_position + body_motion"
)
print(f"身体特徴量: {body_schema}")
print(f"チェックポイント: {checkpoint_path}")
print(f"TorchScript: {torchscript_path}")
print(f"メタデータ: {metadata_path}")
print("続けて skirt_animation_dnn_morph_fixed.py を実行してください。")
