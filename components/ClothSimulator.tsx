'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type MutableRefObject,
} from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useFBX } from '@react-three/drei';
import * as THREE from 'three';
import { DoubleSide } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

type RegionClass = 'front' | 'back' | 'left' | 'right';

type InvisibleSeat = {
  center: THREE.Vector3;
  size: THREE.Vector3;
  topY: number;
};

type HumanBones = {
  pelvis: THREE.Object3D | null;
  leftThigh: THREE.Object3D | null;
  rightThigh: THREE.Object3D | null;
  leftKnee: THREE.Object3D | null;
  rightKnee: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  leftForearm: THREE.Object3D | null;
  rightForearm: THREE.Object3D | null;
  leftHand: THREE.Object3D | null;
  rightHand: THREE.Object3D | null;
  spineLower: THREE.Object3D | null;
};

type SkirtTuning = {
  waistAnchorLift: number;
  waistSlimness: number;
  hemYOffset: number;
};

type CapsuleCollider = {
  name: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
  enabled: boolean;
  priority: number;
  affectsSkirt?: boolean;
  minRowRatio?: number;
  maxRowRatio?: number;
};

type ClothVertex = {
  current: THREE.Vector3;
  previous: THREE.Vector3;
  rest: THREE.Vector3;
  velocity: THREE.Vector3;
  invMass: number;
  row: number;
  col: number;
  region: RegionClass;
  pinWeight: number;
  targetWeight: number;
  penetrated: boolean;
  penetrationDepth: number;
};

type DistanceConstraint = {
  i0: number;
  i1: number;
  restLength: number;
  stiffness: number;
};

type BendConstraint = {
  i0: number;
  i1: number;
  restLength: number;
  stiffness: number;
};

type BoneFrames = {
  hipFrame: THREE.Matrix4;
  thighFrameLeft: THREE.Matrix4;
  thighFrameRight: THREE.Matrix4;
};

type HumanRuntimeData = {
  colliders: CapsuleCollider[];
  frames: BoneFrames;
  sitProgress: number;
  seat: InvisibleSeat;
};

type SkirtConfig = {
  radialSegments: number;
  heightSegments: number;
  topRadius: number;
  hipRadius: number;
  hemRadius: number;
  skirtHeight: number;
  clothThickness: number;
  gravity: number;
  substeps: number;
  constraintIterations: number;
  collisionIterations: number;
  dampingStand: number;
  dampingTransition: number;
  maxVelocity: number;
  maxDisplacement: number;
  distanceStiffness: number;
  diagonalStiffness: number;
  bendStiffness: number;
};

type HumanModelProps = {
  isSitting: boolean;
  modelYOffset: number;
  modelBasePosition: [number, number, number];
  runtimeRef: MutableRefObject<HumanRuntimeData>;
  resetVersion: number;
  onStandRecoverComplete?: () => void;
};

type SkirtClothProps = {
  runtimeRef: MutableRefObject<HumanRuntimeData>;
  tuning: SkirtTuning;
  resetVersion: number;
};

type SimulationState = {
  initialized: boolean;
  vertices: ClothVertex[];
  distance: DistanceConstraint[];
  bend: BendConstraint[];
  targetStanding: THREE.Vector3[];
  targetSitting: THREE.Vector3[];
  targetBlended: THREE.Vector3[];
};

const MODEL_SCALE = 0.01;
const SIT_TIME_RATIO = 0.8;
const CHECKER_TEXTURE_SIZE = 256;
const EPS = 1e-6;
const INVARIANT_WARN_THROTTLE_MS = 1200;

const REQUIRED_SKIRT_COLLIDER_NAMES = [
  'pelvis',
  'leftThigh',
  'rightThigh',
  'leftKnee',
  'rightKnee',
  'crotch',
  'leftForearm',
  'rightForearm',
  'leftHand',
  'rightHand',
] as const;

const UP = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

const TMP0 = new THREE.Vector3();
const TMP1 = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
const TMP4 = new THREE.Vector3();
const TMP5 = new THREE.Vector3();
const TMPQ0 = new THREE.Quaternion();
const TMPQ1 = new THREE.Quaternion();
const TMPM0 = new THREE.Matrix4();
const INVARIANT_LAST_WARN_AT = new Map<string, number>();

const INVISIBLE_SEAT_CENTER = new THREE.Vector3(0, 0.55, -1.45);
const INVISIBLE_SEAT_SIZE = new THREE.Vector3(1.0, 0.12, 1.0);
const INVISIBLE_SEAT_TOP_Y = INVISIBLE_SEAT_CENTER.y + INVISIBLE_SEAT_SIZE.y * 0.5;

const CONFIG: SkirtConfig = {
  radialSegments: 64,
  heightSegments: 36,
  topRadius: 0.2,
  hipRadius: 0.29,
  hemRadius: 0.38,
  skirtHeight: 0.7,
  clothThickness: 0.022,
  gravity: 9.81,
  substeps: 5,
  constraintIterations: 12,
  collisionIterations: 6,
  dampingStand: 0.965,
  dampingTransition: 0.94,
  maxVelocity: 3.7,
  maxDisplacement: 0.05,
  distanceStiffness: 0.94,
  diagonalStiffness: 0.82,
  bendStiffness: 0.36,
};

function smoothstep01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function gridIndex(row: number, col: number, cols: number): number {
  return row * cols + col;
}

function wrapCol(col: number, cols: number): number {
  const c = col % cols;
  return c < 0 ? c + cols : c;
}

function throttledInvariantError(key: string, message: string): void {
  const now = performance.now();
  const last = INVARIANT_LAST_WARN_AT.get(key) ?? -Infinity;
  if (now - last < INVARIANT_WARN_THROTTLE_MS) return;
  INVARIANT_LAST_WARN_AT.set(key, now);
  console.error(message);
}

function throttledInvariantWarn(key: string, message: string): void {
  const now = performance.now();
  const last = INVARIANT_LAST_WARN_AT.get(key) ?? -Infinity;
  if (now - last < INVARIANT_WARN_THROTTLE_MS) return;
  INVARIANT_LAST_WARN_AT.set(key, now);
  console.warn(message);
}

function makeTargetCollisionSafe(
  target: THREE.Vector3,
  colliders: CapsuleCollider[],
  thickness: number,
  rowRatio: number
): THREE.Vector3 {
  const sorted = colliders
    .filter((c) => c.enabled && c.affectsSkirt !== false && !/Hand|Forearm/.test(c.name))
    .sort((a, b) => b.priority - a.priority);

  // One pass is not enough when the target is inside two overlapping body/seat capsules.
  // Keep the target itself collision-safe so target constraints do not pull cloth back inside the body.
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < sorted.length; i += 1) {
      const collider = sorted[i];
      if (collider.minRowRatio !== undefined && rowRatio < collider.minRowRatio) continue;
      if (collider.maxRowRatio !== undefined && rowRatio > collider.maxRowRatio) continue;
      projectPointOutsideCapsule(target, collider, thickness);
    }
  }
  return target;
}

function smoothstepRange(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function shortestAngleDistance(a: number, b: number): number {
  const diff = ((a - b + Math.PI) % (Math.PI * 2)) - Math.PI;
  return Math.abs(diff);
}

function applySmoothHandClearanceToTarget(
  target: THREE.Vector3,
  row: number,
  col: number,
  hipFrame: THREE.Matrix4,
  colliders: CapsuleCollider[],
  config: SkirtConfig
): void {
  const rowRatio = row / (config.heightSegments - 1);
  if (rowRatio < 0.08 || rowRatio > 0.82) return;

  TMPM0.copy(hipFrame).invert();
  const localTarget = TMP0.copy(target).applyMatrix4(TMPM0);
  const targetRadius = Math.hypot(localTarget.x, localTarget.z);
  if (targetRadius < EPS) return;

  const targetAngle = Math.atan2(localTarget.z, localTarget.x);
  const bandCenter = (col / config.radialSegments) * Math.PI * 2;

  let requiredRadius = targetRadius;
  let maxInfluence = 0;

  for (let i = 0; i < colliders.length; i += 1) {
    const collider = colliders[i];
    if (!collider.enabled || collider.affectsSkirt === false) continue;
    if (!/Hand|Forearm/.test(collider.name)) continue;

    const samples = [collider.a, TMP1.copy(collider.a).lerp(collider.b, 0.5), collider.b];
    for (let s = 0; s < samples.length; s += 1) {
      const sampleLocal = TMP2.copy(samples[s]).applyMatrix4(TMPM0);
      const verticalDistance = Math.abs(localTarget.y - sampleLocal.y);
      const sampleAngle = Math.atan2(sampleLocal.z, sampleLocal.x);
      const angularDistance = shortestAngleDistance(targetAngle, sampleAngle);
      const bandDistance = shortestAngleDistance(bandCenter, sampleAngle);

      const verticalInfluence = 1 - smoothstepRange(0.05, 0.28, verticalDistance);
      const angularInfluence = 1 - smoothstepRange(0.12, 0.75, angularDistance);
      const bandInfluence = 1 - smoothstepRange(0.18, 0.92, bandDistance);
      const influence = verticalInfluence * angularInfluence * bandInfluence;
      if (influence <= 0) continue;

      const sampleRadius = Math.hypot(sampleLocal.x, sampleLocal.z);
      const clearance = collider.radius + config.clothThickness + 0.035;
      const candidate = sampleRadius + clearance * THREE.MathUtils.lerp(0.72, 1.0, influence);
      if (candidate > requiredRadius) requiredRadius = candidate;
      if (influence > maxInfluence) maxInfluence = influence;
    }
  }

  if (requiredRadius <= targetRadius + 1e-4 || maxInfluence <= 0) return;

  const safeRadius = THREE.MathUtils.lerp(targetRadius, requiredRadius, THREE.MathUtils.clamp(maxInfluence, 0.08, 0.85));
  const scale = safeRadius / Math.max(targetRadius, EPS);
  localTarget.x *= scale;
  localTarget.z *= scale;
  target.copy(localTarget.applyMatrix4(hipFrame));
}

function assertSkirtColliderInvariants(colliders: CapsuleCollider[]): void {
  for (let i = 0; i < REQUIRED_SKIRT_COLLIDER_NAMES.length; i += 1) {
    const name = REQUIRED_SKIRT_COLLIDER_NAMES[i];
    const collider = colliders.find((c) => c.name === name);
    if (!collider) {
      throttledInvariantError(`missing:${name}`, `[ClothSimulator] Invariant violation: missing required skirt collider "${name}".`);
      continue;
    }
    if (collider.affectsSkirt === false) {
      throttledInvariantError(
        `affects:false:${name}`,
        `[ClothSimulator] Invariant violation: collider "${name}" must have affectsSkirt=true for skirt collisions.`
      );
    }
  }
}

function createCheckerTexture(colorA = '#cdeffd', colorB = '#98d5f4'): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_TEXTURE_SIZE;
  canvas.height = CHECKER_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const square = CHECKER_TEXTURE_SIZE / 8;
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, CHECKER_TEXTURE_SIZE, CHECKER_TEXTURE_SIZE);

  ctx.fillStyle = colorB;
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      if ((r + c) % 2 === 0) ctx.fillRect(c * square, r * square, square, square);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.anisotropy = 16;
  return texture;
}

function classifyRegion(theta: number): RegionClass {
  const x = Math.cos(theta);
  const z = Math.sin(theta);
  if (Math.abs(z) >= Math.abs(x)) return z >= 0 ? 'front' : 'back';
  return x >= 0 ? 'right' : 'left';
}

function localRadiusAtRow(rowRatio: number, config: SkirtConfig, tuning: SkirtTuning): number {
  const base =
    rowRatio < 0.24
      ? THREE.MathUtils.lerp(config.topRadius, config.hipRadius, rowRatio / 0.24)
      : THREE.MathUtils.lerp(config.hipRadius, config.hemRadius, (rowRatio - 0.24) / 0.76);

  const slimInfluence = Math.pow(1 - THREE.MathUtils.clamp(rowRatio / 0.45, 0, 1), 1.7);
  const slimAmount = tuning.waistSlimness * 0.6 * slimInfluence;
  return THREE.MathUtils.clamp(base - slimAmount, 0.12, config.hemRadius + 0.08);
}

function effectiveSkirtLength(config: SkirtConfig, tuning: SkirtTuning): number {
  const lengthDelta = -tuning.hemYOffset * 0.55;
  return THREE.MathUtils.clamp(
    config.skirtHeight + lengthDelta,
    config.skirtHeight * 0.72,
    config.skirtHeight * 1.25
  );
}

function rowTargetStrength(row: number, rowRatio: number): number {
  if (row <= 3) return THREE.MathUtils.lerp(0.85, 1.0, 1 - rowRatio * 3.5);
  if (rowRatio < 0.35) return THREE.MathUtils.lerp(0.45, 0.75, 1 - rowRatio / 0.35);
  if (rowRatio < 0.75) return THREE.MathUtils.lerp(0.2, 0.45, 1 - (rowRatio - 0.35) / 0.4);
  return THREE.MathUtils.lerp(0.08, 0.25, 1 - (rowRatio - 0.75) / 0.25);
}

function computeStandingTargetVertex(
  row: number,
  col: number,
  hipFrame: THREE.Matrix4,
  config: SkirtConfig,
  tuning: SkirtTuning
): THREE.Vector3 {
  const rowRatio = row / (config.heightSegments - 1);
  const theta = (col / config.radialSegments) * Math.PI * 2;
  const radius = localRadiusAtRow(rowRatio, config, tuning);

  const length = effectiveSkirtLength(config, tuning);
  const localY = tuning.waistAnchorLift - rowRatio * length;

  return new THREE.Vector3(Math.cos(theta) * radius, localY, Math.sin(theta) * radius).applyMatrix4(hipFrame);
}

function computeSittingTargetVertex(
  row: number,
  col: number,
  hipFrame: THREE.Matrix4,
  thighFrameLeft: THREE.Matrix4,
  thighFrameRight: THREE.Matrix4,
  seat: InvisibleSeat,
  config: SkirtConfig,
  tuning: SkirtTuning
): THREE.Vector3 {
  const rowRatio = row / (config.heightSegments - 1);
  const theta = (col / config.radialSegments) * Math.PI * 2;
  const xDir = Math.cos(theta);
  const zDir = Math.sin(theta);
  const frontMask = Math.max(0, zDir);
  const backMask = Math.max(0, -zDir);
  const sideMask = 1 - Math.abs(zDir);
  const lowerT = smoothstep01((rowRatio - 0.12) / 0.86);
  const frontT = smoothstep01((rowRatio - 0.14) / 0.72);
  const sideT = smoothstep01((rowRatio - 0.22) / 0.72);
  const backT = smoothstep01((rowRatio - 0.18) / 0.78);

  TMPM0.copy(hipFrame).invert();

  const target = computeStandingTargetVertex(row, col, hipFrame, config, tuning);
  const local = target.applyMatrix4(TMPM0);

  TMP0.setFromMatrixPosition(thighFrameLeft).applyMatrix4(TMPM0);
  TMP1.setFromMatrixPosition(thighFrameRight).applyMatrix4(TMPM0);
  const thighMidLocal = TMP2.copy(TMP0).add(TMP1).multiplyScalar(0.5);
  const seatLocalCenter = TMP3.copy(seat.center).applyMatrix4(TMPM0);
  const seatLocalTopY = seatLocalCenter.y + seat.size.y * 0.5;
  const seatYWorld = seat.topY + config.clothThickness + 0.014;

  const length = effectiveSkirtLength(config, tuning);
  const baseY = tuning.waistAnchorLift - rowRatio * length;
  const baseRadius = localRadiusAtRow(rowRatio, config, tuning);

  local.y = baseY;
  local.x = xDir * baseRadius;
  local.z = zDir * baseRadius;

  if (frontMask > 0.05) {
    const zFloor = thighMidLocal.z + THREE.MathUtils.lerp(0.06, 0.18, frontT) * frontMask;
    const thighTopY = thighMidLocal.y - THREE.MathUtils.lerp(0.04, 0.1, frontT);
    local.z = Math.max(local.z, zFloor);
    local.y = Math.max(local.y, thighTopY);
    local.y = Math.max(local.y, seatLocalTopY + config.clothThickness + 0.012);
  }

  if (backMask > 0.05) {
    const seatYLocal = seatLocalTopY + config.clothThickness + 0.014;
    local.z -= backMask * THREE.MathUtils.lerp(0.04, 0.16, backT);
    local.y = THREE.MathUtils.lerp(local.y, seatYLocal + THREE.MathUtils.lerp(0.08, 0.02, backT), backMask * backT * 0.75);
    local.y = Math.max(local.y, seatYLocal);
  }

  if (sideMask > 0.05) {
    const lateralSpread = THREE.MathUtils.lerp(0.02, 0.08, sideT) * sideMask;
    local.x += xDir * lateralSpread;
    local.y = Math.max(local.y - sideT * 0.025, seatLocalTopY + config.clothThickness + 0.012);
  }

  if (rowRatio > 0.52) {
    const seatBand = smoothstep01((rowRatio - 0.52) / 0.48) * lowerT;
    local.y = Math.max(local.y, seatLocalTopY + config.clothThickness + THREE.MathUtils.lerp(0.008, 0.02, seatBand));
  }

  const worldTarget = local.applyMatrix4(hipFrame);
  worldTarget.y = Math.max(worldTarget.y, seatYWorld);
  return worldTarget;
}

function applyTargetShapeConstraint(vertex: ClothVertex, target: THREE.Vector3, strength: number): void {
  if (strength <= 0) return;

  if (vertex.invMass <= 0) {
    vertex.current.lerp(target, THREE.MathUtils.clamp(strength + vertex.pinWeight * 0.5, 0, 1));
    return;
  }

  const blend = THREE.MathUtils.clamp(strength * (0.45 + 0.55 * vertex.targetWeight), 0, 1);
  vertex.current.lerp(target, blend);
}

function projectPointOutsideCapsule(point: THREE.Vector3, capsule: CapsuleCollider, thickness: number): boolean {
  if (!capsule.enabled) return false;

  TMP0.copy(capsule.b).sub(capsule.a);
  const lenSq = TMP0.lengthSq();

  let t = 0;
  if (lenSq > EPS) t = THREE.MathUtils.clamp(TMP1.copy(point).sub(capsule.a).dot(TMP0) / lenSq, 0, 1);

  TMP1.copy(capsule.a).addScaledVector(TMP0, t);
  TMP2.copy(point).sub(TMP1);
  const dist = TMP2.length();
  const minDist = capsule.radius + thickness;
  if (dist >= minDist) return false;

  if (dist > EPS) {
    TMP2.multiplyScalar(1 / dist);
  } else {
    TMP2.copy(TMP0).cross(UP);
    if (TMP2.lengthSq() < EPS) TMP2.set(1, 0, 0);
    else TMP2.normalize();
  }

  point.copy(TMP1).addScaledVector(TMP2, minDist);
  return true;
}

function solveDistanceConstraint(vertices: ClothVertex[], constraint: DistanceConstraint): void {
  const v0 = vertices[constraint.i0];
  const v1 = vertices[constraint.i1];

  TMP0.copy(v1.current).sub(v0.current);
  const len = TMP0.length();
  if (len < EPS) return;

  const w0 = v0.invMass;
  const w1 = v1.invMass;
  const w = w0 + w1;
  if (w <= EPS) return;

  const c = len - constraint.restLength;
  const corr = (constraint.stiffness * c) / w;
  TMP0.multiplyScalar(1 / len);

  if (w0 > 0) v0.current.addScaledVector(TMP0, corr * w0);
  if (w1 > 0) v1.current.addScaledVector(TMP0, -corr * w1);
}

function solveBendConstraint(vertices: ClothVertex[], constraint: BendConstraint): void {
  const v0 = vertices[constraint.i0];
  const v1 = vertices[constraint.i1];

  TMP0.copy(v1.current).sub(v0.current);
  const len = TMP0.length();
  if (len < EPS) return;

  const w0 = v0.invMass;
  const w1 = v1.invMass;
  const w = w0 + w1;
  if (w <= EPS) return;

  const c = len - constraint.restLength;
  const corr = (constraint.stiffness * c) / w;
  TMP0.multiplyScalar(1 / len);

  if (w0 > 0) v0.current.addScaledVector(TMP0, corr * w0);
  if (w1 > 0) v1.current.addScaledVector(TMP0, -corr * w1);
}

function solveBodyCollisions(
  vertices: ClothVertex[],
  colliders: CapsuleCollider[],
  config: SkirtConfig,
  iterations: number
): { penetrations: number; maxDepth: number; deepestColliderName: string | null } {
  const sorted = colliders
    .filter((c) => c.enabled && c.affectsSkirt !== false)
    .sort((a, b) => b.priority - a.priority);

  let penetrations = 0;
  let maxDepth = 0;
  let deepestColliderName: string | null = null;

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < vertices.length; i += 1) {
      const v = vertices[i];
      const rowRatio = v.row / (config.heightSegments - 1);

      v.penetrated = false;
      v.penetrationDepth = 0;

      for (let c = 0; c < sorted.length; c += 1) {
        const collider = sorted[c];
        if (collider.minRowRatio !== undefined && rowRatio < collider.minRowRatio) continue;
        if (collider.maxRowRatio !== undefined && rowRatio > collider.maxRowRatio) continue;

        TMP0.copy(v.current);
        if (projectPointOutsideCapsule(v.current, collider, config.clothThickness)) {
          TMP1.copy(v.current).sub(TMP0);
          const depth = TMP1.length();
          v.penetrated = true;
          v.penetrationDepth = Math.max(v.penetrationDepth, depth);
          penetrations += 1;
          if (depth > maxDepth) {
            maxDepth = depth;
            deepestColliderName = collider.name;
          }

          const outward = depth > EPS ? TMP1.multiplyScalar(1 / depth) : TMP2.set(0, 1, 0);
          const inward = v.velocity.dot(outward);
          if (inward < 0) v.velocity.addScaledVector(outward, -inward);
          v.velocity.multiplyScalar(0.25);
        }
      }
    }
  }

  return { penetrations, maxDepth, deepestColliderName };
}

function restoreArmRestPose(restPose: Map<THREE.Object3D, THREE.Quaternion>): void {
  restPose.forEach((q, bone) => {
    bone.quaternion.copy(q);
  });
}

function rotateJointTowardTargetLimited(
  joint: THREE.Object3D,
  endEffector: THREE.Object3D,
  targetWorld: THREE.Vector3,
  maxAngle: number
): void {
  joint.getWorldPosition(TMP0);
  endEffector.getWorldPosition(TMP1);
  TMP2.copy(TMP1).sub(TMP0);
  TMP3.copy(targetWorld).sub(TMP0);
  if (TMP2.lengthSq() < EPS || TMP3.lengthSq() < EPS) return;

  TMP2.normalize();
  TMP3.normalize();
  const dot = THREE.MathUtils.clamp(TMP2.dot(TMP3), -1, 1);
  const angle = Math.acos(dot);
  if (!Number.isFinite(angle) || angle < 1e-4) return;

  TMP4.copy(TMP2).cross(TMP3);
  if (TMP4.lengthSq() < EPS) return;
  TMP4.normalize();

  TMPQ0.setFromAxisAngle(TMP4, Math.min(angle, maxAngle));
  joint.getWorldQuaternion(TMPQ1);
  TMPQ1.premultiply(TMPQ0);

  if (joint.parent) {
    joint.parent.getWorldQuaternion(TMPQ0).invert();
    joint.quaternion.copy(TMPQ0.multiply(TMPQ1));
  } else {
    joint.quaternion.copy(TMPQ1);
  }
}

function validateHandWaistSidePose(
  hand: THREE.Object3D | null,
  hipFrame: THREE.Matrix4,
  side: 'left' | 'right'
): boolean {
  if (!hand) return false;
  TMPM0.copy(hipFrame).invert();
  hand.getWorldPosition(TMP0);
  TMP0.applyMatrix4(TMPM0);

  if (side === 'left') {
    return TMP0.x >= -0.65 && TMP0.x <= -0.30 && TMP0.y <= -0.12 && TMP0.y >= -0.48 && TMP0.z >= -0.16 && TMP0.z <= 0.08;
  }
  return TMP0.x >= 0.30 && TMP0.x <= 0.65 && TMP0.y <= -0.12 && TMP0.y >= -0.48 && TMP0.z >= -0.16 && TMP0.z <= 0.08;
}

function applyGentleArmSideOpen(
  sceneRoot: THREE.Object3D,
  bones: HumanBones,
  hipFrame: THREE.Matrix4,
  restPose: Map<THREE.Object3D, THREE.Quaternion>,
  sitProgress: number
): void {
  const applyOne = (
    side: 'left' | 'right',
    upperArm: THREE.Object3D | null,
    forearm: THREE.Object3D | null,
    hand: THREE.Object3D | null
  ) => {
    if (!upperArm || !forearm || !hand) return;

    const savedUpper = upperArm.quaternion.clone();
    const savedForearm = forearm.quaternion.clone();
    const savedHand = hand.quaternion.clone();

    const sign = side === 'left' ? -1 : 1;
    const t = THREE.MathUtils.clamp(sitProgress, 0, 1);
    const candidates = [
      new THREE.Vector3(
        sign * THREE.MathUtils.lerp(0.5, 0.56, t),
        THREE.MathUtils.lerp(-0.24, -0.32, t),
        THREE.MathUtils.lerp(-0.035, -0.01, t)
      ),
      new THREE.Vector3(
        sign * THREE.MathUtils.lerp(0.47, 0.53, t),
        THREE.MathUtils.lerp(-0.22, -0.3, t),
        THREE.MathUtils.lerp(-0.03, -0.005, t)
      ),
    ];

    let valid = false;
    for (let c = 0; c < candidates.length && !valid; c += 1) {
      upperArm.quaternion.copy(savedUpper);
      forearm.quaternion.copy(savedForearm);
      hand.quaternion.copy(savedHand);
      sceneRoot.updateMatrixWorld(true);

      const targetWorld = candidates[c].clone().applyMatrix4(hipFrame);
      for (let i = 0; i < 4; i += 1) {
        sceneRoot.updateMatrixWorld(true);
        rotateJointTowardTargetLimited(forearm, hand, targetWorld, THREE.MathUtils.degToRad(2.0));
        sceneRoot.updateMatrixWorld(true);
        rotateJointTowardTargetLimited(upperArm, hand, targetWorld, THREE.MathUtils.degToRad(1.4));
      }

      sceneRoot.updateMatrixWorld(true);
      valid = validateHandWaistSidePose(hand, hipFrame, side);
    }

    if (!valid) {
      upperArm.quaternion.copy(savedUpper);
      forearm.quaternion.copy(savedForearm);
      hand.quaternion.copy(savedHand);
      sceneRoot.updateMatrixWorld(true);
      throttledInvariantWarn(`hand-waist-side:${side}`, '[ClothSimulator] Hand is not in waist-side range.');
    }
  };

  if (restPose.size === 0) return;
  applyOne('left', bones.leftUpperArm, bones.leftForearm, bones.leftHand);
  applyOne('right', bones.rightUpperArm, bones.rightForearm, bones.rightHand);
}

function solveHandCollisions(
  vertices: ClothVertex[],
  colliders: CapsuleCollider[],
  config: SkirtConfig,
  iterations: number
): void {
  const handColliders = colliders
    .filter((c) => c.enabled && c.affectsSkirt !== false && /Hand|Forearm/.test(c.name))
    .sort((a, b) => b.priority - a.priority);

  if (handColliders.length === 0) return;

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < vertices.length; i += 1) {
      const v = vertices[i];
      const rowRatio = v.row / (config.heightSegments - 1);
      if (rowRatio < 0.06 || rowRatio > 0.78) continue;

      for (let c = 0; c < handColliders.length; c += 1) {
        const collider = handColliders[c];
        if (collider.minRowRatio !== undefined && rowRatio < collider.minRowRatio) continue;
        if (collider.maxRowRatio !== undefined && rowRatio > collider.maxRowRatio) continue;

        TMP0.copy(v.current);
        if (projectPointOutsideCapsule(v.current, collider, config.clothThickness)) {
          TMP1.copy(v.current).sub(TMP0);
          const depth = TMP1.length();
          if (depth > EPS) {
            TMP1.multiplyScalar(1 / depth);
            const inward = v.velocity.dot(TMP1);
            if (inward < 0) v.velocity.addScaledVector(TMP1, -inward);
          }
          v.velocity.multiplyScalar(0.32);
        }
      }
    }
  }
}

function makeSittingTargetSeatSafe(
  target: THREE.Vector3,
  seat: InvisibleSeat,
  rowRatio: number,
  thickness: number
): THREE.Vector3 {
  if (rowRatio <= 0.42) return target;

  const halfX = seat.size.x * 0.5 + 0.1;
  const halfZ = seat.size.z * 0.5 + 0.14;
  const inX = Math.abs(target.x - seat.center.x) <= halfX;
  const inZ = Math.abs(target.z - seat.center.z) <= halfZ;
  if (inX && inZ) {
    target.y = Math.max(target.y, seat.topY + thickness + 0.006);
  }
  return target;
}

function solveSeatCollision(
  vertices: ClothVertex[],
  seat: InvisibleSeat,
  config: SkirtConfig,
  iterations: number,
  sitProgress: number
): void {
  if (sitProgress <= 0.15) return;
  const halfX = seat.size.x * 0.5 + 0.1;
  const halfZ = seat.size.z * 0.5 + 0.14;

  for (let pass = 0; pass < iterations; pass += 1) {
    for (let i = 0; i < vertices.length; i += 1) {
      const v = vertices[i];
      const rowRatio = v.row / (config.heightSegments - 1);
      if (rowRatio <= 0.42) continue;

      const inX = Math.abs(v.current.x - seat.center.x) <= halfX;
      const inZ = Math.abs(v.current.z - seat.center.z) <= halfZ;
      if (!inX || !inZ) continue;

      const minY = seat.topY + config.clothThickness + 0.006;
      if (v.current.y < minY) {
        v.current.y = minY;
        if (v.velocity.y < 0) v.velocity.y *= 0.15;
      }
    }
  }
}

function smoothClothSurface(vertices: ClothVertex[], config: SkirtConfig, strength: number): void {
  const cols = config.radialSegments;
  const rows = config.heightSegments;
  const cache = new Array<THREE.Vector3>(vertices.length);

  for (let r = 4; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = gridIndex(r, c, cols);
      const center = vertices[i].current;
      const left = vertices[gridIndex(r, wrapCol(c - 1, cols), cols)].current;
      const right = vertices[gridIndex(r, wrapCol(c + 1, cols), cols)].current;
      const up = vertices[gridIndex(Math.max(4, r - 1), c, cols)].current;
      const down = vertices[gridIndex(Math.min(rows - 1, r + 1), c, cols)].current;

      cache[i] = new THREE.Vector3(
        (left.x + right.x + up.x + down.x) * 0.25,
        (left.y + right.y + up.y + down.y) * 0.25,
        (left.z + right.z + up.z + down.z) * 0.25
      );
      cache[i].lerp(center, 1 - strength);
    }
  }

  for (let r = 4; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = gridIndex(r, c, cols);
      const smoothed = cache[i];
      if (!smoothed) continue;
      vertices[i].current.copy(smoothed);
    }
  }
}

function detectBucketShape(vertices: ClothVertex[], config: SkirtConfig): boolean {
  const cols = config.radialSegments;
  const row = Math.floor((config.heightSegments - 1) * 0.75);

  let frontY = 0;
  let backY = 0;
  let frontZ = 0;
  let backZ = 0;
  let countFront = 0;
  let countBack = 0;

  for (let c = 0; c < cols; c += 1) {
    const v = vertices[gridIndex(row, c, cols)].current;
    const zDir = Math.sin((c / cols) * Math.PI * 2);
    if (zDir > 0.6) {
      frontY += v.y;
      frontZ += v.z;
      countFront += 1;
    } else if (zDir < -0.6) {
      backY += v.y;
      backZ += v.z;
      countBack += 1;
    }
  }

  if (countFront === 0 || countBack === 0) return false;
  frontY /= countFront;
  backY /= countBack;
  frontZ /= countFront;
  backZ /= countBack;

  const yDiff = Math.abs(frontY - backY);
  const zDiff = Math.abs(frontZ - backZ);
  return yDiff < 0.035 && zDiff < 0.05;
}

function computeCapsuleFromBone(
  name: string,
  bone: THREE.Object3D | null,
  length: number,
  radius: number,
  priority: number,
  localStart: THREE.Vector3,
  localEnd: THREE.Vector3,
  fallbackCenter: THREE.Vector3,
  options?: { affectsSkirt?: boolean; minRowRatio?: number; maxRowRatio?: number }
): CapsuleCollider {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  if (bone) {
    bone.getWorldPosition(TMP0);
    bone.getWorldQuaternion(TMPQ0);
    a.copy(localStart).applyQuaternion(TMPQ0).add(TMP0);
    b.copy(localEnd).applyQuaternion(TMPQ0).add(TMP0);
  } else {
    a.copy(fallbackCenter).add(new THREE.Vector3(0, length * 0.5, 0));
    b.copy(fallbackCenter).add(new THREE.Vector3(0, -length * 0.5, 0));
  }

  return {
    name,
    a,
    b,
    radius,
    enabled: true,
    priority,
    affectsSkirt: options?.affectsSkirt,
    minRowRatio: options?.minRowRatio,
    maxRowRatio: options?.maxRowRatio,
  };
}

function createThighCollider(
  name: 'leftThigh' | 'rightThigh',
  thigh: THREE.Object3D | null,
  knee: THREE.Object3D | null,
  pelvisCenter: THREE.Vector3,
  sideSign: -1 | 1
): CapsuleCollider {
  if (thigh && knee) {
    thigh.getWorldPosition(TMP0);
    knee.getWorldPosition(TMP1);
    return {
      name,
      a: TMP0.clone().add(new THREE.Vector3(0, 0.02, 0.02)),
      b: TMP1.clone(),
      radius: 0.105,
      enabled: true,
      priority: 90,
      affectsSkirt: true,
    };
  }

  return computeCapsuleFromBone(
    name,
    thigh,
    0.38,
    0.105,
    90,
    new THREE.Vector3(0, -0.02, 0.02),
    new THREE.Vector3(0, -0.38, 0.02),
    pelvisCenter.clone().add(new THREE.Vector3(0.12 * sideSign, -0.24, 0.08)),
    { affectsSkirt: true }
  );
}

function initializeSimulationFromRuntime(
  sim: SimulationState,
  runtime: HumanRuntimeData,
  config: SkirtConfig,
  tuning: SkirtTuning
): void {
  if (sim.initialized) return;

  const vertexCount = config.radialSegments * config.heightSegments;
  sim.vertices = [];
  sim.distance = [];
  sim.bend = [];
  sim.targetStanding = Array.from({ length: vertexCount }, () => new THREE.Vector3());
  sim.targetSitting = Array.from({ length: vertexCount }, () => new THREE.Vector3());
  sim.targetBlended = Array.from({ length: vertexCount }, () => new THREE.Vector3());

  for (let row = 0; row < config.heightSegments; row += 1) {
    for (let col = 0; col < config.radialSegments; col += 1) {
      const theta = (col / config.radialSegments) * Math.PI * 2;
      const region = classifyRegion(theta);
      const rowRatio = row / (config.heightSegments - 1);
      const targetWeight = rowTargetStrength(row, rowRatio);

      let pinWeight = 0;
      let invMass = 1;
      if (row === 0) {
        pinWeight = 1;
        invMass = 0;
      } else if (row <= 2) {
        pinWeight = 0.85 - row * 0.2;
        invMass = 0.2;
      } else if (row <= 4) {
        pinWeight = 0.45;
        invMass = 0.6;
      }

      const target = computeStandingTargetVertex(row, col, runtime.frames.hipFrame, config, tuning);
      applySmoothHandClearanceToTarget(target, row, col, runtime.frames.hipFrame, runtime.colliders, config);
      makeTargetCollisionSafe(target, runtime.colliders, config.clothThickness, rowRatio);

      sim.vertices.push({
        current: target.clone(),
        previous: target.clone(),
        rest: target.clone(),
        velocity: new THREE.Vector3(),
        invMass,
        row,
        col,
        region,
        pinWeight,
        targetWeight,
        penetrated: false,
        penetrationDepth: 0,
      });

      const index = gridIndex(row, col, config.radialSegments);
      sim.targetStanding[index].copy(target);
      sim.targetSitting[index].copy(target);
      sim.targetBlended[index].copy(target);
    }
  }

  const identity = new THREE.Matrix4().identity();

  const addDistance = (r0: number, c0: number, r1: number, c1: number, stiffness: number) => {
    const wc1 = wrapCol(c1, config.radialSegments);
    const i0 = gridIndex(r0, c0, config.radialSegments);
    const i1 = gridIndex(r1, wc1, config.radialSegments);
    const p0 = computeStandingTargetVertex(r0, c0, identity, config, tuning);
    const p1 = computeStandingTargetVertex(r1, wc1, identity, config, tuning);
    sim.distance.push({ i0, i1, restLength: p0.distanceTo(p1), stiffness });
  };

  const addBend = (r0: number, c0: number, r1: number, c1: number, stiffness: number) => {
    const wc1 = wrapCol(c1, config.radialSegments);
    const i0 = gridIndex(r0, c0, config.radialSegments);
    const i1 = gridIndex(r1, wc1, config.radialSegments);
    const p0 = computeStandingTargetVertex(r0, c0, identity, config, tuning);
    const p1 = computeStandingTargetVertex(r1, wc1, identity, config, tuning);
    sim.bend.push({ i0, i1, restLength: p0.distanceTo(p1), stiffness });
  };

  for (let row = 0; row < config.heightSegments; row += 1) {
    for (let col = 0; col < config.radialSegments; col += 1) {
      const next = wrapCol(col + 1, config.radialSegments);
      addDistance(row, col, row, next, config.distanceStiffness);

      if (row < config.heightSegments - 1) {
        addDistance(row, col, row + 1, col, config.distanceStiffness);
        addDistance(row, col, row + 1, next, config.diagonalStiffness);
        addDistance(row, next, row + 1, col, config.diagonalStiffness);
      }

      if (row < config.heightSegments - 2) {
        addBend(row, col, row + 2, col, config.bendStiffness);
        addBend(row, col, row + 2, next, config.bendStiffness * 0.9);
      }

      addBend(row, col, row, wrapCol(col + 2, config.radialSegments), config.bendStiffness * 0.85);
    }
  }

  for (let pass = 0; pass <= 10; pass += 1) {
    solveBodyCollisions(sim.vertices, runtime.colliders, config, 1);
    smoothClothSurface(sim.vertices, config, 0.025);
    solveBodyCollisions(sim.vertices, runtime.colliders, config, 1);
  }

  for (let i = 0; i < sim.vertices.length; i += 1) {
    sim.vertices[i].previous.copy(sim.vertices[i].current);
    sim.vertices[i].velocity.set(0, 0, 0);
  }

  sim.initialized = true;
}

function rebuildConstraintRestLengths(
  sim: SimulationState,
  config: SkirtConfig,
  tuning: SkirtTuning
): void {
  const identity = new THREE.Matrix4().identity();

  for (let i = 0; i < sim.distance.length; i += 1) {
    const c = sim.distance[i];
    const v0 = sim.vertices[c.i0];
    const v1 = sim.vertices[c.i1];
    const p0 = computeStandingTargetVertex(v0.row, v0.col, identity, config, tuning);
    const p1 = computeStandingTargetVertex(v1.row, v1.col, identity, config, tuning);
    c.restLength = p0.distanceTo(p1);
  }

  for (let i = 0; i < sim.bend.length; i += 1) {
    const c = sim.bend[i];
    const v0 = sim.vertices[c.i0];
    const v1 = sim.vertices[c.i1];
    const p0 = computeStandingTargetVertex(v0.row, v0.col, identity, config, tuning);
    const p1 = computeStandingTargetVertex(v1.row, v1.col, identity, config, tuning);
    c.restLength = p0.distanceTo(p1);
  }
}

function dampVelocitiesForTuningChange(vertices: ClothVertex[]): void {
  for (let i = 0; i < vertices.length; i += 1) {
    vertices[i].velocity.multiplyScalar(0.2);
    vertices[i].previous.copy(vertices[i].current);
  }
}

function BasePlane() {
  return (
    <mesh position={[0, -0.25, 0]} receiveShadow>
      <boxGeometry args={[20, 0.5, 20]} />
      <meshStandardMaterial color="#111827" metalness={0.2} roughness={0.9} />
    </mesh>
  );
}

function HumanModel({
  isSitting,
  modelYOffset,
  modelBasePosition,
  runtimeRef,
  resetVersion,
  onStandRecoverComplete,
}: HumanModelProps) {
  const fbxScene = useFBX('/models/Stand To Sit.fbx') as THREE.Group & { animations?: THREE.AnimationClip[] };
  const scene = useMemo(() => skeletonClone(fbxScene) as THREE.Group, [fbxScene]);
  const animations = useMemo(() => fbxScene.animations ?? [], [fbxScene]);

  const modelRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const standActionRef = useRef<THREE.AnimationAction | null>(null);
  const animationRootRef = useRef<THREE.Object3D | null>(null);
  const sitStopTimeRef = useRef(0);

  const standRecoverNotifiedRef = useRef(false);
  const armRestPoseRef = useRef<Map<THREE.Object3D, THREE.Quaternion>>(new Map());
  const prevPelvisPosRef = useRef(new THREE.Vector3());
  const prevLeftKneePosRef = useRef(new THREE.Vector3());
  const prevRightKneePosRef = useRef(new THREE.Vector3());
  const prevLeftThighQRef = useRef(new THREE.Quaternion());
  const prevRightThighQRef = useRef(new THREE.Quaternion());
  const motionWarnedRef = useRef(false);
  const prevRawSitProgressRef = useRef(0);
  const noMotionFrameCountRef = useRef(0);

  const bonesRef = useRef<HumanBones>({
    pelvis: null,
    leftThigh: null,
    rightThigh: null,
    leftKnee: null,
    rightKnee: null,
    leftUpperArm: null,
    rightUpperArm: null,
    leftForearm: null,
    rightForearm: null,
    leftHand: null,
    rightHand: null,
    spineLower: null,
  });

  const standClip = useMemo(() => {
    const usable = animations.filter((clip) => clip.tracks.length > 0 && clip.duration > 0);
    const byName = usable.find((clip) => clip.name === 'mixamo.com');
    return byName ?? usable[0] ?? null;
  }, [animations]);

  useEffect(() => {
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && mesh.skeleton?.bones?.length) skinnedMeshes.push(mesh);
    });

    const primary =
      skinnedMeshes.find((mesh) => /surface/i.test(mesh.name)) ??
      [...skinnedMeshes].sort((a, b) => (b.skeleton?.bones.length ?? 0) - (a.skeleton?.bones.length ?? 0))[0] ??
      null;

    let skeletonRoot: THREE.Object3D | null = null;
    if (primary?.skeleton?.bones?.length) {
      const hips = primary.skeleton.bones.filter((bone) => bone.name === 'mixamorigHips' || bone.name === 'Hips');
      skeletonRoot = hips.sort((a, b) => b.children.length - a.children.length)[0] ?? primary.skeleton.bones[0] ?? primary;
    }
    animationRootRef.current = skeletonRoot ?? scene;

    const byName = new Map<string, THREE.Bone>();
    (primary?.skeleton?.bones ?? []).forEach((b) => byName.set(b.name, b));

    const findBone = (names: string[]) => {
      for (let i = 0; i < names.length; i += 1) {
        const found = byName.get(names[i]);
        if (found) return found;
      }
      const lower = names.map((x) => x.toLowerCase());
      for (const [key, bone] of byName.entries()) {
        const k = key.toLowerCase();
        if (lower.some((n) => k.includes(n))) return bone;
      }
      return null;
    };

    bonesRef.current = {
      pelvis: findBone(['mixamorigHips', 'Hips', 'Pelvis', 'pelvis', 'hips']),
      leftThigh: findBone(['mixamorigLeftUpLeg', 'LeftUpLeg', 'leftupleg', 'thigh_l']),
      rightThigh: findBone(['mixamorigRightUpLeg', 'RightUpLeg', 'rightupleg', 'thigh_r']),
      leftKnee: findBone(['mixamorigLeftLeg', 'LeftLeg', 'leftleg', 'knee_l']),
      rightKnee: findBone(['mixamorigRightLeg', 'RightLeg', 'rightleg', 'knee_r']),
      leftUpperArm: findBone(['mixamorigLeftArm', 'LeftArm', 'leftarm', 'LeftUpperArm', 'upper_arm_l']),
      rightUpperArm: findBone(['mixamorigRightArm', 'RightArm', 'rightarm', 'RightUpperArm', 'upper_arm_r']),
      leftForearm: findBone(['mixamorigLeftForeArm', 'LeftForeArm', 'leftforearm']),
      rightForearm: findBone(['mixamorigRightForeArm', 'RightForeArm', 'rightforearm']),
      leftHand: findBone(['mixamorigLeftHand', 'LeftHand', 'lefthand']),
      rightHand: findBone(['mixamorigRightHand', 'RightHand', 'righthand']),
      spineLower: findBone(['mixamorigSpine', 'Spine', 'spine1']),
    };

    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;

    const clipTracks = (standClip?.tracks ?? []).slice(0, 10).map((track) => track.name);
    if (clipTracks.length > 0) {
      console.log('[ClothSimulator] Stand To Sit tracks(head):', clipTracks);
    }

    const snapshotBoneState = () => {
      const state = {
        pelvis: new THREE.Vector3(),
        leftKnee: new THREE.Vector3(),
        rightKnee: new THREE.Vector3(),
        leftThighQ: new THREE.Quaternion(),
        rightThighQ: new THREE.Quaternion(),
      };

      const b = bonesRef.current;
      b.pelvis?.getWorldPosition(state.pelvis);
      b.leftKnee?.getWorldPosition(state.leftKnee);
      b.rightKnee?.getWorldPosition(state.rightKnee);
      b.leftThigh?.getWorldQuaternion(state.leftThighQ);
      b.rightThigh?.getWorldQuaternion(state.rightThighQ);
      return state;
    };

    const didBoneStateMove = (a: ReturnType<typeof snapshotBoneState>, b: ReturnType<typeof snapshotBoneState>) => {
      const posEps = 1e-4;
      const rotEps = 1e-3;
      if (a.pelvis.distanceToSquared(b.pelvis) > posEps) return true;
      if (a.leftKnee.distanceToSquared(b.leftKnee) > posEps) return true;
      if (a.rightKnee.distanceToSquared(b.rightKnee) > posEps) return true;
      if (1 - Math.abs(a.leftThighQ.dot(b.leftThighQ)) > rotEps) return true;
      if (1 - Math.abs(a.rightThighQ.dot(b.rightThighQ)) > rotEps) return true;
      return false;
    };

    const setupAction = (root: THREE.Object3D): THREE.AnimationAction | null => {
      if (!standClip) return null;
      const a = mixer.clipAction(standClip, root);
      a.reset();
      a.enabled = true;
      a.setEffectiveWeight(1);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.paused = true;
      a.setEffectiveTimeScale(0);
      a.play();
      return a;
    };

    let action = setupAction(scene);
    if (action) {
      const sitStop = action.getClip().duration * SIT_TIME_RATIO;
      sitStopTimeRef.current = sitStop;

      mixer.setTime(0);
      scene.updateMatrixWorld(true);
      const standState = snapshotBoneState();

      mixer.setTime(sitStop);
      scene.updateMatrixWorld(true);
      const sitState = snapshotBoneState();

      const movedOnSceneRoot = didBoneStateMove(standState, sitState);
      if (!movedOnSceneRoot && animationRootRef.current && animationRootRef.current !== scene) {
        console.warn('[ClothSimulator] Scene root binding showed no bone motion, retrying with skeleton root.');
        action.stop();
        mixer.uncacheAction(standClip, scene);
        action = setupAction(animationRootRef.current);
      }

      if (action) {
        action.time = 0;
        action.paused = true;
        action.setEffectiveTimeScale(0);
        mixer.setTime(0);
      }
    }

    standActionRef.current = action;
    runtimeRef.current.sitProgress = 0;

    armRestPoseRef.current.clear();
    const b = bonesRef.current;
    [b.leftUpperArm, b.rightUpperArm, b.leftForearm, b.rightForearm, b.leftHand, b.rightHand].forEach((bone) => {
      if (bone) armRestPoseRef.current.set(bone, bone.quaternion.clone());
    });

    return () => {
      action?.stop();
      mixer.stopAllAction();
      mixerRef.current = null;
      standActionRef.current = null;
      animationRootRef.current = null;
    };
  }, [scene, animations, standClip, runtimeRef]);

  useEffect(() => {
    runtimeRef.current.sitProgress = 0;
    standRecoverNotifiedRef.current = false;

    const action = standActionRef.current;
    const mixer = mixerRef.current;
    if (action) {
      action.time = 0;
      action.paused = true;
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(0);
    }
    if (mixer) {
      mixer.setTime(0);
    }
    armRestPoseRef.current.forEach((q, bone) => bone.quaternion.copy(q));
    prevPelvisPosRef.current.set(0, 0, 0);
    prevLeftKneePosRef.current.set(0, 0, 0);
    prevRightKneePosRef.current.set(0, 0, 0);
    prevLeftThighQRef.current.identity();
    prevRightThighQRef.current.identity();
    motionWarnedRef.current = false;
    prevRawSitProgressRef.current = 0;
    noMotionFrameCountRef.current = 0;
    scene.updateMatrixWorld(true);
  }, [resetVersion, runtimeRef, scene]);

  useEffect(() => {
    standRecoverNotifiedRef.current = false;

    const action = standActionRef.current;
    if (!action) return;

    action.enabled = true;
    action.paused = false;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(isSitting ? 0.35 : -0.35);
    action.play();
  }, [isSitting]);

  useFrame((_, delta) => {
    if (modelRef.current) {
      modelRef.current.position.set(modelBasePosition[0], modelBasePosition[1] + modelYOffset, modelBasePosition[2]);
    }

    const action = standActionRef.current;
    const mixer = mixerRef.current;
    let effectiveSitProgress = 0;

    if (mixer && action) {
      const sitStop = sitStopTimeRef.current || action.getClip().duration * SIT_TIME_RATIO;
      if (!action.paused) {
        mixer.update(delta);
      }

      if (action.time >= sitStop) {
        action.time = sitStop;
        action.paused = true;
        action.setEffectiveTimeScale(0);
      } else if (action.time <= 0) {
        action.time = 0;
        action.paused = true;
        action.setEffectiveTimeScale(0);
      }
    } else {
      runtimeRef.current.sitProgress = 0;
    }

    scene.updateMatrixWorld(true);

    const b = bonesRef.current;

    const hipFrame = new THREE.Matrix4();
    if (b.pelvis) {
      b.pelvis.getWorldPosition(TMP1);
      b.pelvis.getWorldQuaternion(TMPQ1);
      hipFrame.compose(TMP1, TMPQ1, UNIT_SCALE);
    } else {
      hipFrame.makeTranslation(modelBasePosition[0], modelBasePosition[1] + 1.0, modelBasePosition[2]);
    }

    if (b.leftKnee) b.leftKnee.getWorldPosition(TMP2);
    if (b.rightKnee) b.rightKnee.getWorldPosition(TMP3);
    if (b.leftThigh) b.leftThigh.getWorldQuaternion(TMPQ0);
    if (b.rightThigh) b.rightThigh.getWorldQuaternion(TMPQ1);

    const pelvisMovedEnough = b.pelvis ? TMP1.distanceToSquared(prevPelvisPosRef.current) > 1e-6 : false;
    const leftKneeMovedEnough = b.leftKnee ? TMP2.distanceToSquared(prevLeftKneePosRef.current) > 1e-6 : false;
    const rightKneeMovedEnough = b.rightKnee ? TMP3.distanceToSquared(prevRightKneePosRef.current) > 1e-6 : false;
    const leftThighRotatedEnough = b.leftThigh ? 1 - Math.abs(TMPQ0.dot(prevLeftThighQRef.current)) > 1e-5 : false;
    const rightThighRotatedEnough = b.rightThigh ? 1 - Math.abs(TMPQ1.dot(prevRightThighQRef.current)) > 1e-5 : false;

    const actualMotionDetected =
      pelvisMovedEnough || leftKneeMovedEnough || rightKneeMovedEnough || leftThighRotatedEnough || rightThighRotatedEnough;

    if (mixer && action) {
      const sitStop = sitStopTimeRef.current || action.getClip().duration * SIT_TIME_RATIO;
      const rawSitProgress = sitStop > EPS ? THREE.MathUtils.clamp(action.time / sitStop, 0, 1) : 0;

      const progressAdvanced = Math.abs(rawSitProgress - prevRawSitProgressRef.current) > 1e-4;
      const playbackDrivenMotion = !action.paused && progressAdvanced;
      const motionDetected = actualMotionDetected || playbackDrivenMotion;

      if (motionDetected) {
        noMotionFrameCountRef.current = 0;
        effectiveSitProgress = rawSitProgress;
      } else {
        noMotionFrameCountRef.current += 1;
        const graceWindow = rawSitProgress < 0.18 || noMotionFrameCountRef.current < 12;
        effectiveSitProgress = graceWindow ? rawSitProgress : 0;
      }

      runtimeRef.current.sitProgress = effectiveSitProgress;

      if (rawSitProgress > 0.35 && !motionDetected && noMotionFrameCountRef.current >= 12 && !motionWarnedRef.current) {
        motionWarnedRef.current = true;
        throttledInvariantWarn('fbx-motion-uncertain', '[ClothSimulator] FBX seat motion detection is uncertain. Falling back to clip progress.');
      }

      prevRawSitProgressRef.current = rawSitProgress;
    } else {
      prevRawSitProgressRef.current = 0;
      noMotionFrameCountRef.current = 0;
    }

    prevPelvisPosRef.current.copy(TMP1);
    if (b.leftKnee) prevLeftKneePosRef.current.copy(TMP2);
    if (b.rightKnee) prevRightKneePosRef.current.copy(TMP3);
    if (b.leftThigh) prevLeftThighQRef.current.copy(TMPQ0);
    if (b.rightThigh) prevRightThighQRef.current.copy(TMPQ1);

    restoreArmRestPose(armRestPoseRef.current);
    applyGentleArmSideOpen(scene, b, hipFrame, armRestPoseRef.current, runtimeRef.current.sitProgress);
    scene.updateMatrixWorld(true);

    const thighLeft = new THREE.Matrix4();
    const thighRight = new THREE.Matrix4();

    if (b.leftThigh) {
      b.leftThigh.getWorldPosition(TMP1);
      b.leftThigh.getWorldQuaternion(TMPQ1);
      thighLeft.compose(TMP1, TMPQ1, UNIT_SCALE);
    } else {
      thighLeft.copy(hipFrame);
    }

    if (b.rightThigh) {
      b.rightThigh.getWorldPosition(TMP2);
      b.rightThigh.getWorldQuaternion(TMPQ1);
      thighRight.compose(TMP2, TMPQ1, UNIT_SCALE);
    } else {
      thighRight.copy(hipFrame);
    }

    const pelvisCenter = TMP3.setFromMatrixPosition(hipFrame).clone();

    const colliders: CapsuleCollider[] = [];

    colliders.push(
      computeCapsuleFromBone(
        'pelvis',
        b.pelvis,
        0.16,
        0.105,
        100,
        new THREE.Vector3(0, 0.08, 0.02),
        new THREE.Vector3(0, -0.08, 0.02),
        pelvisCenter,
        { affectsSkirt: true }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'hipBack',
        b.pelvis,
        0.14,
        0.085,
        96,
        new THREE.Vector3(0, 0.01, -0.085),
        new THREE.Vector3(0, -0.1, -0.11),
        pelvisCenter,
        { affectsSkirt: true, minRowRatio: 0.0, maxRowRatio: 0.42 }
      )
    );

    const runtimeSeat = runtimeRef.current.seat;
    if (
      Math.abs(runtimeSeat.center.y - pelvisCenter.y) < 0.06 &&
      Math.abs(INVISIBLE_SEAT_CENTER.y - pelvisCenter.y) > 0.15
    ) {
      throttledInvariantWarn('seat-pelvis-follow', '[ClothSimulator] Invisible seat must be world-fixed, not pelvis-following.');
    }

    const leftThighCollider = createThighCollider('leftThigh', b.leftThigh, b.leftKnee, pelvisCenter, -1);
    leftThighCollider.minRowRatio = 0.18;
    leftThighCollider.maxRowRatio = 1.0;
    colliders.push(leftThighCollider);

    const rightThighCollider = createThighCollider('rightThigh', b.rightThigh, b.rightKnee, pelvisCenter, 1);
    rightThighCollider.minRowRatio = 0.18;
    rightThighCollider.maxRowRatio = 1.0;
    colliders.push(rightThighCollider);

    colliders.push(
      computeCapsuleFromBone(
        'leftKnee',
        b.leftKnee,
        0.08,
        0.085,
        82,
        new THREE.Vector3(0, 0.03, 0.02),
        new THREE.Vector3(0, -0.03, 0.02),
        pelvisCenter.clone().add(new THREE.Vector3(-0.12, -0.5, 0.14)),
        { affectsSkirt: true }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'rightKnee',
        b.rightKnee,
        0.08,
        0.085,
        82,
        new THREE.Vector3(0, 0.03, 0.02),
        new THREE.Vector3(0, -0.03, 0.02),
        pelvisCenter.clone().add(new THREE.Vector3(0.12, -0.5, 0.14)),
        { affectsSkirt: true }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'leftForearm',
        b.leftForearm,
        0.2,
        0.06,
        48,
        new THREE.Vector3(0, 0.09, 0.005),
        new THREE.Vector3(0, -0.11, 0.01),
        pelvisCenter.clone().add(new THREE.Vector3(-0.36, -0.04, -0.02)),
        { affectsSkirt: true, minRowRatio: 0.1, maxRowRatio: 0.6 }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'rightForearm',
        b.rightForearm,
        0.2,
        0.06,
        48,
        new THREE.Vector3(0, 0.09, 0.005),
        new THREE.Vector3(0, -0.11, 0.01),
        pelvisCenter.clone().add(new THREE.Vector3(0.36, -0.04, -0.02)),
        { affectsSkirt: true, minRowRatio: 0.1, maxRowRatio: 0.6 }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'leftHand',
        b.leftHand,
        0.06,
        0.07,
        52,
        new THREE.Vector3(0, 0.03, 0.01),
        new THREE.Vector3(0, -0.03, 0.01),
        pelvisCenter.clone().add(new THREE.Vector3(-0.42, -0.2, -0.04)),
        { affectsSkirt: true, minRowRatio: 0.12, maxRowRatio: 0.66 }
      )
    );

    colliders.push(
      computeCapsuleFromBone(
        'rightHand',
        b.rightHand,
        0.06,
        0.07,
        52,
        new THREE.Vector3(0, 0.03, 0.01),
        new THREE.Vector3(0, -0.03, 0.01),
        pelvisCenter.clone().add(new THREE.Vector3(0.42, -0.2, -0.04)),
        { affectsSkirt: true, minRowRatio: 0.12, maxRowRatio: 0.66 }
      )
    );


    colliders.push({
      name: 'crotch',
      a: pelvisCenter.clone().add(new THREE.Vector3(0, -0.2, 0.03)),
      b: pelvisCenter.clone().add(new THREE.Vector3(0, -0.26, 0.03)),
      radius: 0.085,
      enabled: true,
      priority: 94,
      affectsSkirt: true,
      maxRowRatio: 0.6,
    });

    colliders.push(
      computeCapsuleFromBone(
        'torsoLower',
        b.spineLower ?? b.pelvis,
        0.24,
        0.12,
        86,
        new THREE.Vector3(0, 0.13, 0),
        new THREE.Vector3(0, -0.11, 0),
        pelvisCenter.clone().add(new THREE.Vector3(0, 0.2, 0)),
        { affectsSkirt: true, maxRowRatio: 0.56 }
      )
    );

    assertSkirtColliderInvariants(colliders);
    runtimeRef.current.colliders = colliders;
    runtimeRef.current.seat = {
      center: INVISIBLE_SEAT_CENTER.clone(),
      size: INVISIBLE_SEAT_SIZE.clone(),
      topY: INVISIBLE_SEAT_TOP_Y,
    };
    runtimeRef.current.frames.hipFrame.copy(hipFrame);
    runtimeRef.current.frames.thighFrameLeft.copy(thighLeft);
    runtimeRef.current.frames.thighFrameRight.copy(thighRight);

    if (!isSitting && runtimeRef.current.sitProgress <= 0.001 && !standRecoverNotifiedRef.current) {
      standRecoverNotifiedRef.current = true;
      onStandRecoverComplete?.();
    }
  }, -100);

  return (
    <group ref={modelRef} position={modelBasePosition}>
      <primitive object={scene} scale={[MODEL_SCALE, MODEL_SCALE, MODEL_SCALE]} />
    </group>
  );
}

function SkirtCloth({ runtimeRef, tuning, resetVersion }: SkirtClothProps) {
  const config = CONFIG;
  const vertexCount = config.radialSegments * config.heightSegments;
  const checkerTexture = useMemo(() => createCheckerTexture(), []);

  const clothGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(vertexCount * 3);
    const indices: number[] = [];

    for (let row = 0; row < config.heightSegments; row += 1) {
      for (let col = 0; col < config.radialSegments; col += 1) {
        const i = gridIndex(row, col, config.radialSegments);
        positions[i * 3] = 0;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = 0;

        if (row < config.heightSegments - 1) {
          const nextCol = wrapCol(col + 1, config.radialSegments);
          const i0 = gridIndex(row, col, config.radialSegments);
          const i1 = gridIndex(row, nextCol, config.radialSegments);
          const i2 = gridIndex(row + 1, col, config.radialSegments);
          const i3 = gridIndex(row + 1, nextCol, config.radialSegments);
          indices.push(i0, i2, i1);
          indices.push(i1, i2, i3);
        }
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }, [config, vertexCount]);
  const clothGeometryRef = useRef<THREE.BufferGeometry | null>(null);

  const simRef = useRef<SimulationState>({
    initialized: false,
    vertices: [],
    distance: [],
    bend: [],
    targetStanding: [],
    targetSitting: [],
    targetBlended: [],
  });
  const lastConstraintTuningRef = useRef<SkirtTuning | null>(null);
  const penetrationMonitorRef = useRef({
    frameCount: 0,
    highDepthStreak: 0,
    lastMaxDepth: 0,
    lastColliderName: 'unknown',
  });
  const settleFrameRef = useRef(0);
  const standingHemFlipStreakRef = useRef(0);
  const seatBelowStreakRef = useRef(0);

  useEffect(() => {
    clothGeometryRef.current = clothGeometry;
    simRef.current.initialized = false;
    lastConstraintTuningRef.current = null;
    penetrationMonitorRef.current.frameCount = 0;
    penetrationMonitorRef.current.highDepthStreak = 0;
    penetrationMonitorRef.current.lastMaxDepth = 0;
    penetrationMonitorRef.current.lastColliderName = 'unknown';
    settleFrameRef.current = 0;
    standingHemFlipStreakRef.current = 0;
    seatBelowStreakRef.current = 0;
  }, [clothGeometry, resetVersion]);

  useFrame((_, delta) => {
    const sim = simRef.current;
    const runtime = runtimeRef.current;

    const runtimeReady = runtime.colliders.length > 0;
    if (!sim.initialized) {
      if (!runtimeReady) return;
      initializeSimulationFromRuntime(sim, runtime, config, tuning);
      lastConstraintTuningRef.current = { ...tuning };
      settleFrameRef.current = 0;
    }

    const lastTuning = lastConstraintTuningRef.current;
    const tuningChanged =
      !lastTuning ||
      Math.abs(lastTuning.hemYOffset - tuning.hemYOffset) > 0.002 ||
      Math.abs(lastTuning.waistSlimness - tuning.waistSlimness) > 0.002 ||
      Math.abs(lastTuning.waistAnchorLift - tuning.waistAnchorLift) > 0.004;

    if (tuningChanged) {
      rebuildConstraintRestLengths(sim, config, tuning);
      dampVelocitiesForTuningChange(sim.vertices);
      lastConstraintTuningRef.current = { ...tuning };
    }

    const vertices = sim.vertices;
    const sitProgress = smoothstep01(runtime.sitProgress);
    const seat = runtime.seat;
    const inTransition = sitProgress > 0.001 && sitProgress < 0.999;
    const isSettling = settleFrameRef.current < 30;

    const dampingBase = inTransition ? config.dampingTransition : config.dampingStand;
    const damping = isSettling ? Math.min(0.985, dampingBase + 0.015) : dampingBase;
    const subDt = Math.min(1 / 24, delta) / config.substeps;

    for (let sub = 0; sub < config.substeps; sub += 1) {
      const hipFrame = runtime.frames.hipFrame;
      const leftFrame = runtime.frames.thighFrameLeft;
      const rightFrame = runtime.frames.thighFrameRight;

      TMP3.setFromMatrixPosition(hipFrame);
      const leftPos = TMP4.setFromMatrixPosition(leftFrame);
      const rightPos = TMP5.setFromMatrixPosition(rightFrame);
      TMP2.copy(leftPos).add(rightPos).multiplyScalar(0.5);
      const seatedBlend = sitProgress;

      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        const rowRatio = v.row / (config.heightSegments - 1);
        const standTarget = computeStandingTargetVertex(v.row, v.col, hipFrame, config, tuning);
        const sitTarget = computeSittingTargetVertex(v.row, v.col, hipFrame, leftFrame, rightFrame, seat, config, tuning);

        applySmoothHandClearanceToTarget(standTarget, v.row, v.col, hipFrame, runtime.colliders, config);
        makeTargetCollisionSafe(standTarget, runtime.colliders, config.clothThickness, rowRatio);

        applySmoothHandClearanceToTarget(sitTarget, v.row, v.col, hipFrame, runtime.colliders, config);
        makeTargetCollisionSafe(sitTarget, runtime.colliders, config.clothThickness, rowRatio);
        makeSittingTargetSeatSafe(sitTarget, seat, rowRatio, config.clothThickness);

        sim.targetStanding[i].copy(standTarget);
        sim.targetSitting[i].copy(sitTarget);
        sim.targetBlended[i].copy(standTarget).lerp(sitTarget, seatedBlend);
      }

      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        if (v.invMass <= 0) {
          v.previous.copy(v.current);
          continue;
        }

        const gravityScale = isSettling ? 0.15 : sitProgress > 0.15 ? 0.25 : 0.35;
        v.velocity.y -= config.gravity * gravityScale * subDt;
        v.velocity.multiplyScalar(damping);
        if (isSettling) v.velocity.multiplyScalar(0.88);

        const rowRatio = v.row / (config.heightSegments - 1);
        if (isSettling && v.velocity.y > 0 && rowRatio > 0.55) v.velocity.y *= 0.15;

        const speed = v.velocity.length();
        if (speed > config.maxVelocity) v.velocity.multiplyScalar(config.maxVelocity / speed);
      }

      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        if (v.invMass <= 0) {
          v.previous.copy(v.current);
          continue;
        }

        v.previous.copy(v.current);
        TMP0.copy(v.velocity).multiplyScalar(subDt);
        const disp = TMP0.length();
        if (disp > config.maxDisplacement) TMP0.multiplyScalar(config.maxDisplacement / disp);
        v.current.add(TMP0);
      }

      let substepMaxDepth = 0;
      let substepWorstCollider: string | null = null;

      for (let iter = 0; iter < config.constraintIterations; iter += 1) {
        for (let i = 0; i < sim.distance.length; i += 1) solveDistanceConstraint(vertices, sim.distance[i]);
        for (let i = 0; i < sim.bend.length; i += 1) solveBendConstraint(vertices, sim.bend[i]);

        for (let i = 0; i < vertices.length; i += 1) {
          const v = vertices[i];
          const rowRatio = v.row / (config.heightSegments - 1);
          let strength = rowTargetStrength(v.row, rowRatio);
          if (sitProgress > 0.15) {
            if (rowRatio < 0.25) {
              strength = Math.max(strength, THREE.MathUtils.lerp(0.8, 1.0, sitProgress));
            } else if (rowRatio < 0.62) {
              strength = Math.max(strength, THREE.MathUtils.lerp(0.62, 0.82, sitProgress));
            } else {
              strength = Math.max(strength, THREE.MathUtils.lerp(0.45, 0.65, sitProgress));
            }
          }
          if (isSettling) {
            strength *= rowRatio > 0.5 ? 1.3 : 1.18;
          }

          if (seatedBlend > 0.1) {
            if (v.region === 'back' && rowRatio > 0.35) strength += 0.1 * seatedBlend;
            if (v.region === 'front' && rowRatio > 0.22 && rowRatio < 0.82) strength += 0.04 * seatedBlend;
            if (v.region === 'left' || v.region === 'right') strength += 0.03 * seatedBlend;
          }

          if (tuning.hemYOffset > 0 && rowRatio > 0.65) {
            strength *= THREE.MathUtils.lerp(1.0, 0.55, smoothstep01((rowRatio - 0.65) / 0.35));
          }

          const targetStrength = THREE.MathUtils.clamp(strength, 0, 1) * (0.72 + 0.28 * v.pinWeight);
          applyTargetShapeConstraint(v, sim.targetBlended[i], targetStrength);

          if (sitProgress < 0.08 && rowRatio > 0.55) {
            const targetY = sim.targetBlended[i].y;
            const maxLift = 0.035;
            if (v.current.y > targetY + maxLift) {
              v.current.y = THREE.MathUtils.lerp(v.current.y, targetY + maxLift, 0.65);
              if (v.velocity.y > 0) v.velocity.y *= 0.15;
            }
          }
        }

        const bodyIter = sitProgress > 0.2 ? 2 : 1;
        const collisionResult = solveBodyCollisions(vertices, runtime.colliders, config, bodyIter);
        solveHandCollisions(vertices, runtime.colliders, config, 1);
        solveSeatCollision(vertices, seat, config, 1, sitProgress);
        if (collisionResult.maxDepth > substepMaxDepth) {
          substepMaxDepth = collisionResult.maxDepth;
          substepWorstCollider = collisionResult.deepestColliderName;
        }
      }

      const monitorInSubstep = penetrationMonitorRef.current;
      if (substepMaxDepth > monitorInSubstep.lastMaxDepth) {
        monitorInSubstep.lastMaxDepth = substepMaxDepth;
        if (substepWorstCollider) monitorInSubstep.lastColliderName = substepWorstCollider;
      }

      smoothClothSurface(vertices, config, seatedBlend > 0.2 ? 0.06 : 0.03);

      const finalCollision = solveBodyCollisions(vertices, runtime.colliders, config, seatedBlend > 0.1 ? 3 : 2);
      solveHandCollisions(vertices, runtime.colliders, config, seatedBlend > 0.1 ? 2 : 1);
      solveSeatCollision(vertices, seat, config, seatedBlend > 0.1 ? 3 : 2, sitProgress);
      if (finalCollision.maxDepth > monitorInSubstep.lastMaxDepth) {
        monitorInSubstep.lastMaxDepth = finalCollision.maxDepth;
        if (finalCollision.deepestColliderName) monitorInSubstep.lastColliderName = finalCollision.deepestColliderName;
      }

      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        TMP0.copy(v.current).sub(v.previous).multiplyScalar(1 / Math.max(subDt, EPS));
        if (v.penetrated) TMP0.multiplyScalar(0.45);
        v.velocity.copy(TMP0);
      }
    }

    if (isSettling) settleFrameRef.current += 1;

    const monitor = penetrationMonitorRef.current;
    monitor.frameCount += 1;
    if (monitor.frameCount > 45) {
      if (monitor.lastMaxDepth > 0.2) {
        monitor.highDepthStreak += 1;
        if (monitor.highDepthStreak >= 12) {
          throttledInvariantWarn(
            `aggregated-penetration:${monitor.lastColliderName}`,
            `[ClothSimulator] Persistent penetration warning near ${monitor.lastColliderName}: maxDepth=${monitor.lastMaxDepth.toFixed(4)}`
          );
        }
      } else {
        monitor.highDepthStreak = 0;
      }

      if (sitProgress > 0.25 && detectBucketShape(vertices, config)) {
        throttledInvariantWarn('bucket-shape-detected', '[ClothSimulator] Bucket-like skirt shape detected during sit pose.');
      }
    }
    monitor.lastMaxDepth = 0;

    if (sitProgress < 0.08) {
      let sumDelta = 0;
      let count = 0;
      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        const rowRatio = v.row / (config.heightSegments - 1);
        if (rowRatio <= 0.75) continue;
        sumDelta += v.current.y - sim.targetBlended[i].y;
        count += 1;
      }
      const avgDelta = count > 0 ? sumDelta / count : 0;
      if (avgDelta > 0.05) {
        standingHemFlipStreakRef.current += 1;
        if (standingHemFlipStreakRef.current > 10) {
          throttledInvariantWarn('standing-hem-flip', '[ClothSimulator] Standing hem flip detected.');
        }
      } else {
        standingHemFlipStreakRef.current = 0;
      }
    } else {
      standingHemFlipStreakRef.current = 0;
    }

    if (sitProgress > 0.15) {
      const halfX = seat.size.x * 0.5 + 0.1;
      const halfZ = seat.size.z * 0.5 + 0.14;
      let belowSeatFound = false;
      for (let i = 0; i < vertices.length; i += 1) {
        const v = vertices[i];
        const rowRatio = v.row / (config.heightSegments - 1);
        if (rowRatio <= 0.42) continue;
        const inX = Math.abs(v.current.x - seat.center.x) <= halfX;
        const inZ = Math.abs(v.current.z - seat.center.z) <= halfZ;
        if (!inX || !inZ) continue;
        if (v.current.y < seat.topY) {
          belowSeatFound = true;
          break;
        }
      }
      if (belowSeatFound) {
        seatBelowStreakRef.current += 1;
        if (seatBelowStreakRef.current > 3) {
          throttledInvariantWarn('cloth-below-seat', '[ClothSimulator] Seated cloth below invisible seat.');
        }
      } else {
        seatBelowStreakRef.current = 0;
      }
    } else {
      seatBelowStreakRef.current = 0;
    }

    const geometry = clothGeometryRef.current;
    if (!geometry) return;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < vertices.length; i += 1) {
      posAttr.setXYZ(i, vertices[i].current.x, vertices[i].current.y, vertices[i].current.z);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  });

  return (
    <mesh geometry={clothGeometry} castShadow receiveShadow>
      <meshStandardMaterial
        map={checkerTexture ?? undefined}
        color="#7dd3fc"
        side={DoubleSide}
        wireframe={false}
        metalness={0.15}
        roughness={0.55}
      />
    </mesh>
  );
}

export default function ClothSimulator() {
  const [isSitting, setIsSitting] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);

  const [waistAnchorLift, setWaistAnchorLift] = useState(0.02);
  const [waistSlimness, setWaistSlimness] = useState(0.0);
  const [hemYOffset, setHemYOffset] = useState(0.0);
  const [sliderLocked, setSliderLocked] = useState(false);

  const resetAll = useCallback(() => {
    setIsSitting(false);
    setSliderLocked(false);
    setWaistAnchorLift(0.02);
    setWaistSlimness(0.0);
    setHemYOffset(0.0);
    runtimeRef.current.sitProgress = 0;
    setResetVersion((v) => v + 1);
  }, []);

  const tuning = useMemo<SkirtTuning>(
    () => ({
      waistAnchorLift,
      waistSlimness,
      hemYOffset,
    }),
    [waistAnchorLift, waistSlimness, hemYOffset]
  );

  const runtimeRef = useRef<HumanRuntimeData>({
    colliders: [],
    frames: {
      hipFrame: new THREE.Matrix4().makeTranslation(0, 1.0, -0.55),
      thighFrameLeft: new THREE.Matrix4().makeTranslation(-0.12, 0.75, -0.45),
      thighFrameRight: new THREE.Matrix4().makeTranslation(0.12, 0.75, -0.45),
    },
    sitProgress: 0,
    seat: {
      center: INVISIBLE_SEAT_CENTER.clone(),
      size: INVISIBLE_SEAT_SIZE.clone(),
      topY: INVISIBLE_SEAT_TOP_Y,
    },
  });

  const modelBasePosition: [number, number, number] = [0, 0, -0.55];

  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [0, 1.9, 5.4], fov: 40 }} className="h-full w-full">
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 2]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
        <spotLight position={[-4, 6, 4]} intensity={0.6} penumbra={0.4} />

        <BasePlane />

        <HumanModel
          isSitting={isSitting}
          modelYOffset={0}
          modelBasePosition={modelBasePosition}
          runtimeRef={runtimeRef}
          resetVersion={resetVersion}
          onStandRecoverComplete={() => {
            setSliderLocked(false);
          }}
        />

        <SkirtCloth runtimeRef={runtimeRef} tuning={tuning} resetVersion={resetVersion} />

        <OrbitControls makeDefault enablePan enableZoom enableRotate />
      </Canvas>

      <div className="pointer-events-none absolute inset-0 flex items-start justify-start p-4">
        <div className="pointer-events-auto w-80 rounded-2xl border border-slate-300/20 bg-slate-900/80 p-3 shadow-2xl backdrop-blur">
          <button
            type="button"
            onClick={() => {
              setIsSitting((value) => {
                const next = !value;
                if (next) setSliderLocked(true);
                return next;
              });
            }}
            className="mb-2 w-full rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
          >
            {isSitting ? '立つ' : '座る'}
          </button>

          <button
            type="button"
            onClick={resetAll}
            className="mb-3 w-full rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500"
          >
            初期状態に戻る
          </button>

          <div className="border-t border-slate-600 pt-3 text-slate-200">
            <h4 className="mb-2 text-sm font-semibold text-emerald-300">腰/裾のリアルタイム調整</h4>
            <p className="mb-2 text-[11px] text-slate-400">座る実行後は、立ち動作完了までスライダーはロックされます。</p>

            <label className="mb-1 block text-xs">腰アンカー高さ: {waistAnchorLift.toFixed(2)}</label>
            <input
              type="range"
              min="-0.02"
              max="0.16"
              step="0.005"
              value={waistAnchorLift}
              onChange={(event) => setWaistAnchorLift(Number(event.target.value))}
              disabled={sliderLocked}
              className="mb-2 w-full"
            />

            <label className="mb-1 block text-xs">腰細さ: {waistSlimness.toFixed(2)}</label>
            <input
              type="range"
              min="0"
              max="0.14"
              step="0.005"
              value={waistSlimness}
              onChange={(event) => setWaistSlimness(Number(event.target.value))}
              disabled={sliderLocked}
              className="mb-2 w-full"
            />

            <label className="mb-1 block text-xs">裾高さ調整: {hemYOffset.toFixed(2)}</label>
            <input
              type="range"
              min="-0.20"
              max="0.20"
              step="0.005"
              value={hemYOffset}
              onChange={(event) => setHemYOffset(Number(event.target.value))}
              disabled={sliderLocked}
              className="w-full"
            />
          </div>
        </div>
      </div>

    </div>
  );
}
