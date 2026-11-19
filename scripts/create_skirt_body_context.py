# scripts\create_skirt_body_context.py
"""スカートアニメーション用の身体コンテキスト作成スクリプト
Colab環境でBlender付属Pythonから実行することを想定している

概要
- Body と Bottoms の幾何関係を解析して DNN 学習用コンテキスト PKL を生成する

役割
- FBX から Body メッシュと Bottoms メッシュを抽出
- 体幹とスカートの接触判定および脚閉じ補正 (runtime leg close) を実行
- 身体頂点の変形変位とスカート頂点の幾何関係を対応付けた特徴量を生成
- body_normals による動的クリアランス補正を適用した幾何教師データを算出
- DNN 学習スクリプト用の PKL ファイルを出力

必須データ
- StandToSit_model.fbx などの人体アニメーション付き FBX モデル

使い方
- 基本実行方法
    python scripts/create_skirt_body_context.py
- コマンドライン引数指定時
    python scripts/create_skirt_body_context.py [FBXパス] [出力PKLパス] [頂点数] [フレーム数] [進捗上限] [ピーク後切捨フラグ] [脚閉じ適用フラグ]
"""

import importlib
import os
import shutil
import subprocess
import sys
import tempfile


# 既定の入力 FBX ファイルパス
DEFAULT_FBX_PATH = "/content/public/models/StandToSit_model.fbx"

# 既定の出力 PKL ファイル保存先パス
DEFAULT_CONTEXT_PATH = "/content/public/models/skirt_body_context_for_dnn.pkl"

# 頂点数チェック用初期値 0 は無制限
DEFAULT_VERTEX_COUNT = "0"

# サンプリングする既定フレーム数
DEFAULT_FRAME_COUNT = "120"

# 座位動作サンプリング時の進捗上限比率
DEFAULT_PROGRESS_LIMIT = "0.85"

# 身体変位ピーク到達後のフレーム切り捨てフラグ初期値 0 は切り捨て無効
DEFAULT_TRUNCATE_AFTER_MOTION_PEAK = "0"

# ランタイム脚閉じ補正の適用フラグ初期値 1 は適用有効
DEFAULT_APPLY_RUNTIME_LEG_CLOSE = "1"

# 環境変数または既定値から構成する引数リスト
DEFAULT_ARGUMENTS = [
    os.environ.get(
        "DNN_BODY_FBX_PATH",
        DEFAULT_FBX_PATH,
    ),
    os.environ.get(
        "DNN_BODY_CONTEXT_PATH",
        DEFAULT_CONTEXT_PATH,
    ),
    os.environ.get("DNN_BODY_VERTEX_COUNT", DEFAULT_VERTEX_COUNT),
    os.environ.get("DNN_BODY_FRAME_COUNT", DEFAULT_FRAME_COUNT),
    os.environ.get("DNN_BODY_PROGRESS_LIMIT", DEFAULT_PROGRESS_LIMIT),
    os.environ.get("DNN_TRUNCATE_AFTER_MOTION_PEAK", DEFAULT_TRUNCATE_AFTER_MOTION_PEAK),
    os.environ.get("DNN_APPLY_RUNTIME_LEG_CLOSE", DEFAULT_APPLY_RUNTIME_LEG_CLOSE),
]

# ローカル座標系の微小スケール比較用イプシロン
LOCAL_SCALE_EPSILON = 1.0e-8

# スカート上端の腰帯領域と判定する高さ比率マージン
WAISTBAND_MARGIN_RATIO = 0.10

# 表面クリアランス計算時の許容下限比率
SURFACE_CLEARANCE_MARGIN_RATIO = 0.95

# 幾何検証における三角形面の最小面積閾値
MINIMUM_SURFACE_AREA = 1.0e-5

# 幾何検証におけるエッジ伸縮比率の許容下限値
MINIMUM_EDGE_RATIO = 0.55

# 幾何検証におけるエッジ伸縮比率の許容上限値
MAXIMUM_EDGE_RATIO = 1.65

# 逆距離二乗重み計算時のゼロ除算防止用イプシロン
INVERSE_DISTANCE_WEIGHT_EPSILON = 1.0e-6

# Body頂点距離投影の収束判定許容誤差。太腿面投影と同じローカル単位。
SURFACE_CLEARANCE_CONVERGENCE_TOLERANCE = 1.0e-4

# 特徴量投影計算におけるゼロ除算防止用イプシロン
FEATURE_PROJECTION_EPSILON = 1.0e-12

# 潜在スタイル空間の代表点。各点は既存の幾何安全補正を通過した教師軌道として保存する。
STYLE_PRESETS = {
    "base": (0.0, 0.0, 0.0),
}


def get_arguments():
    # この処理は引数の順番や省略値を揃えて
    # Blender側のワーカーに同じ形式を渡し続ける
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
    if len(arguments) < 7:
        arguments = [*arguments[:6], "1"]
    return arguments[:7]


def blender_source():
    # この処理はBlenderで実際にBodyとSkirtの位相を調整して
    # 学習用の特徴量と座標を吐き出す本体部分
    return r'''import bpy
import math
import os
import pickle
import re
import sys
import time

from mathutils import Quaternion, Vector
from mathutils.kdtree import KDTree

# Blenderワーカー内で参照する幾何検証定数。外側モジュールの定数は
# この文字列スクリプトへ自動では引き継がれないため、ここで明示する。
LOCAL_SCALE_EPSILON = 1.0e-8
WAISTBAND_MARGIN_RATIO = 0.10
SURFACE_CLEARANCE_MARGIN_RATIO = 0.95
MINIMUM_SURFACE_AREA = 1.0e-5
MINIMUM_EDGE_RATIO = 0.55
MAXIMUM_EDGE_RATIO = 1.65

# 逆距離二乗重み計算時のゼロ除算防止用イプシロン
INVERSE_DISTANCE_WEIGHT_EPSILON = 1.0e-6

# Body頂点距離投影の収束判定許容誤差。太腿面投影と同じローカル単位。
SURFACE_CLEARANCE_CONVERGENCE_TOLERANCE = 1.0e-4


# 脚閉じ補正の開始アニメーション進捗比率
THIGH_CLOSE_START_PROGRESS = 0.12

# 潜在スタイル空間の安全教師を生成する代表点
STYLE_PRESETS = {
    "base": (0.0, 0.0, 0.0),
}

# 脚閉じ補正が完全適用となるアニメーション進捗比率
THIGH_CLOSE_FULL_PROGRESS = 0.58

# 大腿骨から膝の間で内股間隙を評価する補間パラメータ
INNER_THIGH_SAMPLE_T = 0.34

# 脚閉じ完了時の目標内股間隙比率
TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE = 0.010

# 脚閉じ完了時の目標膝間隙比率
TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE = 0.07

# 脚閉じ完了時の目標足首間隙比率
TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE = 0.42

# 着席姿勢基準の内股間隙ハード下限比率
HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE = 0.010

# 着席姿勢基準の膝間隙ハード下限比率
HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE = 0.05

# 着席姿勢基準の足首間隙ハード下限比率
HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE = 0.22

# 太腿内転のローカル最大回転角度
MAX_THIGH_ADDUCTION_LOCAL_ANGLE = math.radians(17.5)

# ワールド座標系での膝方向補正最大角度
MAX_WORLD_KNEE_ALIGN_ANGLE = math.radians(4.0)

# 内転軸キャリブレーション時のテスト回転角度
CALIBRATION_TEST_ANGLE = math.radians(2.5)

# 間隙計算におけるゼロ割防止最小値
GAP_EPSILON_MIN = 0.001

# 左右交差防止のための左右判定イプシロン
LEG_SIDE_KEEP_EPSILON = 0.001

# 脚閉じ補正をアクティブ判定する最小進行度
LEG_CLOSE_PROGRESS_ACTIVE_EPSILON = 0.0001

# 外積軸の長さ二乗の最小閾値
CROSS_AXIS_MIN_LENGTH_SQ = 1.0e-8

# 方向整列計算を行う最小角度差閾値
DIRECTION_ALIGNMENT_MIN_ANGLE = 1.0e-5

# 軸評価におけるY軸方向変位のペナルティ重み
AXIS_CALIBRATION_Y_PENALTY_WEIGHT = 0.25

# 軸評価におけるZ軸方向変位のペナルティ重み
AXIS_CALIBRATION_Z_PENALTY_WEIGHT = 0.25

# 軸評価における足首横変位のペナルティ重み
AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT = 0.12

# 軸評価における左右境界越えのペナルティ値
AXIS_CALIBRATION_SIDE_BREAK_PENALTY = 0.4

# 軸評価における採用最低スコア閾値
AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE = -0.05

# 目標間隙調整をトリガーする内股間隙マージン
REFINE_TRIGGER_INNER_GAP_MARGIN = 0.002

# 目標間隙調整をトリガーする膝間隙マージン
REFINE_TRIGGER_KNEE_GAP_MARGIN = 0.01

# 目標左右位置クランプ時の最小離隔イプシロン
TARGET_SIDE_CLAMP_EPSILON = 0.001

# 脚閉じ回転スケールの探索候補リスト
LEG_CLOSE_BASE_SCALES = [
    2.40, 2.20, 2.00, 1.80, 1.60, 1.40,
    1.20, 1.00, 0.80, 0.60, 0.40, 0.20,
]

# 脚閉じ回転スケールの左右非対称性オフセット候補リスト
LEG_CLOSE_ASYMMETRY_OFFSETS = [0.0, -0.12, 0.12, -0.22, 0.22]

# 脚閉じ評価スコアの内股間隙の重み
SCORE_INNER_GAP_WEIGHT = 1400

# 脚閉じ評価スコアの内股過剰間隙ペナルティ重み
SCORE_INNER_EXCESS_WEIGHT = 600

# 脚閉じ評価スコアの膝間隙の重み
SCORE_KNEE_GAP_WEIGHT = 55

# 脚閉じ評価スコアの膝過剰間隙ペナルティ重み
SCORE_KNEE_EXCESS_WEIGHT = 20

# 脚閉じ評価スコアの足首ボーナス重み
SCORE_ANKLE_BONUS_WEIGHT = 0.5

# 脚閉じ評価スコアの左右非対称ペナルティ重み
SCORE_ASYMMETRY_WEIGHT = 0.15


def smoothstep01(value):
    t = max(0.0, min(1.0, value))
    return t * t * (3.0 - 2.0 * t)


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


def local_units_per_meter(body_object, scene):
    world_scale = body_object.matrix_world.to_scale()
    world_per_local = (
        (world_scale.x + world_scale.y + world_scale.z) / 3.0
    )
    if world_per_local <= LOCAL_SCALE_EPSILON:
        raise RuntimeError("Bodyのローカル座標スケールを取得できません。")
    scene_scale = float(scene.unit_settings.scale_length or 1.0)
    if scene_scale <= LOCAL_SCALE_EPSILON:
        raise RuntimeError("Blenderシーンの単位スケールが不正です。")
    return 1.0 / (world_per_local * scene_scale)


def make_edge_pairs(faces):
    edges = set()
    for face in faces:
        for index in range(3):
            left = int(face[index])
            right = int(face[(index + 1) % 3])
            edges.add((min(left, right), max(left, right)))
    return sorted(edges)


def nearest_body_distance(point, body_points):
    return min(
        vector_norm(vector_sub(point, body_point))
        for body_point in body_points
    )


def nearest_body_index(point, body_points, kd_tree=None):
    if kd_tree is not None:
        _, index, _ = kd_tree.find(point)
        return index
    return min(
        range(len(body_points)),
        key=lambda body_index: sum(
            (point[axis] - body_points[body_index][axis]) ** 2
            for axis in range(3)
        ),
    )


def build_body_kd_tree(body_points):
    tree = KDTree(len(body_points))
    for index, body_point in enumerate(body_points):
        tree.insert(body_point, index)
    tree.balance()
    return tree


def required_surface_clearance(clearance):
    return clearance * SURFACE_CLEARANCE_MARGIN_RATIO


def has_required_surface_clearance(distance, clearance):
    return distance >= (
        required_surface_clearance(clearance)
        - SURFACE_CLEARANCE_CONVERGENCE_TOLERANCE
    )


def validate_skirt_geometry(
    vertices_sequence,
    faces,
    body_sequence,
    clearances,
    fixed_vertices,
    label,
    reference_sequence=None,
    nearest_indices_sequence=None,
    surface_triangles=None,
    surface_mask=None,
    surface_triangle_candidates=None,
    body_kd_trees=None,
):
    # この処理は何をするか
    # スカート頂点列の全フレームについて幾何学的な妥当性と身体接触を厳密に検証する
    #
    # どうやって実現しているか
    # 1 頂点座標にNaNやInfが含まれていないかチェック
    # 2 三角形面の外積から面積を求め 極小縮退面を検出
    # 3 エッジ長と基準メッシュのエッジ長との比率を求め 過度な伸び縮みを警告
    # 4 前フレームからの隣接頂点間変位差分を測り 空間的なギザギザ変形を追跡
    # 5 身体頂点または身体三角パッチとの距離を求め 突き抜けやクリアランス不足をエラー判定
    #
    # 注意点
    # 単純な頂点間距離だけでなく unit_normal による符号付き面距離 signed_surface_distance を検証することで
    # 凹部や鋭角部における内外誤判定を防いでいる
    if not vertices_sequence:
        raise RuntimeError(f"{label}: スカート頂点列が空です。")
    if len(vertices_sequence) != len(body_sequence):
        raise RuntimeError(f"{label}: Bodyとスカートのフレーム数が一致しません。")
    edge_pairs = make_edge_pairs(faces)
    reference_sequence = reference_sequence or vertices_sequence
    minimum_area = MINIMUM_SURFACE_AREA
    minimum_edge_ratio = MINIMUM_EDGE_RATIO
    maximum_edge_ratio = MAXIMUM_EDGE_RATIO
    worst_area = 1.0e20
    worst_edge_ratio = 0.0
    worst_body_distance = 1.0e20
    edge_warning_count = 0
    maximum_neighbor_displacement_delta = 0.0
    for frame_index, vertices in enumerate(vertices_sequence):
        if any(
            not math.isfinite(value)
            for point in vertices
            for value in point
        ):
            raise RuntimeError(f"{label}: frame={frame_index}に非有限値があります。")
        for face in faces:
            a, b, c = (vertices[index] for index in face)
            ab = vector_sub(b, a)
            ac = vector_sub(c, a)
            cross = [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ]
            area = vector_norm(cross) * 0.5
            worst_area = min(worst_area, area)
            if area < minimum_area:
                raise RuntimeError(
                    f"{label}: frame={frame_index}に極端に小さい面があります。"
                )
        edge_reference = (
            vertices_sequence[0]
            if frame_index == 0 and reference_sequence is not vertices_sequence
            else reference_sequence[frame_index]
        )
        for left, right in edge_pairs:
            reference_length = vector_norm(vector_sub(
                edge_reference[left],
                edge_reference[right],
            ))
            current_length = vector_norm(vector_sub(
                vertices[left], vertices[right],
            ))
            if reference_length <= LOCAL_SCALE_EPSILON:
                continue
            ratio = current_length / reference_length
            worst_edge_ratio = max(worst_edge_ratio, ratio)
            if ratio < minimum_edge_ratio or ratio > maximum_edge_ratio:
                edge_warning_count += 1
            if frame_index > 0:
                left_delta = vector_sub(
                    vertices[left],
                    reference_sequence[frame_index][left],
                )
                right_delta = vector_sub(
                    vertices[right],
                    reference_sequence[frame_index][right],
                )
                maximum_neighbor_displacement_delta = max(
                    maximum_neighbor_displacement_delta,
                    vector_norm(vector_sub(left_delta, right_delta)),
                )
        for vertex_index, point in enumerate(vertices):
            if vertex_index in fixed_vertices:
                continue
            if frame_index == 0:
                continue
            if nearest_indices_sequence is not None:
                body_index = nearest_indices_sequence[frame_index][vertex_index]
                body_point = body_sequence[frame_index][body_index]
                distance = vector_norm(vector_sub(point, body_point))
            else:
                distance = nearest_body_distance(point, body_sequence[frame_index])
            if surface_triangles is not None and (
                surface_mask is None or surface_mask[vertex_index]
            ):
                frame_kd_tree = (
                    body_kd_trees[frame_index]
                    if body_kd_trees is not None
                    else None
                )
                triangle_indices = (
                    surface_triangle_candidates[
                        nearest_body_index(
                            point,
                            body_sequence[frame_index],
                            frame_kd_tree,
                        )
                    ]
                    if surface_triangle_candidates is not None
                    else range(len(surface_triangles))
                )
                surface_signed_distance, _, _ = signed_surface_distance(
                    point,
                    body_sequence[frame_index],
                    surface_triangles,
                    triangle_indices,
                )
                if surface_signed_distance is None:
                    raise RuntimeError(
                        f"{label}: frame={frame_index}, vertex={vertex_index}の"
                        "近傍Body面を特定できません。"
                    )
                distance = abs(surface_signed_distance)
                if not has_required_surface_clearance(
                    surface_signed_distance,
                    clearances[vertex_index],
                ):
                    raise RuntimeError(
                        f"{label}: frame={frame_index}, vertex={vertex_index}の"
                        f"Body面符号距離が不足しています:"
                        f" {surface_signed_distance:.6f}"
                    )
            worst_body_distance = min(worst_body_distance, distance)
            surface_constraint_applied = (
                surface_triangles is not None
                and (surface_mask is None or surface_mask[vertex_index])
            )
            if (
                not surface_constraint_applied
                and not has_required_surface_clearance(
                    distance,
                    clearances[vertex_index],
                )
            ):
                raise RuntimeError(
                    f"{label}: frame={frame_index}, vertex={vertex_index}の"
                    f"Body距離が不足しています: {distance:.6f}"
                )
    print(
        f"[diag] {label}: min_area={worst_area:.6e}, "
        f"max_edge_ratio={worst_edge_ratio:.4f}, "
        f"min_body_distance={worst_body_distance:.6f}, "
        f"max_neighbor_displacement_delta="
        f"{maximum_neighbor_displacement_delta:.6f}, "
        f"edge_warnings={edge_warning_count}"
    )


def progress_log(message):
    print(f"[progress] {message}", flush=True)


def should_log_progress(index, total):
    if total <= 1:
        return True
    if index == 0 or index == total - 1:
        return True
    interval = max(1, total // 10)
    return index % interval == 0


def format_elapsed(seconds):
    total_seconds = max(0, int(round(seconds)))
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:d}h{minutes:02d}m{seconds:02d}s"
    return f"{minutes:d}m{seconds:02d}s"


def find_pose_bone_by_name_pattern(armature_object, patterns):
    if armature_object is None:
        return None
    for bone in armature_object.pose.bones:
        if any(pattern.search(bone.name) for pattern in patterns):
            return bone
    return None


def collect_leg_close_bones(armature_object):
    # この処理は何をするか
    # アーマチュア内から脚閉じに必要な主要ボーンを正規表現パターンで検索して辞書化する
    #
    # どうやって実現しているか
    # 骨盤 (hips) 太腿 (thigh) 膝 (knee) 足首 (foot) を複数の命名規則に対応した正規表現でマッチング
    #
    # 注意点
    # モデルによって命名が Mixamo 形式 VRM 形式 標準ボーン名 など異なるため
    # 前方一致や大文字小文字無視を含めて網羅的に検索する
    return {
        "hips": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_C_Hips$", r"^mixamorigHips$", r"^Hips$", r"pelvis",
            )],
        ),
        "leftThigh": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_L_UpperLeg$", r"^mixamorigLeftUpLeg$",
                r"^LeftUpLeg$", r"left.*up.*leg", r"left.*thigh",
            )],
        ),
        "rightThigh": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_R_UpperLeg$", r"^mixamorigRightUpLeg$",
                r"^RightUpLeg$", r"right.*up.*leg", r"right.*thigh",
            )],
        ),
        "leftKnee": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_L_LowerLeg$", r"^mixamorigLeftLeg$",
                r"^LeftLeg$", r"left(?!.*up).*leg", r"left.*knee",
            )],
        ),
        "rightKnee": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_R_LowerLeg$", r"^mixamorigRightLeg$",
                r"^RightLeg$", r"right(?!.*up).*leg", r"right.*knee",
            )],
        ),
        "leftFoot": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_L_Foot$", r"^mixamorigLeftFoot$",
                r"^LeftFoot$", r"left.*foot", r"left.*ankle",
            )],
        ),
        "rightFoot": find_pose_bone_by_name_pattern(
            armature_object,
            [re.compile(pattern, re.I) for pattern in (
                r"^J_Bip_R_Foot$", r"^mixamorigRightFoot$",
                r"^RightFoot$", r"right.*foot", r"right.*ankle",
            )],
        ),
    }


def bone_object_location(bone):
    return bone.matrix.translation.copy()


def bone_position_in_hips(hips, bone):
    return hips.matrix.inverted() @ bone_object_location(bone)


def inner_thigh_sample_in_hips(hips, thigh, knee):
    sample = bone_object_location(thigh).lerp(
        bone_object_location(knee),
        INNER_THIGH_SAMPLE_T,
    )
    return hips.matrix.inverted() @ sample


def signed_lateral_value(position, lateral_axis):
    return position.dot(lateral_axis)


def resolve_lateral_axis(hips, left_candidate, right_candidate, bones):
    axis = right_candidate - left_candidate
    if (
        axis.length_squared < 1.0e-8
        and bones["leftThigh"]
        and bones["rightThigh"]
    ):
        axis = (
            bone_position_in_hips(hips, bones["rightThigh"])
            - bone_position_in_hips(hips, bones["leftThigh"])
        )
    if axis.length_squared < 1.0e-8:
        return Vector((1.0, 0.0, 0.0))
    axis.normalize()
    return axis


def capture_seated_leg_reference(bones):
    required = ["hips", "leftThigh", "rightThigh", "leftKnee", "rightKnee"]
    if any(bones[name] is None for name in required):
        return None
    hips = bones["hips"]
    left_thigh = bone_position_in_hips(hips, bones["leftThigh"])
    right_thigh = bone_position_in_hips(hips, bones["rightThigh"])
    left_inner = inner_thigh_sample_in_hips(
        hips,
        bones["leftThigh"],
        bones["leftKnee"],
    )
    right_inner = inner_thigh_sample_in_hips(
        hips,
        bones["rightThigh"],
        bones["rightKnee"],
    )
    left_knee = bone_position_in_hips(hips, bones["leftKnee"])
    right_knee = bone_position_in_hips(hips, bones["rightKnee"])
    has_ankles = bool(bones["leftFoot"] and bones["rightFoot"])
    left_ankle = (
        bone_position_in_hips(hips, bones["leftFoot"])
        if has_ankles
        else left_knee.copy()
    )
    right_ankle = (
        bone_position_in_hips(hips, bones["rightFoot"])
        if has_ankles
        else right_knee.copy()
    )
    lateral_axis = resolve_lateral_axis(hips, left_knee, right_knee, bones)
    return {
        "lateralAxis": lateral_axis,
        "innerThighGap": max(
            0.001,
            signed_lateral_value(right_inner, lateral_axis)
            - signed_lateral_value(left_inner, lateral_axis),
        ),
        "kneeGap": max(
            0.001,
            signed_lateral_value(right_knee, lateral_axis)
            - signed_lateral_value(left_knee, lateral_axis),
        ),
        "ankleGap": max(
            0.001,
            signed_lateral_value(right_ankle, lateral_axis)
            - signed_lateral_value(left_ankle, lateral_axis),
        ),
        "hasAnkleReference": has_ankles,
    }


def measure_leg_gaps(bones, seated_reference):
    hips = bones["hips"]
    lateral_axis = seated_reference["lateralAxis"]
    left_inner = inner_thigh_sample_in_hips(
        hips,
        bones["leftThigh"],
        bones["leftKnee"],
    )
    right_inner = inner_thigh_sample_in_hips(
        hips,
        bones["rightThigh"],
        bones["rightKnee"],
    )
    left_knee = bone_position_in_hips(hips, bones["leftKnee"])
    right_knee = bone_position_in_hips(hips, bones["rightKnee"])
    if (
        seated_reference["hasAnkleReference"]
        and bones["leftFoot"]
        and bones["rightFoot"]
    ):
        left_ankle = bone_position_in_hips(hips, bones["leftFoot"])
        right_ankle = bone_position_in_hips(hips, bones["rightFoot"])
    else:
        left_ankle = left_knee.copy()
        right_ankle = right_knee.copy()
    return {
        "leftInner": left_inner,
        "rightInner": right_inner,
        "leftKnee": left_knee,
        "rightKnee": right_knee,
        "leftAnkle": left_ankle,
        "rightAnkle": right_ankle,
        "innerThighGap": max(
            0.001,
            signed_lateral_value(right_inner, lateral_axis)
            - signed_lateral_value(left_inner, lateral_axis),
        ),
        "kneeGap": max(
            0.001,
            signed_lateral_value(right_knee, lateral_axis)
            - signed_lateral_value(left_knee, lateral_axis),
        ),
        "ankleGap": max(
            0.001,
            signed_lateral_value(right_ankle, lateral_axis)
            - signed_lateral_value(left_ankle, lateral_axis),
        ),
    }


def set_pose_bone_quaternion(bone, quaternion):
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = quaternion
    bone.rotation_quaternion.normalize()


def ensure_pose_bone_quaternion(bone):
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion.normalize()


def rotate_pose_bone_local(bone, axis, angle):
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = (
        bone.rotation_quaternion @ Quaternion(axis, angle)
    )
    bone.rotation_quaternion.normalize()


def apply_object_rotation_to_bone(bone, delta_object):
    bone.rotation_mode = "QUATERNION"
    parent_quaternion = (
        bone.parent.matrix.to_quaternion()
        if bone.parent
        else Quaternion((1.0, 0.0, 0.0, 0.0))
    )
    delta_local = (
        parent_quaternion.inverted()
        @ delta_object
        @ parent_quaternion
    )
    bone.rotation_quaternion = delta_local @ bone.rotation_quaternion
    bone.rotation_quaternion.normalize()


def point_toward(hips, thigh, current_local, desired_local, fallback_axis, t):
    thigh_object = bone_object_location(thigh)
    current_object = hips.matrix @ current_local
    desired_object = hips.matrix @ desired_local
    current_direction = current_object - thigh_object
    desired_direction = desired_object - thigh_object
    if (
        current_direction.length <= 1.0e-8
        or desired_direction.length <= 1.0e-8
    ):
        return
    current_direction.normalize()
    desired_direction.normalize()
    angle = current_direction.angle(desired_direction, 0.0)
    if not math.isfinite(angle) or angle <= DIRECTION_ALIGNMENT_MIN_ANGLE:
        return
    axis_object = current_direction.cross(desired_direction)
    if axis_object.length_squared > CROSS_AXIS_MIN_LENGTH_SQ:
        axis_object.normalize()
    else:
        axis_object = fallback_axis.copy()
        axis_object.rotate(thigh.matrix.to_quaternion())
        if axis_object.length <= 1.0e-8:
            return
        axis_object.normalize()
    delta = Quaternion(axis_object, min(angle, MAX_WORLD_KNEE_ALIGN_ANGLE * t))
    apply_object_rotation_to_bone(thigh, delta)


def create_adduction_axis_candidates():
    candidates = [
        Vector((1, 0, 0)), Vector((-1, 0, 0)),
        Vector((0, 1, 0)), Vector((0, -1, 0)),
        Vector((0, 0, 1)), Vector((0, 0, -1)),
    ]
    for x in (-1, 0, 1):
        for y in (-1, 0, 1):
            for z in (-1, 0, 1):
                if x == 0 and y == 0 and z == 0:
                    continue
                if abs(x) + abs(y) + abs(z) == 1:
                    continue
                vector = Vector((x, y, z))
                vector.normalize()
                candidates.append(vector)
    return candidates


ADDUCTION_AXIS_CANDIDATES = create_adduction_axis_candidates()


def evaluate_thigh_adduction_axis(bones, thigh, knee, foot, side):
    # この処理は何をするか
    # 骨格モデルごとのローカル座標系の向きに依存せず 脚を自然に内側に閉じる最適回転軸を自動探索する
    #
    # どうやって実現しているか
    # 1 候補となる26方向の単位ベクトル軸に対してテスト角度回転を適用
    # 2 Hips基準の横方向軸への投影変化から 内側への変位量を計算
    # 3 前後上下への不要なブレや左右交差違反に対してペナルティを課してスコアリング
    # 4 最もスコアの高い軸をその脚の最適内転軸として決定
    #
    # 注意点
    # 単純なX軸回転やY軸回転と決め打ちすると モデルごとに脚が前後に跳ね上がったりねじれたりするため
    # 実測によるキャリブレーションで確実に左右方向への純粋な閉じ運動を取り出す
    if not bones["hips"] or not thigh or not knee:
        return None
    ensure_pose_bone_quaternion(thigh)
    original_quaternion = thigh.rotation_quaternion.copy()
    base_left_knee = bone_position_in_hips(bones["hips"], bones["leftKnee"])
    base_right_knee = bone_position_in_hips(bones["hips"], bones["rightKnee"])
    lateral_axis = resolve_lateral_axis(
        bones["hips"],
        base_left_knee,
        base_right_knee,
        bones,
    )
    base_knee = base_left_knee if side == "left" else base_right_knee
    base_foot = (
        bone_position_in_hips(bones["hips"], foot)
        if foot
        else base_knee.copy()
    )
    best_strict_axis = None
    best_strict_score = -1.0e20
    best_loose_axis = None
    best_loose_score = -1.0e20
    for candidate in ADDUCTION_AXIS_CANDIDATES:
        for sign in (1.0, -1.0):
            signed_axis = candidate.copy() * sign
            set_pose_bone_quaternion(thigh, original_quaternion.copy())
            rotate_pose_bone_local(thigh, signed_axis, CALIBRATION_TEST_ANGLE)
            bpy.context.view_layer.update()
            knee_local = bone_position_in_hips(bones["hips"], knee)
            foot_local = (
                bone_position_in_hips(bones["hips"], foot)
                if foot
                else knee_local
            )
            knee_lateral = signed_lateral_value(knee_local, lateral_axis)
            base_knee_lateral = signed_lateral_value(base_knee, lateral_axis)
            foot_lateral = signed_lateral_value(foot_local, lateral_axis)
            base_foot_lateral = signed_lateral_value(base_foot, lateral_axis)
            x_improvement = (
                knee_lateral - base_knee_lateral
                if side == "left"
                else base_knee_lateral - knee_lateral
            )
            keeps_side = (
                knee_lateral < -LEG_SIDE_KEEP_EPSILON
                if side == "left"
                else knee_lateral > LEG_SIDE_KEEP_EPSILON
            )
            foot_keeps_side = True if not foot else (
                foot_lateral < -LEG_SIDE_KEEP_EPSILON
                if side == "left"
                else foot_lateral > LEG_SIDE_KEEP_EPSILON
            )
            y_penalty = (
                abs(knee_local.y - base_knee.y)
                * AXIS_CALIBRATION_Y_PENALTY_WEIGHT
            )
            z_penalty = (
                abs(knee_local.z - base_knee.z)
                * AXIS_CALIBRATION_Z_PENALTY_WEIGHT
            )
            foot_penalty = (
                abs(foot_lateral - base_foot_lateral)
                * AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT
                if foot
                else 0.0
            )
            strict_score = x_improvement - y_penalty - z_penalty - foot_penalty
            side_penalty = (
                0.0
                if keeps_side and foot_keeps_side
                else AXIS_CALIBRATION_SIDE_BREAK_PENALTY
            )
            loose_score = strict_score - side_penalty
            if (
                keeps_side
                and foot_keeps_side
                and strict_score > best_strict_score
            ):
                best_strict_score = strict_score
                best_strict_axis = signed_axis.copy()
            if loose_score > best_loose_score:
                best_loose_score = loose_score
                best_loose_axis = signed_axis.copy()
    set_pose_bone_quaternion(thigh, original_quaternion)
    bpy.context.view_layer.update()
    if (
        best_strict_axis
        and best_strict_score > AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE
    ):
        return best_strict_axis
    if (
        best_loose_axis
        and best_loose_score > AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE
    ):
        return best_loose_axis
    return Vector((0, 1, 0)) if side == "left" else Vector((0, -1, 0))


def capture_leg_adduction_calibration(bones):
    return {
        "leftAxis": evaluate_thigh_adduction_axis(
            bones,
            bones["leftThigh"],
            bones["leftKnee"],
            bones["leftFoot"],
            "left",
        ),
        "rightAxis": evaluate_thigh_adduction_axis(
            bones,
            bones["rightThigh"],
            bones["rightKnee"],
            bones["rightFoot"],
            "right",
        ),
    }


def apply_runtime_leg_close_to_pose(
    bones,
    seated_reference,
    calibration,
    ui_progress,
):
    # この処理は何をするか
    # 着席アニメーションの進行度に合わせて脚の開きを狭めるランタイム脚閉じ補正を実行する
    #
    # どうやって実現しているか
    # 1 進行度 ui_progress をスムーズステップ関数で正規化し 適用係数 t を算出
    # 2 着席基準ポーズにおける内股間隙 膝間隙 足首間隙の目標値を決定
    # 3 キャリブレーション済みの内転軸を用いて複数の回転スケールで太腿ボーンを回転
    # 4 隙間が目標より大きい場合は膝位置を目標位置へ向ける追加の姿勢補正を実行
    # 5 左右の脚が交差せず目標隙間に最も近くなる最適な回転クォータニオンを選択して適用
    #
    # 注意点
    # 過剰に脚を閉じると左右の大腿部メッシュ同士がめり込むため
    # ハード下限値を設けて安全な隙間を厳守する
    if not seated_reference or not calibration:
        return
    required = ["hips", "leftThigh", "rightThigh", "leftKnee", "rightKnee"]
    if any(bones[name] is None for name in required):
        return
    normalized = max(
        0.0,
        min(
            1.0,
            (ui_progress - THIGH_CLOSE_START_PROGRESS)
            / (THIGH_CLOSE_FULL_PROGRESS - THIGH_CLOSE_START_PROGRESS),
        ),
    )
    t = smoothstep01(normalized)
    if t <= LEG_CLOSE_PROGRESS_ACTIVE_EPSILON:
        return
    left_thigh = bones["leftThigh"]
    right_thigh = bones["rightThigh"]
    ensure_pose_bone_quaternion(left_thigh)
    ensure_pose_bone_quaternion(right_thigh)
    original_left = left_thigh.rotation_quaternion.copy()
    original_right = right_thigh.rotation_quaternion.copy()
    current = measure_leg_gaps(bones, seated_reference)
    hard_min_inner = max(
        GAP_EPSILON_MIN,
        seated_reference["innerThighGap"]
        * HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE,
    )
    hard_min_knee = max(
        GAP_EPSILON_MIN,
        seated_reference["kneeGap"] * HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE,
    )
    hard_min_ankle = max(
        GAP_EPSILON_MIN,
        seated_reference["ankleGap"] * HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE,
    )
    desired_inner = max(
        current["innerThighGap"]
        * (1.0 + (TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE - 1.0) * t),
        hard_min_inner,
    )
    desired_knee = max(
        current["kneeGap"]
        * (1.0 + (TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE - 1.0) * t),
        hard_min_knee,
    )
    desired_ankle = max(
        current["ankleGap"]
        * (1.0 + (TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE - 1.0) * t),
        hard_min_ankle,
    )
    lateral_axis = seated_reference["lateralAxis"]
    best_left = original_left.copy()
    best_right = original_right.copy()
    best_score = 1.0e20
    found_valid = False

    def is_valid_state(state):
        left_inner = signed_lateral_value(state["leftInner"], lateral_axis)
        right_inner = signed_lateral_value(state["rightInner"], lateral_axis)
        left_knee = signed_lateral_value(state["leftKnee"], lateral_axis)
        right_knee = signed_lateral_value(state["rightKnee"], lateral_axis)
        left_ankle = signed_lateral_value(state["leftAnkle"], lateral_axis)
        right_ankle = signed_lateral_value(state["rightAnkle"], lateral_axis)
        keeps_sides = (
            left_inner < -LEG_SIDE_KEEP_EPSILON
            and right_inner > LEG_SIDE_KEEP_EPSILON
            and left_knee < -LEG_SIDE_KEEP_EPSILON
            and right_knee > LEG_SIDE_KEEP_EPSILON
            and (
                not seated_reference["hasAnkleReference"]
                or (
                    left_ankle < -LEG_SIDE_KEEP_EPSILON
                    and right_ankle > LEG_SIDE_KEEP_EPSILON
                )
            )
        )
        return (
            keeps_sides
            and state["innerThighGap"] >= hard_min_inner
            and state["kneeGap"] >= hard_min_knee
            and state["ankleGap"] >= hard_min_ankle
        )

    for base_scale in LEG_CLOSE_BASE_SCALES:
        for offset in LEG_CLOSE_ASYMMETRY_OFFSETS:
            left_scale = max(0.0, base_scale + offset)
            right_scale = max(0.0, base_scale - offset)
            set_pose_bone_quaternion(left_thigh, original_left.copy())
            set_pose_bone_quaternion(right_thigh, original_right.copy())
            rotate_pose_bone_local(
                left_thigh,
                calibration["leftAxis"],
                MAX_THIGH_ADDUCTION_LOCAL_ANGLE * t * left_scale,
            )
            rotate_pose_bone_local(
                right_thigh,
                calibration["rightAxis"],
                MAX_THIGH_ADDUCTION_LOCAL_ANGLE * t * right_scale,
            )
            bpy.context.view_layer.update()
            state = measure_leg_gaps(bones, seated_reference)
            if (
                state["innerThighGap"]
                > desired_inner + REFINE_TRIGGER_INNER_GAP_MARGIN
                or state["kneeGap"]
                > desired_knee + REFINE_TRIGGER_KNEE_GAP_MARGIN
            ):
                left_inner_lateral = signed_lateral_value(
                    state["leftInner"],
                    lateral_axis,
                )
                right_inner_lateral = signed_lateral_value(
                    state["rightInner"],
                    lateral_axis,
                )
                left_knee_lateral = signed_lateral_value(
                    state["leftKnee"],
                    lateral_axis,
                )
                right_knee_lateral = signed_lateral_value(
                    state["rightKnee"],
                    lateral_axis,
                )
                inner_center = (left_inner_lateral + right_inner_lateral) * 0.5
                knee_center = (left_knee_lateral + right_knee_lateral) * 0.5
                desired_inner_half = desired_inner * 0.5
                desired_knee_half = desired_knee * 0.5
                desired_left_inner = state["leftInner"] + lateral_axis * (
                    min(
                        inner_center - desired_inner_half,
                        -TARGET_SIDE_CLAMP_EPSILON,
                    )
                    - left_inner_lateral
                )
                desired_right_inner = state["rightInner"] + lateral_axis * (
                    max(
                        inner_center + desired_inner_half,
                        TARGET_SIDE_CLAMP_EPSILON,
                    )
                    - right_inner_lateral
                )
                desired_left_knee = state["leftKnee"] + lateral_axis * (
                    min(
                        knee_center - desired_knee_half,
                        -TARGET_SIDE_CLAMP_EPSILON,
                    )
                    - left_knee_lateral
                )
                desired_right_knee = state["rightKnee"] + lateral_axis * (
                    max(
                        knee_center + desired_knee_half,
                        TARGET_SIDE_CLAMP_EPSILON,
                    )
                    - right_knee_lateral
                )
                point_toward(
                    bones["hips"],
                    left_thigh,
                    state["leftInner"],
                    desired_left_inner,
                    calibration["leftAxis"],
                    t,
                )
                point_toward(
                    bones["hips"],
                    right_thigh,
                    state["rightInner"],
                    desired_right_inner,
                    calibration["rightAxis"],
                    t,
                )
                bpy.context.view_layer.update()
                state = measure_leg_gaps(bones, seated_reference)
                point_toward(
                    bones["hips"],
                    left_thigh,
                    state["leftKnee"],
                    desired_left_knee,
                    calibration["leftAxis"],
                    t,
                )
                point_toward(
                    bones["hips"],
                    right_thigh,
                    state["rightKnee"],
                    desired_right_knee,
                    calibration["rightAxis"],
                    t,
                )
                bpy.context.view_layer.update()
                state = measure_leg_gaps(bones, seated_reference)
            if not is_valid_state(state):
                continue
            inner_penalty = max(0.0, state["innerThighGap"] - desired_inner)
            knee_penalty = max(0.0, state["kneeGap"] - desired_knee)
            ankle_bonus = state["ankleGap"] - desired_ankle
            asym_penalty = (
                abs(left_scale - right_scale)
                * SCORE_ASYMMETRY_WEIGHT
            )
            score = (
                state["innerThighGap"] * SCORE_INNER_GAP_WEIGHT
                + inner_penalty * SCORE_INNER_EXCESS_WEIGHT
                + state["kneeGap"] * SCORE_KNEE_GAP_WEIGHT
                + knee_penalty * SCORE_KNEE_EXCESS_WEIGHT
                - ankle_bonus * SCORE_ANKLE_BONUS_WEIGHT
                + asym_penalty
            )
            if score < best_score:
                best_score = score
                best_left = left_thigh.rotation_quaternion.copy()
                best_right = right_thigh.rotation_quaternion.copy()
                found_valid = True
    if found_valid:
        set_pose_bone_quaternion(left_thigh, best_left)
        set_pose_bone_quaternion(right_thigh, best_right)
    else:
        set_pose_bone_quaternion(left_thigh, original_left)
        set_pose_bone_quaternion(right_thigh, original_right)
    bpy.context.view_layer.update()

args = sys.argv[sys.argv.index("--") + 1:]
fbx_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
requested_vertex_count = int(args[2])
frame_count = int(args[3])
progress_limit = float(args[4])
truncate_after_motion_peak = args[5].lower() in {"1", "true", "yes", "on"}
apply_runtime_leg_close = args[6].lower() in {"1", "true", "yes", "on"}
print("[diag] body_context_worker_version=numpy_free_v2")
print(f"[diag] apply_runtime_leg_close={apply_runtime_leg_close}")
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
local_units_per_meter_value = local_units_per_meter(
    body_object,
    bpy.context.scene,
)
print(
    f"[diag] local_units_per_meter={local_units_per_meter_value:.6f}, "
    f"matrix_world_scale={tuple(body_object.matrix_world.to_scale())}, "
    f"scene_unit_system={bpy.context.scene.unit_settings.system}, "
    f"scene_scale_length={bpy.context.scene.unit_settings.scale_length:.6f}"
)
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
body_vertex_remap = {
    source_index: target_index
    for target_index, source_index in enumerate(body_vertex_indices)
}
body_object.data.calc_loop_triangles()
body_skin_triangles = [
    tuple(body_vertex_remap[index] for index in loop_triangle.vertices)
    for loop_triangle in body_object.data.loop_triangles
    if (
        body_object.data.polygons[loop_triangle.polygon_index].material_index
        in skin_material_indices
        and all(index in body_vertex_remap for index in loop_triangle.vertices)
    )
]
if not body_skin_triangles:
    raise RuntimeError("BodyのSKIN面から三角形を抽出できませんでした。")
body_vertex_triangle_neighbors = [set() for _ in body_vertex_indices]
body_vertex_neighbors = [set() for _ in body_vertex_indices]
for triangle_index, triangle in enumerate(body_skin_triangles):
    for vertex_index in triangle:
        body_vertex_triangle_neighbors[vertex_index].add(triangle_index)
        for neighbor_index in triangle:
            if neighbor_index != vertex_index:
                body_vertex_neighbors[vertex_index].add(neighbor_index)
for vertex_index in range(len(body_vertex_indices)):
    expanded = set(body_vertex_triangle_neighbors[vertex_index])
    for neighbor_index in body_vertex_neighbors[vertex_index]:
        expanded.update(body_vertex_triangle_neighbors[neighbor_index])
    body_vertex_triangle_neighbors[vertex_index] = expanded
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
# ------------------------------------------------------------
# Length用の裾帯。GLBのモーフターゲットは頂点数を変えられないため、メッシュを
# 「Bottoms + 裾帯LENGTH_RING_COUNT段」の上位集合にしておく。基準(base)では帯を
# 裾へ折りたたみ(ごく小さな厚みだけ残す)、各Length候補はその分を展開して表す。
# ------------------------------------------------------------
LENGTH_PIPELINE_VERSION = "geometric_length_rings_v3_dense_face_checked"
LENGTH_RING_COUNT = 8
LENGTH_RATIOS = tuple(
    float(value) for value in os.environ.get("SKIRT_LENGTH_RATIOS", "0.25,0.5,0.75").split(",")
)
# 折りたたんだ帯1段あたりの厚み。縮退面にならず法線が定義できる最小限の値。
LENGTH_RING_EPSILON_METERS = 0.0002
# 帯の各段が重力方向へ向きを揃える強さ(0で表面の延長方向のまま、1で真下)
LENGTH_STRAND_GRAVITY_BLEND = 0.2
LENGTH_STRAND_FIRST_GRAVITY_BLEND = 0.1


def find_hem_boundary_loop(faces, vertices):
    # 三角形メッシュの境界ループのうち最も低いものを裾として返す。
    # 戻り値の向きは既存面の辺と逆向きにし、追加する帯の面の巻き方向を揃える。
    use_count = {}
    face_direction = {}
    for face in faces:
        for index in range(3):
            start, end = face[index], face[(index + 1) % 3]
            edge = (min(start, end), max(start, end))
            use_count[edge] = use_count.get(edge, 0) + 1
            face_direction[edge] = (start, end)
    boundary_edges = [edge for edge, count in use_count.items() if count == 1]
    if any(count > 2 for count in use_count.values()):
        raise RuntimeError("Bottomsに非多様体の辺があり、裾帯を作れません。")
    adjacency_map = {}
    for start, end in boundary_edges:
        adjacency_map.setdefault(start, []).append(end)
        adjacency_map.setdefault(end, []).append(start)
    if any(len(neighbors) != 2 for neighbors in adjacency_map.values()):
        raise RuntimeError("Bottomsの境界が単純なループではありません。")
    visited = set()
    loops = []
    for start in adjacency_map:
        if start in visited:
            continue
        loop = [start]
        visited.add(start)
        previous = None
        current = start
        while True:
            following = [n for n in adjacency_map[current] if n != previous]
            next_vertex = following[0]
            if next_vertex == start:
                break
            if next_vertex in visited:
                raise RuntimeError("Bottomsの境界ループを辿れません。")
            loop.append(next_vertex)
            visited.add(next_vertex)
            previous, current = current, next_vertex
        loops.append(loop)
    if not loops:
        raise RuntimeError("Bottomsに境界ループがありません。")
    hem = min(
        loops,
        key=lambda loop: sum(vertices[i][1] for i in loop) / len(loop),
    )
    first_edge = (min(hem[0], hem[1]), max(hem[0], hem[1]))
    if face_direction[first_edge] != (hem[1], hem[0]):
        hem = [hem[0], *reversed(hem[1:])]
    for index, left in enumerate(hem):
        right = hem[(index + 1) % len(hem)]
        edge = (min(left, right), max(left, right))
        if face_direction[edge] != (right, left):
            raise RuntimeError("Bottoms裾の巻き方向が不揃いです。")
    return hem


def find_vertices_above_hem(faces, vertices, hem):
    # 裾頂点ごとに、表面を上へ辿る隣接頂点(裾ループ外で最も高い頂点)を返す。
    hem_set = set(hem)
    neighbors = {}
    for face in faces:
        for index in range(3):
            start, end = face[index], face[(index + 1) % 3]
            neighbors.setdefault(start, set()).add(end)
            neighbors.setdefault(end, set()).add(start)
    above = []
    for hem_vertex in hem:
        candidates = [
            n for n in neighbors[hem_vertex]
            if n not in hem_set and vertices[n][1] > vertices[hem_vertex][1]
        ]
        if not candidates:
            candidates = [
                n for n in neighbors[hem_vertex]
                if vertices[n][1] > vertices[hem_vertex][1]
            ]
        above.append(
            max(candidates, key=lambda n: vertices[n][1]) if candidates else None
        )
    return above


def unit_or_down(vector):
    length = vector_norm(vector)
    if length <= 1.0e-9:
        return [0.0, -1.0, 0.0]
    return [component / length for component in vector]


source_skirt_vertex_count = len(skirt_base_vertices)
length_ring_loop = find_hem_boundary_loop(skirt_faces, skirt_base_vertices)
length_ring_above = find_vertices_above_hem(
    skirt_faces, skirt_base_vertices, length_ring_loop,
)
length_ring_epsilon = LENGTH_RING_EPSILON_METERS * local_units_per_meter_value
length_ring_size = len(length_ring_loop)


def length_ring_vertex_index(ring, position):
    # ring=1..LENGTH_RING_COUNT。ring=0は裾そのもの。
    if ring == 0:
        return length_ring_loop[position]
    return source_skirt_vertex_count + (ring - 1) * length_ring_size + position


def folded_ring_points(frame_vertices):
    # frame_verticesは元のBottoms頂点列。折りたたんだ帯の頂点を返す。
    points = []
    for ring in range(1, LENGTH_RING_COUNT + 1):
        for position, hem_vertex in enumerate(length_ring_loop):
            above_vertex = length_ring_above[position]
            direction = unit_or_down(
                vector_sub(frame_vertices[hem_vertex], frame_vertices[above_vertex])
                if above_vertex is not None else [0.0, -1.0, 0.0]
            )
            points.append([
                frame_vertices[hem_vertex][axis]
                + direction[axis] * length_ring_epsilon * ring
                for axis in range(3)
            ])
    return points


skirt_base_vertices = (
    skirt_base_vertices + folded_ring_points(skirt_base_vertices)
)
previous_ring_indices = list(length_ring_loop)
for ring in range(1, LENGTH_RING_COUNT + 1):
    next_ring_indices = [
        length_ring_vertex_index(ring, position)
        for position in range(length_ring_size)
    ]
    for position in range(length_ring_size):
        following = (position + 1) % length_ring_size
        skirt_faces.append([
            previous_ring_indices[position],
            previous_ring_indices[following],
            next_ring_indices[following],
        ])
        skirt_faces.append([
            previous_ring_indices[position],
            next_ring_indices[following],
            next_ring_indices[position],
        ])
    previous_ring_indices = next_ring_indices
print(
    f"[diag] length rings: hem_loop={length_ring_size}, rings={LENGTH_RING_COUNT}, "
    f"vertices {source_skirt_vertex_count}->{len(skirt_base_vertices)}, "
    f"faces->{len(skirt_faces)}"
)

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
thigh_vertex_group_indices = {
    group.index
    for group in body_object.vertex_groups
    if re.search(r"(?:upper.?leg|up.?leg|thigh)", group.name, re.I)
}
body_thigh_coverage_mask = [
    any(
        membership.group in thigh_vertex_group_indices
        and membership.weight > 0.0
        for membership in body_object.data.vertices[source_index].groups
    )
    for source_index in body_vertex_indices
]
has_thigh_coverage_weights = any(body_thigh_coverage_mask)
print(
    f"[diag] body thigh coverage weights: "
    f"groups={len(thigh_vertex_group_indices)}, "
    f"vertices={sum(body_thigh_coverage_mask)}"
)

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

leg_close_bones = collect_leg_close_bones(armature_object)
seated_leg_reference = None
leg_adduction_calibration = None
if apply_runtime_leg_close:
    source_frame = animation_start + (
        animation_end - animation_start
    ) * progress_limit
    frame_floor = math.floor(source_frame)
    bpy.context.scene.frame_set(
        int(frame_floor),
        subframe=float(source_frame - frame_floor),
    )
    bpy.context.view_layer.update()
    seated_leg_reference = capture_seated_leg_reference(leg_close_bones)
    leg_adduction_calibration = capture_leg_adduction_calibration(
        leg_close_bones,
    )
    print(
        "[diag] runtime_leg_close bones: "
        + ", ".join(
            f"{name}={bone.name if bone else None}"
            for name, bone in leg_close_bones.items()
        )
    )
    if seated_leg_reference is None:
        print("[warn] runtime_leg_closeの座位参照を取得できませんでした。")
    else:
        print(
            "[diag] runtime_leg_close seated gaps: "
            f"inner={seated_leg_reference['innerThighGap']:.6f}, "
            f"knee={seated_leg_reference['kneeGap']:.6f}, "
            f"ankle={seated_leg_reference['ankleGap']:.6f}"
        )

skinned_vertices = []
skinned_normals = []
skirt_skinned_vertices = []
skirt_skinned_vertices_after_runtime_leg_close = []
leg_landmark_frames = []
sampled_body_progresses = []
sampled_source_frames = []
progress_log(f"Body/SKIN評価を開始します: frames={frame_count}")


def read_evaluated_vertices(body_object, vertex_indices):
    # この処理は何をするか
    # アニメーション評価後のBodyメッシュから指定頂点インデックスのローカル座標列を取得する
    #
    # どうやって実現しているか
    # 依存グラフ (depsgraph) から評価済みオブジェクトとメッシュを生成し各頂点のco座標を抽出
    #
    # 注意点
    # ワールド行列を乗算するとFBX特有のスケールや位置オフセットが混入し
    # ポーズ変化ではなく定数ズレが変位の主成分になってしまうためローカル座標のまま扱う
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_object = body_object.evaluated_get(depsgraph)
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph,
    )
    try:
        return [[
            float(evaluated_mesh.vertices[index].co.x),
            float(evaluated_mesh.vertices[index].co.y),
            float(evaluated_mesh.vertices[index].co.z),
        ] for index in vertex_indices]
    finally:
        evaluated_object.to_mesh_clear()


def read_evaluated_vertices_and_normals(body_object, vertex_indices):
    # この処理は何をするか
    # アニメーション評価後のBodyメッシュから指定頂点のローカル座標と外向き方向ベクトル normals を同時に取得する
    #
    # どうやって実現しているか
    # 評価済みメッシュでcalc_normalsを実行した後に各頂点の座標と normals を抽出
    #
    # 注意点
    # normals はスカート頂点を体表面から外側へ押し出す際の押し出し方向ベクトルとして使用される
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated_object = body_object.evaluated_get(depsgraph)
    evaluated_mesh = evaluated_object.to_mesh(
        preserve_all_data_layers=False,
        depsgraph=depsgraph,
    )
    if hasattr(evaluated_mesh, "calc_normals"):
        evaluated_mesh.calc_normals()
    try:
        coords = [[
            float(evaluated_mesh.vertices[index].co.x),
            float(evaluated_mesh.vertices[index].co.y),
            float(evaluated_mesh.vertices[index].co.z),
        ] for index in vertex_indices]
        normals = [[
            float(evaluated_mesh.vertices[index].normal.x),
            float(evaluated_mesh.vertices[index].normal.y),
            float(evaluated_mesh.vertices[index].normal.z),
        ] for index in vertex_indices]
        return coords, normals
    finally:
        evaluated_object.to_mesh_clear()


def capture_leg_pose_quaternions(bones):
    snapshots = []
    for name in ("leftThigh", "rightThigh"):
        bone = bones.get(name)
        if bone is None:
            continue
        ensure_pose_bone_quaternion(bone)
        snapshots.append((bone, bone.rotation_quaternion.copy()))
    return snapshots


def restore_leg_pose_quaternions(snapshots):
    for bone, quaternion in snapshots:
        set_pose_bone_quaternion(bone, quaternion)
    bpy.context.view_layer.update()


def bone_position_in_body_local(bone):
    world_position = armature_object.matrix_world @ bone.matrix.translation
    return body_object.matrix_world.inverted() @ world_position


def capture_leg_landmarks_in_body_local():
    required_names = ("hips", "leftThigh", "rightThigh", "leftKnee", "rightKnee")
    if armature_object is None or any(
        leg_close_bones.get(name) is None for name in required_names
    ):
        return None
    return {
        name: list(bone_position_in_body_local(leg_close_bones[name]))
        for name in required_names
    }


for index in range(frame_count):
    if should_log_progress(index, frame_count):
        progress_log(f"Body/SKIN評価 {index + 1}/{frame_count}")
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
    frame_leg_pose_quaternions = capture_leg_pose_quaternions(
        leg_close_bones,
    ) if apply_runtime_leg_close else []

    if apply_runtime_leg_close:
        apply_runtime_leg_close_to_pose(
            leg_close_bones,
            seated_leg_reference,
            leg_adduction_calibration,
            progress,
        )
    leg_landmark_frames.append(capture_leg_landmarks_in_body_local())

    # Body/SKINと同じruntime_leg_close後の姿勢系列からBottomsを取得し、
    # 教師スカートとBodyの姿勢基準を一致させる。
    skirt_vertices = read_evaluated_vertices(body_object, skirt_vertex_indices)

    vertices, normals = read_evaluated_vertices_and_normals(
        body_object,
        body_vertex_indices,
    )
    if apply_runtime_leg_close:
        skirt_vertices_after_leg_close = read_evaluated_vertices(
            body_object,
            skirt_vertex_indices,
        )
    else:
        skirt_vertices_after_leg_close = skirt_vertices

    skirt_vertices_before_extension = skirt_vertices
    if len(vertices) != vertex_count:
        raise RuntimeError("評価後Body/SKIN頂点数が一致しません。")
    if len(skirt_vertices) != len(skirt_vertex_indices):
        raise RuntimeError("評価後Body/Bottoms頂点数が一致しません。")
    if len(skirt_vertices_after_leg_close) != len(skirt_vertex_indices):
        raise RuntimeError("脚閉じ後Body/Bottoms頂点数が一致しません。")
    skirt_vertices = skirt_vertices + folded_ring_points(skirt_vertices)
    if skirt_vertices_after_leg_close is skirt_vertices_before_extension:
        skirt_vertices_after_leg_close = skirt_vertices
    else:
        skirt_vertices_after_leg_close = (
            skirt_vertices_after_leg_close
            + folded_ring_points(skirt_vertices_after_leg_close)
        )
    skinned_vertices.append(vertices)
    skinned_normals.append(normals)
    skirt_skinned_vertices.append(skirt_vertices)
    skirt_skinned_vertices_after_runtime_leg_close.append(
        skirt_vertices_after_leg_close,
    )
    restore_leg_pose_quaternions(frame_leg_pose_quaternions)
progress_log("Body/SKIN評価が完了しました。")

if apply_runtime_leg_close:
    skirt_leg_close_differences = []
    for before_frame, after_frame in zip(
        skirt_skinned_vertices,
        skirt_skinned_vertices_after_runtime_leg_close,
    ):
        frame_differences = [
            vector_norm(vector_sub(after_vertex, before_vertex))
            for before_vertex, after_vertex in zip(before_frame, after_frame)
        ]
        skirt_leg_close_differences.extend(frame_differences)
    mean_skirt_leg_close_difference = (
        sum(skirt_leg_close_differences)
        / len(skirt_leg_close_differences)
    )
    print(
        "[diag] skirt before/after runtime_leg_close displacement: "
        f"max={max(skirt_leg_close_differences):.6f}, "
        f"mean={mean_skirt_leg_close_difference:.6f}"
    )

# per-vertex, per-frame displacement: (frames, vertices, 3)
progress_log("Body/SKIN変位計算を開始します。")
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
progress_log("Body/SKIN変位計算が完了しました。")
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
    skirt_skinned_vertices = skirt_skinned_vertices[: peak_index + 1]
    skirt_skinned_vertices_after_runtime_leg_close = (
        skirt_skinned_vertices_after_runtime_leg_close[: peak_index + 1]
    )
    leg_landmark_frames = leg_landmark_frames[: peak_index + 1]
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
progress_log(
    f"スカート頂点近傍探索を開始します: "
    f"skirt_vertices={len(skirt_base_vertices)}, "
    f"body_vertices={len(body_base_vertices)}, neighbors={neighbor_count}"
)
for skirt_index, skirt_vertex in enumerate(skirt_base_vertices):
    if should_log_progress(skirt_index, len(skirt_base_vertices)):
        progress_log(
            f"スカート頂点近傍探索 "
            f"{skirt_index + 1}/{len(skirt_base_vertices)}"
        )
    distances = []
    for body_index, body_vertex in enumerate(body_base_vertices):
        distance_squared = sum(
            (skirt_vertex[axis] - body_vertex[axis]) ** 2
            for axis in range(3)
        )
        distances.append((distance_squared, body_index))
    nearest = sorted(distances)[:neighbor_count]
    weights = [1.0 / (distance + INVERSE_DISTANCE_WEIGHT_EPSILON) for distance, _ in nearest]
    weight_sum = sum(weights)
    neighbor_indices.append([body_index for _, body_index in nearest])
    neighbor_weights.append([weight / weight_sum for weight in weights])
progress_log("スカート頂点近傍探索が完了しました。")

skirt_vertex_body_motion = []
progress_log(
    f"スカート頂点別body_motion生成を開始します: "
    f"frames={len(per_vertex_motion)}"
)
for frame_index, frame_motion in enumerate(per_vertex_motion):
    if should_log_progress(frame_index, len(per_vertex_motion)):
        progress_log(
            f"スカート頂点別body_motion生成 "
            f"{frame_index + 1}/{len(per_vertex_motion)}"
        )
    skirt_frame_motion = []
    for indices, weights in zip(neighbor_indices, neighbor_weights):
        weighted = [0.0, 0.0, 0.0]
        for body_index, weight in zip(indices, weights):
            motion = frame_motion[body_index]
            for axis in range(3):
                weighted[axis] += motion[axis] * weight
        skirt_frame_motion.append(weighted)
    skirt_vertex_body_motion.append(skirt_frame_motion)
progress_log("スカート頂点別body_motion生成が完了しました。")

nearest_body_indices = [indices[0] for indices in neighbor_indices]
print(
    "[diag] skirt_vertex_body_motion: shape="
    f"({len(skirt_vertex_body_motion)}, "
    f"{len(skirt_vertex_body_motion[0])}, 3), "
    f"neighbor_count={neighbor_count}, "
    f"unique nearest body vertices={len(set(nearest_body_indices))}"
)

# ------------------------------------------------------------
# 0185d85準拠: FBXのスキニング済みスカート動作（skirt_skinned_vertices）を
# 100%ベースとし、各フレームの変形後Bodyメッシュに対する動的最近傍探索と
# 変形後外向きベクトルを用いた全方位動的クリアランス保証（+6mm）により
# 臀部・内股・太腿の肌突き破りを解消する
# ------------------------------------------------------------
progress_log("動的クリアランス教師データの生成を開始します。")

# メッシュの隣接リスト構築
adjacency = [set() for _ in range(len(skirt_base_vertices))]
for face in skirt_faces:
    for i in range(3):
        u, v = face[i], face[(i + 1) % 3]
        adjacency[u].add(v)
        adjacency[v].add(u)
edge_pairs = make_edge_pairs(skirt_faces)

# ウエストバンド（最上部10%）の頂点は固定
y_coords_base = [v[1] for v in skirt_base_vertices]
y_max_base = max(y_coords_base)
y_min_base = min(y_coords_base)
y_range_base = max(y_max_base - y_min_base, 1e-6)
is_waistband = [
    (skirt_base_vertices[i][1] >= y_max_base - 0.10 * y_range_base)
    for i in range(len(skirt_base_vertices))
]

# 前面太腿領域の安全クリアランスメートル単位
SAFE_NORMAL_CLEARANCE_FRONT_METERS = 0.006

# 後面臀部領域の安全クリアランスメートル単位
SAFE_NORMAL_CLEARANCE_BACK_METERS = 0.012

# 前面太腿領域のローカル単位クリアランス
SAFE_NORMAL_CLEARANCE_FRONT = (
    SAFE_NORMAL_CLEARANCE_FRONT_METERS * local_units_per_meter_value
)

# 後面臀部領域のローカル単位クリアランス
SAFE_NORMAL_CLEARANCE_BACK = (
    SAFE_NORMAL_CLEARANCE_BACK_METERS * local_units_per_meter_value
)
print(
    f"[diag] skirt_clearance_local_units="
    f"front={SAFE_NORMAL_CLEARANCE_FRONT:.6f}, "
    f"back={SAFE_NORMAL_CLEARANCE_BACK:.6f}"
)

# 各スカート頂点が前面(太腿領域)か後面(臀部領域)かを立位形状のZ座標で判定
skirt_clearance = [
    SAFE_NORMAL_CLEARANCE_FRONT if skirt_base_vertices[i][2] > 0.0
    else SAFE_NORMAL_CLEARANCE_BACK
    for i in range(len(skirt_base_vertices))
]

# 太腿面への最小オフセットローカル単位 1mm相当
THIGH_SURFACE_OFFSET_LOCAL = 0.1

# 太腿面オフセット投影の最大反復回数
THIGH_SURFACE_MAX_ITERATIONS = 32

# 太腿面オフセット投影の収束判定許容誤差
THIGH_SURFACE_CONVERGENCE_TOLERANCE = 1.0e-4

# 太腿面オフセット投影の外挿倍率上限
THIGH_SURFACE_MAX_EXTRAPOLATION = 8.0

# 太腿領域とみなすスカート高さ下限比率
THIGH_REGION_MIN_HEIGHT = 0.12

# 太腿領域とみなすスカート高さ上限比率
THIGH_REGION_MAX_HEIGHT = 0.78

# 外向き方向への押し出し補正最大反復回数
SURFACE_PUSH_MAX_ITERATIONS = 32

# 平滑化処理における自身の変位保持比率
SMOOTH_DISPLACEMENT_SELF_WEIGHT = 0.80

# 平滑化処理における近傍平均変位の合成比率
SMOOTH_DISPLACEMENT_NEIGHBOR_WEIGHT = 0.20

# 太腿上面ドレープ開始のアニメーション進捗閾値
DRAPE_START_PROGRESS = 0.40

# 太腿上面ドレープの進捗区間スパン
DRAPE_PROGRESS_SPAN = 0.60

# 太腿上面ギャップ補正を適用する最小閾値
DRAPE_GAP_TRIGGER_THRESHOLD = 0.004

# 太腿上面ギャップ補正の引き下げ強度比率
DRAPE_PULL_DOWN_RATIO = 0.50
thigh_region_mask = [
    (
        skirt_base_vertices[i][2] > 0.0
        and THIGH_REGION_MIN_HEIGHT
        <= (skirt_base_vertices[i][1] - y_min_base) / y_range_base
        <= THIGH_REGION_MAX_HEIGHT
        and not is_waistband[i]
    )
    for i in range(len(skirt_base_vertices))
]
teacher_clearances = [
    THIGH_SURFACE_OFFSET_LOCAL if thigh_region_mask[i]
    else skirt_clearance[i]
    for i in range(len(skirt_base_vertices))
]
fixed_vertices = set()


def push_outside_body_surface(
    point, frame_body_pts, frame_body_norms, clearance, body_index=None,
    kd_tree=None,
):
    # この処理は何をするか
    # スカート頂点をBody三角形面から指定クリアランスの外側へ投影する
    #
    # どうやって実現しているか
    # 1 KDTreeで近傍Body頂点を求め、その頂点に接続する三角形だけを調べる
    # 2 符号付き面距離が不足する場合、合成した外向き法線へ投影する
    # 3 太腿と非太腿で同じBody面モデルを共有し、検証と補正を一致させる
    #
    # 注意点
    # 最近傍頂点の距離球では、頂点切替時に投影方向が不連続になる。
    # 太腿ですでに使っている三角形面の法線へ統一してその振動を避ける。
    required_clearance = required_surface_clearance(clearance)
    result = list(point)
    for _ in range(SURFACE_PUSH_MAX_ITERATIONS):
        nearest_b_idx = nearest_body_index(
            result, frame_body_pts, kd_tree,
        )
        candidate_triangle_indices = body_vertex_triangle_neighbors[
            nearest_b_idx
        ]
        signed_distance, _, unit_normal = signed_surface_distance(
            result,
            frame_body_pts,
            body_skin_triangles,
            candidate_triangle_indices,
        )
        if signed_distance is None or unit_normal is None:
            raise RuntimeError("Body面距離投影の近傍三角形を特定できません。")
        if has_required_surface_clearance(signed_distance, clearance):
            return result
        push = required_clearance - signed_distance
        if push <= SURFACE_CLEARANCE_CONVERGENCE_TOLERANCE:
            return result
        result = [
            result[axis] + unit_normal[axis] * push
            for axis in range(3)
        ]
    # この関数は平滑化の途中段階でも呼ばれる。ここで未収束を例外にすると、
    # 後続の再投影・太腿面補正・全フレーム最終検証へ到達できない。
    # 安全性の採否は必ず validate_skirt_geometry() が最終形状に対して判定する。
    return result


def closest_point_on_body_triangle(point, body_points, triangle):
    # この処理は何をするか
    # 3次元空間内の任意のクエリ点から指定された三角形面上の最近接点および外向きベクトル normal を計算する
    #
    # どうやって実現しているか
    # Christer Ericson のリアルタイム衝突検出アルゴリズムに基づくボロノイ領域判定を採用
    # 頂点領域 辺領域 面内部領域の順に射影判定を行い 正確な最近接点座標を特定
    #
    # 注意点
    # 三角形の退化によるゼロ除算を防ぐため 面積や分母に対して微小イプシロンで下限クランプする
    a, b, c = (Vector(body_points[index]) for index in triangle)
    query = Vector(point)
    ab = b - a
    ac = c - a
    ap = query - a
    d1 = ab.dot(ap)
    d2 = ac.dot(ap)
    if d1 <= 0.0 and d2 <= 0.0:
        return a, (b - a).cross(c - a).normalized()
    bp = query - b
    d3 = ab.dot(bp)
    d4 = ac.dot(bp)
    if d3 >= 0.0 and d4 <= d3:
        return b, (b - a).cross(c - a).normalized()
    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        t = d1 / max(d1 - d3, 1.0e-8)
        return a + ab * t, (b - a).cross(c - a).normalized()
    cp = query - c
    d5 = ab.dot(cp)
    d6 = ac.dot(cp)
    if d6 >= 0.0 and d5 <= d6:
        return c, (b - a).cross(c - a).normalized()
    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        t = d2 / max(d2 - d6, 1.0e-8)
        return a + ac * t, (b - a).cross(c - a).normalized()
    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        t = (d4 - d3) / max((d4 - d3) + (d5 - d6), 1.0e-8)
        return b + (c - b) * t, (b - a).cross(c - a).normalized()
    denominator = 1.0 / max(va + vb + vc, 1.0e-8)
    v = vb * denominator
    w = vc * denominator
    return a + ab * v + ac * w, (b - a).cross(c - a).normalized()


SURFACE_FEATURE_TOLERANCE = 1.0e-5


def feature_angle_weight(closest, body_points, triangle):
    # この処理は何をするか
    # 最近接点が三角形の頂点 辺 面のいずれに位置するかに応じて合成重み角度を計算する
    #
    # どうやって実現しているか
    # 頂点上にある場合は隣接2辺のなす角を計算
    # 辺上にある場合は平面角 pi を返す
    # 面内部にある場合は立体角 2*pi を返す
    #
    # 注意点
    # 共有頂点や共有エッジにおける normal の不連続性を解消する
    corners = [Vector(body_points[index]) for index in triangle]
    for corner_index, corner in enumerate(corners):
        if (closest - corner).length > SURFACE_FEATURE_TOLERANCE:
            continue
        left = corners[(corner_index + 1) % 3] - corner
        right = corners[(corner_index + 2) % 3] - corner
        if (
            left.length <= SURFACE_FEATURE_TOLERANCE
            or right.length <= SURFACE_FEATURE_TOLERANCE
        ):
            return 0.0
        cosine = left.normalized().dot(right.normalized())
        return math.acos(max(-1.0, min(1.0, cosine)))
    for edge_index in range(3):
        start = corners[edge_index]
        edge = corners[(edge_index + 1) % 3] - start
        length_squared = edge.length_squared
        if length_squared <= 1.0e-12:
            continue
        t = (closest - start).dot(edge) / length_squared
        if t < 0.0 or t > 1.0:
            continue
        if (closest - (start + edge * t)).length <= SURFACE_FEATURE_TOLERANCE:
            return math.pi
    return 2.0 * math.pi


def signed_surface_distance(point, body_points, triangles, triangle_indices):
    # この処理は何をするか
    # 身体メッシュ表面に対する符号付き最短距離 (Signed Surface Distance) を計算する
    # 身体の外側なら正値 内側へのめり込みなら負値を返す
    #
    # どうやって実現しているか
    # 1 近傍の候補三角形群から最近接点と最短ユークリッド距離を探索
    # 2 最近接点を共有する三角形群の normal を角度重み付きで合成し unit_normal ベクトルを構築
    # 3 クエリ点と最近接点の差分ベクトルと unit_normal の内積符号から内外判定を決定
    #
    # 注意点
    # 凹面や急峻な関節溝でも内外判定が反転しない厳密な幾何アルゴリズムであるため
    # 教師データの生成と検証テストで完全に同一の計算式を共有する
    query = Vector(point)
    closest = None
    closest_distance_squared = 1.0e30
    for triangle_index in triangle_indices:
        candidate, _ = closest_point_on_body_triangle(
            point, body_points, triangles[triangle_index],
        )
        distance_squared = (query - candidate).length_squared
        if distance_squared < closest_distance_squared:
            closest_distance_squared = distance_squared
            closest = candidate
    if closest is None:
        return None, None, None
    normal_sum = Vector((0.0, 0.0, 0.0))
    fallback_normal = None
    for triangle_index in triangle_indices:
        triangle = triangles[triangle_index]
        candidate, normal = closest_point_on_body_triangle(
            point, body_points, triangle,
        )
        if normal.length <= 1.0e-8:
            continue
        if (candidate - closest).length > SURFACE_FEATURE_TOLERANCE:
            continue
        if fallback_normal is None:
            fallback_normal = normal
        normal_sum += normal * feature_angle_weight(
            closest, body_points, triangle,
        )
    if normal_sum.length <= 1.0e-12:
        if fallback_normal is None:
            return None, None, None
        normal_sum = fallback_normal
    unit_normal = normal_sum.normalized()
    distance = math.sqrt(closest_distance_squared)
    offset = query - closest
    signed = distance if offset.dot(unit_normal) >= 0.0 else -distance
    return signed, closest, unit_normal


def apply_thigh_surface_offset(
    frame_skirt,
    frame_body_pts,
    thigh_mask,
    kd_tree=None,
    frame_index=-1,
):
    # この処理は何をするか
    # 太腿領域のスカート頂点をBody表面から指定厚み (1mm相当) 確実に浮いた位置へ射影補正する
    #
    # どうやって実現しているか
    # 1 符号付き面距離を計算し 不足しているオフセット量を算出
    # 2 狭い凹部での線形収束遅延を回避するため 連続する不足量比率から幾何級数の残りを予測して外挿加速
    # 3 接線方向の位置を保ちながら unit_normal 方向へ頂点をステップ移動
    #
    # 注意点
    # 既に1mm以上浮いている自然なドレープ形状の頂点は一切移動させず
    # めり込みまたは接近しすぎた頂点のみを選択的に押し出す
    minimum_distances = []
    for index, point in enumerate(frame_skirt):
        if not thigh_mask[index]:
            continue
        current = list(point)
        achieved = None
        converged = False
        previous_deficit = None
        extrapolation = 1.0
        for _ in range(THIGH_SURFACE_MAX_ITERATIONS):
            candidate_triangle_indices = body_vertex_triangle_neighbors[
                nearest_body_index(current, frame_body_pts, kd_tree)
            ]
            signed, closest, unit_normal = signed_surface_distance(
                current,
                frame_body_pts,
                body_skin_triangles,
                candidate_triangle_indices,
            )
            if signed is None:
                break
            achieved = signed
            if signed >= (
                THIGH_SURFACE_OFFSET_LOCAL
                - THIGH_SURFACE_CONVERGENCE_TOLERANCE
            ):
                converged = True
                break
            deficit = THIGH_SURFACE_OFFSET_LOCAL - signed
            if previous_deficit is not None and previous_deficit > 1.0e-12:
                ratio = deficit / previous_deficit
                if 0.0 < ratio < 0.999:
                    extrapolation = min(
                        1.0 / (1.0 - ratio),
                        THIGH_SURFACE_MAX_EXTRAPOLATION,
                    )
                else:
                    extrapolation = THIGH_SURFACE_MAX_EXTRAPOLATION
            previous_deficit = deficit
            step = deficit * extrapolation
            current = [
                current[axis] + unit_normal[axis] * step
                for axis in range(3)
            ]
        if achieved is None:
            continue
        if not converged:
            raise RuntimeError(
                f"太腿面オフセットが収束しませんでした: frame={frame_index}, "
                f"vertex={index}, achieved={achieved:.9f}, "
                f"required={THIGH_SURFACE_OFFSET_LOCAL:.9f}。"
                "この頂点は1mmを確保できない狭い凹部に挟まれています。"
            )
        frame_skirt[index] = current
        minimum_distances.append(achieved)
    return min(minimum_distances, default=1.0e30)


def smooth_skirt_displacement(
    frame_skirt,
    reference_frame_skirt,
    adjacency,
    fixed_vertices,
):
    displacements = [
        vector_sub(point, reference_frame_skirt[index])
        for index, point in enumerate(frame_skirt)
    ]
    smoothed = [list(point) for point in frame_skirt]
    for index, neighbors in enumerate(adjacency):
        if index in fixed_vertices or not neighbors:
            continue
        average = mean_vector([displacements[neighbor] for neighbor in neighbors])
        for axis in range(3):
            displacement = (
                displacements[index][axis] * SMOOTH_DISPLACEMENT_SELF_WEIGHT
                + average[axis] * SMOOTH_DISPLACEMENT_NEIGHBOR_WEIGHT
            )
            smoothed[index][axis] = reference_frame_skirt[index][axis] + displacement
    return smoothed


geometric_teacher_vertices = []
dynamic_nearest_body_indices_sequence = []
thigh_surface_min_distances = []
body_kd_trees = []
for frame_idx in range(frame_count):
    if should_log_progress(frame_idx, frame_count):
        progress_log(
            f"動的クリアランス教師生成 "
            f"{frame_idx + 1}/{frame_count}"
        )
    prog = frame_idx / float(frame_count - 1)
    frame_skirt = [list(pt) for pt in skirt_skinned_vertices[frame_idx]]
    reference_frame_skirt = [list(pt) for pt in frame_skirt]
    frame_body_pts = skinned_vertices[frame_idx]
    frame_body_norms = skinned_normals[frame_idx]
    frame_kd_tree = build_body_kd_tree(frame_body_pts)
    body_kd_trees.append(frame_kd_tree)

    # 太腿上面の過剰な浮きを自然に接地させる処理（下限は skirt_clearance を厳守）
    if prog > DRAPE_START_PROGRESS:
        t_drape = smoothstep01((prog - DRAPE_START_PROGRESS) / DRAPE_PROGRESS_SPAN)
        for i in range(len(frame_skirt)):
            if is_waistband[i]:
                continue
            # 前面上部（太腿上面領域）
            if skirt_base_vertices[i][2] > 0.0:
                body_ref = frame_body_pts[nearest_body_indices[i]]
                target_top_y = body_ref[1] + skirt_clearance[i]
                v_gap = frame_skirt[i][1] - target_top_y
                if v_gap > DRAPE_GAP_TRIGGER_THRESHOLD:
                    new_y = frame_skirt[i][1] - v_gap * DRAPE_PULL_DOWN_RATIO * t_drape
                    frame_skirt[i][1] = max(new_y, target_top_y)

    # 変位場を隣接頂点で平滑化する。絶対位置を平均するとBody側へ
    # 引き戻されるため、元スキニング形状からの変位だけを平滑化する。
    for _ in range(2):
        frame_skirt = smooth_skirt_displacement(
            frame_skirt,
            reference_frame_skirt,
            adjacency,
            fixed_vertices,
        )

    # 中間形状では投影せず、ドレープと平滑化の完了後に一度だけBody面へ投影する。
    # 最終形状は直後の全頂点・全フレーム面距離検証で必ずゲートする。
    for i in range(len(frame_skirt)):
        if thigh_region_mask[i]:
            continue
        frame_skirt[i] = push_outside_body_surface(
            frame_skirt[i],
            frame_body_pts,
            frame_body_norms,
            skirt_clearance[i],
            kd_tree=frame_kd_tree,
        )
    thigh_min_distance = apply_thigh_surface_offset(
        frame_skirt,
        frame_body_pts,
        thigh_region_mask,
        kd_tree=frame_kd_tree,
        frame_index=frame_idx,
    )
    thigh_surface_min_distances.append(thigh_min_distance)
    if frame_idx in {
        0,
        int(round((frame_count - 1) * 0.40)),
        int(round((frame_count - 1) * 0.617)),
        frame_count - 1,
    }:
        print(
            f"[diag] thigh_surface frame={frame_idx} "
            f"min_distance={thigh_min_distance:.6f}"
        )

    dynamic_nearest_body_indices = [
        nearest_body_index(point, frame_body_pts, frame_kd_tree)
        for point in frame_skirt
    ]
    dynamic_nearest_body_indices_sequence.append(
        dynamic_nearest_body_indices
    )
    geometric_teacher_vertices.append(frame_skirt)

geometric_teacher_vertices[0] = [list(pt) for pt in skirt_base_vertices]
goal_vertices = geometric_teacher_vertices[-1]
validate_skirt_geometry(
    geometric_teacher_vertices,
    skirt_faces,
    skinned_vertices,
    teacher_clearances,
    fixed_vertices,
    "geometric_teacher_vertices",
    reference_sequence=skirt_skinned_vertices,
    nearest_indices_sequence=dynamic_nearest_body_indices_sequence,
    surface_triangles=body_skin_triangles,
    surface_mask=None,
    surface_triangle_candidates=body_vertex_triangle_neighbors,
    body_kd_trees=body_kd_trees,
)
progress_log("動的クリアランス高精度教師データの生成が完了しました。")

if STYLE_PRESETS != {"base": (0.0, 0.0, 0.0)}:
    raise RuntimeError(
        "Length候補はSTYLE_PRESETSではなくLENGTH_RATIOSから生成します。"
    )

style_teacher_vertices = {}
style_teacher_vertices["base"] = geometric_teacher_vertices

# ------------------------------------------------------------
# Length教師: 基準教師の裾頂点から、帯の各段を「表面の延長方向から重力方向へ
# 少しずつ向きを変えながら」伸ばす。段ごとに身体の外側へ投影するので、
# 脚の上では太腿に沿い、膝より先では下へ垂れる。全フレーム・全頂点を
# base教師と同じ符号付き面距離で検証し、1つでも不足すれば停止する。
# ------------------------------------------------------------
progress_log("Length教師データの生成を開始します。")
length_rest_height = y_range_base


# 立位FBXでは降ろした手がスカート側面に重なる。ランタイムが腕を外へ開いて回避する
# 箇所なので、帯の面の貫通検査では腕・手に最も近い点を対象外にする
# (頂点の符号付き面距離検証は腕も含めて全て行う)。
arm_group_pattern = re.compile(
    r"(upperarm|lowerarm|forearm|hand|index\d|little\d|middle\d|ring\d|thumb\d|pinky\d)",
    re.IGNORECASE,
)
arm_group_indices = {
    index for index, group in enumerate(body_object.vertex_groups)
    if arm_group_pattern.search(group.name)
}
body_arm_vertex_mask = []
for source_index in body_vertex_indices:
    memberships = body_object.data.vertices[source_index].groups
    total_weight = sum(item.weight for item in memberships)
    arm_weight = sum(item.weight for item in memberships if item.group in arm_group_indices)
    body_arm_vertex_mask.append(total_weight > 0.0 and arm_weight / total_weight > 0.5)
if not any(body_arm_vertex_mask):
    raise RuntimeError("Bodyの腕・手の頂点を特定できません。")


from mathutils.bvhtree import BVHTree

body_bvh_cache = {}


def body_bvh(frame_idx):
    # Body面への最近接をCで引くための木。符号は最近接面の法線で決めるため、
    # 頂点・辺の近傍では厳密な角度重み付き法線と僅かに異なる。
    # 補正の下見と一次検証にだけ使い、採否は厳密な符号付き面距離で決める。
    if frame_idx not in body_bvh_cache:
        body_bvh_cache[frame_idx] = BVHTree.FromPolygons(
            [tuple(point) for point in skinned_vertices[frame_idx]],
            [tuple(triangle) for triangle in body_skin_triangles],
        )
    return body_bvh_cache[frame_idx]


def bvh_signed_distance(tree, point):
    location, normal, _, distance = tree.find_nearest(Vector(point))
    if location is None:
        return None, None
    sign = 1.0 if (Vector(point) - location).dot(normal) >= 0.0 else -1.0
    return sign * distance, normal


# 帯の面が身体を横切らないよう、面上の点(重心・辺の中点)に求める最小の離隔。
LENGTH_FACE_CLEARANCE = 0.2
# 面上の検査点の重心座標。重心・辺の中点・各頂点寄りの点。大きな面の中央の
# 膨らみ(膝など)を拾うため、辺の中点だけでなく面内の点も含める。
FACE_SAMPLE_WEIGHTS = (
    (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0),
    (0.5, 0.5, 0.0), (0.0, 0.5, 0.5), (0.5, 0.0, 0.5),
    (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6),
    (0.25, 0.25, 0.5), (0.5, 0.25, 0.25), (0.25, 0.5, 0.25),
)
LENGTH_FACE_REFINE_PASSES = 12
# 1回の補正で頂点を動かす上限(局所的な法線の乱れで頂点が飛ぶのを防ぐ)
LENGTH_FACE_MAX_SHIFT = 1.0
# BVHの下見で離隔に十分な余裕がある頂点は、厳密な投影計算を省く
LENGTH_BVH_MARGIN = 0.3
# 一次検証で離隔がこの値未満の点だけ、厳密な符号付き面距離で再計算する
LENGTH_MEASURE_EXACT_BELOW = 0.8


def refine_ring_faces(frame_vertices, active_rings, body_points, kd_tree, tree):
    # 頂点が全て身体の外でも、長い三角形(襞の隣り合う裾頂点など)は太腿や膝の
    # 曲面を横切る。面上の点が不足していれば、不足分をその法線方向へ動かせる頂点
    # (裾そのものは動かさない)を押し出す。全面が足りるまで繰り返す。
    first_face = len(skirt_faces) - 2 * LENGTH_RING_COUNT * length_ring_size
    last_face = first_face + 2 * active_rings * length_ring_size
    for _ in range(LENGTH_FACE_REFINE_PASSES):
        moved = False
        for face in skirt_faces[first_face:last_face]:
            movable = [index >= source_skirt_vertex_count for index in face]
            if not any(movable):
                continue
            corners = [frame_vertices[index] for index in face]
            samples = [
                (
                    [sum(weight * corner[axis] for weight, corner in zip(weights, corners))
                     for axis in range(3)],
                    list(weights),
                )
                for weights in FACE_SAMPLE_WEIGHTS
            ]
            for sample, weights in samples:
                signed, normal = bvh_signed_distance(tree, sample)
                if signed is None or signed >= LENGTH_MEASURE_EXACT_BELOW:
                    continue
                nearest = nearest_body_index(sample, body_points, kd_tree)
                if body_arm_vertex_mask[nearest]:
                    continue
                # 下見の符号は凹部で厳密な判定とずれるため、身体に近い点は
                # 検証と同じ厳密な符号付き面距離とその法線で判定する。
                signed, _, normal = signed_surface_distance(
                    sample, body_points, body_skin_triangles,
                    body_vertex_triangle_neighbors[nearest],
                )
                if signed is None or normal is None or signed >= LENGTH_FACE_CLEARANCE:
                    continue
                deficit = LENGTH_FACE_CLEARANCE - signed
                movable_weight = sum(w for w, m in zip(weights, movable) if m)
                if deficit <= 0.0 or movable_weight <= 1.0e-6:
                    continue
                shift = min(deficit / movable_weight + 0.02, LENGTH_FACE_MAX_SHIFT)
                for index, can_move in zip(face, movable):
                    if can_move:
                        frame_vertices[index] = [
                            frame_vertices[index][axis] + normal[axis] * shift
                            for axis in range(3)
                        ]
                moved = True
                corners = [frame_vertices[index] for index in face]
        if not moved:
            return
    # 収束しなければ、検証側(measure_length_teacher)が数値で止める。


def build_length_teacher(extension_ratio):
    active_rings = max(1, int(math.ceil(extension_ratio * LENGTH_RING_COUNT - 1.0e-9)))
    step_length = length_rest_height * extension_ratio / active_rings
    sequence = []
    for frame_idx in range(frame_count):
        frame_vertices = [list(point) for point in geometric_teacher_vertices[frame_idx]]
        frame_body_pts = skinned_vertices[frame_idx]
        frame_body_norms = skinned_normals[frame_idx]
        frame_kd_tree = body_kd_trees[frame_idx]
        strand_directions = []
        for position, hem_vertex in enumerate(length_ring_loop):
            above_vertex = length_ring_above[position]
            hem_point = frame_vertices[hem_vertex]
            surface_direction = unit_or_down(
                vector_sub(hem_point, frame_vertices[above_vertex])
                if above_vertex is not None else [0.0, -1.0, 0.0]
            )
            direction = unit_or_down([
                surface_direction[axis] * (1.0 - LENGTH_STRAND_FIRST_GRAVITY_BLEND)
                + (-1.0 if axis == 1 else 0.0) * LENGTH_STRAND_FIRST_GRAVITY_BLEND
                for axis in range(3)
            ])
            previous_point = hem_point
            for ring in range(1, active_rings + 1):
                vertex_index = length_ring_vertex_index(ring, position)
                direction = unit_or_down([
                    direction[axis] * (1.0 - LENGTH_STRAND_GRAVITY_BLEND)
                    + (-1.0 if axis == 1 else 0.0) * LENGTH_STRAND_GRAVITY_BLEND
                    for axis in range(3)
                ])
                candidate = [
                    previous_point[axis] + direction[axis] * step_length
                    for axis in range(3)
                ]
                if frame_idx > 0:
                    candidate = push_outside_body_surface(
                        candidate,
                        frame_body_pts,
                        frame_body_norms,
                        teacher_clearances[vertex_index],
                        kd_tree=frame_kd_tree,
                    )
                direction = unit_or_down(vector_sub(candidate, previous_point))
                frame_vertices[vertex_index] = candidate
                previous_point = candidate
            strand_directions.append(direction)
        if frame_idx > 0:
            # 面の補正は頂点を動かすので、頂点クリアランスの再確保と交互に収束させる。
            for _ in range(LENGTH_FACE_REFINE_PASSES):
                refine_ring_faces(frame_vertices, active_rings, frame_body_pts, frame_kd_tree, body_bvh(frame_idx))
                vertex_moved = False
                for position in range(length_ring_size):
                    for ring in range(1, active_rings + 1):
                        vertex_index = length_ring_vertex_index(ring, position)
                        bvh_distance, _ = bvh_signed_distance(
                            body_bvh(frame_idx), frame_vertices[vertex_index],
                        )
                        if bvh_distance is not None and bvh_distance >= (
                            teacher_clearances[vertex_index] + LENGTH_BVH_MARGIN
                        ):
                            continue
                        pushed = push_outside_body_surface(
                            frame_vertices[vertex_index],
                            frame_body_pts,
                            frame_body_norms,
                            teacher_clearances[vertex_index],
                            kd_tree=frame_kd_tree,
                        )
                        if pushed != frame_vertices[vertex_index]:
                            frame_vertices[vertex_index] = pushed
                            vertex_moved = True
                if not vertex_moved:
                    break
        # 使わない段は、最後に使った段の外向き法線へ微小な厚みだけ離して折りたたむ。
        for position in range(length_ring_size):
            last_point = frame_vertices[length_ring_vertex_index(active_rings, position)]
            outward = strand_directions[position]
            if frame_idx > 0:
                signed, _, normal = signed_surface_distance(
                    last_point, frame_body_pts, body_skin_triangles,
                    body_vertex_triangle_neighbors[
                        nearest_body_index(last_point, frame_body_pts, frame_kd_tree)
                    ],
                )
                if signed is not None and normal is not None:
                    outward = normal
            for ring in range(active_rings + 1, LENGTH_RING_COUNT + 1):
                frame_vertices[length_ring_vertex_index(ring, position)] = [
                    last_point[axis] + outward[axis] * length_ring_epsilon * (ring - active_rings)
                    for axis in range(3)
                ]
        if frame_idx > 0 and active_rings < LENGTH_RING_COUNT:
            # 折りたたんだ段の面(最後の段と同じ位置にある長い面)も同じ基準で整える。
            for _ in range(LENGTH_FACE_REFINE_PASSES):
                refine_ring_faces(frame_vertices, LENGTH_RING_COUNT, frame_body_pts, frame_kd_tree, body_bvh(frame_idx))
                vertex_moved = False
                for position in range(length_ring_size):
                    for ring in range(1, LENGTH_RING_COUNT + 1):
                        vertex_index = length_ring_vertex_index(ring, position)
                        bvh_distance, _ = bvh_signed_distance(
                            body_bvh(frame_idx), frame_vertices[vertex_index],
                        )
                        if bvh_distance is not None and bvh_distance >= (
                            teacher_clearances[vertex_index] + LENGTH_BVH_MARGIN
                        ):
                            continue
                        pushed = push_outside_body_surface(
                            frame_vertices[vertex_index],
                            frame_body_pts,
                            frame_body_norms,
                            teacher_clearances[vertex_index],
                            kd_tree=frame_kd_tree,
                        )
                        if pushed != frame_vertices[vertex_index]:
                            frame_vertices[vertex_index] = pushed
                            vertex_moved = True
                if not vertex_moved:
                    break
        if active_rings < LENGTH_RING_COUNT:
            # 面の補正で折りたたんだ段同士が重なると面積ゼロの縮退面になる。
            # 隣り合う段が微小な厚み(length_ring_epsilon)を保つよう直す。
            for position in range(length_ring_size):
                for ring in range(active_rings + 1, LENGTH_RING_COUNT + 1):
                    previous_vertex = frame_vertices[length_ring_vertex_index(ring - 1, position)]
                    current_index = length_ring_vertex_index(ring, position)
                    gap = vector_sub(frame_vertices[current_index], previous_vertex)
                    if vector_norm(gap) >= length_ring_epsilon * 0.5:
                        continue
                    outward = strand_directions[position]
                    if frame_idx > 0:
                        _, normal = bvh_signed_distance(body_bvh(frame_idx), previous_vertex)
                        if normal is not None:
                            outward = list(normal)
                    frame_vertices[current_index] = [
                        previous_vertex[axis] + outward[axis] * length_ring_epsilon
                        for axis in range(3)
                    ]
        sequence.append(frame_vertices)
    return sequence


def measure_length_teacher(sequence):
    # 各候補の数値QA。validate_skirt_geometryで例外が出なかった結果の記録用。
    minimum_distance = 1.0e30
    minimum_face_distance = 1.0e30
    worst_face = None
    maximum_edge_ratio = 0.0
    first_ring_face = len(skirt_faces) - 2 * LENGTH_RING_COUNT * length_ring_size
    for frame_idx in range(1, len(sequence)):
        frame_body_pts = skinned_vertices[frame_idx]
        frame_kd_tree = body_kd_trees[frame_idx]

        frame_tree = body_bvh(frame_idx)

        def surface_distance_at(point):
            approximate, _ = bvh_signed_distance(frame_tree, point)
            if approximate is not None and approximate >= LENGTH_MEASURE_EXACT_BELOW:
                return approximate
            signed, _, _ = signed_surface_distance(
                point,
                frame_body_pts,
                body_skin_triangles,
                body_vertex_triangle_neighbors[
                    nearest_body_index(point, frame_body_pts, frame_kd_tree)
                ],
            )
            return signed

        for vertex_index in range(source_skirt_vertex_count, len(sequence[frame_idx])):
            minimum_distance = min(
                minimum_distance, surface_distance_at(sequence[frame_idx][vertex_index]),
            )
        # 頂点が全て身体の外でも、長い三角形が膝などを横切ることがある。
        # 帯の面について重心と辺の中点も身体の外にあることを確認する。
        for face_offset, face in enumerate(skirt_faces[first_ring_face:]):
            corners = [sequence[frame_idx][index] for index in face]
            samples = [
                [sum(weight * corner[axis] for weight, corner in zip(weights, corners))
                 for axis in range(3)]
                for weights in FACE_SAMPLE_WEIGHTS
            ]
            for sample in samples:
                if body_arm_vertex_mask[
                    nearest_body_index(sample, frame_body_pts, frame_kd_tree)
                ]:
                    continue
                sample_distance = surface_distance_at(sample)
                if sample_distance < minimum_face_distance:
                    minimum_face_distance = sample_distance
                    worst_face = (
                        frame_idx, face_offset, [round(v, 2) for v in sample],
                        [[round(v, 2) for v in corner] for corner in corners],
                        [round(surface_distance_at(corner), 3) for corner in corners],
                    )
    if minimum_face_distance < 0.0:
        frame_idx, face_offset, sample, worst_corners, worst_corner_distances = worst_face
        raise RuntimeError(
            "Length教師の帯の面が身体を横切っています: "
            f"min_face_distance={minimum_face_distance:.6f}, frame={frame_idx}, "
            f"ring={face_offset // (2 * length_ring_size) + 1}, "
            f"strand={(face_offset % (2 * length_ring_size)) // 2}, point={sample}, "
            f"corners={worst_corners}, corner_distances={worst_corner_distances}"
        )
    for frame_idx in range(1, len(sequence)):
        for left, right in edge_pairs:
            reference = vector_norm(vector_sub(sequence[0][left], sequence[0][right]))
            if reference <= LOCAL_SCALE_EPSILON:
                continue
            ratio = vector_norm(vector_sub(
                sequence[frame_idx][left], sequence[frame_idx][right],
            )) / reference
            maximum_edge_ratio = max(maximum_edge_ratio, ratio)
    return minimum_distance, minimum_face_distance, maximum_edge_ratio


length_teacher_vertices = {}
length_candidates = {}
for extension_ratio in LENGTH_RATIOS:
    length_name = f"length_{int(round(extension_ratio * 100)):03d}"
    length_sequence = build_length_teacher(extension_ratio)
    validate_skirt_geometry(
        length_sequence,
        skirt_faces,
        skinned_vertices,
        teacher_clearances,
        fixed_vertices,
        length_name,
        reference_sequence=[length_sequence[0]] * len(length_sequence),
        nearest_indices_sequence=[
            [nearest_body_index(point, skinned_vertices[frame_idx], body_kd_trees[frame_idx])
             for point in frame_points]
            for frame_idx, frame_points in enumerate(length_sequence)
        ],
        surface_triangles=body_skin_triangles,
        surface_mask=None,
        surface_triangle_candidates=body_vertex_triangle_neighbors,
        body_kd_trees=body_kd_trees,
    )
    minimum_distance, minimum_face_distance, maximum_edge_ratio = measure_length_teacher(length_sequence)
    length_teacher_vertices[length_name] = length_sequence
    length_candidates[length_name] = {
        "extension_ratio": extension_ratio,
        "active_rings": max(1, int(math.ceil(extension_ratio * LENGTH_RING_COUNT - 1.0e-9))),
        "frame_count": len(length_sequence),
        "numeric_qa": "pass",
        "minimum_signed_distance": minimum_distance,
        "minimum_face_sample_distance": minimum_face_distance,
        "maximum_edge_ratio": maximum_edge_ratio,
    }
    print(
        f"[diag] {length_name}: min_signed_distance={minimum_distance:.6f}, "
        f"min_face_sample_distance={minimum_face_distance:.6f}, "
        f"max_edge_ratio={maximum_edge_ratio:.4f}"
    )
progress_log("Length教師データの生成が完了しました。")

os.makedirs(os.path.dirname(output_path), exist_ok=True)
progress_log(f"身体特徴量PKLを書き込みます: {output_path}")
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "body_base_vertices": body_base_vertices,
            "body_vertex_indices": body_vertex_indices,
            "body_skin_triangles": body_skin_triangles,
            # 面距離を教師側と同一定義で再計算するための近傍三角形候補
            "body_vertex_triangle_neighbors": [
                sorted(indices)
                for indices in body_vertex_triangle_neighbors
            ],
            "thigh_region_mask": thigh_region_mask,
            "body_thigh_coverage_mask": body_thigh_coverage_mask,
            "has_thigh_coverage_weights": has_thigh_coverage_weights,
            "leg_landmark_frames": leg_landmark_frames,
            "skinned_vertices": skinned_vertices,
            "skinned_normals": skinned_normals,
            "skirt_skinned_vertices": skirt_skinned_vertices,
            "skirt_skinned_vertices_after_runtime_leg_close": (
                skirt_skinned_vertices_after_runtime_leg_close
            ),
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
            # 新規: 衝突回避ゴールポーズおよびブレンド教師頂点列
            "skirt_geometric_sitting_vertices": goal_vertices,
            "skirt_geometric_teacher_vertices": geometric_teacher_vertices,
            # style名 -> (frames, vertices, 3)。全て既存と同じ安全補正済み教師。
            "skirt_style_teacher_vertices": style_teacher_vertices,
            # Length候補ごとの教師。baseと同じ頂点数・面で、裾帯を展開した形状。
            "skirt_length_teacher_vertices": length_teacher_vertices,
            "skirt_length_candidates": length_candidates,
            "skirt_length_ring_loop": length_ring_loop,
            "skirt_length_ring_count": LENGTH_RING_COUNT,
            "skirt_source_vertex_count": source_skirt_vertex_count,
            "style_latent_schema": ["length", "tightness", "pleats"],
            "style_controls": [],
            "length_release_status": "disabled_pending_cloth_bake_coverage_and_image_qa",
            "style_presets": {
                name: list(vector)
                for name, vector in STYLE_PRESETS.items()
            },
            "skirt_clearance_local_units": teacher_clearances,
            "skirt_dynamic_nearest_body_indices": (
                dynamic_nearest_body_indices_sequence
            ),
            "thigh_surface_min_distances": thigh_surface_min_distances,
            "skirt_base_vertices": skirt_base_vertices,
            "skirt_waistband_mask": is_waistband,
            "skirt_faces": skirt_faces,
            "local_units_per_meter": local_units_per_meter_value,
            "skirt_vertex_indices": skirt_vertex_indices,
            "animation_start": animation_start,
            "animation_end": animation_end,
            "progress_limit": progress_limit,
            "apply_runtime_leg_close": apply_runtime_leg_close,
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
with open(output_path, "rb") as file:
    written_context = pickle.load(file)
validate_skirt_geometry(
    written_context["skirt_geometric_teacher_vertices"],
    written_context["skirt_faces"],
    written_context["skinned_vertices"],
    written_context["skirt_clearance_local_units"],
    fixed_vertices,
    "written_context",
    reference_sequence=written_context["skirt_skinned_vertices"],
    nearest_indices_sequence=written_context[
        "skirt_dynamic_nearest_body_indices"
    ],
    surface_triangles=written_context["body_skin_triangles"],
    surface_mask=None,
    surface_triangle_candidates=body_vertex_triangle_neighbors,
    body_kd_trees=body_kd_trees,
)
progress_log("身体特徴量PKLの書き込みが完了しました。")

# Length候補の数値QA結果を、PKLのSHA-256に結び付けて保存する。
# 公開(release_status=approved)は6視点の画像QAを人が承認するまで行わない。
import hashlib
import json

with open(output_path, "rb") as file:
    written_context_sha256 = hashlib.sha256(file.read()).hexdigest()
candidate_manifest_path = os.path.join(
    os.path.dirname(output_path),
    "skirt_length_release_manifest.json",
)
with open(candidate_manifest_path, "w", encoding="utf-8") as file:
    json.dump(
        {
            "schema_version": 2,
            "source": "geometric_teacher_length_rings",
            "pipeline_version": LENGTH_PIPELINE_VERSION,
            "context_sha256": written_context_sha256,
            "ring_count": LENGTH_RING_COUNT,
            "candidates": {
                name: {**info, "image_qa": "pending_manual_review"}
                for name, info in length_candidates.items()
            },
            "image_qa": {"status": "pending_manual_review", "views_per_candidate": 6},
            "approved_by": None,
            "release_status": "blocked",
        },
        file,
        indent=2,
        ensure_ascii=False,
    )
progress_log(f"Length候補マニフェストを書き込みました: {candidate_manifest_path}")
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
        command = [
            blender_command,
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            worker_file.name,
            "--",
            *arguments,
        ]
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        output_lines = []
        print("--- Blender output start ---", flush=True)
        try:
            if process.stdout is not None:
                for line in process.stdout:
                    print(line, end="", flush=True)
                    output_lines.append(line)
            return_code = process.wait()
        except KeyboardInterrupt:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        print("--- Blender output end ---", flush=True)

        result = subprocess.CompletedProcess(
            [
                *command,
            ],
            return_code,
            stdout="".join(output_lines),
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
