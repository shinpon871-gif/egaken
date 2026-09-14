"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useFBX, useGLTF } from '@react-three/drei';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils';
import skirtDeformation from '../public/models/skirt_deformation.json';

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
  [meshId: string]: ColorCategory;
}

type ColorCategory = 'hair' | 'skin' | 'jacket' | 'skirt' | 'shoes' | 'default';

type AnimatedSkirtGltf = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

type SkirtDeformationMetadata = {
  progress?: number;
  vertex_count?: number;
  displacements?: number[][];
};

const skirtDeformationMetadata = skirtDeformation as SkirtDeformationMetadata;

// スカート変形メタデータから取得したパラメータによるアセットキャッシュ更新用バージョン識別文字列
const SKIRT_ASSET_VERSION = [
  skirtDeformationMetadata.progress ?? 0,
  skirtDeformationMetadata.vertex_count ?? 0,
  skirtDeformationMetadata.displacements?.[0]?.[0] ?? 0,
  skirtDeformationMetadata.displacements?.at(-1)?.[2] ?? 0,
]
  .map((value) => Number(value).toFixed(4))
  .join('_');

// スカートモーフ重みが有効に変化しているかを判定する微小閾値
const SKIRT_MORPH_WEIGHT_EPSILON = 1e-6;

// ベクトルの長さ二乗がゼロと見なせる微小閾値
const SMALL_VECTOR_LENGTH_SQ = 1e-8;

// 方向ベクトル間の角度差がゼロと見なせる微小角度閾値
const SMALL_ANGLE_EPSILON = 1e-5;

// 座位アニメーションの再生終了位置を切り詰める安全進捗上限比率
// 100%まで再生すると人体骨格が不自然に折れ曲がるため85%でクリップする
const SAFE_SIT_CLIP_PROGRESS = 0.85;

// 読み込み対象のFBX人体アニメーションモデルの公開パス
const FBX_MODEL_PATH = '/models/StandToSit_model.fbx';

// 読み込み対象のスカートGLBモーフアニメーションモデルの公開パス
const SKIRT_GLB_PATH = '/models/skirt_mesh_sitting_animation.glb';

// 3次元空間の背景色ダークネイビー
const SCENE_BACKGROUND_COLOR = '#0f172a';

// 半球ライトの空側から差し込む白色光
const HEMISPHERE_SKY_COLOR = '#ffffff';

// 半球ライトの地面側からの照り返し暗灰色光
const HEMISPHERE_GROUND_COLOR = '#334155';

// 初期カメラの3次元座標位置 X=0 Y=0 Z=4.5
const CAMERA_INITIAL_POSITION: [number, number, number] = [0, 0, 4.5];

// カメラの垂直視野角 32度
const CAMERA_FOV = 32;

// モデル表示ルートの原点基準座標 X=0 Y=0 Z=0
const MODEL_BASE_POSITION: [number, number, number] = [0, 0, 0];

// カメラオービット操作の中心注視点座標 X=0 Y=0 Z=0
const ORBIT_CONTROLS_TARGET: [number, number, number] = [0, 0, 0];

// 上下均等な環境光を補う半球ライトの光度
const HEMISPHERE_LIGHT_INTENSITY = 0.7;

// 全方位から均一に照らす環境光の光度
const AMBIENT_LIGHT_INTENSITY = 0.5;

// 斜め前方上方から陰影を作る平行光源の配置座標 X=5 Y=10 Z=6
const DIRECTIONAL_LIGHT_POSITION: [number, number, number] = [5, 10, 6];

// 平行光源の光度
const DIRECTIONAL_LIGHT_INTENSITY = 1.5;

// 斜め後方上方からハイライトを作るスポット光源の配置座標 X=-5 Y=8 Z=4
const SPOT_LIGHT_POSITION: [number, number, number] = [-5, 8, 4];

// スポット光源の光度
const SPOT_LIGHT_INTENSITY = 0.8;

// スポットライトの境界ぼかし度合い 半影比率 0.5
const SPOT_LIGHT_PENUMBRA = 0.5;

// 画面右側に配置する操作パネルの横幅ピクセル数 340px
const CONTROL_PANEL_WIDTH = 340;

// アニメーション進捗スライダーの最小値 立位状態 0.0
const PROGRESS_MIN = 0;

// アニメーション進捗スライダーの最大値 着席完了状態 1.0
const PROGRESS_MAX = 1;

// 進捗スライダーの最小操作刻み幅 0.001
const PROGRESS_STEP = 0.001;

// 立つ座るボタン押下時にポーズを自動シークする1秒あたりの進行速度倍率
const AUTO_SEEK_SPEED = 1.2;

// 自動シークで目標進捗値に到達したと判定する許容誤差イプシロン
const TARGET_EPSILON = 1e-4;

// 画面垂直視野の高さに対してモデルが占める目標表示比率 85%
const MODEL_VIEW_HEIGHT_FRACTION = 0.85;

// モデル境界ボックス取得に失敗した際の予備スケール倍率 0.01倍
const FALLBACK_OBJECT_SCALE = 0.01;

// アニメーションクリップ再生時間が未取得の場合にゼロ除算を防ぐ既定の再生秒数 1.0秒
const DEFAULT_CLIP_DURATION = 1.0;

// FBX人体および衣服メッシュの標準ラフネス粗さ 0.5
const FBX_MATERIAL_ROUGHNESS = 0.5;

// FBX人体および衣服メッシュの標準メタリック金属度 0.1
const FBX_MATERIAL_METALNESS = 0.1;

// スカートメッシュの布地らしい質感を出すラフネス粗さ 0.55
const SKIRT_MATERIAL_ROUGHNESS = 0.55;

// スカートメッシュの布地らしい質感を出すメタリック金属度 0.05
const SKIRT_MATERIAL_METALNESS = 0.05;

// 衣服や身体各部位の初期配色パレット定義
const DEFAULT_COLORS: Record<ColorCategory, string> = {
  hair: '#3b2418',
  skin: '#f5dcc0',
  jacket: '#7dd3fc',
  skirt: '#1e293b',
  shoes: '#171717',
  default: '#d1d5db',
};

// スカートのモーフアニメーションは morphTargetInfluences か weights を含むトラックだけを使う
// それ以外の骨格トラックは見え方に影響しないので除外して速度と安全性を保つ
function getSkirtMorphWeightTracks(clip: THREE.AnimationClip): THREE.KeyframeTrack[] {
  return clip.tracks.filter((track) => /morphTargetInfluences|\.weights$/i.test(track.name));
}

// GLB の終端で値が戻るケースがあるので実際に動いている直前の時刻を使う
// こうしておくと 100% 近くで首振りが起きる問題を避けられる
function resolveLastValidSkirtMorphTime(clip: THREE.AnimationClip): number {
  const morphTracks = getSkirtMorphWeightTracks(clip);
  let lastValidTime: number | null = null;
  let lastValidTimeBeforeClipEnd: number | null = null;

  morphTracks.forEach((track) => {
    const times = Array.from(track.times);
    const values = Array.from(track.values as ArrayLike<number>);
    const valueSize = times.length > 0 ? values.length / times.length : 0;
    if (!Number.isInteger(valueSize) || valueSize <= 0) return;

    times.forEach((time, keyIndex) => {
      const start = keyIndex * valueSize;
      const hasActiveMorph = values
        .slice(start, start + valueSize)
        .some((value) => Math.abs(value) > SKIRT_MORPH_WEIGHT_EPSILON);
      if (hasActiveMorph) {
        lastValidTime = Math.max(lastValidTime ?? time, time);
        if (time < clip.duration) {
          lastValidTimeBeforeClipEnd = Math.max(lastValidTimeBeforeClipEnd ?? time, time);
        }
      }
    });
  });

  if (lastValidTime !== null && lastValidTime >= clip.duration && lastValidTimeBeforeClipEnd !== null) {
    return lastValidTimeBeforeClipEnd;
  }

  return lastValidTime ?? clip.duration;
}

function resolveSkirtClipTime(clip: THREE.AnimationClip, uiProgress: number): number {
  const morphTracks = getSkirtMorphWeightTracks(clip);
  const startTime = morphTracks.reduce((minTime, track) => {
    const firstTime = track.times[0];
    return Number.isFinite(firstTime) ? Math.min(minTime, firstTime) : minTime;
  }, Number.POSITIVE_INFINITY);
  const validStartTime = Number.isFinite(startTime) ? startTime : 0;
  const validEndTime = resolveLastValidSkirtMorphTime(clip);

  return THREE.MathUtils.lerp(
    validStartTime,
    validEndTime,
    THREE.MathUtils.clamp(uiProgress, 0, 1)
  );
}

// 100%の座位ポーズはモデル上で体が不自然に折れ曲がるため85%程度までで止める
function inferMaterialCategory(materialName: string, meshName: string): ColorCategory {
  const search = `${materialName} ${meshName}`.toLowerCase();
  if (/hair/.test(search)) return 'hair';
  if (/shoe|footwear|sneaker|boot/.test(search)) return 'shoes';
  if (/bottom|skirt/.test(search)) return 'skirt';
  if (/top|shirt|jacket|coat|blouse|dress|cloth/.test(search)) return 'jacket';
  if (/skin|face|body|mouth|eye|brow|hair/.test(search)) return 'skin';
  return 'default';
}

function inferMeshType(
  meshName: string,
  parentName: string,
  matName: string,
  texName: string,
  customType?: ColorCategory
): ColorCategory {
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

  if (/hair/.test(meshOnly)) return 'hair';
  if (knownBodyMesh || /face|body/.test(meshOnly)) return 'skin';
  if (knownClothingMesh) return inferMaterialCategory(`${matName} ${texName}`, meshName);

  const isBody = /body|skin|torso|head|leg|arm|hand|foot|face|neck|eye|mouth|teeth|hair|ear|nose|brow|lash|female|avatar|avartar|zbrush/i.test(searchStr);
  const isClothing = /skirt|dress|shirt|top|pant|jacket|coat|sleeve|hood|blouse|cape|jumpsuit|tunic|cloth|clothes|bottom|wear|suit|collar|tie|sock|shoe|boot|hat|cap|glove/i.test(searchStr);

  if (isBody && !isClothing) return inferMaterialCategory(`${matName} ${texName}`, meshName);
  if (isClothing) return inferMaterialCategory(`${matName} ${texName}`, meshName);
  return 'default';
}

function isArmPoseBoneName(name: string): boolean {
  return /mixamorig(left|right)(arm|forearm|hand)|j_bip_[lr]_(upperarm|lowerarm|hand)|left(upper)?arm|right(upper)?arm|leftforearm|rightforearm|lefthand|righthand/i.test(name);
}

type ArmSpreadBones = {
  hips: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  leftForearm: THREE.Object3D | null;
  rightForearm: THREE.Object3D | null;
};

// 立位区間でのみ腕広げ補正を有効化する終了進捗
// 0.0から0.18までの立位初期でのみ腕を外側に開き太ももとの接触を防ぐ
const STANDING_ARM_SPREAD_END_PROGRESS = 0.18;

// 現在の腕方向を目標の外開き方向へ寄せる補間割合 38%
const STANDING_ARM_OUTWARD_BLEND = 0.38;

// 目標腕方向を生成する際の体幹横方向ベクトルの合成重み
const STANDING_ARM_OUTWARD_LATERAL_WEIGHT = 0.34;

// 腕外開き補正における1フレームあたりの最大回転角度 4度
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

// 座位への脚閉じ補正を開始するアニメーション進捗閾値
// 0.12未満では歩容や着席動作の自然な開きを維持する
const THIGH_CLOSE_START_PROGRESS = 0.12;

// 座位への脚閉じ補正が100%完全適用となるアニメーション進捗閾値
const THIGH_CLOSE_FULL_PROGRESS = 0.58;

// 太もも付け根から膝の間で内股間隔を計測する補間係数 0が付け根 1が膝
// 22%の位置で計測し太もも内側の最も接触しやすい部位を監視する
const INNER_THIGH_SAMPLE_T = 0.22;

// 脚閉じ完了時における着席基準内股間隔に対する目標隙間比率 1%
const TARGET_INNER_THIGH_GAP_RATIO_AT_FULL_CLOSE = 0.010;

// 脚閉じ完了時における着席基準膝間隔に対する目標隙間比率 2%
const TARGET_KNEE_GAP_RATIO_AT_FULL_CLOSE = 0.02;

// 脚閉じ完了時における着席基準足首間隔に対する目標隙間比率 20%
const TARGET_ANKLE_GAP_RATIO_AT_FULL_CLOSE = 0.20;

// 着席基準内股間隔に対する安全ガード用ハード下限比率 1%
const HARD_MIN_INNER_THIGH_GAP_RATIO_FROM_SIT_POSE = 0.010;

// 着席基準膝間隔に対する安全ガード用ハード下限比率 2%
const HARD_MIN_KNEE_GAP_RATIO_FROM_SIT_POSE = 0.02;

// 着席基準足首間隔に対する安全ガード用ハード下限比率 10%
const HARD_MIN_ANKLE_GAP_RATIO_FROM_SIT_POSE = 0.10;

// 太ももボーンを内転回転させるローカル最大回転角度 17.5度
const MAX_THIGH_ADDUCTION_LOCAL_ANGLE = THREE.MathUtils.degToRad(17.5);

// 膝位置を目標方向へ向けるワールド姿勢補正の最大回転角度 4.0度
const MAX_WORLD_KNEE_ALIGN_ANGLE = THREE.MathUtils.degToRad(4.0);

// 内転回転軸のキャリブレーション探索時に試行回転させるテスト角度 2.5度
const CALIBRATION_TEST_ANGLE = THREE.MathUtils.degToRad(2.5);

// 間隔計算においてゼロ除算を防ぐ最小安全値 0.001
const GAP_EPSILON_MIN = 0.001;

// 左右の脚が境界を越えて交差していないかを判定する境界イプシロン 0.001
const LEG_SIDE_KEEP_EPSILON = 0.001;

// 脚閉じ補正処理を有効とみなす最小進行度閾値 0.0001
const LEG_CLOSE_PROGRESS_ACTIVE_EPSILON = 0.0001;

// 外積ベクトルの長さ二乗がゼロとみなせる微小閾値
const CROSS_AXIS_MIN_LENGTH_SQ = 1e-8;

// 方向ベクトル間の角度差が計算可能とみなす最小角度閾値
const DIRECTION_ALIGNMENT_MIN_ANGLE = 1e-5;

// 軸キャリブレーション評価において膝の上下方向Y軸ずれに課すペナルティ重み
const AXIS_CALIBRATION_Y_PENALTY_WEIGHT = 0.25;

// 軸キャリブレーション評価において膝の前後方向Z軸ずれに課すペナルティ重み
const AXIS_CALIBRATION_Z_PENALTY_WEIGHT = 0.25;

// 軸キャリブレーション評価において足首の横方向ずれに課すペナルティ重み
const AXIS_CALIBRATION_FOOT_LATERAL_PENALTY_WEIGHT = 0.12;

// 軸キャリブレーション評価において左右脚の交差が発生した際に課すペナルティ値
const AXIS_CALIBRATION_SIDE_BREAK_PENALTY = 0.4;

// 軸キャリブレーションで採用を許可する最小許容スコア閾値
const AXIS_CALIBRATION_MIN_ACCEPTABLE_SCORE = -0.05;

// 軸方向の反転パターン数 正方向と負方向の2パターン
const AXIS_SIGN_VARIANTS = 2;

// 目標位置調整をトリガーする内股隙間の許容超過マージン
const REFINE_TRIGGER_INNER_GAP_MARGIN = 0.002;

// 目標位置調整をトリガーする膝隙間の許容超過マージン
const REFINE_TRIGGER_KNEE_GAP_MARGIN = 0.01;

// 目標脚位置を中央境界でクランプする際の最小離隔イプシロン
const TARGET_SIDE_CLAMP_EPSILON = 0.001;

// 太もも内転回転角のスケール探索候補リスト 2.4倍から0.2倍まで12段階
const LEG_CLOSE_BASE_SCALES = [2.40, 2.20, 2.00, 1.80, 1.60, 1.40, 1.20, 1.00, 0.80, 0.60, 0.40, 0.20];

// 左右脚の非対称回転を試行するためのオフセット候補リスト
const LEG_CLOSE_ASYMMETRY_OFFSETS = [0.0, -0.12, 0.12, -0.22, 0.22];

// 脚閉じ姿勢スコア計算における内股隙間の最小化を重視する重み係数
const SCORE_INNER_GAP_WEIGHT = 1400;

// 内股隙間が目標値を超過した際に課すペナルティ重み係数
const SCORE_INNER_EXCESS_WEIGHT = 600;

// 脚閉じ姿勢スコア計算における膝隙間の最小化を重視する重み係数
const SCORE_KNEE_GAP_WEIGHT = 180;

// 膝隙間が目標値を超過した際に課すペナルティ重み係数
const SCORE_KNEE_EXCESS_WEIGHT = 80;

// 足首隙間が目標値以下に収まっている場合に与えるボーナス重み係数
const SCORE_ANKLE_BONUS_WEIGHT = 0.5;

// 左右脚の内転スケール差による非対称性に課すペナルティ重み係数
const SCORE_ASYMMETRY_WEIGHT = 0.15;

// 探索の早期終了を判定する内股隙間の許容マージン
const EARLY_ACCEPT_INNER_GAP_MARGIN = 0.0015;

// 探索の早期終了を判定する膝隙間の許容マージン
const EARLY_ACCEPT_KNEE_GAP_MARGIN = 0.004;

// 探索早期終了判定における内股隙間の重み指数
const EARLY_BREAK_INNER_WEIGHT = 1000;

// 探索早期終了判定における膝隙間の重み指数
const EARLY_BREAK_KNEE_WEIGHT = 120;

// 探索早期終了判定におけるスコア基準オフセット値
const EARLY_BREAK_SCORE_BIAS = 2.0;

// 軸リカバリログの最大出力件数
const LEG_ADDUCTION_AXIS_RECOVERY_MAX_LOGS = 0;

// 脚閉じ処理の詳細トレースログ出力フラグ
const LEG_ADDUCTION_TRACE = false;

// 詳細トレースログの最大出力件数
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

let legAdductionAxisRecoveryDebugCount = 0;
let legAdductionTraceCount = 0;

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
        if (nonZero === 1) continue; // 単軸方向は基本候補側で列挙済み
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
    hips: findBoneByNamePattern(root, [/^J_Bip_C_Hips$/i, /^mixamorigHips$/i, /^Hips$/i, /pelvis/i]),
    leftUpperArm: findBoneByNamePattern(root, [/^J_Bip_L_UpperArm$/i, /^mixamorigLeftArm$/i, /^LeftArm$/i, /left.*upper.*arm/i, /left.*arm/i]),
    rightUpperArm: findBoneByNamePattern(root, [/^J_Bip_R_UpperArm$/i, /^mixamorigRightArm$/i, /^RightArm$/i, /right.*upper.*arm/i, /right.*arm/i]),
    leftForearm: findBoneByNamePattern(root, [/^J_Bip_L_LowerArm$/i, /^mixamorigLeftForeArm$/i, /^LeftForeArm$/i, /left.*forearm/i]),
    rightForearm: findBoneByNamePattern(root, [/^J_Bip_R_LowerArm$/i, /^mixamorigRightForeArm$/i, /^RightForeArm$/i, /right.*forearm/i]),
  };
}

function collectLegCloseBones(root: THREE.Object3D): LegCloseBones {
  return {
    hips: findBoneByNamePattern(root, [/^J_Bip_C_Hips$/i, /^mixamorigHips$/i, /^Hips$/i, /pelvis/i]),
    leftThigh: findBoneByNamePattern(root, [/^J_Bip_L_UpperLeg$/i, /^mixamorigLeftUpLeg$/i, /^LeftUpLeg$/i, /left.*up.*leg/i, /left.*thigh/i]),
    rightThigh: findBoneByNamePattern(root, [/^J_Bip_R_UpperLeg$/i, /^mixamorigRightUpLeg$/i, /^RightUpLeg$/i, /right.*up.*leg/i, /right.*thigh/i]),
    leftKnee: findBoneByNamePattern(root, [/^J_Bip_L_LowerLeg$/i, /^mixamorigLeftLeg$/i, /^LeftLeg$/i, /left(?!.*up).*leg/i, /left.*knee/i]),
    rightKnee: findBoneByNamePattern(root, [/^J_Bip_R_LowerLeg$/i, /^mixamorigRightLeg$/i, /^RightLeg$/i, /right(?!.*up).*leg/i, /right.*knee/i]),
    leftFoot: findBoneByNamePattern(root, [/^J_Bip_L_Foot$/i, /^mixamorigLeftFoot$/i, /^LeftFoot$/i, /left.*foot/i, /left.*ankle/i]),
    rightFoot: findBoneByNamePattern(root, [/^J_Bip_R_Foot$/i, /^mixamorigRightFoot$/i, /^RightFoot$/i, /right.*foot/i, /right.*ankle/i]),
  };
}

function getLowestFootLocalY(root: THREE.Object3D, bones: LegCloseBones): number | null {
  const feet = [bones.leftFoot, bones.rightFoot].filter((foot): foot is THREE.Object3D => Boolean(foot));
  if (feet.length === 0) return null;

  const localYValues = feet.map((foot) => {
    const worldPosition = foot.getWorldPosition(new THREE.Vector3());
    return root.worldToLocal(worldPosition).y;
  });

  return Math.min(...localYValues);
}

function smoothstep01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

// 骨格のローカル座標を股関節基準で取る
// この座標系を使うと左右脚の位置差を扱いやすくなる
function getLocalPositionFromBone(
  hips: THREE.Object3D,
  bone: THREE.Object3D,
  out: THREE.Vector3,
  hipInv: THREE.Matrix4
): THREE.Vector3 {
  bone.getWorldPosition(out);
  return out.applyMatrix4(hipInv);
}

// 太ももの内側をまっすぐな線で取ることで座位時の密着感を安定させる
// 内側を少し膝寄りに寄せて脚の接触位置を自然に保つ
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

// 左右の広がりを知るための軸上の符号付き値を計算する
// 右側が正で左側が負になるようにして閉じ具合を比較しやすくする
function getSignedLateralValue(localPos: THREE.Vector3, lateralAxisLocal: THREE.Vector3): number {
  return localPos.dot(lateralAxisLocal);
}

// 左右の候補位置から横方向軸を決める
// 脚が近すぎて方向が取れないときは太ももの位置で代替軸を作る
function resolveLateralAxisLocal(
  hips: THREE.Object3D,
  leftCandidate: THREE.Vector3,
  rightCandidate: THREE.Vector3,
  fallbackBoneLeft: THREE.Object3D | null,
  fallbackBoneRight: THREE.Object3D | null,
  hipInv: THREE.Matrix4
): THREE.Vector3 {
  const axis = new THREE.Vector3().subVectors(rightCandidate, leftCandidate);

  if (axis.lengthSq() < SMALL_VECTOR_LENGTH_SQ && fallbackBoneLeft && fallbackBoneRight) {
    const leftThighLocal = getLocalPositionFromBone(hips, fallbackBoneLeft, new THREE.Vector3(), hipInv);
    const rightThighLocal = getLocalPositionFromBone(hips, fallbackBoneRight, new THREE.Vector3(), hipInv);
    axis.copy(rightThighLocal.sub(leftThighLocal));
  }

  if (axis.lengthSq() < SMALL_VECTOR_LENGTH_SQ) {
    axis.set(1, 0, 0);
  } else {
    axis.normalize();
  }

  return axis;
}

// 座位時の基準脚の位置と間隔を保存する
// 立位から座位へ進む途中で左右のギャップを比較する材料として使う
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

// 現在の脚の開き具合を計測する
// 座位基準との差分を見て閉じるべき強さを決める
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

// 太ももの内転軸を候補から選ぶ
// 体の形状が変わると軸がぶれるので試行しながら安全な方向を探す
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
  // 軸の見つけ方が失敗したときは太ももの自然な回転方向を安全側で使う
  return side === 'left' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0);
}

// 脚の内転軸を初期化して次の補正で使えるようにする
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


// 座位に近づくにつれて脚を閉じて太ももがぶつからないようにする
// 間隔の下限を守りながら自然な角度を選ぶ
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

// 立位では腕を少し外側へ開いて袖や手が太ももに食い込まないようにする
// 座位に進むと補正を弱くして自然な姿勢へ戻す
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

  // 立位区間では腕を外側に開くように補正して手の位置が大腿部とぶつかる状態を防ぐ
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

    // 正角度で外開きになるよう回転軸の向きをここで決める
    const axisWorld = new THREE.Vector3().crossVectors(desiredDir, currentDir);
    const axisLenSq = axisWorld.lengthSq();
    const angle = currentDir.angleTo(desiredDir);

    if (!Number.isFinite(angle) || angle <= SMALL_ANGLE_EPSILON) return;

    const safeAxisWorld =
      axisLenSq > SMALL_VECTOR_LENGTH_SQ
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

// モデル内の全メッシュへカテゴリ別マテリアルを適用する
// 色変更とワイヤーフレーム切り替えを即時反映するため再生成する
function applyCustomMaterials(
  root: THREE.Object3D | null,
  wireframe: boolean,
  customMapping: MeshColorMapping,
  colors: Record<ColorCategory, string>,
  onDiscoverMeshes?: (meshes: { id: string; name: string; current: ColorCategory }[]) => void,
  hiddenCategories?: ReadonlySet<ColorCategory>
) {
  if (!root) return;

  const createMaterial = (mesh: THREE.Mesh, sourceMaterial: THREE.Material | null, category: ColorCategory) => {
    // 色変更を即時反映するため毎回新しいマテリアルを生成する
    // 使い回すと古い色状態が残るため再利用しない

    const newMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors[category] || colors.default),
      side: THREE.DoubleSide,
      roughness: FBX_MATERIAL_ROUGHNESS,
      metalness: FBX_MATERIAL_METALNESS,
      wireframe: wireframe,
      vertexColors: false,
      map: null,
      emissive: new THREE.Color(0x000000),
    });
    newMat.visible = !hiddenCategories?.has(category);

    // スキンメッシュではスキニングを有効化し差し替え後もポーズ変形を維持する
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      (newMat as THREE.MeshStandardMaterial & { skinning?: boolean }).skinning = true;
    }
    newMat.userData.fromClothSim = true;

    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      // ポーズ中のスキン頂点はバインドポーズの範囲外へ出るためカリングしない
      mesh.frustumCulled = false;
    }

    if (sourceMaterial) sourceMaterial.dispose();
    return newMat;
  };
  
  const discovered: { id: string; name: string; current: ColorCategory }[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      const meshId = mesh.uuid;
      const meshName = mesh.name || "Unnamed Mesh";
      const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const materialArray = originalMaterials.filter((material): material is THREE.Material => Boolean(material));
      const matName = materialArray.filter(Boolean).map((m) => m?.name || '').join(' ');
      const texName = materialArray
        .filter(Boolean)
        .map((m) => ((m as THREE.MeshStandardMaterial)?.map?.name || ''))
        .join(' ');
      const parentName = mesh.parent?.name || "";

      // 毎回再分類してユーザーデータ蓄積を避ける
      // 識別子は複製と再読込で変わるためメッシュ名でも割り当て可能にする
      const meshType = inferMeshType(
        meshName,
        parentName,
        matName,
        texName,
        customMapping[meshId] ?? customMapping[meshName] ?? mesh.userData.clothSimMeshType
      );

      mesh.userData.clothSimMeshType = meshType;
        mesh.visible = !hiddenCategories?.has(meshType);

      discovered.push({ id: meshId, name: meshName, current: meshType });

      const storedMaterialCategories = Array.isArray(mesh.userData.clothSimMaterialCategories)
        ? mesh.userData.clothSimMaterialCategories as ColorCategory[]
        : [];
      const materialCategories = originalMaterials.map((sourceMaterial, index) => {
        const storedCategory = storedMaterialCategories[index];
        if (storedCategory && storedCategory !== 'default') return storedCategory;

        const materialType = inferMaterialCategory(sourceMaterial?.name || '', meshName);
        return materialType === 'default' ? meshType : materialType;
      });
      mesh.userData.clothSimMaterialCategories = materialCategories;

      const nextMaterials = originalMaterials.map((sourceMaterial, index) => {
        return createMaterial(mesh, sourceMaterial, materialCategories[index]);
      });
      mesh.material = nextMaterials.length === 1 ? nextMaterials[0] : nextMaterials;
    }
  });

  // メッシュ一覧をUI側へ通知する
  // 一度だけまたは変更時のみ走る制御は親側に置く
  if (onDiscoverMeshes) {
    onDiscoverMeshes(discovered);
  }
}

// スカートはモーフアニメーション済みのメッシュをそのまま使うので
// 見た目だけを統一するシンプルなマテリアルへ置き換える
function applyAnimatedSkirtMaterial(
  root: THREE.Object3D | null,
  wireframe: boolean,
  skirtColor: string
): void {
  if (!root) return;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    sourceMaterials.forEach((material) => material?.dispose());

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(skirtColor),
      side: THREE.DoubleSide,
      roughness: SKIRT_MATERIAL_ROUGHNESS,
      metalness: SKIRT_MATERIAL_METALNESS,
      wireframe,
      vertexColors: false,
    });
    (material as THREE.MeshStandardMaterial & { morphTargets?: boolean }).morphTargets = true;
    material.userData.fromClothSim = true;

    mesh.material = material;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

function SceneWithFBX({
  fbxPath,
  skirtGlbPath,
  modelBasePosition,
  progress,
  onProgressChange,
  wireframe,
  playTarget,
  onFinished = () => {},
  colors,
  customMapping,
  onDiscoverMeshes
}: {
  fbxPath: string;
  skirtGlbPath: string;
  modelBasePosition: [number, number, number];
  progress: number;
  onProgressChange: (p: number) => void;
  wireframe: boolean;
  playTarget: number | null;
  onFinished?: () => void;
  colors: Record<ColorCategory, string>;
  customMapping: MeshColorMapping;
  onDiscoverMeshes: (meshes: { id: string; name: string; current: ColorCategory }[]) => void;
}) {
  const SIT_CLIP_PROGRESS = SAFE_SIT_CLIP_PROGRESS;
  const uiProgressToClipProgress = useCallback((uiProgress: number) => {
    const clamped = Math.min(Math.max(uiProgress, 0), 1);
    return clamped * SIT_CLIP_PROGRESS;
  }, [SIT_CLIP_PROGRESS]);

  const fbx = useFBX(fbxPath) as THREE.Group & { animations?: THREE.AnimationClip[] };
  const skirtGltf = useGLTF(skirtGlbPath) as AnimatedSkirtGltf;
  
  // FBX そのものを壊さないためスケルトンだけ複製して編集用の姿勢を作る
  const cloned = useMemo(() => {
    if (!fbx) return null;
    const clonedGroup = skeletonClone(fbx) as THREE.Group;
    return clonedGroup;
  }, [fbx]);

  const clonedSkirt = useMemo(() => {
    if (!skirtGltf?.scene) return null;
    return skeletonClone(skirtGltf.scene) as THREE.Group;
  }, [skirtGltf]);

  const { camera } = useThree();
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const skirtActionRef = useRef<THREE.AnimationAction | null>(null);
  const progressRef = useRef(progress);
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
  const hipRestPositionRef = useRef<THREE.Vector3 | null>(null);
  const rootMotionInterpolantRef = useRef<THREE.Interpolant | null>(null);
  const rootMotionInitialYRef = useRef(0);
  const rootMotionInitialZRef = useRef(0);
  const standingFootLocalYRef = useRef<number | null>(null);
  const modelRootRef = useRef<THREE.Group>(null);
  const skirtRootMotionRef = useRef<THREE.Group>(null);
  const hiddenFbxCategories = useMemo(() => new Set<ColorCategory>(['skirt']), []);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // 外部のアニメーション補助を使わずAnimationMixerを独自管理する
  const mixer = useMemo(() => {
    if (!cloned) return null;
    return new THREE.AnimationMixer(cloned);
  }, [cloned]);

  const skirtMixer = useMemo(() => {
    if (!clonedSkirt) return null;
    return new THREE.AnimationMixer(clonedSkirt);
  }, [clonedSkirt]);

  // アニメーションクリップの選択と初期化
  // モデルの本来の動きをそのまま使いながら表示専用のトラックだけを残す
  const selectedClip = useMemo(() => {
    if (!fbx?.animations || fbx.animations.length === 0) return null;
    const clip = fbx.animations.find((candidate) => /mixamo.com|Take|take/i.test(candidate.name)) || fbx.animations[0];
    const renderTracks = clip.tracks.filter((track) => !/^egaken\.(position|quaternion|scale)$/.test(track.name));
    return new THREE.AnimationClip(`${clip.name}_renderable`, clip.duration, renderTracks);
  }, [fbx]);

  const selectedSkirtClip = useMemo(() => {
    if (!skirtGltf?.animations || skirtGltf.animations.length === 0) return null;
    return skirtGltf.animations.find((candidate) => /keyaction|take|skirt/i.test(candidate.name)) || skirtGltf.animations[0];
  }, [skirtGltf]);

  // UI の進行度をアニメーションクリップ時間へ変換して姿勢を再現する
  // 立位と座位の区間を押さえながら脚の閉じ具合や腕の開き具合を補正する
  const applyPoseAtProgress = useCallback(
    (uiProgress: number) => {
      if (!mixer || !selectedClip || !cloned) return;
      const duration = selectedClip.duration || DEFAULT_CLIP_DURATION;
      const clipTime = uiProgressToClipProgress(uiProgress) * duration;
      mixer.setTime(clipTime);
      mixer.update(0);

      if (skirtMixer && selectedSkirtClip) {
        skirtMixer.setTime(resolveSkirtClipTime(selectedSkirtClip, uiProgress));
        skirtMixer.update(0);
      }

      const rootMotionOffset = new THREE.Vector3(0, 0, 0);
      if (legCloseBonesRef.current.hips && hipRestPositionRef.current) {
        legCloseBonesRef.current.hips.position.copy(hipRestPositionRef.current);
        const rootMotion = rootMotionInterpolantRef.current?.evaluate(clipTime);
        if (rootMotion) {
          rootMotionOffset.set(
            0,
            rootMotion[1] - rootMotionInitialYRef.current,
            rootMotion[2] - rootMotionInitialZRef.current
          );
          legCloseBonesRef.current.hips.position.y += rootMotionOffset.y;
          legCloseBonesRef.current.hips.position.z += rootMotionOffset.z;
        }
      }

      if (skirtRootMotionRef.current) {
        skirtRootMotionRef.current.position.copy(rootMotionOffset);
      }

      // 立位時の腕基準ポーズを安定して維持する
      // 立位区間だけ上腕を外側へ開き手の衣装食い込みを避ける
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

      if (modelRootRef.current && standingFootLocalYRef.current !== null) {
        cloned.updateMatrixWorld(true);
        const currentFootLocalY = getLowestFootLocalY(cloned, legCloseBonesRef.current);
        if (currentFootLocalY !== null) {
          const worldScaleY = cloned.getWorldScale(new THREE.Vector3()).y;
          modelRootRef.current.position.y = modelBasePosition[1] +
            (standingFootLocalYRef.current - currentFootLocalY) * worldScaleY;
        }
      }
    },
    [cloned, mixer, modelBasePosition, selectedClip, selectedSkirtClip, skirtMixer, uiProgressToClipProgress]
  );

  // マテリアルの適用とメッシュ検出
  useEffect(() => {
    if (!cloned) return;
    applyCustomMaterials(cloned, wireframe, customMapping, colors, onDiscoverMeshes, hiddenFbxCategories);
  }, [cloned, wireframe, customMapping, colors, onDiscoverMeshes, hiddenFbxCategories]);

  useEffect(() => {
    if (!clonedSkirt) return;
    applyAnimatedSkirtMaterial(clonedSkirt, wireframe, colors.skirt);
  }, [clonedSkirt, wireframe, colors.skirt]);

  useEffect(() => {
    if (!skirtMixer || !clonedSkirt || !selectedSkirtClip) return;
    const action = skirtMixer.clipAction(selectedSkirtClip);
    action.reset();
    action.setEffectiveWeight(1.0);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    skirtActionRef.current = action;
    skirtMixer.setTime(0);
    skirtMixer.update(0);
    clonedSkirt.updateMatrixWorld(true);

    return () => {
      skirtMixer.stopAllAction();
      skirtActionRef.current = null;
    };
  }, [clonedSkirt, selectedSkirtClip, skirtMixer]);

  // アクションの設定と一時停止
  // 自動再生と手動操作が競合しないように初期値を揃える
  useEffect(() => {
    if (!mixer || !cloned || !selectedClip) return;
    const action = mixer.clipAction(selectedClip);
    action.reset();
    action.setEffectiveWeight(1.0);
    action.play();
    actionRef.current = action;

    // 立位の腕ポーズを一度だけ記録する
    // 座位側のサンプリング後に腕ボーンのみ復元し手の太もも食い込みを防ぐ
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
    standingFootLocalYRef.current = getLowestFootLocalY(cloned, legCloseBonesRef.current);
    hipRestPositionRef.current = legCloseBonesRef.current.hips?.position.clone() ?? null;
    const sourceClip = fbx.animations?.find((candidate) => /mixamo.com|Take|take/i.test(candidate.name)) || fbx.animations?.[0];
    const rootPositionTrack = sourceClip?.tracks.find((track) => track.name === 'egaken.position') as THREE.VectorKeyframeTrack | undefined;
    rootMotionInterpolantRef.current = rootPositionTrack
      ? rootPositionTrack.InterpolantFactoryMethodLinear(new Float32Array(3))
      : null;
    rootMotionInitialYRef.current = rootPositionTrack?.values[1] ?? 0;
    rootMotionInitialZRef.current = rootPositionTrack?.values[2] ?? 0;
    legAdductionAxisRecoveryDebugCount = 0;
    legAdductionTraceCount = 0;

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
      hipRestPositionRef.current = null;
      rootMotionInterpolantRef.current = null;
      rootMotionInitialYRef.current = 0;
      rootMotionInitialZRef.current = 0;
      standingFootLocalYRef.current = null;
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
  }, [SIT_CLIP_PROGRESS, mixer, cloned, fbx, selectedClip]);

  // スライダーや自動再生で値が変わるたびに姿勢をすぐ再計算する
  // ここで更新した値がボーンに反映されるので画面が常に同期する
  useEffect(() => {
    applyPoseAtProgress(progress);
  }, [applyPoseAtProgress, progress]);

  // サイズと位置の自動計算ロジック
  // 画面の見え方を保つため既存の比率を維持して拡大率を決める
  const { objectScale, modelOffsetY } = useMemo(() => {
    if (!cloned) return { objectScale: FALLBACK_OBJECT_SCALE, modelOffsetY: 0 };

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
    const desiredHeight = camHeightAtDist * MODEL_VIEW_HEIGHT_FRACTION;

    const scale = size.y > 0 ? desiredHeight / size.y : FALLBACK_OBJECT_SCALE;
    const centerY = (box.min.y + box.max.y) / 2;
    const offsetY = -centerY * scale;

    return { objectScale: scale, modelOffsetY: offsetY };
  }, [cloned, camera, modelBasePosition]);

  // ボタン操作とスライダーによるポーズ変更をボーンへすぐ反映する
  // 目標に到達したら値を固定して勝手に戻らないようにする
  useFrame((_, delta) => {
    if (!mixer || !actionRef.current || !selectedClip) return;

    const currentProgress = progressRef.current;

    if (playTarget !== null) {
      // 立つ座るボタン押下時の滑らかな自動シーク
      let nextProgress = currentProgress;

      if (currentProgress < playTarget) {
        nextProgress = Math.min(currentProgress + delta * AUTO_SEEK_SPEED, playTarget);
      } else if (currentProgress > playTarget) {
        nextProgress = Math.max(currentProgress - delta * AUTO_SEEK_SPEED, playTarget);
      }

      // 目標に非常に接近したらスナップして確定させる
      if (Math.abs(nextProgress - playTarget) <= TARGET_EPSILON) {
        nextProgress = playTarget;
      }

      if (nextProgress !== currentProgress) {
        progressRef.current = nextProgress;
        onProgressChange(nextProgress);
      }

      applyPoseAtProgress(nextProgress);

      // 目標に到達したら目標値を空にしてアニメーション停止する
      // 姿勢値自体は保持されるため座り状態が続く
      const distToTarget = Math.abs(nextProgress - playTarget);
      if (distToTarget <= TARGET_EPSILON) {
        onFinished();
      }
    } else {
      // スライダーの手動操作時または目標到達後
      applyPoseAtProgress(currentProgress);
    }
  });

  return (
    <group ref={modelRootRef} position={modelBasePosition}>
      <group scale={[objectScale, objectScale, objectScale]} position={[0, modelOffsetY, 0]}>
        {cloned && <primitive object={cloned} />}
        {clonedSkirt && (
          <group ref={skirtRootMotionRef}>
            <primitive object={clonedSkirt} rotation={[Math.PI / 2, 0, 0]} />
          </group>
        )}
      </group>
    </group>
  );
}

export default function ClothSimulator() {
  const [wireframe, setWireframe] = useState(false);
  const [progress, setProgress] = useState(PROGRESS_MIN);
  const [playTarget, setPlayTarget] = useState<number | null>(null);
  const [colors, setColors] = useState<Record<ColorCategory, string>>(DEFAULT_COLORS);

  const modelBasePosition = MODEL_BASE_POSITION;
  const fbxPath = FBX_MODEL_PATH;
  const skirtGlbPath = `${SKIRT_GLB_PATH}?v=${SKIRT_ASSET_VERSION}`;

  const customMapping = useMemo<MeshColorMapping>(() => ({}), []);

  // メッシュ検出コールバックは今は UI で使わないので空の関数だけ用意する
  const handleDiscoverMeshes = useCallback(() => {}, []);

  const updateColor = useCallback((category: ColorCategory, value: string) => {
    setColors((current) => ({ ...current, [category]: value }));
  }, []);

  // パーツのタイプを手動で切り替えるトグルは救済UI統合により廃止

  return (
    <div className="absolute inset-0 w-full h-full bg-[#0f172a] overflow-hidden select-none">
      {/* 3次元キャンバス領域 */}
      <Canvas
        shadows
        camera={{ position: CAMERA_INITIAL_POSITION, fov: CAMERA_FOV }}
        className="w-full h-full"
        gl={{ alpha: false }}
        onCreated={({ gl }) => {
          gl.shadowMap.type = THREE.PCFShadowMap;
        }}
      >
        <color attach="background" args={[SCENE_BACKGROUND_COLOR]} />
        <hemisphereLight args={[HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_LIGHT_INTENSITY]} />
        <ambientLight intensity={AMBIENT_LIGHT_INTENSITY} />
        <directionalLight position={DIRECTIONAL_LIGHT_POSITION} intensity={DIRECTIONAL_LIGHT_INTENSITY} castShadow />
        <spotLight position={SPOT_LIGHT_POSITION} intensity={SPOT_LIGHT_INTENSITY} penumbra={SPOT_LIGHT_PENUMBRA} />

        <SceneWithFBX
          fbxPath={fbxPath}
          skirtGlbPath={skirtGlbPath}
          modelBasePosition={modelBasePosition}
          progress={progress}
          onProgressChange={setProgress}
          wireframe={wireframe}
          playTarget={playTarget}
          onFinished={() => setPlayTarget(null)}
          customMapping={customMapping}
          colors={colors}
          onDiscoverMeshes={handleDiscoverMeshes}
        />

        <OrbitControls makeDefault enablePan={true} enableZoom={true} enableRotate={true} target={ORBIT_CONTROLS_TARGET} />
      </Canvas>

      {/* 右側のメイン操作コントロールパネル */}
      <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-4">
        <div className="pointer-events-auto rounded-2xl border border-slate-700/40 bg-slate-900/90 p-4 shadow-2xl backdrop-blur-md style-panel" style={{ width: CONTROL_PANEL_WIDTH }}>
          {/* 座る立つアニメーションボタン */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="text-xs font-medium text-slate-400 mb-2">Animation Triggers</div>
            <div className="flex items-center gap-2">
              {/* 立位ボタン */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress <= PROGRESS_STEP
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg' 
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                }`}
                onClick={() => setPlayTarget(PROGRESS_MIN)}
              >
                🧍 Stand (立)
              </button>
              
              {/* 座位ボタン */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress >= PROGRESS_MAX - PROGRESS_STEP
                    ? 'bg-sky-600 text-white border-sky-500 shadow-lg' 
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                }`}
                onClick={() => setPlayTarget(PROGRESS_MAX)}
              >
                🧎 Sit (座)
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/60 pt-2 font-mono">
              <span>Status:</span>
              <span className="text-slate-200 font-bold">
                {playTarget !== null ? '⏳ Moving...' : progress >= PROGRESS_MAX - PROGRESS_STEP ? '✅ Sitting' : progress <= PROGRESS_STEP ? '✅ Standing' : '⏸️ Paused'}
              </span>
            </div>
          </div>

          {/* ポーズバー */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-1.5">
              <span>Pose バー (Manual Seek)</span>
              <span className="font-mono text-slate-200 bg-slate-800 px-1.5 py-0.5 rounded">{(progress * 100).toFixed(1)}%</span>
            </div>
            <input
              type="range"
              min={PROGRESS_MIN}
              max={PROGRESS_MAX}
              step={PROGRESS_STEP}
              value={progress}
              onChange={(e) => {
                // スライダー操作時は自動移行を即時キャンセル
                setPlayTarget(null);
                setProgress(parseFloat(e.target.value));
              }}
              className="w-full accent-sky-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg appearance-none"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
              <span>Stand</span>
              <span>Sit</span>
            </div>
          </div>

          {/* 色コントロール */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="text-xs font-medium text-slate-400 mb-2">Color Controls</div>
            {([
              ['hair', '髪色'],
              ['skin', '肌の色'],
              ['jacket', '上着の色'],
              ['skirt', 'スカートの色'],
              ['shoes', '靴の色'],
            ] as const).map(([category, label]) => (
              <label key={category} className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-300">
                <span>{label}</span>
                <input
                  type="color"
                  value={colors[category]}
                  onChange={(e) => updateColor(category, e.target.value)}
                  className="h-7 w-12 cursor-pointer rounded border border-slate-700 bg-slate-900 p-0.5"
                  aria-label={label}
                />
              </label>
            ))}
          </div>

          {/* 表示オプション */}
          <div className="mb-2 space-y-2 px-1">
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
