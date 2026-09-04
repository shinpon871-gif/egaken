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
blender_data_path = os.path.join(output_dir, "skirt_animation_vertices_for_blender.pkl")

# Colabの%run -iはセルを再実行してもカーネルの変数(globals())が残り続ける。
# 「まだ無ければ読み込む」だと、前回の実行(あるいは別のPKLに対する実行)で
# 残った古いbase_skirt_pcを誤って使い回してしまうため、PKLが存在する限り
# 常にそちらを正として読み直す。
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
if input_features not in (9, 12):
    raise RuntimeError(f"DNN入力次元は9または12が必要です: {input_features}")

with open(body_context_path, "rb") as file:
    context = pickle.load(file)
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
    raise RuntimeError(
        "base_skirt_pcの縮尺がbody_context PKLのskirt_base_verticesと一致しません。\n"
        f"base_skirt_pc対角長: {base_vertices_extent:.6f}, "
        f"PKL skirt_base_vertices対角長: {context_skirt_extent:.6f}\n"
        "base_skirt_pcがColabカーネルに残っている別スケール・別ソースのメッシュの"
        "可能性があります。base_skirt_pc/base_skirt_facesの変数を削除してから、"
        f"{body_context_path} のskirt_base_vertices/skirt_facesを使い直してください。"
    )
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


progresses = np.linspace(0.0, 1.0, num_animation_frames, dtype=np.float32)
vertices = np.asarray([predict_vertices(float(progress)) for progress in progresses])
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
    key = obj.shape_key_add(name=f"Pose_{frame_index:03d}")
    for vertex_index, vertex in enumerate(vertices[frame_index]):
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
print(f"頂点数: {len(base_vertices):,}, 面数: {len(faces):,}, フレーム数: {num_animation_frames}")