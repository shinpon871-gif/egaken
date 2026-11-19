# scripts/approve_skirt_length_release.py
"""スカートLength候補の最終画像QAと公開承認スクリプト

概要
- 数値QAを通過したLength候補のmanifestを読み込む
- 立位・遷移・座位の正面/側面6画像を参照画像と比較する
- 全チェックを通過した場合だけmanifestをapprovedへ更新する

必須データ
- create_skirt_body_context.pyが生成したrelease manifest(教師データ由来のLength候補)
- render_skirt_length_views.pyが出力した候補ごとの6視点PNG
- 同じファイル名の目視確認済み参照PNG

使い方
    python scripts/approve_skirt_length_release.py [manifest] [qa_dir] [reference_dir] [reviewer]
"""

import hashlib
import json
import os
import sys


DEFAULT_ARGUMENTS = [
    os.environ.get(
        "SKIRT_LENGTH_MANIFEST_PATH",
        "public/models/skirt_length_release_manifest.json",
    ),
    os.environ.get(
        "SKIRT_LENGTH_QA_DIR",
        "docs/skirt_length_qa/rendered",
    ),
    os.environ.get(
        "SKIRT_LENGTH_REFERENCE_DIR",
        "docs/skirt_length_qa/approved_reference",
    ),
    os.environ.get("SKIRT_LENGTH_REVIEWER", ""),
]

REQUIRED_VIEWS = (
    "standing_front",
    "standing_side",
    "transition_front",
    "transition_side",
    "seated_front",
    "seated_side",
)

REQUIRED_PIPELINE_VERSION = "geometric_length_rings_v3_dense_face_checked"
REQUIRED_SOURCE = "geometric_teacher_length_rings"
DEFAULT_PUBLIC_RELEASE_PATH = "public/models/skirt_length_release.json"
APPROVER_REVISION = "approve_geometric_length_gate_20261119"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_arguments():
    # Colabのノートブックセルで%run/execすると sys.argv はipykernelの
    # 起動引数("-f", "kernel-....json"等)になり、ユーザー引数ではない。
    if "--" in sys.argv:
        arguments = sys.argv[sys.argv.index("--") + 1:]
    elif len(sys.argv[1:]) == 4 and not sys.argv[1].startswith("-"):
        arguments = sys.argv[1:]
    else:
        arguments = DEFAULT_ARGUMENTS
    argument_names = (
        "MANIFEST (SKIRT_LENGTH_MANIFEST_PATH)",
        "QA_DIR (SKIRT_LENGTH_QA_DIR)",
        "REFERENCE_DIR (SKIRT_LENGTH_REFERENCE_DIR)",
        "REVIEWER (SKIRT_LENGTH_REVIEWER)",
    )
    if len(arguments) != 4:
        print(
            f"[length-approve] blocked: expected 4 arguments, got {len(arguments)}",
            flush=True,
        )
        return DEFAULT_ARGUMENTS
    return arguments


def write_public_release(manifest, path):
    public_manifest = {
        "schema_version": 1,
        "release_status": manifest.get("release_status", "blocked"),
        "image_qa": manifest.get("image_qa", {"status": "pending"}),
        "approved_by": manifest.get("approved_by"),
        "context_sha256": manifest.get("context_sha256"),
        "candidates": {
            name: {
                "extension_ratio": candidate.get("extension_ratio"),
            }
            for name, candidate in manifest.get("candidates", {}).items()
            if candidate.get("numeric_qa") == "pass"
            and candidate.get("image_qa") == "pass"
        },
    }
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(public_manifest, file, indent=2, ensure_ascii=False)
    print(f"[length-approve] public release written: {path}", flush=True)


def main():
    manifest_path, qa_dir, reference_dir, reviewer = get_arguments()
    print(f"[length-approve] approver revision: {APPROVER_REVISION}", flush=True)
    print(f"[length-approve] manifest: {manifest_path}", flush=True)
    print(f"[length-approve] QA directory: {qa_dir}", flush=True)
    print(f"[length-approve] reference directory: {reference_dir}", flush=True)
    print(f"[length-approve] reviewer: {reviewer}", flush=True)
    if not reviewer.strip():
        raise ValueError("Reviewer name must not be empty.")
    if not os.path.isfile(manifest_path):
        print(f"[length-approve] blocked: manifest not found: {manifest_path}", flush=True)
        write_public_release({"release_status": "blocked", "candidates": {}}, DEFAULT_PUBLIC_RELEASE_PATH)
        return
    with open(manifest_path, "r", encoding="utf-8") as file:
        manifest = json.load(file)
    candidates = manifest.get("candidates", {})
    if not candidates:
        print("[length-approve] blocked: manifest contains no candidates.", flush=True)
        write_public_release(manifest, DEFAULT_PUBLIC_RELEASE_PATH)
        return
    print(f"[length-approve] candidates loaded: {len(candidates)}", flush=True)
    if (
        manifest.get("pipeline_version") != REQUIRED_PIPELINE_VERSION
        or manifest.get("source") != REQUIRED_SOURCE
    ):
        print(
            "[length-approve] blocked: unsupported Length pipeline: "
            f"{manifest.get('source')} / {manifest.get('pipeline_version')}. "
            "create_skirt_body_context.pyで再生成してください。",
            flush=True,
        )
        write_public_release(manifest, DEFAULT_PUBLIC_RELEASE_PATH)
        return
    # 承認は特定のcontext PKLに対するものなので、同じディレクトリのPKLと一致を確認する。
    context_path = os.path.join(
        os.path.dirname(manifest_path), "skirt_body_context_for_dnn.pkl"
    )
    if not os.path.isfile(context_path) or sha256(context_path) != manifest.get("context_sha256"):
        print(
            "[length-approve] blocked: manifest does not match the context PKL next to it.",
            flush=True,
        )
        write_public_release(manifest, DEFAULT_PUBLIC_RELEASE_PATH)
        return

    failures = []
    for candidate_name, candidate in candidates.items():
        print(f"[length-approve] checking candidate: {candidate_name}", flush=True)
        if candidate.get("numeric_qa") != "pass":
            failures.append(f"numeric QA failed: {candidate_name}")
            continue
        checked_views = 0
        for view_name in REQUIRED_VIEWS:
            filename = f"{candidate_name}_{view_name}.png"
            rendered = os.path.join(qa_dir, filename)
            reference = os.path.join(reference_dir, filename)
            if not os.path.isfile(rendered):
                failures.append(f"missing rendered view: {filename}")
                continue
            if not os.path.isfile(reference):
                failures.append(f"missing approved reference: {filename}")
                continue
            if sha256(rendered) != sha256(reference):
                failures.append(f"image regression mismatch: {filename}")
            else:
                checked_views += 1
        print(
            f"[length-approve] image checks: {candidate_name} "
            f"{checked_views}/{len(REQUIRED_VIEWS)} passed",
            flush=True,
        )

    if failures:
        for candidate in candidates.values():
            if candidate.get("numeric_qa") == "pass":
                candidate["image_qa"] = "failed"
        manifest["image_qa"] = {
            "status": "failed",
            "reviewer": reviewer,
            "comparison": "sha256 exact PNG equality",
            "failures": failures,
        }
        manifest["release_status"] = "blocked"
    else:
        for candidate in candidates.values():
            candidate["image_qa"] = "pass"
        manifest["image_qa"] = {
            "status": "pass",
            "reviewer": reviewer,
            "comparison": "sha256 exact PNG equality against visually approved references",
            "views_per_candidate": len(REQUIRED_VIEWS),
        }
        manifest["release_status"] = "approved"
        manifest["approved_by"] = reviewer

    with open(manifest_path, "w", encoding="utf-8") as file:
        json.dump(manifest, file, indent=2, ensure_ascii=False)
    public_release_path = os.environ.get(
        "SKIRT_LENGTH_PUBLIC_RELEASE_PATH",
        DEFAULT_PUBLIC_RELEASE_PATH,
    )
    write_public_release(manifest, public_release_path)
    print(
        f"[length-approve] manifest written: status={manifest['release_status']}",
        flush=True,
    )
    if failures:
        print(
            "[length-approve] release blocked; no Length candidate was approved.",
            flush=True,
        )
        for failure in failures:
            print(f"[length-approve] {failure}", flush=True)
        return
    print(f"Length release approved for {len(candidates)} candidates by {reviewer}.")


if __name__ == "__main__":
    main()
