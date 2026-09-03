import argparse
import json
import math
import os
import struct
import sys
from typing import Any


DEFAULT_GLB_PATH = "/content/public/models/skirt_mesh_sitting_animation.glb"


COMPONENT_TYPE_FORMATS = {
    5120: ("b", 1),
    5121: ("B", 1),
    5122: ("h", 2),
    5123: ("H", 2),
    5125: ("I", 4),
    5126: ("f", 4),
}

ACCESSOR_TYPE_SIZES = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def read_glb(path: str) -> tuple[dict[str, Any], bytes]:
    with open(path, "rb") as file:
        data = file.read()

    if len(data) < 12:
        raise ValueError("GLBヘッダーが短すぎます。")

    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError(f"GLBではありません: magic={magic!r}")
    if version != 2:
        raise ValueError(f"glTF 2.0ではありません: version={version}")
    if length != len(data):
        raise ValueError(f"GLB長が一致しません: header={length}, actual={len(data)}")

    json_chunk = None
    bin_chunk = b""
    offset = 12

    while offset < length:
        if offset + 8 > length:
            raise ValueError("チャンクヘッダーが途中で終わっています。")

        chunk_length, chunk_type = struct.unpack_from("<I4s", data, offset)
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_length
        if chunk_end > length:
            raise ValueError("チャンク長がGLB全体長を超えています。")

        chunk_data = data[chunk_start:chunk_end]
        if chunk_type == b"JSON":
            json_text = chunk_data.rstrip(b"\x00 \t\r\n").decode("utf-8")
            json_chunk = json.loads(json_text)
        elif chunk_type == b"BIN\x00":
            bin_chunk = chunk_data

        offset = chunk_end

    if json_chunk is None:
        raise ValueError("JSONチャンクが見つかりません。")

    return json_chunk, bin_chunk


def read_accessor(
    gltf: dict[str, Any],
    bin_chunk: bytes,
    accessor_index: int,
) -> list[float | int]:
    accessors = gltf.get("accessors", [])
    buffer_views = gltf.get("bufferViews", [])

    accessor = accessors[accessor_index]
    if "sparse" in accessor:
        raise NotImplementedError("sparse accessorはこの確認スクリプトでは未対応です。")

    buffer_view = buffer_views[accessor["bufferView"]]
    component_type = accessor["componentType"]
    accessor_type = accessor["type"]
    count = accessor["count"]

    if component_type not in COMPONENT_TYPE_FORMATS:
        raise ValueError(f"未対応のcomponentTypeです: {component_type}")
    if accessor_type not in ACCESSOR_TYPE_SIZES:
        raise ValueError(f"未対応のaccessor typeです: {accessor_type}")

    struct_format, component_size = COMPONENT_TYPE_FORMATS[component_type]
    item_size = ACCESSOR_TYPE_SIZES[accessor_type]
    byte_stride = buffer_view.get("byteStride", component_size * item_size)
    base_offset = (
        buffer_view.get("byteOffset", 0)
        + accessor.get("byteOffset", 0)
    )

    values: list[float | int] = []
    for item_index in range(count):
        item_offset = base_offset + item_index * byte_stride
        for component_index in range(item_size):
            component_offset = item_offset + component_index * component_size
            values.append(
                struct.unpack_from(
                    "<" + struct_format,
                    bin_chunk,
                    component_offset,
                )[0]
            )

    return values


def read_vec3_accessor(
    gltf: dict[str, Any],
    bin_chunk: bytes,
    accessor_index: int,
) -> list[list[float]]:
    accessor = gltf.get("accessors", [])[accessor_index]
    if accessor.get("type") != "VEC3":
        raise ValueError("VEC3 accessorではありません。")
    values = read_accessor(gltf, bin_chunk, accessor_index)
    return [
        [
            float(values[index]),
            float(values[index + 1]),
            float(values[index + 2]),
        ]
        for index in range(0, len(values), 3)
    ]


def compute_bounds(vertices: list[list[float]]) -> dict[str, Any]:
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for vertex in vertices:
        for axis in range(3):
            value = float(vertex[axis])
            minimum[axis] = min(minimum[axis], value)
            maximum[axis] = max(maximum[axis], value)
    size = [maximum[axis] - minimum[axis] for axis in range(3)]
    diagonal = math.sqrt(sum(value * value for value in size))
    return {
        "min": minimum,
        "max": maximum,
        "size": size,
        "diagonal": diagonal,
    }


def format_vector(values: list[float]) -> str:
    return "[" + ", ".join(f"{value:.6f}" for value in values) + "]"


def interpolate_weights(
    times: list[float | int],
    values: list[float | int],
    item_size: int,
    progress: float,
) -> list[float]:
    if not times or item_size <= 0:
        return []
    time_values = [float(value) for value in times]
    duration = time_values[-1]
    sample_time = max(0.0, min(1.0, progress)) * duration
    lower = 0
    while (
        lower + 1 < len(time_values)
        and time_values[lower + 1] <= sample_time
    ):
        lower += 1
    if lower + 1 >= len(time_values):
        start = lower * item_size
        return [float(value) for value in values[start:start + item_size]]
    upper = lower + 1
    lower_time = time_values[lower]
    upper_time = time_values[upper]
    if upper_time <= lower_time:
        weight = 0.0
    else:
        weight = (sample_time - lower_time) / (upper_time - lower_time)
    lower_start = lower * item_size
    upper_start = upper * item_size
    return [
        float(values[lower_start + index]) * (1.0 - weight)
        + float(values[upper_start + index]) * weight
        for index in range(item_size)
    ]


def apply_morph_targets(
    base_vertices: list[list[float]],
    target_deltas: list[list[list[float]]],
    weights: list[float],
) -> list[list[float]]:
    vertices = [vertex.copy() for vertex in base_vertices]
    for target_index, target in enumerate(target_deltas):
        if target_index >= len(weights):
            break
        weight = float(weights[target_index])
        if abs(weight) <= 1.0e-8:
            continue
        for vertex_index, delta in enumerate(target):
            vertices[vertex_index][0] += delta[0] * weight
            vertices[vertex_index][1] += delta[1] * weight
            vertices[vertex_index][2] += delta[2] * weight
    return vertices


def describe_meshes(gltf: dict[str, Any]) -> None:
    meshes = gltf.get("meshes", [])
    accessors = gltf.get("accessors", [])

    print(f"シーン内のメッシュ数: {len(meshes)}")
    for mesh_index, mesh in enumerate(meshes):
        print(f"  Mesh {mesh_index}: {mesh.get('name', 'Unnamed')}")
        for primitive_index, primitive in enumerate(
            mesh.get("primitives", [])
        ):
            position_accessor_index = primitive.get("attributes", {}).get(
                "POSITION"
            )
            vertex_count = (
                accessors[position_accessor_index]["count"]
                if position_accessor_index is not None
                else "N/A"
            )
            index_accessor_index = primitive.get("indices")
            face_count = (
                accessors[index_accessor_index]["count"] // 3
                if index_accessor_index is not None
                else "N/A"
            )
            morph_target_count = len(primitive.get("targets", []))
            print(
                "    Primitive "
                f"{primitive_index}: 頂点数={vertex_count}, 面数={face_count}, "
                f"morphTarget数={morph_target_count}"
            )


def describe_animations(gltf: dict[str, Any], bin_chunk: bytes) -> bool:
    animations = gltf.get("animations", [])
    if not animations:
        print("GLBファイルにはglTF animations配列がありません。")
        return False

    has_weight_animation = False
    print(f"GLBファイルには {len(animations)} 個のglTFアニメーションが含まれています。")

    for animation_index, animation in enumerate(animations):
        channels = animation.get("channels", [])
        samplers = animation.get("samplers", [])
        print(
            f"  Animation {animation_index}: "
            f"{animation.get('name', 'Unnamed')}"
        )
        print(f"    channels={len(channels)}, samplers={len(samplers)}")

        for channel_index, channel in enumerate(channels):
            target = channel.get("target", {})
            target_path = target.get("path")
            sampler = samplers[channel["sampler"]]
            times = read_accessor(gltf, bin_chunk, sampler["input"])
            values = read_accessor(gltf, bin_chunk, sampler["output"])
            item_size = len(values) // len(times) if times else 0
            interpolation = sampler.get("interpolation", "LINEAR")

            if target_path == "weights":
                has_weight_animation = True

            print(
                f"    Channel {channel_index}: node={target.get('node')}, "
                f"path={target_path}, interpolation={interpolation}, "
                f"keyframes={len(times)}, valueSize={item_size}"
            )

            if times:
                print(f"      time range: {times[0]:.6f} -> {times[-1]:.6f}")

            sample_indices = (
                sorted({0, 1, len(times) // 2, len(times) - 1})
                if times
                else []
            )
            for key_index in sample_indices:
                start = key_index * item_size
                end = start + item_size
                key_values = values[start:end]
                nonzero = [
                    (value_index, value)
                    for value_index, value in enumerate(key_values)
                    if abs(float(value)) > 1.0e-6
                ]
                preview = ", ".join(
                    f"{value_index}:{float(value):.3f}"
                    for value_index, value in nonzero[:8]
                )
                print(
                    f"      key {key_index}: "
                    f"time={float(times[key_index]):.6f}, "
                    f"nonzeroWeights={len(nonzero)}"
                    + (f", {preview}" if preview else "")
                )

    if has_weight_animation:
        print("判定: Shape Key / morph target のweightsアニメーションが存在します。")
    else:
        print("判定: animations配列はありますが、weightsアニメーションは見つかりません。")

    return has_weight_animation


def describe_morph_bounds(
    gltf: dict[str, Any],
    bin_chunk: bytes,
    max_diagonal_ratio: float,
    max_axis_ratio: float,
) -> bool:
    meshes = gltf.get("meshes", [])
    animations = gltf.get("animations", [])
    if not meshes or not animations:
        return False

    primitive = None
    for mesh in meshes:
        for candidate in mesh.get("primitives", []):
            if candidate.get("targets"):
                primitive = candidate
                break
        if primitive is not None:
            break
    if primitive is None:
        print("morph target付きPrimitiveが見つかりません。")
        return False

    position_accessor_index = primitive.get("attributes", {}).get("POSITION")
    if position_accessor_index is None:
        print("POSITION accessorが見つかりません。")
        return False

    base_vertices = read_vec3_accessor(
        gltf,
        bin_chunk,
        position_accessor_index,
    )
    target_deltas = []
    for target in primitive.get("targets", []):
        target_position_accessor_index = target.get("POSITION")
        if target_position_accessor_index is None:
            continue
        target_deltas.append(
            read_vec3_accessor(gltf, bin_chunk, target_position_accessor_index)
        )

    weight_sampler = None
    for animation in animations:
        samplers = animation.get("samplers", [])
        for channel in animation.get("channels", []):
            if channel.get("target", {}).get("path") == "weights":
                weight_sampler = samplers[channel["sampler"]]
                break
        if weight_sampler is not None:
            break
    if weight_sampler is None:
        print("weights animation samplerが見つかりません。")
        return False

    times = read_accessor(gltf, bin_chunk, weight_sampler["input"])
    values = read_accessor(gltf, bin_chunk, weight_sampler["output"])
    item_size = len(values) // len(times) if times else 0
    basis_bounds = compute_bounds(base_vertices)
    basis_size = basis_bounds["size"]
    basis_diagonal = max(float(basis_bounds["diagonal"]), 1.0e-12)
    axis_floor = basis_diagonal * 0.05

    print()
    print("=" * 70)
    print("morph再生時の形状サイズ確認")
    print("=" * 70)
    print(f"Basisサイズ       : {format_vector(basis_size)}")
    print(f"Basis対角長       : {basis_diagonal:.6f}")

    ok = True
    sample_progresses = [0.0, 0.25, 0.5, 0.75, 1.0]
    for progress in sample_progresses:
        weights = interpolate_weights(times, values, item_size, progress)
        morphed = apply_morph_targets(base_vertices, target_deltas, weights)
        bounds = compute_bounds(morphed)
        size = bounds["size"]
        diagonal_ratio = float(bounds["diagonal"]) / basis_diagonal
        axis_ratio = max(
            size[axis] / max(basis_size[axis], axis_floor)
            for axis in range(3)
        )
        nonzero_weights = sum(1 for value in weights if abs(value) > 1.0e-6)
        print(
            f"進捗 {progress * 100:5.1f}%: "
            f"size={format_vector(size)}, "
            f"対角比={diagonal_ratio:.6f}, "
            f"最大軸比={axis_ratio:.6f}, "
            f"有効weights={nonzero_weights}"
        )
        if diagonal_ratio > max_diagonal_ratio or axis_ratio > max_axis_ratio:
            ok = False

    if ok:
        print("判定: morph再生時の形状サイズは許容範囲内です。")
    else:
        print("判定: morph再生時の形状サイズが異常です。")

    return ok


def main() -> None:
    parser = argparse.ArgumentParser(
        description="GLB内のglTFモーフターゲットアニメーションを直接確認します。"
    )
    parser.add_argument(
        "glb_path",
        nargs="?",
        default=DEFAULT_GLB_PATH,
        help="確認するGLBファイルパス",
    )
    parser.add_argument(
        "--max-diagonal-ratio",
        type=float,
        default=2.0,
        help="Basis対角長に対する許容最大比",
    )
    parser.add_argument(
        "--max-axis-ratio",
        type=float,
        default=2.5,
        help="Basis各軸サイズに対する許容最大比",
    )
    argv = sys.argv[1:]
    filtered_argv: list[str] = []
    ignored_argv: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "-f" and index + 1 < len(argv):
            ignored_argv.extend(argv[index:index + 2])
            index += 2
            continue
        if arg.startswith("--f=") or arg.startswith("--file="):
            ignored_argv.append(arg)
            index += 1
            continue
        filtered_argv.append(arg)
        index += 1

    args, unknown_args = parser.parse_known_args(filtered_argv)
    ignored_argv.extend(unknown_args)
    if ignored_argv:
        print(
            "未使用の起動引数を無視します: "
            + " ".join(ignored_argv)
        )

    glb_path = args.glb_path
    print(f"GLBファイルの読み込み: {glb_path}")

    if not os.path.isfile(glb_path):
        raise FileNotFoundError(f"GLBファイルが見つかりません: {glb_path}")

    gltf, bin_chunk = read_glb(glb_path)
    print("GLB JSONチャンクを直接読み込みました。")
    print(f"BINチャンクサイズ: {len(bin_chunk):,} bytes")

    describe_meshes(gltf)
    has_weight_animation = describe_animations(gltf, bin_chunk)
    bounds_ok = describe_morph_bounds(
        gltf,
        bin_chunk,
        args.max_diagonal_ratio,
        args.max_axis_ratio,
    )

    if not has_weight_animation or not bounds_ok:
        raise RuntimeError("GLB morph animation検査に失敗しました。")


if __name__ == "__main__":
    main()
