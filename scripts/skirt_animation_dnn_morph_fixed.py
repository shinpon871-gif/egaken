# scripts\skirt_animation_dnn_morph_fixed.py
"""スカートアニメーション用 DNN Morph 固定および GLB 出力スクリプト
Colab環境でBlender付属Pythonから実行することを想定している

概要
- 学習済み DNN または幾何教師データを用いて座位アニメーション GLB を生成する

役割
- 立位スカートメッシュと身体特徴量コンテキストのスケール整合性を検証
- 幾何教師データまたは学習済みモデルから座位遷移頂点列を算出
- Body メッシュとの動的クリアランス検証および衝突めり込み防止処理を実行
- 各フレームの頂点変位を Shape Key に変換して GLB および blend ファイルへ出力
- アニメーション進捗と姿勢角の対応マッピング JSON を書き出し

必須データ
- base_skirt_pc 立位スカートの頂点座標配列
- base_skirt_faces 立位スカートの面インデックス配列
- model train_skirt_sitting_dnn.py で学習済みの PyTorch モデル
- skirt_body_context_for_dnn.pkl 身体特徴量 PKL ファイル

使い方
- 実行手順
    1 create_skirt_body_context.py と train_skirt_sitting_dnn.py を事前実行
    2 base_skirt_pc base_skirt_faces model が存在する状態で本スクリプトを実行
    3 %run -i /content/skirt_animation_dnn_morph_fixed.py
    4 生成された skirt_mesh_sitting_animation.glb を Three.js 等のビューアで確認
"""

import json
import os
import pickle
import subprocess
import sys
import tempfile
import urllib.request

import numpy as np
import torch
import torch.nn as nn


# Blender付属Pythonのsite-packagesディレクトリパス
BLENDER_SITE_PACKAGES = "/usr/bin/3.0/python/lib/python3.10/site-packages"

# Colab環境のdist-packagesディレクトリ接頭辞
COLAB_DIST_PACKAGES_PREFIX = "/usr/local/lib/python"

# 実行時Colab環境のdist-packages完全パス
COLAB_SITE_PACKAGES = (
    f"{COLAB_DIST_PACKAGES_PREFIX}{sys.version_info.major}.{sys.version_info.minor}/dist-packages"
)

# Blenderアニメーション出力時の標準フレームレート
BLENDER_DEFAULT_FPS = 24.0

# 表面最近接点判定における頂点辺判定の許容幾何誤差
SURFACE_FEATURE_TOLERANCE = 1.0e-5

# 基準メッシュ対角長に対する変位ノルムの許容最大倍率
MAX_DISPLACEMENT_RATIO_LIMIT = 5.0

# メッシュ対角長比較におけるスケール不一致許容比率
SCALE_TOLERANCE_RATIO = 0.2

# ゼロ除算防止および微小値比較用イプシロン
FLOAT_EPSILON = 1.0e-8

# 太腿Body面との最小許容距離閾値
MIN_BODY_DISTANCE_THRESHOLD = 0.095

# スカート上端の腰帯領域と判定する高さ比率マージン
WAISTBAND_MARGIN_RATIO = 0.10

# 微小距離判定用イプシロン
SMALL_DISTANCE_EPSILON = 1.0e-6

# 身体距離計算におけるゼロ割防止イプシロン
BODY_DISTANCE_EPSILON = 1.0e-8

# 表面クリアランス計算時の許容下限比率
SURFACE_CLEARANCE_MARGIN_RATIO = 0.95

# 幾何検証における三角形面の最小面積閾値
MINIMUM_SURFACE_AREA = 1.0e-5

# 幾何検証におけるエッジ伸縮比率の許容下限値
MINIMUM_EDGE_RATIO = 0.55

# 幾何検証におけるエッジ伸縮比率の許容上限値
MAXIMUM_EDGE_RATIO = 1.65

blender_site_packages = BLENDER_SITE_PACKAGES
colab_site_packages = COLAB_SITE_PACKAGES

if os.path.exists(blender_site_packages) and os.path.exists(colab_site_packages):
    pth_file_path = os.path.join(blender_site_packages, "colab_packages.pth")
    with open(pth_file_path, "w", encoding="utf-8") as f:
        f.write(colab_site_packages + "\n")

# StandToSit_model.fbx の Bottoms 抽出結果を base_skirt_pc/base_skirt_faces に用意して実行する。
# model は train_skirt_sitting_dnn.py で学習した9次元または12次元モデル。
num_animation_frames = int(globals().get("DNN_ANIMATION_FRAMES", 120))
max_sit_angle = float(globals().get("max_sit_angle", np.deg2rad(75.0)))
output_dir = str(globals().get("DNN_OUTPUT_DIR", "/content/public/models"))
body_context_path = str(globals().get(
    "DNN_BODY_CONTEXT_PATH",
    os.path.join(output_dir, "skirt_body_context_for_dnn.pkl"),
))
glb_path = str(globals().get(
    "DNN_GLB_OUTPUT_PATH",
    os.path.join(output_dir, "skirt_mesh_sitting_animation.glb"),
))
blend_path = str(globals().get(
    "DNN_BLEND_OUTPUT_PATH",
    os.path.join(output_dir, "skirt_mesh_sitting_animation.blend"),
))
npz_path = os.path.join(output_dir, "skirt_animation_vertices.npz")
mapping_path = os.path.join(output_dir, "skirt_animation_pose_mapping.json")
blender_data_path = os.path.join(output_dir, "skirt_animation_vertices_for_blender.pkl")
# Colabの%run -iはセルを再実行しても古い変数が残り続くので
# PKLがあればその内容を正として読み直す
if os.path.isfile(body_context_path):
    with open(body_context_path, "rb") as file:
        skirt_context = pickle.load(file)
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
if input_features not in (12, 15):
    raise RuntimeError(f"DNN入力次元はスタイルz込みの12または15が必要です: {input_features}")

style_latent_dimensions = 3
base_input_features = input_features - style_latent_dimensions

with open(body_context_path, "rb") as file:
    context = pickle.load(file)
# この処理は何をするか
# メッシュ間の縮尺不一致を検出し スケール違いによる変位爆発を防止する
#
# どうやって実現しているか
# 読み込んだ base_vertices と PKL 内の skirt_base_vertices のバウンディングボックス対角長を比較
#
# 注意点
# スケールを自動推測して補正するとスキップ接続により実質数十万倍の破綻変位を生む危険があるため
# 不一致時は自動補正せず明確なエラーで停止させる
context_skirt_extent = float(np.linalg.norm(
    np.asarray(context["skirt_base_vertices"], dtype=np.float64).max(axis=0)
    - np.asarray(context["skirt_base_vertices"], dtype=np.float64).min(axis=0)
))
base_vertices_extent = float(np.linalg.norm(
    base_vertices.max(axis=0).astype(np.float64) - base_vertices.min(axis=0).astype(np.float64)
))
if abs(base_vertices_extent - context_skirt_extent) > SCALE_TOLERANCE_RATIO * max(context_skirt_extent, FLOAT_EPSILON):
    raise RuntimeError(
        "base_skirt_pcの縮尺がbody_context PKLのskirt_base_verticesと一致しません。\n"
        f"base_skirt_pc対角長: {base_vertices_extent:.6f}, "
        f"PKL skirt_base_vertices対角長: {context_skirt_extent:.6f}\n"
        "base_skirt_pcがColabカーネルに残っている別スケール・別ソースのメッシュの"
        "可能性があります。base_skirt_pc/base_skirt_facesの変数を削除してから、"
        f"{body_context_path} のskirt_base_vertices/skirt_facesを使い直してください。"
    )

# この処理は何をするか
# スカート頂点ごとに空間変化する身体変位特徴量を優先取得する
#
# どうやって実現しているか
# PKL内に skirt_vertex_body_motion が存在すればそれを採用し なければ全体平均の body_motion にフォールバック
#
# 注意点
# 全体平均の body_motion をブロードキャストするとスカート全体が剛体移動して相対変形が失われるため
# 空間的な変形を表現可能な頂点別特徴量を優先する
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


def enforce_body_clearance(vertices, context):
    # この処理は何をするか
    # 生成された全フレームのスカート頂点列に対し Body メッシュとの衝突貫通を幾何学的に解消する
    #
    # どうやって実現しているか
    # 1 各フレームに対応する Body 頂点 body_points および外向き方向 body_normals を取得
    # 2 腰帯領域以外の頂点について 最近傍 Body 頂点との距離を計算
    # 3 必要クリアランスを下回る頂点を body_normals 方向または相対ベクトル方向へ段階的に押し出す
    # 4 最大反復回数内で収束するまで押し出しを反復
    #
    # 注意点
    # 腰帯領域は人体にフィットさせるためクリアランス押し出しから除外する
    # 収束しないフレームが存在する場合は形状破綻の兆候として即座にエラー停止する
    body_frames = np.asarray(context.get("skinned_vertices", []), dtype=np.float32)
    body_normals = np.asarray(context.get("skinned_normals", []), dtype=np.float32)
    clearances = np.asarray(
        context.get("skirt_clearance_local_units", []),
        dtype=np.float32,
    )
    if body_frames.ndim != 3 or body_normals.shape != body_frames.shape:
        raise RuntimeError(
            "GLB生成: 衝突投影用の body_normals がありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    thigh_surface_distances = np.asarray(
        context.get("thigh_surface_min_distances", []),
        dtype=np.float32,
    )
    if thigh_surface_distances.ndim != 1 or len(thigh_surface_distances) < 2:
        raise RuntimeError(
            "GLB検証: 太腿Body面距離の診断値がありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    if clearances.shape != (len(base_vertices),):
        raise RuntimeError(
            "GLB生成: ローカル単位のクリアランスがありません。"
        )
    base_y = base_vertices[:, 1]
    waistband = base_y >= np.max(base_y) - WAISTBAND_MARGIN_RATIO * max(
        float(np.ptp(base_y)),
        SMALL_DISTANCE_EPSILON,
    )
    corrected = np.asarray(vertices, dtype=np.float32).copy()
    correction_count = 0
    maximum_correction = 0.0
    unresolved_frames = []
    for frame_index in range(1, len(corrected)):
        source_index = min(
            int(round(
                frame_index * (len(body_frames) - 1)
                / max(len(corrected) - 1, 1)
            )),
            len(body_frames) - 1,
        )
        body_points = body_frames[source_index]
        normals = body_normals[source_index]
        converged = False
        for _ in range(32):
            offsets = (
                corrected[frame_index, :, None, :]
                - body_points[None, :, :]
            )
            distances_squared = np.sum(offsets * offsets, axis=2)
            nearest_indices = np.argmin(distances_squared, axis=1)
            nearest_points = body_points[nearest_indices]
            nearest_normals = normals[nearest_indices]
            offsets = corrected[frame_index] - nearest_points
            distances = np.linalg.norm(offsets, axis=1)
            safe_distances = clearances.copy()
            safe_distances[waistband] = 0.0
            pushes = safe_distances - distances
            pushes[waistband] = 0.0
            active = pushes > SMALL_DISTANCE_EPSILON
            if not np.any(active):
                converged = True
                break
            directions = np.zeros_like(offsets)
            valid_directions = distances > SMALL_DISTANCE_EPSILON
            directions[valid_directions] = (
                offsets[valid_directions]
                / distances[valid_directions, None]
            )
            directions[~valid_directions] = nearest_normals[~valid_directions]
            corrected[frame_index] += directions * pushes[:, None]
            correction_count += int(np.sum(active))
            maximum_correction = max(maximum_correction, float(np.max(pushes)))
        if not converged:
            unresolved_frames.append(frame_index)
    if unresolved_frames:
        raise RuntimeError(
            "GLB生成: Body距離投影が収束しませんでした。"
            f" frames={unresolved_frames[:10]}"
        )
    print(
        "[diag] GLB body clearance projection: "
        f"corrections={correction_count}, "
        f"max_correction={maximum_correction:.6f}"
    )
    return corrected


def validate_generated_geometry(vertices, faces, context):
    # この処理は何をするか
    # GLB出力直前の全フレーム頂点配列に対し 形状の健全性と身体面との距離制約を多角的に検証する
    #
    # どうやって実現しているか
    # 1 面の面積計算により縮退面や極小反転面を検出
    # 2 エッジ長伸縮比率により過度の引き裂きや過密化を検出
    # 3 Ericsonアルゴリズムと unit_normal による符号付き面距離 signed_surface_distance を用いて太腿面との離隔を厳密計測
    # 4 最小許容面距離を下回るフレームがあればエラーを発生
    #
    # 注意点
    # 最初のフレーム (Basis) はアニメーションオフセットを含まない素の基準メッシュと比較し
    # 2フレーム目以降はスキニング後メッシュとの相対変化として正しく検証する
    if not np.isfinite(vertices).all():
        raise RuntimeError("GLB検証: 頂点列にNaNまたはInfがあります。")
    body_frames = np.asarray(context.get("skinned_vertices", []), dtype=np.float32)
    if body_frames.ndim != 3 or body_frames.shape[2] != 3:
        raise RuntimeError("GLB検証: Bodyフレーム列がありません。")
    clearances = np.asarray(
        context.get("skirt_clearance_local_units", []),
        dtype=np.float32,
    )
    if clearances.shape != (len(base_vertices),):
        raise RuntimeError(
            "GLB検証: ローカル単位のクリアランスがありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    thigh_surface_distances = np.asarray(
        context.get("thigh_surface_min_distances", []),
        dtype=np.float32,
    )
    if thigh_surface_distances.ndim != 1 or len(thigh_surface_distances) < 2:
        raise RuntimeError(
            "GLB検証: 太腿Body面距離の診断値がありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    body_triangles = np.asarray(
        context.get("body_skin_triangles", []),
        dtype=np.int32,
    )
    thigh_mask = np.asarray(
        context.get("thigh_region_mask", []),
        dtype=bool,
    )
    if (
        body_triangles.ndim != 2
        or body_triangles.shape[1] != 3
        or thigh_mask.shape != (len(base_vertices),)
    ):
        raise RuntimeError(
            "GLB検証: Body SKIN三角形または太腿領域マスクがありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    triangle_candidates = context.get("body_vertex_triangle_neighbors")
    if (
        triangle_candidates is None
        or len(triangle_candidates) != body_frames.shape[1]
    ):
        raise RuntimeError(
            "GLB検証: 近傍三角形候補(body_vertex_triangle_neighbors)がありません。"
            " create_skirt_body_context.pyを再実行してください。"
        )
    triangle_candidates = [
        np.asarray(sorted(indices), dtype=np.int32)
        for indices in triangle_candidates
    ]

    def closest_points_on_triangles(point, triangle_points):
        a = triangle_points[:, 0]
        b = triangle_points[:, 1]
        c = triangle_points[:, 2]
        ab = b - a
        ac = c - a
        ap = point[None, :] - a
        bp = point[None, :] - b
        cp = point[None, :] - c
        d1 = np.sum(ab * ap, axis=1)
        d2 = np.sum(ac * ap, axis=1)
        d3 = np.sum(ab * bp, axis=1)
        d4 = np.sum(ac * bp, axis=1)
        d5 = np.sum(ab * cp, axis=1)
        d6 = np.sum(ac * cp, axis=1)
        va = d3 * d6 - d5 * d4
        vb = d5 * d2 - d1 * d6
        vc = d1 * d4 - d3 * d2
        denominator = np.maximum(va + vb + vc, BODY_DISTANCE_EPSILON)
        v = (vb / denominator)[:, None]
        w = (vc / denominator)[:, None]
        closest = a + ab * v + ac * w
        # 優先度の低い領域から順に上書きし、Ericson法と同じ判定順序にする
        edge_bc = ((d4 - d3) + (d5 - d6))
        t_bc = ((d4 - d3) / np.maximum(edge_bc, BODY_DISTANCE_EPSILON))[:, None]
        closest = np.where(
            ((va <= 0.0) & ((d4 - d3) >= 0.0) & ((d5 - d6) >= 0.0))[:, None],
            b + (c - b) * t_bc,
            closest,
        )
        t_ac = (d2 / np.maximum(d2 - d6, BODY_DISTANCE_EPSILON))[:, None]
        closest = np.where(
            ((vb <= 0.0) & (d2 >= 0.0) & (d6 <= 0.0))[:, None],
            a + ac * t_ac,
            closest,
        )
        closest = np.where(
            ((d6 >= 0.0) & (d5 <= d6))[:, None],
            c,
            closest,
        )
        t_ab = (d1 / np.maximum(d1 - d3, BODY_DISTANCE_EPSILON))[:, None]
        closest = np.where(
            ((vc <= 0.0) & (d1 >= 0.0) & (d3 <= 0.0))[:, None],
            a + ab * t_ab,
            closest,
        )
        closest = np.where(
            ((d3 >= 0.0) & (d4 <= d3))[:, None],
            b,
            closest,
        )
        closest = np.where(
            ((d1 <= 0.0) & (d2 <= 0.0))[:, None],
            a,
            closest,
        )
        normals = np.cross(ab, ac)
        lengths = np.linalg.norm(normals, axis=1)
        return closest, normals, lengths

    def feature_angle_weight(closest, corners):
        for corner_index in range(3):
            corner = corners[corner_index]
            if np.linalg.norm(closest - corner) > SURFACE_FEATURE_TOLERANCE:
                continue
            left = corners[(corner_index + 1) % 3] - corner
            right = corners[(corner_index + 2) % 3] - corner
            left_length = np.linalg.norm(left)
            right_length = np.linalg.norm(right)
            if (
                left_length <= SURFACE_FEATURE_TOLERANCE
                or right_length <= SURFACE_FEATURE_TOLERANCE
            ):
                return 0.0
            cosine = float(
                np.dot(left / left_length, right / right_length)
            )
            return float(np.arccos(min(1.0, max(-1.0, cosine))))
        for edge_index in range(3):
            start = corners[edge_index]
            edge = corners[(edge_index + 1) % 3] - start
            length_squared = float(np.dot(edge, edge))
            if length_squared <= 1.0e-12:
                continue
            t = float(np.dot(closest - start, edge)) / length_squared
            if t < 0.0 or t > 1.0:
                continue
            projected = start + edge * t
            if np.linalg.norm(closest - projected) <= SURFACE_FEATURE_TOLERANCE:
                return float(np.pi)
        return float(2.0 * np.pi)

    def signed_surface_distance(point, body_points, candidates):
        triangle_points = body_points[body_triangles[candidates]]
        closest, normals, lengths = closest_points_on_triangles(
            point,
            triangle_points,
        )
        valid = lengths > BODY_DISTANCE_EPSILON
        if not np.any(valid):
            return None
        closest = closest[valid]
        unit_normals = normals[valid] / lengths[valid, None]
        triangle_points = triangle_points[valid]
        distances = np.linalg.norm(point[None, :] - closest, axis=1)
        best = int(np.argmin(distances))
        best_point = closest[best]
        shared = np.nonzero(
            np.linalg.norm(closest - best_point[None, :], axis=1)
            <= SURFACE_FEATURE_TOLERANCE
        )[0]
        normal_sum = np.zeros(3, dtype=np.float64)
        for shared_index in shared:
            normal_sum += unit_normals[shared_index] * feature_angle_weight(
                best_point,
                triangle_points[shared_index],
            )
        norm = float(np.linalg.norm(normal_sum))
        unit_normal = (
            normal_sum / norm if norm > 1.0e-12 else unit_normals[best]
        )
        distance = float(distances[best])
        if float(np.dot(point - best_point, unit_normal)) >= 0.0:
            return distance
        return -distance

    def minimum_signed_surface_distance(points, body_points):
        if len(points) == 0:
            return float("inf")
        deltas = points[:, None, :] - body_points[None, :, :]
        nearest_body = np.argmin(
            np.einsum("ijk,ijk->ij", deltas, deltas),
            axis=1,
        )
        minimum = float("inf")
        for point, body_vertex in zip(points, nearest_body):
            candidates = triangle_candidates[body_vertex]
            if candidates.size == 0:
                continue
            signed = signed_surface_distance(point, body_points, candidates)
            if signed is None:
                continue
            minimum = min(minimum, signed)
        return minimum
    edge_pairs = np.unique(
        np.sort(
            np.concatenate(
                [faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]],
                axis=0,
            ),
            axis=1,
        ),
        axis=0,
    )
    base_edges = np.linalg.norm(
        base_vertices[edge_pairs[:, 0]] - base_vertices[edge_pairs[:, 1]],
        axis=1,
    )
    base_y = base_vertices[:, 1]
    waistband = base_y >= np.max(base_y) - WAISTBAND_MARGIN_RATIO * max(
        float(np.ptp(base_y)),
        SMALL_DISTANCE_EPSILON,
    )
    min_area = MINIMUM_SURFACE_AREA
    min_edge_ratio = MINIMUM_EDGE_RATIO
    max_edge_ratio = MAXIMUM_EDGE_RATIO
    minimum_area = float("inf")
    maximum_edge_ratio = 0.0
    minimum_body_distance = float("inf")
    minimum_thigh_surface_distance = float("inf")
    edge_warning_count = 0
    for frame_index, frame_vertices in enumerate(vertices):
        ab = frame_vertices[faces[:, 1]] - frame_vertices[faces[:, 0]]
        ac = frame_vertices[faces[:, 2]] - frame_vertices[faces[:, 0]]
        areas = 0.5 * np.linalg.norm(np.cross(ab, ac), axis=1)
        frame_min_area = float(np.min(areas))
        minimum_area = min(minimum_area, frame_min_area)
        if frame_min_area < min_area:
            raise RuntimeError(
                f"GLB検証: frame={frame_index}に極端に小さい面があります。"
            )
        source_index = min(
            int(round(frame_index * (len(body_frames) - 1) / max(len(vertices) - 1, 1))),
            len(body_frames) - 1,
        )
        if frame_index == 0:
            # vertices[0] is explicitly reset to the exported Basis mesh.
            # Compare it with the same mesh, not with the FBX-evaluated frame
            # that may contain an animation-origin offset.
            reference = base_vertices
        else:
            reference = np.asarray(
                context["skirt_skinned_vertices"][source_index],
                dtype=np.float32,
            )
        reference_edges = np.linalg.norm(
            reference[edge_pairs[:, 0]] - reference[edge_pairs[:, 1]],
            axis=1,
        )
        edge_ratios = np.divide(
            np.linalg.norm(
                frame_vertices[edge_pairs[:, 0]]
                - frame_vertices[edge_pairs[:, 1]],
                axis=1,
            ),
            np.maximum(reference_edges, BODY_DISTANCE_EPSILON),
        )
        frame_max_ratio = float(np.max(edge_ratios))
        maximum_edge_ratio = max(maximum_edge_ratio, frame_max_ratio)
        if np.any(edge_ratios < min_edge_ratio) or np.any(edge_ratios > max_edge_ratio):
            edge_warning_count += int(
                np.sum((edge_ratios < min_edge_ratio) | (edge_ratios > max_edge_ratio))
            )
        if frame_index == 0:
            continue
        body_points = body_frames[source_index]
        surface_distance = minimum_signed_surface_distance(
            frame_vertices[thigh_mask],
            body_points,
        )
        minimum_thigh_surface_distance = min(
            minimum_thigh_surface_distance,
            surface_distance,
        )
        if surface_distance < MIN_BODY_DISTANCE_THRESHOLD:
            raise RuntimeError(
                f"GLB検証: frame={frame_index}の太腿Body面符号距離が不足しています。"
                f" distance={surface_distance:.6f}"
            )
        thigh_surface_distance = float(
            np.interp(
                frame_index / max(len(vertices) - 1, 1),
                np.linspace(0.0, 1.0, len(thigh_surface_distances)),
                thigh_surface_distances,
            )
        )
        minimum_thigh_surface_distance = min(
            minimum_thigh_surface_distance,
            thigh_surface_distance,
        )
        if thigh_surface_distance < MIN_BODY_DISTANCE_THRESHOLD:
            raise RuntimeError(
                f"GLB検証: frame={frame_index}の太腿Body面距離が不足しています。"
                f" distance={thigh_surface_distance:.6f}"
            )
        distances = np.linalg.norm(
            frame_vertices[~waistband, None, :] - body_points[None, :, :],
            axis=2,
        ).min(axis=1)
        frame_min_distance = float(np.min(distances))
        minimum_body_distance = min(minimum_body_distance, frame_min_distance)
    print(
        "[diag] GLB geometry validation: "
        f"min_area={minimum_area:.6e}, "
        f"max_edge_ratio={maximum_edge_ratio:.4f}, "
        f"min_body_distance={minimum_body_distance:.6f}, "
        f"min_thigh_surface_distance={minimum_thigh_surface_distance:.6f}, "
        f"edge_warnings={edge_warning_count}"
    )


def interpolate(values, progress):
    index = np.clip(progress, 0.0, 1.0) * (len(values) - 1)
    lower = int(np.floor(index))
    upper = min(lower + 1, len(values) - 1)
    return (1.0 - (index - lower)) * values[lower] + (index - lower) * values[upper]


def predict_vertices(progress, style_vector=None):
    angle = float(progress * max_sit_angle)
    pose = np.repeat(np.asarray([[0.0, angle, 0.0]], dtype=np.float32), len(base_vertices), axis=0)
    motion = interpolate(body_motion, progress)
    position = base_vertices + motion
    style = np.asarray(style_vector or [0.0, 0.0, 0.0], dtype=np.float32)
    if style.shape != (style_latent_dimensions,):
        raise ValueError(f"style_vectorは{style_latent_dimensions}次元で指定してください: {style}")
    style_rows = np.repeat(style[None, :], len(base_vertices), axis=0)
    if base_input_features == 9:
        inputs = np.concatenate([pose, base_vertices, motion, style_rows], axis=1)
    else:
        inputs = np.concatenate([pose, base_vertices, position, motion, style_rows], axis=1)
    with torch.inference_mode():
        output = model(torch.from_numpy(inputs).to(device=device, dtype=dtype))
    if isinstance(output, (tuple, list)):
        output = output[0]
    prediction = output.detach().cpu().numpy().astype(np.float32)
    if prediction.shape != base_vertices.shape:
        raise RuntimeError(f"DNN出力形状が不正です: {prediction.shape}")
    return base_vertices + prediction


def resolve_animation_vertices(progresses, style_name="base"):
    # この処理は何をするか
    # アニメーション出力用の全フレーム頂点軌道を決定する
    #
    # どうやって実現しているか
    # 1 PKL内に衝突回避済みの幾何教師データ (skirt_geometric_teacher_vertices) が存在する場合はそれを優先採用
    # 2 存在しない場合は DNN モデルに各進行度を入力して推論を実行
    #
    # 注意点
    # 衝突フリーな2つの姿勢を線形補間しても中間フレームで衝突フリー性は保証されないため
    # 教師フレーム数とアニメーションフレーム数が一致しない場合は補間推測せず停止させる
    style_teachers = context.get("skirt_style_teacher_vertices", {})
    teacher = style_teachers.get(style_name)
    if teacher is None:
        teacher = context.get("skirt_geometric_teacher_vertices")
    if teacher is not None:
        teacher = np.asarray(teacher, dtype=np.float32)
        expected_shape = (len(body_motion), len(base_vertices), 3)
        if teacher.shape != expected_shape:
            raise RuntimeError(
                "幾何教師の形状がbody_contextと一致しません: "
                f"{teacher.shape} != {expected_shape}"
            )
        if not np.isfinite(teacher).all():
            raise RuntimeError("幾何教師にNaNまたはInfがあります。")
        print(
            "[diag] animation source: "
            f"style={style_name} (collision-safe authoritative trajectory)"
        )
        if len(teacher) != len(progresses):
            raise RuntimeError(
                "教師フレーム数と出力フレーム数が一致しません: "
                f"teacher={len(teacher)}, animation={len(progresses)}。\n"
                "衝突回避済みの2姿勢を線形補間しても衝突回避は保たれないため、"
                "DNN_ANIMATION_FRAMESとcreate_skirt_body_context.pyの"
                "frame_countを揃えて再実行してください。"
            )
        return teacher.copy()
    print(
        "[warn] skirt_geometric_teacher_verticesがないため、"
        "DNN出力を使用します。"
    )
    return np.asarray(
        [predict_vertices(float(progress)) for progress in progresses],
        dtype=np.float32,
    )


progresses = np.linspace(0.0, 1.0, num_animation_frames, dtype=np.float32)
style_presets = context.get("style_presets", {"base": [0.0, 0.0, 0.0]})
style_vertices = {
    style_name: resolve_animation_vertices(progresses, style_name)
    for style_name in style_presets
}
vertices = style_vertices["base"]
vertices[0] = base_vertices
if not np.isfinite(vertices).all():
    raise RuntimeError("DNN出力にNaNまたはInfがあります。")
validate_generated_geometry(vertices, faces, context)

source_body_progresses = np.asarray(
    context.get("source_body_progresses", []),
    dtype=np.float32,
)
source_frames = np.asarray(context.get("source_frames", []), dtype=np.float32)
source_motion_progresses = np.linspace(
    0.0,
    1.0,
    len(body_motion),
    dtype=np.float32,
)
if source_body_progresses.shape[0] == len(body_motion):
    mapped_body_progresses = np.interp(
        progresses,
        source_motion_progresses,
        source_body_progresses,
    ).astype(np.float32)
else:
    mapped_body_progresses = np.full_like(progresses, np.nan, dtype=np.float32)
if source_frames.shape[0] == len(body_motion):
    mapped_source_frames = np.interp(
        progresses,
        source_motion_progresses,
        source_frames,
    ).astype(np.float32)
else:
    mapped_source_frames = np.full_like(progresses, np.nan, dtype=np.float32)

with open(mapping_path, "w", encoding="utf-8") as file:
    context_progress_limit = context.get("progress_limit", float("nan"))
    context_original_frame_count = context.get("original_frame_count", 0)
    context_adopted_frame_count = context.get(
        "adopted_frame_count",
        len(body_motion),
    )
    json.dump(
        {
            "format_version": 2,
            "source": "skirt_animation_dnn_morph_fixed.py",
            "glb_path": glb_path,
            "body_context_path": body_context_path,
            "frame_count": int(num_animation_frames),
            "max_sit_angle_rad": float(max_sit_angle),
            "body_context_progress_limit": float(context_progress_limit),
            "body_context_apply_runtime_leg_close": bool(
                context.get("apply_runtime_leg_close", False),
            ),
            "body_context_has_skirt_after_runtime_leg_close": bool(
                "skirt_skinned_vertices_after_runtime_leg_close" in context
            ),
            "skirt_teacher_source": (
                "geometric_hybrid_teacher"
                if "skirt_geometric_teacher_vertices" in context
                else "skirt_skinned_vertices"
            ),
            "style_latent_schema": ["length", "tightness", "pleats"],
            "style_presets": style_presets,
            "body_context_motion_norm_peak_index": context.get(
                "motion_norm_peak_index",
                None,
            ),
            "body_context_motion_norm_peak_body_progress": context.get(
                "motion_norm_peak_body_progress",
                None,
            ),
            "body_context_original_frame_count": int(
                context_original_frame_count,
            ),
            "body_context_adopted_frame_count": int(
                context_adopted_frame_count,
            ),
            "pose_mapping": [
                {
                    "key_index": int(index),
                    "shape_key": (
                        "Basis" if index == 0 else f"Pose_{index:03d}"
                    ),
                    "glb_time": float((index + 1) / BLENDER_DEFAULT_FPS),
                    "dnn_progress": float(progress),
                    "pose_y_rad": float(progress * max_sit_angle),
                    "source_body_progress": (
                        None
                        if not np.isfinite(mapped_body_progresses[index])
                        else float(mapped_body_progresses[index])
                    ),
                    "source_frame": (
                        None
                        if not np.isfinite(mapped_source_frames[index])
                        else float(mapped_source_frames[index])
                    ),
                }
                for index, progress in enumerate(progresses)
            ],
        },
        file,
        indent=2,
        ensure_ascii=False,
    )

# この処理は何をするか
# 頂点変位が基準メッシュ対角長に対して異常に巨大化していないかを検証する
#
# どうやって実現しているか
# 全フレームの最大頂点変位ノルムを基準メッシュ対角長で除算し 上限倍率 MAX_DISPLACEMENT_RATIO_LIMIT を超過していないか判定
#
# 注意点
# 異常変位が含まれるとThree.js側でバウンディングボックスが極端に膨張し モデルが画面外に消える原因となる
# 古いモデルによる学習データ不整合が疑われる場合は z-score を用いて再学習の必要性を診断する
base_extent = float(np.linalg.norm(base_vertices.max(axis=0) - base_vertices.min(axis=0)))
displacement_norms = np.linalg.norm(vertices - base_vertices[None, :, :], axis=2)
max_displacement = float(displacement_norms.max())
max_displacement_ratio = max_displacement / max(base_extent, BODY_DISTANCE_EPSILON)
if max_displacement_ratio > MAX_DISPLACEMENT_RATIO_LIMIT:
    worst_frame = int(np.argmax(displacement_norms.max(axis=1)))

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
        worst_style = np.zeros((len(base_vertices), style_latent_dimensions), dtype=np.float32)
        if base_input_features == 9:
            worst_inputs = np.concatenate([worst_pose, base_vertices, worst_motion, worst_style], axis=1)
        else:
            worst_inputs = np.concatenate([worst_pose, base_vertices, worst_position, worst_motion, worst_style], axis=1)
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

os.makedirs(output_dir, exist_ok=True)
np.savez(
    npz_path,
    vertices=vertices,
    faces=faces,
    progresses=progresses,
    **{
        f"style_{name}_vertices": sequence
        for name, sequence in style_vertices.items()
    },
)
with open(blender_data_path, "wb") as file:
    pickle.dump(
        {
            "vertices": vertices.tolist(),
            "style_vertices": {
                name: sequence.tolist()
                for name, sequence in style_vertices.items()
            },
            "faces": faces.tolist(),
        },
        file,
        protocol=4,
    )

# BlenderのPython環境にnumpyをインストールするロジックを再導入
print("BlenderのPython環境にnumpyが利用可能か確認しています...")

blender_python_executable = None
try:
    # BlenderのPythonインタプリタの実際のパスを取得
    blender_python_executable_output = subprocess.run([
        "blender", "--background", "--python-expr", "import sys; print(sys.executable)"
    ], capture_output=True, text=True, check=True)
    # Blenderの起動メッセージが混入するため、最初の行のみを取得
    blender_python_executable = blender_python_executable_output.stdout.strip().split('\n')[0]
    print(f"BlenderのPython実行可能パス: {blender_python_executable}")

    if not blender_python_executable or not os.path.exists(blender_python_executable):
        raise RuntimeError("BlenderのPython実行可能パスを取得できませんでした。")

    # numpyが既にインストールされているかBlenderのPythonでチェック
    check_numpy_script = """
import sys
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

# Blender起動スクリプトの先頭でsys.pathにColabのライブラリパスを追加
blender_script = r'''
import sys
colab_path = f"/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages"
if colab_path not in sys.path:
    sys.path.insert(0, colab_path)

import os
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
style_vertices = data.get("style_vertices", {"base": vertices})
faces = data["faces"]
if len(vertices) != frame_count or not vertices or not vertices[0] or len(vertices[0][0]) != 3:
    raise RuntimeError("頂点アニメーション形状が不正です。")
for style_name, sequence in style_vertices.items():
    if len(sequence) != frame_count or len(sequence[0]) != len(vertices[0]):
        raise RuntimeError(f"スタイル頂点アニメーション形状が不正です: {style_name}")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
mesh = bpy.data.meshes.new("BottomsSkirtAnimationMesh")
mesh.from_pydata(vertices[0], [], faces)
mesh.update()
obj = bpy.data.objects.new("Skirt_Animated_Bottoms", mesh)
bpy.context.collection.objects.link(obj)
obj.shape_key_add(name="Basis")
for frame_index in range(1, frame_count):
    key = obj.shape_key_add(name=f"Pose_{frame_index:03d}")
    for vertex_index, vertex in enumerate(vertices[frame_index]):
        key.data[vertex_index].co = tuple(float(value) for value in vertex)

# 代表スタイルごとの全姿勢を静的モーフとして保存する。
# Three.jsはPoseとStyleを別々に加算せず、ここにある完全形状を重み付きで合成する。
for style_name, sequence in style_vertices.items():
    safe_name = "".join(character if character.isalnum() else "_" for character in style_name)
    # 立位フレームもスタイル固有の完全形状として出力する。
    # frame 0 を省くと、Three.js側で立位スタイルを選んでも適用先がない。
    for frame_index in range(frame_count):
        key = obj.shape_key_add(name=f"Style_{safe_name}_{frame_index:03d}")
        for vertex_index, vertex in enumerate(sequence[frame_index]):
            key.data[vertex_index].co = tuple(float(value) for value in vertex)

shape_keys = obj.data.shape_keys.key_blocks
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = frame_count
for key in shape_keys:
    key.value = 0.0
for frame_index in range(1, frame_count):
    key = shape_keys[f"Pose_{frame_index:03d}"]
    frame = frame_index + 1
    key.value = 0.0
    key.keyframe_insert(data_path="value", frame=frame - 1)
    key.value = 1.0
    key.keyframe_insert(data_path="value", frame=frame)
    if frame < frame_count:
        key.value = 0.0
        key.keyframe_insert(data_path="value", frame=frame + 1)
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
try:
    result = subprocess.run([
        "blender", "--background", "--python-exit-code", "1",
        "--python", blender_script_path, "--", blender_data_path, glb_path,
        blend_path, str(num_animation_frames),
    ], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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
print(f"姿勢対応情報を保存しました: {mapping_path}")
print(f"頂点数: {len(base_vertices):,}, 面数: {len(faces):,}, フレーム数: {num_animation_frames}")
