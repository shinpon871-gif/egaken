# scripts\train_skirt_sitting_dnn.py
"""スカートの座位遷移学習を行う DNN トレーニングスクリプト
Colab環境でBlender付属Pythonから実行することを想定している

概要
- 立位スカート形状と身体特徴量から座位への変形残差を予測する DNN を学習する

役割
- base_skirt_pc と base_skirt_faces を使って幾何入力を構築
- DNN_BODY_CONTEXT から身体特徴量を取得して入力へ結合
- 姿勢ごとの教師頂点を生成して身体追従ベースラインからの残差学習を実行
- メッシュ形状崩れを抑える幾何拘束損失を加えてモデルを最適化
- 学習済みモデルチェックポイント TorchScript およびメタデータを保存

必須データ
- base_skirt_pc 立位スカートの頂点座標配列
- base_skirt_faces 立位スカートの面インデックス配列
- skirt_body_context_for_dnn.pkl 身体特徴量PKLファイル

使い方
- 実行手順
    1 base_skirt_pc と base_skirt_faces をColabカーネル上で用意
    2 必要に応じて DNN_INPUT_FEATURES に 9 または 12 を設定
    3 %run -i /content/train_skirt_sitting_dnn.py を実行
    4 完了後 model 変数に学習済みモデルが格納され skirt_animation_dnn_morph_fixed.py で利用可能となる

入力次元の構成
- 9次元  [pose(3), point(3), body_motion(3)]
- 12次元 [pose(3), point(3), body_position(3), body_motion(3)]

モデル構造の特徴
- 入力末尾3列の body_motion にそのまま追従し DNN が学習した残差を加えるスキップ接続構造
"""

import json
import os
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


# 再現性を確保するための乱数シード値
RANDOM_SEED = int(globals().get("DNN_RANDOM_SEED", 20260903))

# DNNの入力特徴量次元数。末尾にスタイルzを連結した12または15次元。
INPUT_FEATURES = int(globals().get("DNN_INPUT_FEATURES", 12))

# 潜在スタイルベクトル [length, tightness, pleats] の次元数
STYLE_LATENT_DIMENSIONS = 3

# 学習時に許可するのはLengthだけを変えた安全教師プリセット。
ALLOWED_STYLE_PRESETS = {"base"}
LENGTH_RELEASE_BLOCKED_STATUS = "disabled_pending_cloth_bake_coverage_and_image_qa"

# スタイルzを除く従来の入力次元 9 または 12
BASE_INPUT_FEATURES = INPUT_FEATURES - STYLE_LATENT_DIMENSIONS

# 座位動作時の最大着席角度度数法
MAX_SIT_ANGLE_DEGREES = float(
    globals().get("DNN_MAX_SIT_ANGLE_DEGREES", 75.0)
)

# 教師データ生成時の姿勢サンプリング分割数
NUM_POSE_SAMPLES = int(globals().get("DNN_NUM_POSE_SAMPLES", 61))

# DNNネットワークの中間層隠れ層ユニット数
HIDDEN_SIZE = int(globals().get("DNN_HIDDEN_SIZE", 192))

# 最適化アルゴリズムの学習率
LEARNING_RATE = float(globals().get("DNN_LEARNING_RATE", 1.0e-2))

# 最適化時の重み減衰係数
WEIGHT_DECAY = float(globals().get("DNN_WEIGHT_DECAY", 1.0e-6))

# 学習進捗ログを出力するステップ間隔
PRINT_INTERVAL = int(globals().get("DNN_PRINT_INTERVAL", 100))

# 学習ステップ数の外部上書き値
TRAIN_STEPS_OVERRIDE = globals().get("DNN_TRAIN_STEPS", None)

# バッチサイズの外部上書き値
BATCH_SIZE_OVERRIDE = globals().get("DNN_BATCH_SIZE", None)

# 出力成果物の保存先ディレクトリ
OUTPUT_DIR = str(
    globals().get("DNN_OUTPUT_DIR", "/content/public/models")
)

# メッシュ対角長比較におけるスケール不一致許容比率
SCALE_TOLERANCE_RATIO = 0.2

# ゼロ除算や微小値比較に使用するイプシロン
FLOAT_EPSILON = 1.0e-8

# 検証用フレームをサンプリングするステップ間隔
VALIDATION_SAMPLE_INTERVAL = 5

# スカートメッシュとして最低限必要な頂点数
MINIMUM_VERTEX_COUNT = 4

# スカートメッシュとして最低限必要な面数
MINIMUM_FACE_COUNT = 1

# 残差スケーリング係数の安全下限値
MINIMUM_RESIDUAL_SCALE = 1.0e-6

# GPU環境における既定の学習ステップ数
DEFAULT_TRAIN_STEPS_CUDA = 3000

# CPU環境における既定の学習ステップ数
DEFAULT_TRAIN_STEPS_CPU = 6000

# GPU環境における既定のバッチサイズ
DEFAULT_BATCH_SIZE_CUDA = 8192

# CPU環境における既定のバッチサイズ
DEFAULT_BATCH_SIZE_CPU = 4096

# バッチサイズの許容下限値
MIN_BATCH_SIZE = 32

# 合成教師データ生成における着席時沈み込み比率
TEACHER_SIT_DROP_RATIO = 0.16

# 合成教師データ生成における側面膨らみ比率
TEACHER_SIDE_SWELL_RATIO = 0.08

# 合成教師データ生成における前面深さ変形比率
TEACHER_FRONT_DEPTH_RATIO = 0.12

# 合成教師データ生成における前面バイアス変形比率
TEACHER_FRONT_DEPTH_BIAS_RATIO = 0.06

# 合成教師データ生成における側面拡大幅比率
TEACHER_SIDE_SCALE_RATIO = 0.05

# 合成教師データ生成における変形開始高さ比率
TEACHER_HEIGHT_START_RATIO = 0.05

# 合成教師データ生成における変形高さ範囲比率
TEACHER_HEIGHT_RANGE_RATIO = 0.95

# 主損失関数における Smooth L1 損失の重み
TRAINING_LOSS_WEIGHT_DATA = 0.8

# 主損失関数における MSE 損失の重み
TRAINING_LOSS_WEIGHT_MSE = 0.2

# 幾何エッジ拘束損失の合成重み
EDGE_CONSTRAINT_WEIGHT = 0.05

# 学習率の最終値を初期値に対する比率で指定する
LEARNING_RATE_FINAL_RATIO = float(globals().get("DNN_LEARNING_RATE_FINAL_RATIO", 0.02))

# 勾配クリッピングの最大ノルム閾値
GRADIENT_CLIP_NORM = 5.0

# 身体特徴量PKLファイルの読み込み先パス
BODY_CONTEXT_PATH = str(
    globals().get(
        "DNN_BODY_CONTEXT_PATH",
        os.path.join(OUTPUT_DIR, "skirt_body_context_for_dnn.pkl"),
    )
)
os.makedirs(OUTPUT_DIR, exist_ok=True)

if INPUT_FEATURES not in (12, 15) or BASE_INPUT_FEATURES not in (9, 12):
    raise ValueError(
        "DNN_INPUT_FEATURES はスタイルz込みの12または15にしてください。"
    )

# この処理はColabの再実行で残った古い変数を拾わないようにして
# PKLの内容を学習データの正として扱う
if os.path.isfile(BODY_CONTEXT_PATH):
    import pickle

    with open(BODY_CONTEXT_PATH, "rb") as file:
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
if num_points < MINIMUM_VERTEX_COUNT or num_faces < MINIMUM_FACE_COUNT:
    raise ValueError("スカートの頂点数または面数が不足しています。")
if np.min(base_skirt_faces) < 0 or np.max(base_skirt_faces) >= num_points:
    raise ValueError("base_skirt_facesに範囲外の頂点インデックスがあります。")

# この処理はメッシュのサイズ差を検出して
# 学習時に別スケールのデータを混ぜてしまう事故を素早く止める
if os.path.isfile(BODY_CONTEXT_PATH):
    import pickle

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
            base_skirt_pc.max(axis=0).astype(np.float64)
            - base_skirt_pc.min(axis=0).astype(np.float64)
        ))
        if abs(base_skirt_extent - pkl_skirt_extent) > SCALE_TOLERANCE_RATIO * max(pkl_skirt_extent, FLOAT_EPSILON):
            raise RuntimeError(
                "base_skirt_pcの縮尺がbody_context PKLのskirt_base_verticesと"
                "一致しません。\n"
                f"base_skirt_pc対角長: {base_skirt_extent:.6f}, "
                f"PKL skirt_base_vertices対角長: {pkl_skirt_extent:.6f}\n"
                "base_skirt_pcがColabカーネルに残っている別スケール・別ソースの"
                "メッシュの可能性があります。base_skirt_pc/base_skirt_facesの"
                f"変数を削除してから、{BODY_CONTEXT_PATH} の"
                "skirt_base_vertices/skirt_facesを使い直してください。"
            )


# 特徴量正規化スケール計算時のゼロ除算防止用イプシロン
INPUT_SCALE_MIN_EPSILON = 1.0e-6

# 身体座標のSimilarity Transform計算における特異判定イプシロン
SIMILARITY_TRANSFORM_EPSILON = 1.0e-20

# 幾何形状バウンディングボックスの高さおよび奥行きの最小安全値
GEOMETRY_SPAN_MIN_EPSILON = 1.0e-6


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
    if denominator <= SIMILARITY_TRANSFORM_EPSILON:
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
    if os.path.isfile(BODY_CONTEXT_PATH):
        import pickle

        with open(BODY_CONTEXT_PATH, "rb") as file:
            context = pickle.load(file)
        if not isinstance(context, dict):
            raise TypeError("身体特徴量PKLの内容がdictではありません。")
        motion = resolve_motion_from_context(context)
        motion = broadcast_body_motion(motion)
        print(f"身体特徴量の入力元: {BODY_CONTEXT_PATH}")
        if BASE_INPUT_FEATURES == 9:
            return motion
        position = base_skirt_pc[None, :, :] + motion
        return np.concatenate([position, motion], axis=2)

    direct = globals().get("DNN_BODY_CONTEXT_FEATURES", None)
    if direct is not None:
        features = np.asarray(direct, dtype=np.float32)
        # Add this line to broadcast the motion if its shape is (frames, 3)
        features = broadcast_body_motion(features)
        expected_channels = 3 if BASE_INPUT_FEATURES == 9 else 6
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
        if BASE_INPUT_FEATURES == 9:
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
    if BASE_INPUT_FEATURES == 9:
        return motion
    position = base_skirt_pc[None, :, :] + motion
    return np.concatenate([position, motion], axis=2)


body_features = get_body_features()
# 注意: DNN_BODY_CONTEXT_FEATURES/DNN_BODY_MOTIONという名前でここに書き戻すと、
# それらは get_body_features() 自身が「手動オーバーライド」として最優先で
# 読みに行く名前と衝突する。Colabの%run -iはセルを再実行してもglobals()が
# 残るため、前回このスクリプトを実行した際の結果が次回の実行で誤って
# 「手動オーバーライド」として再利用され、新しいPKLを再生成しても
# 古い身体特徴量のまま学習し続けてしまう。そのためオーバーライド名とは
# 別名で公開する。
DNN_BODY_CONTEXT_FEATURES_RESOLVED = body_features.copy()
DNN_BODY_MOTION_RESOLVED = (
    body_features[:, :, :3]
    if BASE_INPUT_FEATURES == 9
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

# ------------------------------------------------------------
# 教師データの読み込み
# 1. create_skirt_body_context.pyで生成された幾何Goal Pose付きブレンド教師
#    (skirt_geometric_teacher_vertices)を最優先で使用。
#    立位〜60%までは 0185d85 の body_motion 追従、
#    60%〜100%で太腿カプセル衝突回避・めくれ抑制ゴールへ滑らかに遷移する。
# 2. 手動指定 (DNN_TRAINING_VERTICES / DNN_SITTING_VERTICES)
# 3. 従来フォールバック (skirt_skinned_vertices)
# ------------------------------------------------------------
if provided_training_vertices is None and os.path.isfile(BODY_CONTEXT_PATH):
    import pickle

    with open(BODY_CONTEXT_PATH, "rb") as file:
        teacher_context = pickle.load(file)
    if (
        isinstance(teacher_context, dict)
        and "skirt_geometric_teacher_vertices" in teacher_context
    ):
        provided_training_vertices = np.asarray(
            teacher_context["skirt_geometric_teacher_vertices"],
            dtype=np.float32,
        )
        provided_pose_angles = np.linspace(
            0.0,
            max_sit_angle,
            len(provided_training_vertices),
            dtype=np.float32,
        )
        print(
            "教師スカート頂点の入力元(衝突回避幾何ブレンド教師): "
            f"{BODY_CONTEXT_PATH} skirt_geometric_teacher_vertices"
        )
    elif (
        isinstance(teacher_context, dict)
        and "skirt_skinned_vertices" in teacher_context
    ):
        provided_training_vertices = np.asarray(
            teacher_context["skirt_skinned_vertices"],
            dtype=np.float32,
        )
        provided_pose_angles = np.linspace(
            0.0,
            max_sit_angle,
            len(provided_training_vertices),
            dtype=np.float32,
        )
        print(
            "教師スカート頂点の入力元: "
            f"{BODY_CONTEXT_PATH} skirt_skinned_vertices"
        )


def smoothstep(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def make_teacher(vertices: np.ndarray, progress: float) -> np.ndarray:
    center = np.mean(vertices, axis=0)
    centered = vertices - center
    vertical = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    height = max(float(np.ptp(centered @ vertical)), GEOMETRY_SPAN_MIN_EPSILON)
    normalized_height = np.clip((centered @ vertical) / height + 0.5, 0.0, 1.0)
    sit = float(smoothstep(np.asarray(progress)))
    front_extent = max(float(np.ptp(centered[:, 2])), GEOMETRY_SPAN_MIN_EPSILON)
    front = np.clip(centered[:, 2] / front_extent, -1.0, 1.0)
    lower = smoothstep(
        (normalized_height - TEACHER_HEIGHT_START_RATIO)
        / TEACHER_HEIGHT_RANGE_RATIO
    )
    result = centered.copy()
    result[:, 1] -= sit * height * lower * (
        TEACHER_SIT_DROP_RATIO + TEACHER_SIDE_SWELL_RATIO * front
    )
    result[:, 2] += (
        sit * height * lower * (
            TEACHER_FRONT_DEPTH_RATIO
            + TEACHER_FRONT_DEPTH_BIAS_RATIO * np.maximum(front, 0.0)
        )
    )
    result[:, 0] *= 1.0 + sit * TEACHER_SIDE_SCALE_RATIO * lower
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

# resampled_bodyの末尾3チャンネルは常にmotion(9次元入力ならそのまま、
# 12次元入力ならposition+motionのmotion側)。SkirtDeformationDNN.forward()は
# 「motion_baseline(=motion) + eased*network(x)*output_scale」を出力するため、
# 学習ターゲットは絶対変位teacher_displacementsのままでよい
# (forward()内のskip接続が自動的にmotionを差し引いた分だけnetworkに学習させる)。
# ここでresidual_displacements(=teacher-motion)を計算するのは、
# 「networkが実際に学習すべき残差の大きさ」に output_scale を合わせるためだけ。
# これをtarget_rows_allにもそのまま使うと、forward()が加算するmotionと
# 二重に相殺され、学習が破綻する(推論時に出力が桁違いに爆発する)。
resampled_motion = resampled_body[:, :, -3:]

if target_source == "geometry_aware_synthetic_teacher":
    # make_teacher()は身体の実変位と無関係な「相対的な布のたわみ」しか
    # 表現していない。これをそのまま絶対教師にすると、skip接続で加算される
    # motion_baseline(実際の身体の動き)を打ち消す方向にDNNが学習してしまい、
    # 出力全体が「身体に追従せずほぼ動かない」小さな変位に収束してしまう
    # (=見た目が座り込みに追従しない、ビクビクした程度の変化になる)。
    # 教師データ自体に身体の実変位を主成分として組み込み、
    # 「まず身体に追従し、その上にたわみを乗せる」形に一致させる。
    teacher_displacements = teacher_displacements + resampled_motion

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

# PKLに保存された全スタイル教師を条件付き学習へ展開する。各軌道は
# create_skirt_body_context.pyでクリアランス・下向きドレープ・太腿面補正済み。
style_training_sequences = {"base": teacher_vertices}
style_presets = {"base": [0.0, 0.0, 0.0]}
if os.path.isfile(BODY_CONTEXT_PATH):
    import pickle

    with open(BODY_CONTEXT_PATH, "rb") as file:
        style_context = pickle.load(file)
    if (
        style_context.get("length_release_status") != LENGTH_RELEASE_BLOCKED_STATUS
        or style_context.get("style_controls") != []
    ):
        raise RuntimeError(
            "Length release gate metadataが未設定または未承認です。"
            " create_skirt_body_context.pyでbase-only contextを再生成してください。"
        )
    style_presets.update(style_context.get("style_presets", {}))
    style_teacher_sequences = style_context.get("skirt_style_teacher_vertices", {})
    if set(style_teacher_sequences) != ALLOWED_STYLE_PRESETS:
        raise RuntimeError(
            "未検証Style軌道が含まれるかbase教師がありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    unexpected_presets = set(style_presets) - ALLOWED_STYLE_PRESETS
    if unexpected_presets:
        raise RuntimeError(
            "旧Style軸を含むbody_contextです。"
            f" create_skirt_body_context.pyを再実行してください: {sorted(unexpected_presets)}"
        )
    if set(style_presets) != ALLOWED_STYLE_PRESETS:
        raise RuntimeError(
            "検証済みbase以外のStyleは学習できません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    if any(
        len(vector) != STYLE_LATENT_DIMENSIONS
        or abs(float(vector[1])) > FLOAT_EPSILON
        or abs(float(vector[2])) > FLOAT_EPSILON
        for vector in style_presets.values()
    ):
        raise RuntimeError("Style潜在値はLength軸だけを使用できます。")
    for style_name, style_vertices in style_teacher_sequences.items():
        if style_name not in ALLOWED_STYLE_PRESETS:
            raise RuntimeError(
                f"未対応のStyle教師です: {style_name}。"
                " body_contextを再生成してください。"
            )
        sequence = np.asarray(style_vertices, dtype=np.float32)
        if sequence.shape != teacher_vertices.shape:
            raise ValueError(
                f"スタイル教師 {style_name} の形状が不正です: "
                f"{sequence.shape} != {teacher_vertices.shape}"
            )
        if not np.isfinite(sequence).all():
            raise ValueError(
                f"スタイル教師 {style_name} にNaNまたはInfがあります"
            )
        style_training_sequences[style_name] = sequence.astype(np.float32)

pose_rows_all = []
input_rows_all = []
target_rows_all = []
frame_indices_all = []
for style_name, style_vertices in style_training_sequences.items():
    style_vector = np.asarray(style_presets.get(style_name, [0.0, 0.0, 0.0]), dtype=np.float32)
    if style_vector.shape != (STYLE_LATENT_DIMENSIONS,):
        raise ValueError(f"スタイルベクトルが不正です: {style_name}={style_vector}")
    style_displacements = style_vertices - base_skirt_pc[None, :, :]
    for frame_index, angle in enumerate(pose_angles):
        pose = np.repeat(
            np.asarray([[0.0, float(angle), 0.0]], dtype=np.float32),
            num_points,
            axis=0,
        )
        style_rows = np.repeat(style_vector[None, :], num_points, axis=0)
        rows = np.concatenate(
            [pose, base_skirt_pc, resampled_body[frame_index], style_rows],
            axis=1,
        )
        pose_rows_all.append(pose)
        input_rows_all.append(rows.astype(np.float32))
        target_rows_all.append(style_displacements[frame_index].astype(np.float32))
        frame_indices_all.append(np.full(num_points, frame_index, dtype=np.int64))

all_inputs = np.concatenate(input_rows_all, axis=0)
all_targets = np.concatenate(target_rows_all, axis=0)
all_frame_indices = np.concatenate(frame_indices_all, axis=0)
if all_inputs.shape[1] != INPUT_FEATURES:
    raise RuntimeError(f"構成された入力次元が不正です: {all_inputs.shape}")

validation_frame_mask = np.zeros(frame_count, dtype=bool)
validation_frame_mask[1:-1:VALIDATION_SAMPLE_INTERVAL] = True
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
input_scale = np.maximum(input_scale, np.float32(INPUT_SCALE_MIN_EPSILON))
# output_scaleは「DNNが学習すべき残差(襞の変形)」の大きさに合わせる。
# body_motionという絶対変位そのままの大きさで正規化すると、残差(通常は
# body_motionより小さい)に対してeased*output_scaleが過大な自由度を持ち、
# 学習・外挿が不安定になる。
output_scale = float(
    max(
        np.max(np.linalg.norm(all_targets, axis=1)),
        MINIMUM_RESIDUAL_SCALE,
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
        residual = self.network(normalized)
        eased = (
            normalized_progress
            * normalized_progress
            * (3.0 - 2.0 * normalized_progress)
        )
        # 末尾3列はスタイルzであり、その直前3列がbody_motionである。
        # 実変位)。DNNの出力にそのまま加算するskip接続にすることで、
        # 「まず身体の動きに追従し、その上にDNNが襞の変形(残差)を乗せる」
        # 構造にする。無相関な入力を絶対座標へ直接学習させるより安定する。
        motion_baseline = inputs[:, -6:-3]
        return motion_baseline + eased * residual * self.output_scale


device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
train_steps = int(
    TRAIN_STEPS_OVERRIDE
    or (DEFAULT_TRAIN_STEPS_CUDA if device.type == "cuda" else DEFAULT_TRAIN_STEPS_CPU)
)
batch_size = int(
    BATCH_SIZE_OVERRIDE
    or (DEFAULT_BATCH_SIZE_CUDA if device.type == "cuda" else DEFAULT_BATCH_SIZE_CPU)
)
batch_size = max(MIN_BATCH_SIZE, min(batch_size, len(train_inputs_np)))
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
# 学習率を終盤に向けて下げ、一定学習率で見られた損失の振動を抑える
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
    optimizer,
    T_max=train_steps,
    eta_min=LEARNING_RATE * LEARNING_RATE_FINAL_RATIO,
)

# メッシュ幾何拘束用のエッジリストと初期エッジ長を構築
edge_set = set()
for face in base_skirt_faces:
    for i in range(3):
        u, v = int(face[i]), int(face[(i + 1) % 3])
        edge_set.add((min(u, v), max(u, v)))
edge_pairs_np = np.array(list(edge_set), dtype=np.int64)
edge_u_idx = torch.from_numpy(edge_pairs_np[:, 0]).to(device)
edge_v_idx = torch.from_numpy(edge_pairs_np[:, 1]).to(device)
initial_edges_u = torch.from_numpy(base_skirt_pc[edge_pairs_np[:, 0]]).to(device)
initial_edges_v = torch.from_numpy(base_skirt_pc[edge_pairs_np[:, 1]]).to(device)
initial_edge_lengths = torch.norm(initial_edges_u - initial_edges_v, dim=1)

# フレームごとの全頂点入力テンソル（幾何Loss計算用）
frame_full_inputs = [
    torch.from_numpy(input_rows_all[f]).to(device)
    for f in range(frame_count)
]
frame_full_targets = [
    torch.from_numpy(target_rows_all[f]).to(device)
    for f in range(frame_count)
]
base_skirt_torch = torch.from_numpy(base_skirt_pc).to(device)

best_rmse = float("inf")
best_state = None
for step in range(1, train_steps + 1):
    model.train()
    indices = torch.randint(len(train_inputs), (batch_size,))
    batch_inputs = train_inputs[indices].to(device)
    batch_targets = train_targets[indices].to(device)
    optimizer.zero_grad(set_to_none=True)
    prediction = model(batch_inputs)
    loss_data = (
        TRAINING_LOSS_WEIGHT_DATA * F.smooth_l1_loss(prediction, batch_targets)
        + TRAINING_LOSS_WEIGHT_MSE * F.mse_loss(prediction, batch_targets)
    )

    # 幾何拘束損失 (ランダムなフレームを1つ選んでエッジ長を拘束)
    random_frame = random.randint(0, frame_count - 1)
    frame_in = frame_full_inputs[random_frame]
    frame_disp = model(frame_in)
    frame_verts = base_skirt_torch + frame_disp
    pred_edge_lengths = torch.norm(frame_verts[edge_u_idx] - frame_verts[edge_v_idx], dim=1)
    loss_edge = F.mse_loss(pred_edge_lengths, initial_edge_lengths)

    # トータル損失
    loss = loss_data + EDGE_CONSTRAINT_WEIGHT * loss_edge

    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), GRADIENT_CLIP_NORM)
    optimizer.step()
    scheduler.step()

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
        "format_version": 3,
        "model_class": "SkirtDeformationDNN",
        "input_feature_count": INPUT_FEATURES,
        "model_state_dict": {
            name: value.cpu()
            for name, value in model.state_dict().items()
        },
        "vertex_count": num_points,
        "face_count": num_faces,
        "target_source": target_source,
        "style_latent_schema": ["length", "tightness", "pleats"],
        "style_controls": [],
        "length_release_status": LENGTH_RELEASE_BLOCKED_STATUS,
        "style_presets": style_presets,
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
            "format_version": 3,
            "input_feature_count": INPUT_FEATURES,
            "body_feature_schema": (
                "body_motion"
                if BASE_INPUT_FEATURES == 9
                else "body_position_and_body_motion"
            ),
            "style_latent_schema": ["length", "tightness", "pleats"],
            "style_controls": [],
            "length_release_status": LENGTH_RELEASE_BLOCKED_STATUS,
            "style_presets": style_presets,
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
    if BASE_INPUT_FEATURES == 9
    else "body_position + body_motion"
)
print(f"身体特徴量: {body_schema}")
print(f"チェックポイント: {checkpoint_path}")
print(f"TorchScript: {torchscript_path}")
print(f"メタデータ: {metadata_path}")
print("続けて skirt_animation_dnn_morph_fixed.py を実行してください。")
