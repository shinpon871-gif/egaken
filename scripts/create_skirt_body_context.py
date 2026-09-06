# scripts\create_skirt_body_context.py
# スカートアニメーション用のBodyコンテキスト作成スクリプト
# Colab環境でBlender付属Pythonから実行することを想定している
import importlib
import os
import shutil
import subprocess
import sys
import tempfile


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
    os.environ.get("DNN_TRUNCATE_AFTER_MOTION_PEAK", "0"),
    os.environ.get("DNN_APPLY_RUNTIME_LEG_CLOSE", "1"),
]


def get_arguments():
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
    return r'''import bpy
import math
import os
import pickle
import re
import sys

from mathutils import Quaternion, Vector


THIGH_CLOSE_START_PROGRESS = 0.12
THIGH_CLOSE_FULL_PROGRESS = 0.58
INNER_THIGH_SAMPLE_T = 0.34
TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE = 0.010
TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE = 0.07
TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE = 0.42
HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE = 0.010
HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE = 0.05
HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE = 0.22
MAX_THIGH_ADDUCTION_LOCAL_ANGLE = math.radians(17.5)
MAX_WORLD_KNEE_ALIGN_ANGLE = math.radians(4.0)
CALIBRATION_TEST_ANGLE = math.radians(2.5)
GAP_EPSILON_MIN = 0.001
LEG_SIDE_KEEP_EPSILON = 0.001
LEG_CLOSE_PROGRESS_ACTIVE_EPSILON = 0.0001
CROSS_AXIS_MIN_LENGTH_SQ = 1.0e-8
DIRECTION_ALIGNMENT_MIN_ANGLE = 1.0e-5
AXIS_CALIBRATION_Y_PENALTY_WEIGHT = 0.25
AXIS_CALIBRATION_Z_PENALTY_WEIGHT = 0.25
AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT = 0.12
AXIS_CALIBRATION_SIDE_BREAK_PENALTY = 0.4
AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE = -0.05
REFINE_TRIGGER_INNER_GAP_MARGIN = 0.002
REFINE_TRIGGER_KNEE_GAP_MARGIN = 0.01
TARGET_SIDE_CLAMP_EPSILON = 0.001
LEG_CLOSE_BASE_SCALES = [
    2.40, 2.20, 2.00, 1.80, 1.60, 1.40,
    1.20, 1.00, 0.80, 0.60, 0.40, 0.20,
]
LEG_CLOSE_ASYMMETRY_OFFSETS = [0.0, -0.12, 0.12, -0.22, 0.22]
SCORE_INNER_GAP_WEIGHT = 1400
SCORE_INNER_EXCESS_WEIGHT = 600
SCORE_KNEE_GAP_WEIGHT = 55
SCORE_KNEE_EXCESS_WEIGHT = 20
SCORE_ANKLE_BONUS_WEIGHT = 0.5
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


def progress_log(message):
    print(f"[progress] {message}", flush=True)


def should_log_progress(index, total):
    if total <= 1:
        return True
    if index == 0 or index == total - 1:
        return True
    interval = max(1, total // 10)
    return index % interval == 0


def find_pose_bone_by_name_pattern(armature_object, patterns):
    if armature_object is None:
        return None
    for bone in armature_object.pose.bones:
        if any(pattern.search(bone.name) for pattern in patterns):
            return bone
    return None


def collect_leg_close_bones(armature_object):
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
skirt_skinned_vertices = []
sampled_body_progresses = []
sampled_source_frames = []
progress_log(f"Body/SKIN評価を開始します: frames={frame_count}")
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
    if apply_runtime_leg_close:
        apply_runtime_leg_close_to_pose(
            leg_close_bones,
            seated_leg_reference,
            leg_adduction_calibration,
            progress,
        )
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
        skirt_vertices = [[
            float(evaluated_mesh.vertices[index].co.x),
            float(evaluated_mesh.vertices[index].co.y),
            float(evaluated_mesh.vertices[index].co.z),
        ] for index in skirt_vertex_indices]
    finally:
        evaluated_object.to_mesh_clear()
    if len(vertices) != vertex_count:
        raise RuntimeError("評価後Body/SKIN頂点数が一致しません。")
    if len(skirt_vertices) != len(skirt_vertex_indices):
        raise RuntimeError("評価後Body/Bottoms頂点数が一致しません。")
    skinned_vertices.append(vertices)
    skirt_skinned_vertices.append(skirt_vertices)
progress_log("Body/SKIN評価が完了しました。")

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
    weights = [1.0 / (distance + 1.0e-6) for distance, _ in nearest]
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

os.makedirs(os.path.dirname(output_path), exist_ok=True)
progress_log(f"身体特徴量PKLを書き込みます: {output_path}")
with open(output_path, "wb") as file:
    pickle.dump(
        {
            "body_base_vertices": body_base_vertices,
            "body_vertex_indices": body_vertex_indices,
            "skinned_vertices": skinned_vertices,
            "skirt_skinned_vertices": skirt_skinned_vertices,
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
            "skirt_base_vertices": skirt_base_vertices,
            "skirt_faces": skirt_faces,
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
progress_log("身体特徴量PKLの書き込みが完了しました。")
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
