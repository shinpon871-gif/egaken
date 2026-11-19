# scripts/run_skirt_pipeline.py
"""スカート学習から GLB 生成までの全自動実行スクリプト
Colab のセルへのコード貼り付けを不要にする。ローカル Mac でも Colab でも同じ形で動く。

概要
- context 生成、DNN 学習、GLB 出力を順に実行し、各段階の成果物を検証する

使い方
    python scripts/run_skirt_pipeline.py [--output DIR] [--fbx PATH] [--steps context,render,train,glb]

既定の steps は context,train,glb。
render は Length 候補の6視点画像QA(docs/skirt_length_qa/rendered)を作る。画像を目視した後に
scripts/approve_skirt_length_release.py で承認すると、GLBにLength候補が含まれる。
Blender が PATH 上に無い場合は環境変数 BLENDER_BIN で指定する。
"""

import argparse
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import time

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPTS_DIR)


def log(message):
    print(f"[pipeline] {message}", flush=True)


def ensure_blender():
    blender_bin = os.environ.get("BLENDER_BIN")
    if blender_bin:
        wrapper_dir = tempfile.mkdtemp(prefix="blender_bin_")
        wrapper = os.path.join(wrapper_dir, "blender")
        with open(wrapper, "w", encoding="utf-8") as file:
            file.write(f'#!/bin/sh\nexec "{blender_bin}" "$@"\n')
        os.chmod(wrapper, 0o755)
        os.environ["PATH"] = wrapper_dir + os.pathsep + os.environ["PATH"]
    if shutil.which("blender") is None:
        raise RuntimeError(
            "Blender が見つかりません。Colab なら apt-get install -y blender、"
            "Mac なら BLENDER_BIN=/path/to/Blender を指定してください。"
        )


def run_script(name, extra_globals=None):
    # 学習・GLB スクリプトは globals().get で設定を読む前提なので runpy で渡す。
    path = os.path.join(SCRIPTS_DIR, name)
    log(f"start {name}")
    started = time.time()
    result = runpy.run_path(path, init_globals=extra_globals or {}, run_name="__pipeline__")
    log(f"done {name} ({time.time() - started:.0f}s)")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=os.path.join(REPO_ROOT, "public", "models"))
    parser.add_argument(
        "--fbx", default=os.path.join(REPO_ROOT, "public", "models", "StandToSit_model.fbx")
    )
    parser.add_argument("--steps", default="context,train,glb")
    args = parser.parse_args()
    steps = [step.strip() for step in args.steps.split(",") if step.strip()]
    unknown = set(steps) - {"context", "render", "train", "glb"}
    if unknown:
        raise SystemExit(f"unknown steps: {sorted(unknown)}")

    output = os.path.abspath(args.output)
    fbx = os.path.abspath(args.fbx)
    context = os.path.join(output, "skirt_body_context_for_dnn.pkl")
    os.makedirs(output, exist_ok=True)
    if not os.path.isfile(fbx):
        raise SystemExit(f"FBX not found: {fbx}")
    ensure_blender()

    os.environ["DNN_BODY_FBX_PATH"] = fbx
    os.environ["DNN_BODY_CONTEXT_PATH"] = context
    settings = {"DNN_OUTPUT_DIR": output, "DNN_BODY_CONTEXT_PATH": context}

    trained = {}
    if "context" in steps:
        subprocess.run(
            [sys.executable, os.path.join(SCRIPTS_DIR, "create_skirt_body_context.py")],
            check=True,
        )
    if "render" in steps:
        subprocess.run(
            [
                sys.executable,
                os.path.join(SCRIPTS_DIR, "render_skirt_length_views.py"),
                context,
                os.path.join(REPO_ROOT, "docs", "skirt_length_qa", "rendered"),
            ],
            check=True,
        )
    if "train" in steps or "glb" in steps:
        # glb は学習済み model を必要とするため、train を省いた場合も同じ設定で学習する。
        trained = run_script("train_skirt_sitting_dnn.py", settings)
    if "glb" in steps:
        run_script(
            "skirt_animation_dnn_morph_fixed.py",
            {**settings, "model": trained["model"]},
        )
        glb = os.path.join(output, "skirt_mesh_sitting_animation.glb")
        if not os.path.isfile(glb) or os.path.getsize(glb) == 0:
            raise RuntimeError(f"GLB が生成されていません: {glb}")
        log(f"GLB: {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")
    log("all steps finished")


if __name__ == "__main__":
    main()
