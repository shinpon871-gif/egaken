"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useFBX } from '@react-three/drei';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils';

// ボーン構造診断用
function dumpBoneStructure(root: THREE.Object3D, label: string): void {
  const bones: Array<{ name: string; depth: number }> = [];
  root.traverse((obj, depth = 0) => {
    const bone = obj as THREE.Bone;
    if (bone.isBone && bone.name) {
      bones.push({ name: bone.name, depth: 0 });
    }
  });

  let hierarchy = '';
  root.traverse((obj) => {
    const bone = obj as THREE.Bone;
    if (!bone.isBone || !bone.name) return;

    let depth = 0;
    let p = bone.parent;
    while (p && p !== root) {
      depth += 1;
      p = p.parent;
    }

    hierarchy += '  '.repeat(depth) + bone.name + '\n';
  });

  console.log(`\n=== ${label} ===\nTotal bones: ${bones.length}\n${hierarchy}`);
}


const SUPPRESSED_CONSOLE_PATTERNS = [
  'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.',
  'THREE.WebGLShadowMap: PCFSoftShadowMap has been deprecated. Using PCFShadowMap instead.',
  'THREE.FBXLoader: Vertex has more than 4 skinning weights assigned to vertex. Deleting additional weights.',
  'THREE.FBXLoader:',
  'map is not supported in three.js, skipping texture.',
  'undefined map is not supported in three.js, skipping texture.',
  'Download the React DevTools for a better development experience',
  '[Fast Refresh] rebuilding',
  '[Fast Refresh] done in',
];

const __clothConsolePatchKey = '__clothSimulatorConsolePatched_v2';
const __fbxTextureUrlGuardKey = '__clothSimulatorFbxTextureUrlGuard_v1';
if (typeof globalThis !== 'undefined' && !(globalThis as Record<string, unknown>)[__clothConsolePatchKey]) {
  (globalThis as Record<string, unknown>)[__clothConsolePatchKey] = true;

  const shouldSuppressConsoleMessage = (args: unknown[]): boolean => {
    const joined = args.map((arg) => String(arg)).join(' ');
    return SUPPRESSED_CONSOLE_PATTERNS.some((msg) => joined.includes(msg));
  };

  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);

  console.warn = (...args: unknown[]) => {
    if (shouldSuppressConsoleMessage(args)) return;
    originalWarn(...args);
  };
  console.log = (...args: unknown[]) => {
    if (shouldSuppressConsoleMessage(args)) return;
    originalLog(...args);
  };
  console.info = (...args: unknown[]) => {
    if (shouldSuppressConsoleMessage(args)) return;
    originalInfo(...args);
  };
}

if (typeof globalThis !== 'undefined' && !(globalThis as Record<string, unknown>)[__fbxTextureUrlGuardKey]) {
  (globalThis as Record<string, unknown>)[__fbxTextureUrlGuardKey] = true;

  const shouldIgnoreFbxTextureUrl = (value: string): boolean => {
    if (!value) return false;

    const normalized = value.replace(/\\/g, '/');
    return (
      /^(?:[A-Za-z]:)?\/Users\//i.test(normalized) ||
      /\/Users\//i.test(normalized) ||
      /My%20project\/Assets\//i.test(normalized) ||
      /Asset%20Manager\//i.test(normalized) ||
      /scourceimages\//i.test(normalized) ||
      /female_avartar\.bmp/i.test(normalized) ||
      /egaken\.Textures/i.test(normalized)
    );
  };

  const originalTextureLoad = THREE.TextureLoader.prototype.load.bind(THREE.TextureLoader.prototype) as typeof THREE.TextureLoader.prototype.load;

  THREE.TextureLoader.prototype.load = function patchedLoad(
    this: THREE.TextureLoader,
    url: string,
    onLoad?: ((texture: THREE.Texture) => void) | undefined,
    onProgress?: ((event: ProgressEvent) => void) | undefined,
    onError?: ((event: ErrorEvent | Error) => void) | undefined
  ) {
    const textureUrl = typeof url === 'string' ? url : '';
    if (shouldIgnoreFbxTextureUrl(textureUrl)) {
      const fallbackTexture = new THREE.Texture();
      fallbackTexture.colorSpace = THREE.SRGBColorSpace;
      if (typeof onLoad === 'function') {
        onLoad(fallbackTexture);
      }
      return fallbackTexture;
    }

    return originalTextureLoad.call(
      this,
      url,
      onLoad as ((texture: THREE.Texture) => void) | undefined,
      onProgress as ((event: ProgressEvent) => void) | undefined,
      onError as ((err: unknown) => void) | undefined
    );
  } as typeof THREE.TextureLoader.prototype.load;
}

// メッシュごとのカスタム色割り当て用の型定義
interface MeshColorMapping {
  [meshId: string]: 'clothing' | 'body' | 'default';
}

type MeshType = 'clothing' | 'body' | 'default';

const SAFE_SIT_CLIP_PROGRESS = 0.85; // 100%の座位ポーズはモデル上で体が不自然に折れ曲がるため85%程度までで止める

function inferMeshType(
  meshName: string,
  parentName: string,
  matName: string,
  texName: string,
  customType?: MeshType
): MeshType {
  if (customType && customType !== 'default') return customType;

  const meshOnly = meshName.toLowerCase();
  const searchStr = `${meshName} ${parentName} ${matName} ${texName}`.toLowerCase();

  // 現在のモデルには特定命名のボディメッシュが含まれる
  // 以前の分類器はその命名規則を拾えず服カテゴリ側に落ちていたため
  // 肌色スライダーの結果が服色で上書きされる問題が起きていた
  const knownBodyMesh =
    /female[_-]?avartar|female[_-]?avatar|avartar|avatar|zbrush|defualt_group|default_group/.test(meshOnly);
  const knownClothingMesh =
    /^d026/i.test(meshName) ||
    /skirt|dress|shirt|top|pant|jacket|coat|sleeve|hood|blouse|cape|jumpsuit|tunic|cloth|clothes|bottom|wear|suit|collar|tie|sock|shoe|boot|hat|cap|glove/i.test(meshOnly);

  if (knownBodyMesh) return 'body';
  if (knownClothingMesh) return 'clothing';

  const isBody = /body|skin|torso|head|leg|arm|hand|foot|face|neck|eye|mouth|teeth|hair|ear|nose|brow|lash|female|avatar|avartar|zbrush/i.test(searchStr);
  const isClothing = /skirt|dress|shirt|top|pant|jacket|coat|sleeve|hood|blouse|cape|jumpsuit|tunic|cloth|clothes|bottom|wear|suit|collar|tie|sock|shoe|boot|hat|cap|glove/i.test(searchStr);

  if (isBody && !isClothing) return 'body';
  if (isClothing) return 'clothing';
  return 'clothing';
}

function isArmPoseBoneName(name: string): boolean {
  return /mixamorig(left|right)(arm|forearm|hand)|left(upper)?arm|right(upper)?arm|leftforearm|rightforearm|lefthand|righthand/i.test(name);
}

function normalizeSkirtFrameToLocal(frame: number[][], garmentReferenceName?: string | null): Float32Array {
  if (!frame || frame.length === 0) return new Float32Array();

  const points = frame.map((pt) => ({ x: pt[0] ?? 0, y: pt[1] ?? 0, z: pt[2] ?? 0 }));
  const centroid = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z }),
    { x: 0, y: 0, z: 0 }
  );

  const count = points.length || 1;
  const center = { x: centroid.x / count, y: centroid.y / count, z: centroid.z / count };
  const localScale = garmentReferenceName ? 1.6 : 1.35;
  const base = new Float32Array(frame.length * 3);

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const localX = (point.x - center.x) * localScale;
    const localY = (point.y - center.y) * localScale;
    const localZ = (point.z - center.z) * localScale;
    const radial = Math.hypot(localX, localZ) || 0.0001;
    const normalizedX = radial > 0 ? localX / radial : 1;
    const normalizedZ = radial > 0 ? localZ / radial : 0;

    base[i * 3] = localX + normalizedX * 0.02;
    base[i * 3 + 1] = localY + Math.abs(point.y - center.y) * 0.2;
    base[i * 3 + 2] = localZ + normalizedZ * 0.02;
  }

  return base;
}

function mapSkirtFrameToMeshVertices(
  mesh: THREE.Mesh,
  frame: number[][],
  garmentReferenceName?: string | null,
  motionScale = 1.0
): Float32Array {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  if (!positions) return new Float32Array();

  const basePositions = mesh.userData.skirtBasePositions as Float32Array | undefined;
  if (!basePositions || basePositions.length === 0) return new Float32Array();

  const mapped = basePositions.slice();
  const vertexCount = Math.min(positions.count, frame.length, basePositions.length / 3);
  const restFrame = frame[0] ?? [0, 0, 0];

  for (let i = 0; i < vertexCount; i += 1) {
    const idx = i * 3;
    const point = frame[i] ?? frame[Math.min(frame.length - 1, i)];
    if (!point) {
      continue;
    }

    const reference = restFrame.length >= 3 ? restFrame : [0, 0, 0];
    const deltaX = (point[0] - reference[0]) * motionScale;
    const deltaY = (point[1] - reference[1]) * motionScale;
    const deltaZ = (point[2] - reference[2]) * motionScale;

    mapped[idx] = basePositions[idx] + deltaX;
    mapped[idx + 1] = basePositions[idx + 1] + deltaY;
    mapped[idx + 2] = basePositions[idx + 2] + deltaZ;
  }

  return mapped;
}

async function loadSkirtAssetFromUrl(candidate: string): Promise<THREE.Object3D | null> {
  console.log('[SceneWithFBX] attempting real skirt asset load:', candidate);

  try {
    const response = await fetch(candidate);
    console.log('[SceneWithFBX] fetch status for real skirt asset:', candidate, response.status, response.headers.get('content-type'));
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const header = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 4)));
    console.log('[SceneWithFBX] asset magic header:', candidate, header, 'length:', buffer.byteLength);

    const useGltfLoader = header === 'glTF' || candidate.toLowerCase().endsWith('.glb') || candidate.toLowerCase().endsWith('.gltf');

    if (useGltfLoader) {
      const loader = new GLTFLoader();
      const gltf = await loader.parseAsync(buffer, '/');
      const scene = gltf.scene ?? null;
      console.log('[SceneWithFBX] parsed real skirt mesh as glTF:', candidate, 'sceneChildren:', scene?.children.length ?? 0);
      return scene;
    }

    const loader = new FBXLoader();
    const fbxRoot = loader.parse(buffer, '/');
    console.log('[SceneWithFBX] parsed real skirt mesh as FBX:', candidate, 'children:', fbxRoot.children.length);
    return fbxRoot as THREE.Object3D;
  } catch (error) {
    console.warn('[SceneWithFBX] real skirt asset load failed:', candidate, error);
    return null;
  }
}

function createStandaloneSkirtMesh(skirtAnimData: number[][][] | null, colorHex: string, garmentReferenceName?: string | null): THREE.Mesh | null {
  if (!skirtAnimData || skirtAnimData.length === 0) return null;

  const referenceFrame = skirtAnimData[0];
  if (!referenceFrame || referenceFrame.length === 0) return null;

  const positions = normalizeSkirtFrameToLocal(referenceFrame, garmentReferenceName);
  const vertexCount = positions.length / 3;
  const segments = Math.max(10, Math.min(36, Math.round(Math.sqrt(vertexCount))));
  const rings = Math.max(8, Math.ceil(vertexCount / segments));
  const indices: number[] = [];

  for (let ring = 0; ring < rings - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * segments + segment;
      const b = ring * segments + ((segment + 1) % segments);
      const c = (ring + 1) * segments + segment;
      const d = (ring + 1) * segments + ((segment + 1) % segments);
      if (a < vertexCount && b < vertexCount && c < vertexCount && d < vertexCount) {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (indices.length > 0) {
    geometry.setIndex(indices);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    roughness: 0.8,
    metalness: 0.1,
    wireframe: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DedicatedSkirtMesh';
  mesh.position.set(0, 0.8, 0);
  mesh.userData.skirtBasePositions = positions.slice();
  mesh.userData.skirtSegments = segments;
  mesh.userData.skirtRings = rings;
  mesh.userData.skirtFrameCount = skirtAnimData.length;
  return mesh;
}

function findSkirtMesh(root: THREE.Object3D): THREE.Mesh | null {
  if (!root) return null;

  const candidates: Array<{ mesh: THREE.Mesh; score: number; debug: string }> = [];

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;

    const mesh = obj as THREE.Mesh;
    const pos = mesh.geometry?.attributes.position;
    const vertexCount = pos ? pos.count : 0;
    const materialNames = Array.isArray(mesh.material)
      ? mesh.material.map((m) => (m ? m.name : '')).join(' ')
      : mesh.material?.name || '';

    const searchable = [
      mesh.name,
      mesh.parent?.name || '',
      materialNames,
      mesh.geometry?.uuid || '',
      mesh.userData?.name || '',
    ]
      .join(' ')
      .toLowerCase();

    const isBodyLike = /avatar|avartar|zbrush|default_group|body|skin|head|torso|arm|leg|hand|foot|face|neck|hair/.test(searchable);
    const isClothingLike = /skirt|petticoat|hem|dress|sash|garment|cloth|coat skirt|coatskirt|lower garment/.test(searchable);

    let score = 0;
    if (isClothingLike) score += 500;
    if (/skirtback|skirtfront|skirtside/.test(searchable)) score += 250;
    if (/d026|dress|skirt|cloth/.test(materialNames.toLowerCase())) score += 80;
    if (vertexCount > 4000 && vertexCount < 20000) score += 80;
    if (vertexCount > 20000 && vertexCount < 60000) score += 30;
    if (vertexCount > 60000) score -= 400;
    if (isBodyLike) score -= 1000;

    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    if (size.y > 2.0 || size.x > 2.5 || size.z > 1.5) score -= 300;
    if (size.y > 0.3 && size.y < 1.2 && size.x < 1.5 && size.z < 1.0) score += 50;

    if (score >= 150 && !isBodyLike && vertexCount < 60000) {
      candidates.push({
        mesh,
        score,
        debug: `${mesh.name || 'unnamed'} :: score=${score} :: verts=${vertexCount} :: size=${size.toArray().map((v) => v.toFixed(3)).join(',')}`,
      });
    }
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  if (top) {
    console.log('[SceneWithFBX] selected skirt mesh candidate:', top.debug);
  }

  return top?.mesh ?? null;
}

type ArmSpreadBones = {
  hips: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  leftForearm: THREE.Object3D | null;
  rightForearm: THREE.Object3D | null;
};

// 立位区間でのみ腕広げ補正を有効化する終了進捗（これを超えると補正しない）
const STANDING_ARM_SPREAD_END_PROGRESS = 0.18;
// 現在腕方向を目標方向へ寄せる補間率（大きいほど強く目標へ寄る）
const STANDING_ARM_OUTWARD_BLEND = 0.38;
// 目標腕方向を作る際の左右成分の重み（大きいほど外側へ開く）
const STANDING_ARM_OUTWARD_LATERAL_WEIGHT = 0.34;
// 1フレームあたりの最大回転角（正値）回転軸側で向きを決める
const STANDING_ARM_OUTWARD_MAX_ANGLE = THREE.MathUtils.degToRad(4);

type LegCloseBones = {
  hips: THREE.Object3D | null;
  leftThigh: THREE.Object3D | null;
  rightThigh: THREE.Object3D | null;
  leftKnee: THREE.Object3D | null;
  rightKnee: THREE.Object3D | null;
  leftFoot: THREE.Object3D | null;
  rightFoot: THREE.Object3D | null;
};

type LegAdductionCalibration = {
  leftAxis: THREE.Vector3 | null;
  rightAxis: THREE.Vector3 | null;
};

type ResolvedLegAdductionCalibration = {
  leftAxis: THREE.Vector3;
  rightAxis: THREE.Vector3;
};

const THIGH_CLOSE_START_PROGRESS = 0.12;
const THIGH_CLOSE_FULL_PROGRESS = 0.58;

// ★座位時の脚閉じ密着化定義（目標は股間が見えないほどぴったり太もも同士を閉じた状態）

//【座位脚閉じ関連の各パラメータ定義】
// 内腿サンプリング位置の補間係数（太ももから膝へのパス上での相対位置: 0.0=太もも, 1.0=膝）
const INNER_THIGH_SAMPLE_T = 0.34;
// ターゲット時の内腿間隔の比率（基本座位ポーズの内腿ギャップに対する縮小目標）
const TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE = 0.010;
// ターゲット時の膝間隔の比率（基本座位ポーズの膝ギャップに対する縮小目標）
const TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE = 0.07;
// ターゲット時の足首間隔の比率（基本座位ポーズの足首ギャップに対する縮小目標）
const TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE = 0.42;
// 内腿ギャップの厳格な下限（これ以上閉じるとメッシュが破綻する安全限界）
const HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE = 0.010;
// 膝ギャップの厳格な下限（脚交差を防ぐ安全限界）
const HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE = 0.05;
// 足首ギャップの厳格な下限（足首の不自然な動きを防ぐ安全限界）
const HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE = 0.22;
// 太もも内転の最大回転角（脚交差を防ぐため過度に上げない）
const MAX_THIGH_ADDUCTION_LOCAL_ANGLE = THREE.MathUtils.degToRad(17.5);
// 膝の世界座標調整の最大回転角（内転後の膝微調整に使用）
const MAX_WORLD_KNEE_ALIGN_ANGLE = THREE.MathUtils.degToRad(4.0);
// 軸キャリブレーション時のテスト回転角度
const CALIBRATION_TEST_ANGLE = THREE.MathUtils.degToRad(2.5);

//【脚閉じ探索で使用する数値的な閾値】
// ギャップ値の下限（比率計算の退化を防止）
const GAP_EPSILON_MIN = 0.001;
// 左右脚が元の側に留まる判定用閾値（脚交差を防止）
const LEG_SIDE_KEEP_EPSILON = 0.001;
// 脚閉じ進行度がほぼゼロと見なす閾値（微小値判定に使用）
const LEG_CLOSE_PROGRESS_ACTIVE_EPSILON = 0.0001;
// ベクトル外積の長さ二乗の下限（軸代替判定に使用）
const CROSS_AXIS_MIN_LENGTH_SQ = 1e-8;
// 方向ベクトル間の角度の下限（微小差分を無視して数値ノイズを低減）
const DIRECTION_ALIGNMENT_MIN_ANGLE = 1e-5;

//【軸キャリブレーション評価における重み係数】
// 膝の上下ずれペナルティ重み（大きいほど膝の上下動を抑制）
const AXIS_CALIBRATION_Y_PENALTY_WEIGHT = 0.25;
// 膝の前後ずれペナルティ重み（大きいほど膝の前後動を抑制）
const AXIS_CALIBRATION_Z_PENALTY_WEIGHT = 0.25;
// 足首の側方ずれペナルティ重み（足首の不自然な動きを抑制）
const AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT = 0.12;
// 脚交差検出時のペナルティ（脚交差を強く抑止）
const AXIS_CALIBRATION_SIDE_BREAK_PENALTY = 0.4;
// 軸キャリブレーション時の最小受け入れスコア（これ以下は不採用）
const AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE = -0.05;
// 軸の方向パターン数（左右各軸について正逆2方向を評価）
const AXIS_SIGN_VARIANTS = 2;

//【ターゲット値の微調整を開始・終了する判定用マージン】
// 内腜ギャップがターゲット超過時の許容値（超過で微調整開始）
const REFINE_TRIGGER_INNER_GAP_MARGIN = 0.002;
// 膝ギャップがターゲット超過時の許容値（超過で膝微調整開始）
const REFINE_TRIGGER_KNEE_GAP_MARGIN = 0.01;
// 脚が交差しないよう制限する値（ハード下限として機能）
const TARGET_SIDE_CLAMP_EPSILON = 0.001;

//【脚閉じ探索時の対称・非対称な内転スケール候補】
// 太もも内転の回転スケール候補（大きいほど内転が強い）
const LEG_CLOSE_BASE_SCALES = [2.40, 2.20, 2.00, 1.80, 1.60, 1.40, 1.20, 1.00, 0.80, 0.60, 0.40, 0.20];
// 左右非対称な内転を試す際のオフセット（左右異なる強度での閉じを可能にする）
const LEG_CLOSE_ASYMMETRY_OFFSETS = [0.0, -0.12, 0.12, -0.22, 0.22];

//【スコア計算における重み係数（内腜密着→膝密着→足首自然さの優先順）】
// 内腜ギャップの小ささ重視重み（大きいほど密着を優先）
const SCORE_INNER_GAP_WEIGHT = 1400;
// 内腿ギャップがターゲット超過時のペナルティ重み制御の強さ
const SCORE_INNER_EXCESS_WEIGHT = 600;
// 膝ギャップの小ささ重視重み（大きいほど膝を寄せるポーズを優先）
const SCORE_KNEE_GAP_WEIGHT = 55;
// 膝ギャップがターゲット超過時のペナルティ重み（過度な開きを抑制）
const SCORE_KNEE_EXCESS_WEIGHT = 20;
// 足首ギャップがターゲット以下の場合のボーナス重み（過度な密着を防止）
const SCORE_ANKLE_BONUS_WEIGHT = 0.5;
// 左右内転スケール差異のペナルティ重み（歪んだ座り方を避ける）
const SCORE_ASYMMETRY_WEIGHT = 0.15;

//【探索の早期終了判定用品質閾値】
// 内腿ギャップがターゲット以下となる許容値（充分な密着度）
const EARLY_ACCEPT_INNER_GAP_MARGIN = 0.0015;
// 膝ギャップがターゲット以下となる許容値（充分な膝の寄せ度）
const EARLY_ACCEPT_KNEE_GAP_MARGIN = 0.004;
// 探索早期終了判定時のスコア計算における内腿重み指数
const EARLY_BREAK_INNER_WEIGHT = 1000;
// 探索早期終了判定時のスコア計算における膝重み指数
const EARLY_BREAK_KNEE_WEIGHT = 40;
// 探索早期終了判定時のスコアベースオフセット（判定感度の調整値）
const EARLY_BREAK_SCORE_BIAS = 2.0;

const LEG_ADDUCTION_DEBUG_MAX_LOGS = 0;
const LEG_ADDUCTION_AXIS_RECOVERY_MAX_LOGS = 0;
const LEG_ADDUCTION_TRACE = false;
const LEG_ADDUCTION_TRACE_MAX_LOGS = 0;

type SeatedLegReference = {
  leftThighLocal: THREE.Vector3;
  rightThighLocal: THREE.Vector3;
  leftInnerThighLocal: THREE.Vector3;
  rightInnerThighLocal: THREE.Vector3;
  leftKneeLocal: THREE.Vector3;
  rightKneeLocal: THREE.Vector3;
  leftAnkleLocal: THREE.Vector3;
  rightAnkleLocal: THREE.Vector3;
  lateralAxisLocal: THREE.Vector3;
  thighGap: number;
  innerThighGap: number;
  kneeGap: number;
  ankleGap: number;
  hasAnkleReference: boolean;
};

let legAdductionDebugCount = 0;
let legAdductionAxisRecoveryDebugCount = 0;
let legAdductionTraceCount = 0;
let legAdductionSkipBeforeWindowCount = 0;

function logLegAdduction(
  event: string,
  payload: Record<string, unknown>,
  level: 'log' | 'warn' = 'log'
): void {
  if (!LEG_ADDUCTION_TRACE) return;
  if (legAdductionTraceCount >= LEG_ADDUCTION_TRACE_MAX_LOGS) return;

  legAdductionTraceCount += 1;
  const label = `[LegAdductionTrace] ${event}`;
  if (level === 'warn') {
    console.warn(label, payload);
    return;
  }
  console.log(label, payload);
}

function createAdductionAxisCandidates(): THREE.Vector3[] {
  const primary: THREE.Vector3[] = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  const diagonal: THREE.Vector3[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        if (x === 0 && y === 0 && z === 0) continue;
        const nonZero = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (nonZero === 1) continue; // 単軸方向は基本候補側で既に列挙済み
        diagonal.push(new THREE.Vector3(x, y, z).normalize());
      }
    }
  }
  return [...primary, ...diagonal];
}

const ADDUCTION_AXIS_CANDIDATES = createAdductionAxisCandidates();

function findBoneByNamePattern(root: THREE.Object3D, patterns: RegExp[]): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found || !obj.name) return;
    if (patterns.some((pattern) => pattern.test(obj.name))) {
      found = obj;
    }
  });
  return found;
}

function collectArmSpreadBones(root: THREE.Object3D): ArmSpreadBones {
  return {
    hips: findBoneByNamePattern(root, [/^mixamorigHips$/i, /^Hips$/i, /pelvis/i]),
    leftUpperArm: findBoneByNamePattern(root, [/^mixamorigLeftArm$/i, /^LeftArm$/i, /left.*upper.*arm/i, /left.*arm/i]),
    rightUpperArm: findBoneByNamePattern(root, [/^mixamorigRightArm$/i, /^RightArm$/i, /right.*upper.*arm/i, /right.*arm/i]),
    leftForearm: findBoneByNamePattern(root, [/^mixamorigLeftForeArm$/i, /^LeftForeArm$/i, /left.*forearm/i]),
    rightForearm: findBoneByNamePattern(root, [/^mixamorigRightForeArm$/i, /^RightForeArm$/i, /right.*forearm/i]),
  };
}

function collectLegCloseBones(root: THREE.Object3D): LegCloseBones {
  return {
    hips: findBoneByNamePattern(root, [/^mixamorigHips$/i, /^Hips$/i, /pelvis/i]),
    leftThigh: findBoneByNamePattern(root, [/^mixamorigLeftUpLeg$/i, /^LeftUpLeg$/i, /left.*up.*leg/i, /left.*thigh/i]),
    rightThigh: findBoneByNamePattern(root, [/^mixamorigRightUpLeg$/i, /^RightUpLeg$/i, /right.*up.*leg/i, /right.*thigh/i]),
    leftKnee: findBoneByNamePattern(root, [/^mixamorigLeftLeg$/i, /^LeftLeg$/i, /left(?!.*up).*leg/i, /left.*knee/i]),
    rightKnee: findBoneByNamePattern(root, [/^mixamorigRightLeg$/i, /^RightLeg$/i, /right(?!.*up).*leg/i, /right.*knee/i]),
    leftFoot: findBoneByNamePattern(root, [/^mixamorigLeftFoot$/i, /^LeftFoot$/i, /left.*foot/i, /left.*ankle/i]),
    rightFoot: findBoneByNamePattern(root, [/^mixamorigRightFoot$/i, /^RightFoot$/i, /right.*foot/i, /right.*ankle/i]),
  };
}

function smoothstep01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function getLocalPositionFromBone(
  hips: THREE.Object3D,
  bone: THREE.Object3D,
  out: THREE.Vector3,
  hipInv: THREE.Matrix4
): THREE.Vector3 {
  bone.getWorldPosition(out);
  return out.applyMatrix4(hipInv);
}

function getInnerThighLocalSample(
  hips: THREE.Object3D,
  thigh: THREE.Object3D,
  knee: THREE.Object3D,
  out: THREE.Vector3,
  hipInv: THREE.Matrix4
): THREE.Vector3 {
  const thighWorld = thigh.getWorldPosition(new THREE.Vector3());
  const kneeWorld = knee.getWorldPosition(new THREE.Vector3());
  out.copy(thighWorld).lerp(kneeWorld, INNER_THIGH_SAMPLE_T);
  return out.applyMatrix4(hipInv);
}

function getSignedLateralValue(localPos: THREE.Vector3, lateralAxisLocal: THREE.Vector3): number {
  return localPos.dot(lateralAxisLocal);
}

function resolveLateralAxisLocal(
  hips: THREE.Object3D,
  leftCandidate: THREE.Vector3,
  rightCandidate: THREE.Vector3,
  fallbackBoneLeft: THREE.Object3D | null,
  fallbackBoneRight: THREE.Object3D | null,
  hipInv: THREE.Matrix4
): THREE.Vector3 {
  const axis = new THREE.Vector3().subVectors(rightCandidate, leftCandidate);

  if (axis.lengthSq() < 1e-8 && fallbackBoneLeft && fallbackBoneRight) {
    const leftThighLocal = getLocalPositionFromBone(hips, fallbackBoneLeft, new THREE.Vector3(), hipInv);
    const rightThighLocal = getLocalPositionFromBone(hips, fallbackBoneRight, new THREE.Vector3(), hipInv);
    axis.copy(rightThighLocal.sub(leftThighLocal));
  }

  if (axis.lengthSq() < 1e-8) {
    axis.set(1, 0, 0);
  } else {
    axis.normalize();
  }

  return axis;
}

function captureSeatedLegReference(root: THREE.Object3D, bones: LegCloseBones): SeatedLegReference | null {
  if (!bones.hips || !bones.leftThigh || !bones.rightThigh || !bones.leftKnee || !bones.rightKnee) return null;

  root.updateMatrixWorld(true);
  const hipInv = new THREE.Matrix4().copy(bones.hips.matrixWorld).invert();

  const leftThighLocal = getLocalPositionFromBone(bones.hips, bones.leftThigh, new THREE.Vector3(), hipInv);
  const rightThighLocal = getLocalPositionFromBone(bones.hips, bones.rightThigh, new THREE.Vector3(), hipInv);
  const leftInnerThighLocal = getInnerThighLocalSample(bones.hips, bones.leftThigh, bones.leftKnee, new THREE.Vector3(), hipInv);
  const rightInnerThighLocal = getInnerThighLocalSample(bones.hips, bones.rightThigh, bones.rightKnee, new THREE.Vector3(), hipInv);
  const leftKneeLocal = getLocalPositionFromBone(bones.hips, bones.leftKnee, new THREE.Vector3(), hipInv);
  const rightKneeLocal = getLocalPositionFromBone(bones.hips, bones.rightKnee, new THREE.Vector3(), hipInv);

  const hasAnkles = Boolean(bones.leftFoot && bones.rightFoot);
  const leftAnkleLocal = hasAnkles
    ? getLocalPositionFromBone(bones.hips, bones.leftFoot as THREE.Object3D, new THREE.Vector3(), hipInv)
    : leftKneeLocal.clone();
  const rightAnkleLocal = hasAnkles
    ? getLocalPositionFromBone(bones.hips, bones.rightFoot as THREE.Object3D, new THREE.Vector3(), hipInv)
    : rightKneeLocal.clone();

  const lateralAxisLocal = resolveLateralAxisLocal(
    bones.hips,
    leftKneeLocal,
    rightKneeLocal,
    bones.leftThigh,
    bones.rightThigh,
    hipInv
  );

  const leftThighLateral = getSignedLateralValue(leftThighLocal, lateralAxisLocal);
  const rightThighLateral = getSignedLateralValue(rightThighLocal, lateralAxisLocal);
  const leftInnerThighLateral = getSignedLateralValue(leftInnerThighLocal, lateralAxisLocal);
  const rightInnerThighLateral = getSignedLateralValue(rightInnerThighLocal, lateralAxisLocal);
  const leftKneeLateral = getSignedLateralValue(leftKneeLocal, lateralAxisLocal);
  const rightKneeLateral = getSignedLateralValue(rightKneeLocal, lateralAxisLocal);
  const leftAnkleLateral = getSignedLateralValue(leftAnkleLocal, lateralAxisLocal);
  const rightAnkleLateral = getSignedLateralValue(rightAnkleLocal, lateralAxisLocal);

  return {
    leftThighLocal,
    rightThighLocal,
    leftInnerThighLocal,
    rightInnerThighLocal,
    leftKneeLocal,
    rightKneeLocal,
    leftAnkleLocal,
    rightAnkleLocal,
    lateralAxisLocal,
    thighGap: Math.max(0.001, rightThighLateral - leftThighLateral),
    innerThighGap: Math.max(0.001, rightInnerThighLateral - leftInnerThighLateral),
    kneeGap: Math.max(0.001, rightKneeLateral - leftKneeLateral),
    ankleGap: Math.max(0.001, rightAnkleLateral - leftAnkleLateral),
    hasAnkleReference: hasAnkles,
  };
}

function measureLegGaps(
  hips: THREE.Object3D,
  bones: LegCloseBones,
  seatedRef: SeatedLegReference
): {
  leftThighLocal: THREE.Vector3;
  rightThighLocal: THREE.Vector3;
  leftInnerThighLocal: THREE.Vector3;
  rightInnerThighLocal: THREE.Vector3;
  leftKneeLocal: THREE.Vector3;
  rightKneeLocal: THREE.Vector3;
  leftAnkleLocal: THREE.Vector3;
  rightAnkleLocal: THREE.Vector3;
  lateralAxisLocal: THREE.Vector3;
  thighGap: number;
  innerThighGap: number;
  kneeGap: number;
  ankleGap: number;
} {
  const hipInv = new THREE.Matrix4().copy(hips.matrixWorld).invert();
  const leftThighLocal = getLocalPositionFromBone(hips, bones.leftThigh as THREE.Object3D, new THREE.Vector3(), hipInv);
  const rightThighLocal = getLocalPositionFromBone(hips, bones.rightThigh as THREE.Object3D, new THREE.Vector3(), hipInv);
  const leftInnerThighLocal = getInnerThighLocalSample(hips, bones.leftThigh as THREE.Object3D, bones.leftKnee as THREE.Object3D, new THREE.Vector3(), hipInv);
  const rightInnerThighLocal = getInnerThighLocalSample(hips, bones.rightThigh as THREE.Object3D, bones.rightKnee as THREE.Object3D, new THREE.Vector3(), hipInv);
  const leftKneeLocal = getLocalPositionFromBone(hips, bones.leftKnee as THREE.Object3D, new THREE.Vector3(), hipInv);
  const rightKneeLocal = getLocalPositionFromBone(hips, bones.rightKnee as THREE.Object3D, new THREE.Vector3(), hipInv);
  const leftAnkleLocal = seatedRef.hasAnkleReference && bones.leftFoot
    ? getLocalPositionFromBone(hips, bones.leftFoot, new THREE.Vector3(), hipInv)
    : leftKneeLocal.clone();
  const rightAnkleLocal = seatedRef.hasAnkleReference && bones.rightFoot
    ? getLocalPositionFromBone(hips, bones.rightFoot, new THREE.Vector3(), hipInv)
    : rightKneeLocal.clone();

  return {
    leftThighLocal,
    rightThighLocal,
    leftInnerThighLocal,
    rightInnerThighLocal,
    leftKneeLocal,
    rightKneeLocal,
    leftAnkleLocal,
    rightAnkleLocal,
    lateralAxisLocal: seatedRef.lateralAxisLocal,
    thighGap: Math.max(
      0.001,
      getSignedLateralValue(rightThighLocal, seatedRef.lateralAxisLocal) - getSignedLateralValue(leftThighLocal, seatedRef.lateralAxisLocal)
    ),
    innerThighGap: Math.max(
      0.001,
      getSignedLateralValue(rightInnerThighLocal, seatedRef.lateralAxisLocal) - getSignedLateralValue(leftInnerThighLocal, seatedRef.lateralAxisLocal)
    ),
    kneeGap: Math.max(
      0.001,
      getSignedLateralValue(rightKneeLocal, seatedRef.lateralAxisLocal) - getSignedLateralValue(leftKneeLocal, seatedRef.lateralAxisLocal)
    ),
    ankleGap: Math.max(
      0.001,
      getSignedLateralValue(rightAnkleLocal, seatedRef.lateralAxisLocal) - getSignedLateralValue(leftAnkleLocal, seatedRef.lateralAxisLocal)
    ),
  };
}

function evaluateThighAdductionAxis(
  root: THREE.Object3D,
  bones: LegCloseBones,
  thigh: THREE.Object3D | null,
  knee: THREE.Object3D | null,
  foot: THREE.Object3D | null,
  side: 'left' | 'right'
): THREE.Vector3 | null {
  if (!bones.hips || !thigh || !knee) return null;

  const originalQ = thigh.quaternion.clone();
  root.updateMatrixWorld(true);
  const baseHipInv = new THREE.Matrix4().copy(bones.hips.matrixWorld).invert();
  const baseLeftKnee = getLocalPositionFromBone(bones.hips, bones.leftKnee as THREE.Object3D, new THREE.Vector3(), baseHipInv);
  const baseRightKnee = getLocalPositionFromBone(bones.hips, bones.rightKnee as THREE.Object3D, new THREE.Vector3(), baseHipInv);
  const lateralAxis = resolveLateralAxisLocal(
    bones.hips,
    baseLeftKnee,
    baseRightKnee,
    bones.leftThigh,
    bones.rightThigh,
    baseHipInv
  );
  const baseKnee = side === 'left' ? baseLeftKnee : baseRightKnee;
  const baseFoot = foot
    ? getLocalPositionFromBone(bones.hips, foot, new THREE.Vector3(), baseHipInv)
    : baseKnee.clone();

  let bestStrictAxis: THREE.Vector3 | null = null;
  let bestStrictScore = -Infinity;
  let bestLooseAxis: THREE.Vector3 | null = null;
  let bestLooseScore = -Infinity;

  for (let i = 0; i < ADDUCTION_AXIS_CANDIDATES.length; i += 1) {
    const candidate = ADDUCTION_AXIS_CANDIDATES[i];
    for (let signIndex = 0; signIndex < AXIS_SIGN_VARIANTS; signIndex += 1) {
      const signedAxis = candidate.clone().multiplyScalar(signIndex === 0 ? 1 : -1);
      thigh.quaternion.copy(originalQ);
      thigh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(signedAxis, CALIBRATION_TEST_ANGLE));
      root.updateMatrixWorld(true);

      const hipInv = new THREE.Matrix4().copy(bones.hips.matrixWorld).invert();
      const kneeLocal = getLocalPositionFromBone(bones.hips, knee, new THREE.Vector3(), hipInv);
      const footLocal = foot
        ? getLocalPositionFromBone(bones.hips, foot, new THREE.Vector3(), hipInv)
        : kneeLocal;

      const kneeLateral = getSignedLateralValue(kneeLocal, lateralAxis);
      const baseKneeLateral = getSignedLateralValue(baseKnee, lateralAxis);
      const footLateral = getSignedLateralValue(footLocal, lateralAxis);
      const baseFootLateral = getSignedLateralValue(baseFoot, lateralAxis);
      const xImprovement = side === 'left' ? kneeLateral - baseKneeLateral : baseKneeLateral - kneeLateral;
      const keepsSide = side === 'left' ? kneeLateral < -LEG_SIDE_KEEP_EPSILON : kneeLateral > LEG_SIDE_KEEP_EPSILON;
      const footKeepsSide = !foot || (side === 'left' ? footLateral < -LEG_SIDE_KEEP_EPSILON : footLateral > LEG_SIDE_KEEP_EPSILON);
      const yPenalty = Math.abs(kneeLocal.y - baseKnee.y) * AXIS_CALIBRATION_Y_PENALTY_WEIGHT;
      const zPenalty = Math.abs(kneeLocal.z - baseKnee.z) * AXIS_CALIBRATION_Z_PENALTY_WEIGHT;
      const footPenalty = foot ? Math.abs(footLateral - baseFootLateral) * AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT : 0.0;
      const strictScore = xImprovement - yPenalty - zPenalty - footPenalty;
      const sidePenalty = keepsSide && footKeepsSide ? 0 : AXIS_CALIBRATION_SIDE_BREAK_PENALTY;
      const looseScore = xImprovement - yPenalty - zPenalty - footPenalty - sidePenalty;

      if (keepsSide && footKeepsSide && strictScore > bestStrictScore) {
        bestStrictScore = strictScore;
        bestStrictAxis = signedAxis.clone();
      }

      if (looseScore > bestLooseScore) {
        bestLooseScore = looseScore;
        bestLooseAxis = signedAxis.clone();
      }
    }
  }

  thigh.quaternion.copy(originalQ);
  root.updateMatrixWorld(true);

  if (bestStrictAxis && bestStrictScore > AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE) return bestStrictAxis;
  if (bestLooseAxis && bestLooseScore > AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE) return bestLooseAxis;
  return null;
}

function fallbackAdductionAxisFromSide(side: 'left' | 'right'): THREE.Vector3 {
  // 軸キャリブレーション失敗時は股関節ローカルの左右回頭方向を緊急代替として使う
  return side === 'left' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0);
}

function captureLegAdductionCalibration(root: THREE.Object3D, bones: LegCloseBones): LegAdductionCalibration {
  return {
    leftAxis: evaluateThighAdductionAxis(root, bones, bones.leftThigh, bones.leftKnee, bones.leftFoot, 'left'),
    rightAxis: evaluateThighAdductionAxis(root, bones, bones.rightThigh, bones.rightKnee, bones.rightFoot, 'right'),
  };
}

function resolveLegAdductionCalibration(
  root: THREE.Object3D,
  bones: LegCloseBones,
  calibration: LegAdductionCalibration | null
): ResolvedLegAdductionCalibration | null {
  if (!calibration) return null;

  const hadLeftAxis = Boolean(calibration.leftAxis);
  const hadRightAxis = Boolean(calibration.rightAxis);

  if (!calibration.leftAxis) {
    calibration.leftAxis = evaluateThighAdductionAxis(root, bones, bones.leftThigh, bones.leftKnee, bones.leftFoot, 'left');
  }
  if (!calibration.rightAxis) {
    calibration.rightAxis = evaluateThighAdductionAxis(root, bones, bones.rightThigh, bones.rightKnee, bones.rightFoot, 'right');
  }

  if (!calibration.leftAxis) {
    calibration.leftAxis = fallbackAdductionAxisFromSide('left');
    logLegAdduction('axis_fallback_forced', {
      side: 'left',
      reason: 'calibration_failed',
      axis: calibration.leftAxis.toArray(),
    }, 'warn');
  }
  if (!calibration.rightAxis) {
    calibration.rightAxis = fallbackAdductionAxisFromSide('right');
    logLegAdduction('axis_fallback_forced', {
      side: 'right',
      reason: 'calibration_failed',
      axis: calibration.rightAxis.toArray(),
    }, 'warn');
  }

  if (legAdductionAxisRecoveryDebugCount < LEG_ADDUCTION_AXIS_RECOVERY_MAX_LOGS) {
    legAdductionAxisRecoveryDebugCount += 1;
    logLegAdduction('axis_calibration', {
      hadLeftAxis,
      hadRightAxis,
      hasLeftAxis: Boolean(calibration.leftAxis),
      hasRightAxis: Boolean(calibration.rightAxis),
      leftAxis: calibration.leftAxis?.toArray() ?? null,
      rightAxis: calibration.rightAxis?.toArray() ?? null,
    });
  }

  return {
    leftAxis: calibration.leftAxis as THREE.Vector3,
    rightAxis: calibration.rightAxis as THREE.Vector3,
  };
}


function applySeatedLegAdductionWithGapLimit(
  root: THREE.Object3D,
  bones: LegCloseBones,
  seatedRef: SeatedLegReference | null,
  calibration: LegAdductionCalibration | null,
  uiProgress: number
): void {
  if (
    !seatedRef ||
    !calibration ||
    !bones.hips ||
    !bones.leftThigh ||
    !bones.rightThigh ||
    !bones.leftKnee ||
    !bones.rightKnee
  ) {
    return;
  }

  const resolvedCalibration = resolveLegAdductionCalibration(root, bones, calibration);
  if (!resolvedCalibration) return;

  const normalized = THREE.MathUtils.clamp(
    (uiProgress - THIGH_CLOSE_START_PROGRESS) / (THIGH_CLOSE_FULL_PROGRESS - THIGH_CLOSE_START_PROGRESS),
    0,
    1
  );
  const t = smoothstep01(normalized);
  if (t <= LEG_CLOSE_PROGRESS_ACTIVE_EPSILON) return;

  const seatedReference = seatedRef;
  const hips = bones.hips;
  const leftThigh = bones.leftThigh;
  const rightThigh = bones.rightThigh;
  const lateralAxisLocal = seatedReference.lateralAxisLocal.clone().normalize();

  const current = measureLegGaps(hips, bones, seatedReference);
  const hardMinInnerThighGap = Math.max(GAP_EPSILON_MIN, seatedReference.innerThighGap * HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE);
  const hardMinKneeGap = Math.max(GAP_EPSILON_MIN, seatedReference.kneeGap * HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE);
  const hardMinAnkleGap = Math.max(GAP_EPSILON_MIN, seatedReference.ankleGap * HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE);

  const desiredInnerThighGap = Math.max(
    current.innerThighGap * THREE.MathUtils.lerp(1.0, TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE, t),
    hardMinInnerThighGap
  );
  const desiredKneeGap = Math.max(
    current.kneeGap * THREE.MathUtils.lerp(1.0, TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE, t),
    hardMinKneeGap
  );
  const desiredAnkleGap = Math.max(
    current.ankleGap * THREE.MathUtils.lerp(1.0, TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE, t),
    hardMinAnkleGap
  );

  const originalLeftQ = leftThigh.quaternion.clone();
  const originalRightQ = rightThigh.quaternion.clone();

  let bestLeftQ = originalLeftQ.clone();
  let bestRightQ = originalRightQ.clone();
  let bestScore = Number.POSITIVE_INFINITY;
  let foundValid = false;

  const getLaterals = (state: ReturnType<typeof measureLegGaps>) => ({
    leftInner: getSignedLateralValue(state.leftInnerThighLocal, lateralAxisLocal),
    rightInner: getSignedLateralValue(state.rightInnerThighLocal, lateralAxisLocal),
    leftKnee: getSignedLateralValue(state.leftKneeLocal, lateralAxisLocal),
    rightKnee: getSignedLateralValue(state.rightKneeLocal, lateralAxisLocal),
    leftAnkle: getSignedLateralValue(state.leftAnkleLocal, lateralAxisLocal),
    rightAnkle: getSignedLateralValue(state.rightAnkleLocal, lateralAxisLocal),
  });

  const isValidState = (state: ReturnType<typeof measureLegGaps>) => {
    const l = getLaterals(state);
    const keepsSides =
      l.leftInner < -LEG_SIDE_KEEP_EPSILON &&
      l.rightInner > LEG_SIDE_KEEP_EPSILON &&
      l.leftKnee < -LEG_SIDE_KEEP_EPSILON &&
      l.rightKnee > LEG_SIDE_KEEP_EPSILON &&
      (!seatedReference.hasAnkleReference || (l.leftAnkle < -LEG_SIDE_KEEP_EPSILON && l.rightAnkle > LEG_SIDE_KEEP_EPSILON));

    return (
      keepsSides &&
      state.innerThighGap >= hardMinInnerThighGap &&
      state.kneeGap >= hardMinKneeGap &&
      state.ankleGap >= hardMinAnkleGap
    );
  };

  const baseScales = LEG_CLOSE_BASE_SCALES;
  const asymOffsets = LEG_CLOSE_ASYMMETRY_OFFSETS;

  for (const baseScale of baseScales) {
    for (const offset of asymOffsets) {
      const leftScale = Math.max(0, baseScale + offset);
      const rightScale = Math.max(0, baseScale - offset);

      leftThigh.quaternion.copy(originalLeftQ);
      rightThigh.quaternion.copy(originalRightQ);

      const leftAngle = MAX_THIGH_ADDUCTION_LOCAL_ANGLE * t * leftScale;
      const rightAngle = MAX_THIGH_ADDUCTION_LOCAL_ANGLE * t * rightScale;

      leftThigh.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(resolvedCalibration.leftAxis, leftAngle)
      ).normalize();
      rightThigh.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(resolvedCalibration.rightAxis, rightAngle)
      ).normalize();
      root.updateMatrixWorld(true);

      let state = measureLegGaps(hips, bones, seatedReference);

      if (state.innerThighGap > desiredInnerThighGap + REFINE_TRIGGER_INNER_GAP_MARGIN || state.kneeGap > desiredKneeGap + REFINE_TRIGGER_KNEE_GAP_MARGIN) {
        const applyWorldRotationToBone = (bone: THREE.Object3D, deltaWorld: THREE.Quaternion) => {
          const parentWorldQ = bone.parent
            ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const parentWorldInv = parentWorldQ.clone().invert();
          const deltaLocal = parentWorldInv.multiply(deltaWorld.clone()).multiply(parentWorldQ);
          bone.quaternion.premultiply(deltaLocal).normalize();
        };

        const localToWorld = (localPoint: THREE.Vector3) => localPoint.clone().applyMatrix4(hips.matrixWorld);
        const pointToward = (
          thigh: THREE.Object3D,
          currentLocal: THREE.Vector3,
          desiredLocal: THREE.Vector3,
          fallbackAxisLocal: THREE.Vector3
        ) => {
          const thighWorld = thigh.getWorldPosition(new THREE.Vector3());
          const currentWorld = localToWorld(currentLocal);
          const desiredWorld = localToWorld(desiredLocal);
          const currentDir = currentWorld.sub(thighWorld).normalize();
          const desiredDir = desiredWorld.sub(thighWorld).normalize();
          const axis = new THREE.Vector3().crossVectors(currentDir, desiredDir);
          const angle = currentDir.angleTo(desiredDir);
          if (!Number.isFinite(angle) || angle <= DIRECTION_ALIGNMENT_MIN_ANGLE) return;
          const axisWorld = axis.lengthSq() > CROSS_AXIS_MIN_LENGTH_SQ
            ? axis.normalize()
            : fallbackAxisLocal.clone().applyQuaternion(thigh.getWorldQuaternion(new THREE.Quaternion())).normalize();
          const delta = new THREE.Quaternion().setFromAxisAngle(axisWorld, Math.min(angle, MAX_WORLD_KNEE_ALIGN_ANGLE * t));
          applyWorldRotationToBone(thigh, delta);
        };

        const l = getLaterals(state);
        const innerCenter = (l.leftInner + l.rightInner) * 0.5;
        const kneeCenter = (l.leftKnee + l.rightKnee) * 0.5;
        const desiredInnerHalf = desiredInnerThighGap * 0.5;
        const desiredKneeHalf = desiredKneeGap * 0.5;

        const desiredLeftInnerLocal = state.leftInnerThighLocal.clone().add(
          lateralAxisLocal.clone().multiplyScalar(Math.min(innerCenter - desiredInnerHalf, -TARGET_SIDE_CLAMP_EPSILON) - l.leftInner)
        );
        const desiredRightInnerLocal = state.rightInnerThighLocal.clone().add(
          lateralAxisLocal.clone().multiplyScalar(Math.max(innerCenter + desiredInnerHalf, TARGET_SIDE_CLAMP_EPSILON) - l.rightInner)
        );
        const desiredLeftKneeLocal = state.leftKneeLocal.clone().add(
          lateralAxisLocal.clone().multiplyScalar(Math.min(kneeCenter - desiredKneeHalf, -TARGET_SIDE_CLAMP_EPSILON) - l.leftKnee)
        );
        const desiredRightKneeLocal = state.rightKneeLocal.clone().add(
          lateralAxisLocal.clone().multiplyScalar(Math.max(kneeCenter + desiredKneeHalf, TARGET_SIDE_CLAMP_EPSILON) - l.rightKnee)
        );

        pointToward(leftThigh, state.leftInnerThighLocal, desiredLeftInnerLocal, resolvedCalibration.leftAxis);
        pointToward(rightThigh, state.rightInnerThighLocal, desiredRightInnerLocal, resolvedCalibration.rightAxis);
        root.updateMatrixWorld(true);
        state = measureLegGaps(hips, bones, seatedReference);
        pointToward(leftThigh, state.leftKneeLocal, desiredLeftKneeLocal, resolvedCalibration.leftAxis);
        pointToward(rightThigh, state.rightKneeLocal, desiredRightKneeLocal, resolvedCalibration.rightAxis);
        root.updateMatrixWorld(true);
        state = measureLegGaps(hips, bones, seatedReference);
      }

      if (!isValidState(state)) {
        continue;
      }

      const innerPenalty = Math.max(0, state.innerThighGap - desiredInnerThighGap);
      const kneePenalty = Math.max(0, state.kneeGap - desiredKneeGap);
      const ankleBonus = state.ankleGap - desiredAnkleGap;
      const asymPenalty = Math.abs(leftScale - rightScale) * SCORE_ASYMMETRY_WEIGHT;
      const score =
        state.innerThighGap * SCORE_INNER_GAP_WEIGHT +
        innerPenalty * SCORE_INNER_EXCESS_WEIGHT +
        state.kneeGap * SCORE_KNEE_GAP_WEIGHT +
        kneePenalty * SCORE_KNEE_EXCESS_WEIGHT -
        ankleBonus * SCORE_ANKLE_BONUS_WEIGHT +
        asymPenalty;

      if (score < bestScore) {
        bestScore = score;
        bestLeftQ = leftThigh.quaternion.clone();
        bestRightQ = rightThigh.quaternion.clone();
        foundValid = true;
      }

      if (state.innerThighGap <= desiredInnerThighGap + EARLY_ACCEPT_INNER_GAP_MARGIN && state.kneeGap <= desiredKneeGap + EARLY_ACCEPT_KNEE_GAP_MARGIN) {
        bestLeftQ = leftThigh.quaternion.clone();
        bestRightQ = rightThigh.quaternion.clone();
        foundValid = true;
        break;
      }
    }
    if (foundValid && bestScore < desiredInnerThighGap * EARLY_BREAK_INNER_WEIGHT + desiredKneeGap * EARLY_BREAK_KNEE_WEIGHT + EARLY_BREAK_SCORE_BIAS) {
      break;
    }
  }

  if (foundValid) {
    leftThigh.quaternion.copy(bestLeftQ);
    rightThigh.quaternion.copy(bestRightQ);
  } else {
    leftThigh.quaternion.copy(originalLeftQ);
    rightThigh.quaternion.copy(originalRightQ);
  }
  root.updateMatrixWorld(true);
}

function applyStandingUpperArmSpread(
  root: THREE.Object3D,
  bones: ArmSpreadBones,
  uiProgress: number
): void {
  if (!bones.hips || !bones.leftUpperArm || !bones.rightUpperArm || !bones.leftForearm || !bones.rightForearm) {
    return;
  }

  const standT = 1 - smoothstep01(uiProgress / STANDING_ARM_SPREAD_END_PROGRESS);
  if (standT <= 1e-4) return;

  const hipsWorldQ = bones.hips.getWorldQuaternion(new THREE.Quaternion());
  const worldDown = new THREE.Vector3(0, -1, 0).applyQuaternion(hipsWorldQ).normalize();

  const applyToSide = (
    upperArm: THREE.Object3D,
    forearm: THREE.Object3D,
    side: 'left' | 'right'
  ) => {
    root.updateMatrixWorld(true);

    const upperWorldPos = upperArm.getWorldPosition(new THREE.Vector3());
    const foreWorldPos = forearm.getWorldPosition(new THREE.Vector3());
    const currentDir = foreWorldPos.sub(upperWorldPos).normalize();

    const lateralWorld = new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0)
      .applyQuaternion(hipsWorldQ)
      .normalize();

    const desiredBaseDir = worldDown.clone().addScaledVector(
      lateralWorld,
      STANDING_ARM_OUTWARD_LATERAL_WEIGHT
    ).normalize();

    const desiredDir = currentDir.clone().lerp(
      desiredBaseDir,
      STANDING_ARM_OUTWARD_BLEND * standT
    ).normalize();

    // 正角度で外開きになるように回転軸の向きをここで決める
    const axisWorld = new THREE.Vector3().crossVectors(desiredDir, currentDir);
    const axisLenSq = axisWorld.lengthSq();
    const angle = currentDir.angleTo(desiredDir);

    if (!Number.isFinite(angle) || angle <= 1e-5) return;

    const safeAxisWorld =
      axisLenSq > 1e-8
        ? axisWorld.normalize()
        : worldDown.clone().cross(lateralWorld).normalize();

    const clampedAngle = Math.min(angle, STANDING_ARM_OUTWARD_MAX_ANGLE * standT);
    const deltaWorld = new THREE.Quaternion().setFromAxisAngle(safeAxisWorld, clampedAngle);

    const parentWorldQ = upperArm.parent
      ? upperArm.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const parentWorldInv = parentWorldQ.clone().invert();
    const deltaLocal = parentWorldInv.multiply(deltaWorld.clone()).multiply(parentWorldQ);

    upperArm.quaternion.premultiply(deltaLocal).normalize();
  };

  applyToSide(bones.leftUpperArm, bones.leftForearm, 'left');
  applyToSide(bones.rightUpperArm, bones.rightForearm, 'right');
  root.updateMatrixWorld(true);
}

/**
 * モデル内の全メッシュに対してマテリアルを強制上書き適用する関数
 */
function applyCustomMaterials(
  root: THREE.Object3D | null,
  wireframe: boolean,
  customMapping: MeshColorMapping,
  clothingColorHex: string,
  skinColorHex: string,
  onDiscoverMeshes?: (meshes: { id: string; name: string; current: 'clothing' | 'body' | 'default' }[]) => void
) {
  if (!root) return;

  const createOrUpdateMaterial = (mesh: THREE.Mesh, hexColor: string) => {
    // 色変更を確実に即時反映させるため毎回新しいマテリアルを生成する
    // 使い回すと古い色状態が残ることがあるため再利用しない

    const newMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hexColor),
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.1,
      wireframe: wireframe,
      vertexColors: false,
      map: null,
      emissive: new THREE.Color(0x000000),
    });

    // スキンメッシュではスキニングを有効化し差し替え後もポーズ変形を維持する
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      (newMat as THREE.MeshStandardMaterial & { skinning?: boolean }).skinning = true;
    }
    newMat.userData.fromClothSim = true;

    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }

    mesh.material = newMat;
  };
  
  const discovered: { id: string; name: string; current: MeshType }[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      const meshId = mesh.uuid;
      const meshName = mesh.name || "Unnamed Mesh";
      const materialArray = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const matName = materialArray.filter(Boolean).map((m) => m?.name || '').join(' ');
      const texName = materialArray
        .filter(Boolean)
        .map((m) => ((m as THREE.MeshStandardMaterial)?.map?.name || ''))
        .join(' ');
      const parentName = mesh.parent?.name || "";

      // 毎回再分類（ユーザーデータ蓄積を避ける）識別子は複製/再読込で変わるため
      // カスタム割り当ては識別子とメッシュ名の両方を許可する
      const type = inferMeshType(
        meshName,
        parentName,
        matName,
        texName,
        customMapping[meshId] ?? customMapping[meshName]
      );

      discovered.push({ id: meshId, name: meshName, current: type });

      // 指定された色に合わせた新規マテリアルを強制生成
      let hexColor = clothingColorHex;
      if (type === 'clothing') {
        hexColor = clothingColorHex;
      } else if (type === 'body') {
        hexColor = skinColorHex;
      }
      createOrUpdateMaterial(mesh, hexColor);
    }
  });

  // メッシュ一覧をUI側へ通知（一度だけまたは変更時のみ走るよう親で制御）
  if (onDiscoverMeshes) {
    onDiscoverMeshes(discovered);
  }
}

function SceneWithFBX({
  fbxPath,
  modelBasePosition,
  progress,
  onProgressChange,
  wireframe,
  playTarget,
  onFinished = () => {},
  clothingColorHex,
  skinColorHex,
  customMapping,
  onDiscoverMeshes
}: {
  fbxPath: string;
  modelBasePosition: [number, number, number];
  progress: number;
  onProgressChange: (p: number) => void;
  wireframe: boolean;
  playTarget: number | null;
  onFinished?: () => void;
  clothingColorHex: string;
  skinColorHex: string;
  customMapping: MeshColorMapping;
  onDiscoverMeshes: (meshes: { id: string; name: string; current: 'clothing' | 'body' | 'default' }[]) => void;
}) {
  const SIT_CLIP_PROGRESS = SAFE_SIT_CLIP_PROGRESS;
  const uiProgressToClipProgress = useCallback((uiProgress: number) => {
    const clamped = Math.min(Math.max(uiProgress, 0), 1);
    return clamped * SIT_CLIP_PROGRESS;
  }, [SIT_CLIP_PROGRESS]);

  const fbx = useFBX(fbxPath) as THREE.Group & { animations?: THREE.AnimationClip[] };
  const animationFbx = useFBX('/models/StandToSit_model.fbx') as THREE.Group & { animations?: THREE.AnimationClip[] };
  
  // ボーン構造を診断出力
  useEffect(() => {
    if (fbx && animationFbx) {
      dumpBoneStructure(fbx, 'StandToSit.fbx (Model)');
      dumpBoneStructure(animationFbx, 'StandToSit_model.fbx (Animation)');
    }
  }, [fbx, animationFbx]);
  
  // スケルトンのクローンを作成
  const cloned = useMemo(() => {
    if (!fbx) return null;
    const clonedGroup = skeletonClone(fbx) as THREE.Group;
    return clonedGroup;
  }, [fbx]);

  const { camera } = useThree();
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const progressRef = useRef(progress);
  const skirtMeshRef = useRef<THREE.Mesh | null>(null);
  const [skirtAnimData, setSkirtAnimData] = useState<number[][][] | null>(null);
  const [realSkirtAsset, setRealSkirtAsset] = useState<THREE.Object3D | null>(null);
  const [garmentReferenceName, setGarmentReferenceName] = useState<string | null>(null);
  const armRestPoseRef = useRef<Array<{ bone: THREE.Object3D; quaternion: THREE.Quaternion }>>([]);
  const armSpreadBonesRef = useRef<ArmSpreadBones>({
    hips: null,
    leftUpperArm: null,
    rightUpperArm: null,
    leftForearm: null,
    rightForearm: null,
  });
  const legCloseBonesRef = useRef<LegCloseBones>({
    hips: null,
    leftThigh: null,
    rightThigh: null,
    leftKnee: null,
    rightKnee: null,
    leftFoot: null,
    rightFoot: null,
  });
  const seatedLegReferenceRef = useRef<SeatedLegReference | null>(null);
  const legAdductionCalibrationRef = useRef<LegAdductionCalibration | null>(null);
  const TARGET_EPSILON = 1e-4;

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    let cancelled = false;

    const loadSkirtAnim = async () => {
      try {
        const res = await fetch('/models/skirt_deformation.json');
        if (!res.ok) {
          throw new Error(`Failed to fetch skirt deformation JSON: ${res.status}`);
        }
        const data = (await res.json()) as { frames?: number[][][] };
        if (!cancelled && data.frames && data.frames.length > 0) {
          setSkirtAnimData(data.frames);
        }
      } catch (error) {
        console.warn('[SceneWithFBX] skirt deformation JSON load failed, fallback to default:', error);
        if (!cancelled) {
          setSkirtAnimData(null);
        }
      }
    };

    loadSkirtAnim();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSkirtDeformation = useCallback((uiProgress: number) => {
    if (!skirtAnimData || skirtAnimData.length === 0 || !skirtMeshRef.current) return;

    const mesh = skirtMeshRef.current;
    const geometry = mesh.geometry;
    const positionAttribute = geometry.getAttribute('position');
    if (!positionAttribute) return;

    const basePositions = mesh.userData.skirtBasePositions as Float32Array | undefined;
    if (!basePositions) return;

    const safeProgress = Math.min(Math.max(uiProgress, 0), 1);
    const totalFrames = skirtAnimData.length;
    const motionFactor = garmentReferenceName ? 1.75 : 1.2;
    const framePos = safeProgress * (totalFrames - 1);
    const frameIndex = Math.min(totalFrames - 1, Math.floor(framePos));
    const nextFrameIndex = Math.min(totalFrames - 1, frameIndex + 1);
    const blend = totalFrames > 1 ? framePos - frameIndex : 0;

    const currentFrame = skirtAnimData[frameIndex] ?? skirtAnimData[0];
    const nextFrame = skirtAnimData[nextFrameIndex] ?? currentFrame;

    const currentMapped = mapSkirtFrameToMeshVertices(mesh, currentFrame, garmentReferenceName, motionFactor);
    const nextMapped = mapSkirtFrameToMeshVertices(mesh, nextFrame, garmentReferenceName, motionFactor);

    const array = positionAttribute.array as Float32Array;
    for (let i = 0; i < currentMapped.length; i += 1) {
      array[i] = THREE.MathUtils.lerp(currentMapped[i], nextMapped[i], blend);
    }

    positionAttribute.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }, [garmentReferenceName, skirtAnimData]);

  // 【原因解決①】外部のアニメーション補助を廃止し独自管理へ統一
  const mixer = useMemo(() => {
    if (!cloned) return null;
    return new THREE.AnimationMixer(cloned);
  }, [cloned]);

  // アニメーションクリップの選択と初期化
  const selectedClip = useMemo(() => {
    if (!fbx?.animations || fbx.animations.length === 0) return null;
    // 一般的なテイク名を含むクリップを優先して探索
    return fbx.animations.find((clip) => /mixamo.com|Take|take/i.test(clip.name)) || fbx.animations[0];
  }, [fbx]);

  const applyPoseAtProgress = useCallback(
    (uiProgress: number) => {
      if (!mixer || !selectedClip || !cloned) return;
      const duration = selectedClip.duration || 1;
      mixer.setTime(uiProgressToClipProgress(uiProgress) * duration);
      mixer.update(0);

      // 立位時の腕基準ポーズを安定して維持しつつ立位区間だけ上腕を少し外側へ開いて
      // 手が衣装へ食い込まないようにする
      if (armRestPoseRef.current.length > 0) {
        armRestPoseRef.current.forEach(({ bone, quaternion }) => {
          bone.quaternion.copy(quaternion);
        });
        cloned.updateMatrixWorld(true);
        applyStandingUpperArmSpread(cloned, armSpreadBonesRef.current, uiProgress);
      }

      applySeatedLegAdductionWithGapLimit(
        cloned,
        legCloseBonesRef.current,
        seatedLegReferenceRef.current,
        legAdductionCalibrationRef.current,
        uiProgress
      );

      updateSkirtDeformation(uiProgress);
    },
    [cloned, mixer, selectedClip, uiProgressToClipProgress, updateSkirtDeformation]
  );

  // マテリアルの適用とメッシュ検出
  useEffect(() => {
    if (!cloned) return;
    applyCustomMaterials(cloned, wireframe, customMapping, clothingColorHex, skinColorHex, onDiscoverMeshes);
  }, [cloned, wireframe, customMapping, clothingColorHex, skinColorHex, onDiscoverMeshes]);

  useEffect(() => {
    let cancelled = false;

    const loadRealSkirtAsset = async () => {
      const candidates = ['/models/skirt_mesh.fbx'];

      for (const candidate of candidates) {
        if (cancelled) return;

        const asset = await loadSkirtAssetFromUrl(candidate);
        if (asset && !cancelled) {
          console.log('[SceneWithFBX] accepted real skirt asset candidate:', candidate, 'name:', asset.name, 'children:', asset.children.length);
          setRealSkirtAsset(asset);
          return;
        }

        console.log('[SceneWithFBX] rejected real skirt asset candidate:', candidate, 'asset:', Boolean(asset), 'cancelled:', cancelled);
      }

      if (!cancelled) {
        setRealSkirtAsset(null);
      }
    };

    loadRealSkirtAsset();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cloned) return;

    const realAsset = realSkirtAsset ? realSkirtAsset.clone() : null;
    const dedicatedSkirt = realAsset ?? (skirtAnimData ? createStandaloneSkirtMesh(skirtAnimData, clothingColorHex, garmentReferenceName) : null);
    if (!dedicatedSkirt) return;

    const targetMesh = dedicatedSkirt instanceof THREE.Mesh
      ? dedicatedSkirt
      : (findSkirtMesh(dedicatedSkirt) ?? dedicatedSkirt.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined);

    if (!targetMesh) return;

    const basePositions = targetMesh.geometry?.getAttribute('position')?.array as Float32Array | undefined;
    if (basePositions && basePositions.length > 0 && (!targetMesh.userData.skirtBasePositions || targetMesh.userData.skirtBasePositions.length !== basePositions.length)) {
      targetMesh.userData.skirtBasePositions = basePositions.slice();
    }

    cloned.add(dedicatedSkirt);
    dedicatedSkirt.position.set(0, 0.8, 0.0);
    dedicatedSkirt.rotation.set(0, 0, 0);
    dedicatedSkirt.scale.set(1.0, 1.0, 1.0);
    skirtMeshRef.current = targetMesh;

    console.log(
      '[SceneWithFBX] skirt target selected:',
      realAsset ? 'real-skirt-asset' : 'synthetic-skirt-fallback',
      'meshName:',
      targetMesh.name,
      'vertexCount:',
      targetMesh.geometry?.attributes.position?.count
    );

    updateSkirtDeformation(progress);

    return () => {
      if (dedicatedSkirt.parent) {
        dedicatedSkirt.parent.remove(dedicatedSkirt);
      }
      if (targetMesh.geometry) {
        targetMesh.geometry.dispose();
      }
      const material = targetMesh.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material.dispose();
      }
      skirtMeshRef.current = null;
    };
  }, [cloned, clothingColorHex, garmentReferenceName, progress, realSkirtAsset, skirtAnimData, updateSkirtDeformation]);

  // アクションの設定と一時停止（自動再生の競合を徹底排除）
  useEffect(() => {
    if (!mixer || !cloned || !selectedClip) return;
    const action = mixer.clipAction(selectedClip);
    action.reset();
    action.setEffectiveWeight(1.0);
    action.play();
    actionRef.current = action;

    // 立位の腕ポーズを一度だけ記録する座位側のサンプリング後に腕ボーンのみ復元し
    // 100%ポーズで両手が太ももへ押し込まれるのを防ぐ
    mixer.setTime(0);
    mixer.update(0);
    const armBones: Array<{ bone: THREE.Object3D; quaternion: THREE.Quaternion }> = [];
    cloned.traverse((obj) => {
      if (obj.name && isArmPoseBoneName(obj.name)) {
        armBones.push({ bone: obj, quaternion: obj.quaternion.clone() });
      }
    });
    armRestPoseRef.current = armBones;
    armSpreadBonesRef.current = collectArmSpreadBones(cloned);
    legCloseBonesRef.current = collectLegCloseBones(cloned);
    legAdductionDebugCount = 0;
    legAdductionAxisRecoveryDebugCount = 0;
    legAdductionTraceCount = 0;
    legAdductionSkipBeforeWindowCount = 0;

    // 座位基準進捗時点の参照姿勢を股関節ローカル空間で取得する
    mixer.setTime(SIT_CLIP_PROGRESS * (selectedClip.duration || 1));
    mixer.update(0);
    seatedLegReferenceRef.current = captureSeatedLegReference(cloned, legCloseBonesRef.current);
    legAdductionCalibrationRef.current = captureLegAdductionCalibration(cloned, legCloseBonesRef.current);

    if (seatedLegReferenceRef.current) {
      logLegAdduction('seated_reference_captured', {
        innerThighGap: seatedLegReferenceRef.current.innerThighGap,
        kneeGap: seatedLegReferenceRef.current.kneeGap,
        ankleGap: seatedLegReferenceRef.current.ankleGap,
        lateralAxisLocal: seatedLegReferenceRef.current.lateralAxisLocal.toArray(),
        hasAnkleReference: seatedLegReferenceRef.current.hasAnkleReference,
        leftAxis: legAdductionCalibrationRef.current?.leftAxis?.toArray() ?? null,
        rightAxis: legAdductionCalibrationRef.current?.rightAxis?.toArray() ?? null,
        bones: {
          hips: legCloseBonesRef.current.hips?.name ?? null,
          leftThigh: legCloseBonesRef.current.leftThigh?.name ?? null,
          rightThigh: legCloseBonesRef.current.rightThigh?.name ?? null,
          leftKnee: legCloseBonesRef.current.leftKnee?.name ?? null,
          rightKnee: legCloseBonesRef.current.rightKnee?.name ?? null,
          leftFoot: legCloseBonesRef.current.leftFoot?.name ?? null,
          rightFoot: legCloseBonesRef.current.rightFoot?.name ?? null,
        },
      });
    } else {
      logLegAdduction('seated_reference_missing', {
        bones: {
          hips: legCloseBonesRef.current.hips?.name ?? null,
          leftThigh: legCloseBonesRef.current.leftThigh?.name ?? null,
          rightThigh: legCloseBonesRef.current.rightThigh?.name ?? null,
          leftKnee: legCloseBonesRef.current.leftKnee?.name ?? null,
          rightKnee: legCloseBonesRef.current.rightKnee?.name ?? null,
          leftFoot: legCloseBonesRef.current.leftFoot?.name ?? null,
          rightFoot: legCloseBonesRef.current.rightFoot?.name ?? null,
        },
      }, 'warn');
    }

    if (!legAdductionCalibrationRef.current?.leftAxis || !legAdductionCalibrationRef.current?.rightAxis) {
      logLegAdduction('initial_axis_calibration_incomplete', {
        leftAxis: legAdductionCalibrationRef.current?.leftAxis?.toArray() ?? null,
        rightAxis: legAdductionCalibrationRef.current?.rightAxis?.toArray() ?? null,
      });
    }

    // 以降の進捗ベース姿勢サンプリングが変わらないよう最後に立位フレームへ戻す
    mixer.setTime(0);
    mixer.update(0);

    cloned.updateMatrixWorld(true);

    return () => {
      mixer.stopAllAction();
      actionRef.current = null;
      armRestPoseRef.current = [];
      armSpreadBonesRef.current = {
        hips: null,
        leftUpperArm: null,
        rightUpperArm: null,
        leftForearm: null,
        rightForearm: null,
      };
      seatedLegReferenceRef.current = null;
      legAdductionCalibrationRef.current = null;
      legCloseBonesRef.current = {
        hips: null,
        leftThigh: null,
        rightThigh: null,
        leftKnee: null,
        rightKnee: null,
        leftFoot: null,
        rightFoot: null,
      };
    };
  }, [SIT_CLIP_PROGRESS, mixer, cloned, selectedClip]);

  // 初期ポーズ適用と外部変更時の即時反映
  useEffect(() => {
    applyPoseAtProgress(progress);
  }, [applyPoseAtProgress, progress]);

  // 【指定維持】上手くいったサイズと位置の自動計算ロジックを100%完全キープ
  const { objectScale, modelOffsetY } = useMemo(() => {
    if (!cloned) return { objectScale: 0.01, modelOffsetY: 0 };

    const box = new THREE.Box3();
    cloned.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const geom = (obj as THREE.Mesh).geometry;
        if (geom) {
          geom.computeBoundingBox();
          if (geom.boundingBox) box.union(geom.boundingBox);
        }
      }
    });

    if (box.isEmpty()) return { objectScale: 0.01, modelOffsetY: 0 };

    const size = box.getSize(new THREE.Vector3());
    const cam = camera as THREE.PerspectiveCamera;

    const distance = cam.position.distanceTo(new THREE.Vector3(...modelBasePosition));
    const camHeightAtDist = 2 * distance * Math.tan((cam.fov * Math.PI) / 360);
    const desiredFraction = 0.85;
    const desiredHeight = camHeightAtDist * desiredFraction;

    const scale = size.y > 0 ? desiredHeight / size.y : 0.01;
    const centerY = (box.min.y + box.max.y) / 2;
    const offsetY = -centerY * scale;

    return { objectScale: scale, modelOffsetY: offsetY };
  }, [cloned, camera, modelBasePosition]);

  // 【原因解決②】ボタン操作およびスライダーによるポーズ変更をボーンへリアルタイム反映
  // 目標到達後は姿勢値を固定し勝手に戻らないようにする
  useFrame((_, delta) => {
    if (!mixer || !actionRef.current || !selectedClip) return;

    const currentProgress = progressRef.current;

    if (playTarget !== null) {
      // 立つ/座るボタン押下時の滑らかな自動シーク
      const speed = 1.2; // アニメーションの再生速度倍率
      let nextProgress = currentProgress;

      if (currentProgress < playTarget) {
        nextProgress = Math.min(currentProgress + delta * speed, playTarget);
      } else if (currentProgress > playTarget) {
        nextProgress = Math.max(currentProgress - delta * speed, playTarget);
      }

      // 目標に非常に接近したらスナップして確定させる
      if (Math.abs(nextProgress - playTarget) <= TARGET_EPSILON) {
        nextProgress = playTarget;
      }

      if (nextProgress !== currentProgress) {
        progressRef.current = nextProgress;
        onProgressChange(nextProgress);
      }

      applyPoseAtProgress(nextProgress); // デルタ0で即時ポーズをメッシュに反映

      // updateSkirtDeformation は applyPoseAtProgress 内で既に呼ばれるため
      // ここで二重に適用するとガクつきが増える。 1 回だけ更新する。

      // 目標に到達したら目標値を空にしてアニメーション停止
      // これにより姿勢値は固定される（外部更新がない限り変わらない）
      const distToTarget = Math.abs(nextProgress - playTarget);
      if (distToTarget <= TARGET_EPSILON) {
        // ここで目標値を空にしてフレーム毎の動きを止める
        // ただし姿勢値自体は保持されるので座り状態が続く
        onFinished();
      }
    } else {
      // スライダー（ポーズバー）の手動操作時または目標到達後
      applyPoseAtProgress(currentProgress); // 即時ボーン反映
    }
  });

  return (
    <group position={modelBasePosition}>
      {cloned && (
        <primitive
          object={cloned}
          scale={[objectScale, objectScale, objectScale]}
          position={[0, modelOffsetY, 0]}
        />
      )}
    </group>
  );
}

export default function ClothSimulator() {
  const [wireframe, setWireframe] = useState(false);
  const [progress, setProgress] = useState(0); // 0: 立位, 1: 座位
  const [playTarget, setPlayTarget] = useState<number | null>(null);
  const [fbxReloadKey, setFbxReloadKey] = useState(0);
  const [canvasResetKey, setCanvasResetKey] = useState(0);
  // 新規: 皮膚色トーン（0 = 明るい, 1 = 暗い）
  const [skinTone, setSkinTone] = useState(0);
  // 服色パレットインデックス（0:黒,1:赤,2:青,3:黄,4:白）
  const [clothingIndex, setClothingIndex] = useState(2);

  const modelBasePosition: [number, number, number] = [0, 0, 0];
  const fbxPath = '/models/StandToSit.fbx';

  // 服のカラーパレット
  const clothingPalette = ['#000000', '#ef4444', '#7dd3fc', '#facc15', '#ffffff'];

  // 皮膚色: ライトベージュ -> 褐色 の補間
  const skinLight = useMemo(() => new THREE.Color('#f5dcc0'), []);
  const skinDark = useMemo(() => new THREE.Color('#7a4a2b'), []);
  const skinColorHex = useMemo(() => {
    const c = new THREE.Color();
    c.lerpColors(skinLight, skinDark, Math.min(Math.max(skinTone, 0), 1));
    return `#${c.getHexString()}`;
  }, [skinTone, skinLight, skinDark]);

  const clothingColorHex = clothingPalette[Math.max(0, Math.min(clothingIndex, clothingPalette.length - 1))];

  // メッシュ検出コールバックは現状UI未使用のため空関数とする
  const handleDiscoverMeshes = useCallback(() => {}, []);

  const handleReload = useCallback(() => {
    // 姿勢・視点・表示は初期化するが色は保持する
    setPlayTarget(null);
    setProgress(0);
    setWireframe(false);
    setFbxReloadKey((prev) => prev + 1);
    setCanvasResetKey((prev) => prev + 1);
  }, []);

  // パーツのタイプ（服・肌・その他）を手動で切り替えるトグル関数
  // ※ 救済UIを統合したため個別トグルは廃止

  return (
    <div className="absolute inset-0 w-full h-full bg-[#0f172a] overflow-hidden select-none">
      {/* 3次元キャンバス領域 */}
      <Canvas
        key={canvasResetKey}
        shadows
        camera={{ position: [0, 0, 4.5], fov: 32 }}
        className="w-full h-full"
        gl={{ alpha: false }}
        onCreated={({ gl }) => {
          gl.shadowMap.type = THREE.PCFShadowMap;
        }}
      >
        <color attach="background" args={["#0f172a"]} />
        <hemisphereLight args={["#ffffff", "#334155", 0.7]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 10, 6]} intensity={1.5} castShadow />
        <spotLight position={[-5, 8, 4]} intensity={0.8} penumbra={0.5} />

        <SceneWithFBX
          fbxPath={fbxPath}
          modelBasePosition={modelBasePosition}
          progress={progress}
          onProgressChange={setProgress}
          wireframe={wireframe}
          playTarget={playTarget}
          onFinished={() => setPlayTarget(null)}
          customMapping={{}}
          clothingColorHex={clothingColorHex}
          skinColorHex={skinColorHex}
          onDiscoverMeshes={handleDiscoverMeshes}
          key={fbxReloadKey}
        />

        <OrbitControls makeDefault enablePan={true} enableZoom={true} enableRotate={true} target={[0, 0, 0]} />
      </Canvas>

      {/* 右側：メイン操作コントロールパネル */}
      <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-4">
        <div className="pointer-events-auto rounded-2xl border border-slate-700/40 bg-slate-900/90 p-4 shadow-2xl backdrop-blur-md style-panel" style={{ width: 340 }}>
          <div className="text-sm font-bold text-slate-100 mb-3 flex items-center justify-between border-b border-slate-700/50 pb-2">
            <span>Pose & Color Controller</span>
            <span className="text-[11px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full font-mono">v4.6-KneeGapTightenV1</span>
          </div>

          {/* 1. 再読込ボタン：完全に初期状態（起立して停止）へリセットする */}
          <div className="mb-4">
            <button
              className="w-full py-2 rounded-lg bg-rose-600/90 hover:bg-rose-600 text-sm font-semibold text-white transition-all shadow-md shadow-rose-900/20 active:scale-[0.98]"
              onClick={handleReload}
            >
              🔄 Reload (Reset to Stand)
            </button>
          </div>

          {/* 2. 座る/立つアニメーションボタン */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="text-xs font-medium text-slate-400 mb-2">Animation Triggers</div>
            <div className="flex items-center gap-2">
              {/* 立位ボタン：0（立ち状態）へ向けてアニメーション停止まで移行 */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress <= 0.001
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg' 
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                }`}
                onClick={() => setPlayTarget(0)}
              >
                🧍 Stand (立)
              </button>
              
              {/* 座位ボタン：1（座り状態）へ向けてアニメーション停止まで移行 */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress >= 0.999
                    ? 'bg-sky-600 text-white border-sky-500 shadow-lg' 
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                }`}
                onClick={() => setPlayTarget(1)}
              >
                🧎 Sit (座)
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/60 pt-2 font-mono">
              <span>Status:</span>
              <span className="text-slate-200 font-bold">
                {playTarget !== null ? '⏳ Moving...' : progress >= 0.999 ? '✅ Sitting' : progress <= 0.001 ? '✅ Standing' : '⏸️ Paused'}
              </span>
            </div>
          </div>

          {/* 3. ポーズバー（タイムラインスライダー） */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-1.5">
              <span>Pose バー (Manual Seek)</span>
              <span className="font-mono text-slate-200 bg-slate-800 px-1.5 py-0.5 rounded">{(progress * 100).toFixed(1)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={progress}
              onChange={(e) => {
                setPlayTarget(null); // スライダー操作時は自動移行を即時キャンセル
                setProgress(parseFloat(e.target.value));
              }}
              className="w-full accent-sky-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg appearance-none"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
              <span>Stand</span>
              <span>Sit</span>
            </div>
          </div>

          {/* 3.5 皮膚色 / 服色コントロール */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="text-xs font-medium text-slate-400 mb-2">Color Controls</div>

            <div className="text-[11px] text-slate-300 mb-2">Skin Tone</div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={skinTone}
                onChange={(e) => setSkinTone(parseFloat(e.target.value))}
                className="flex-1 accent-amber-400 h-1.5"
              />
              <div style={{ width: 36, height: 20, background: skinColorHex, borderRadius: 4, border: '1px solid rgba(255,255,255,0.06)', transition: 'background 0.1s' }} />
              <span className="text-[10px] text-slate-500 font-mono">{skinColorHex}</span>
            </div>

            <div className="mt-3 text-[11px] text-slate-300 mb-2">Clothing Color</div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={4}
                step={1}
                value={clothingIndex}
                onChange={(e) => setClothingIndex(parseInt(e.target.value))}
                className="flex-1 accent-sky-500 h-1.5"
              />
              <div style={{ width: 36, height: 20, background: clothingColorHex, borderRadius: 4, border: '1px solid rgba(255,255,255,0.06)', transition: 'background 0.1s' }} />
              <span className="text-[10px] text-slate-500 font-mono">{clothingColorHex}</span>
            </div>
          </div>

          {/* 4. 表示オプション */}
          <div className="mb-2 px-1">
            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
                className="rounded border-slate-700 text-sky-500 focus:ring-0 focus:ring-offset-0 bg-slate-900 w-4 h-4"
              />
              <span className="font-medium">Show Wireframe (ワイヤーフレーム)</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
