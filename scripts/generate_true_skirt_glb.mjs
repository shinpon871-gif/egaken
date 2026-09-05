// FBXボーンスキニング結果からスカート頂点変形を抽出しモーフターゲット付きGLBを出力するスクリプト
import fs from 'fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Node.js環境用FileReaderポリフィル
class NodeFileReader {
  constructor() {
    this.onload = null;
    this.onloadend = null;
    this.onerror = null;
    this.result = null;
  }
  // ArrayBuffer形式の読み込み処理
  readAsArrayBuffer(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (this.onload) this.onload({ target: this });
        if (this.onloadend) this.onloadend({ target: this });
      });
    } else if (Buffer.isBuffer(blob)) {
      this.result = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
      if (this.onload) this.onload({ target: this });
      if (this.onloadend) this.onloadend({ target: this });
    }
  }
  // DataURL形式の読み込み処理
  readAsDataURL(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      blob.arrayBuffer().then((buf) => {
        const base64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
        if (this.onload) this.onload({ target: this });
        if (this.onloadend) this.onloadend({ target: this });
      });
    }
  }
}
globalThis.FileReader = NodeFileReader;

// FBXLoaderのテクスチャ読み込み用documentポリフィル
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({ style: {}, addEventListener: () => {}, src: '' }),
    createElement: () => ({ style: {}, addEventListener: () => {}, src: '' }),
  };
}

// FBXモデルファイルの読み込みとBodyメッシュの取得
const fbxBuf = fs.readFileSync('public/models/StandToSit_model.fbx');
const loader = new FBXLoader();
const group = loader.parse(fbxBuf.buffer.slice(fbxBuf.byteOffset, fbxBuf.byteOffset + fbxBuf.byteLength), '');

let bodyMesh = null;
group.traverse((c) => {
  if (c.name === 'Body') bodyMesh = c;
});

const geom = bodyMesh.geometry;
const pos = geom.attributes.position;
const norm = geom.attributes.normal;
const uv = geom.attributes.uv;
const skinIndex = geom.attributes.skinIndex;
const skinWeight = geom.attributes.skinWeight;

// Bodyメッシュ内におけるBottoms（スカート）の頂点開始位置と頂点数
const startIdx = 29664;
const countIdx = 2100;
const numVerts = countIdx;

// スカートの基準法線およびUV属性の抽出
const basePositions = new Float32Array(numVerts * 3);
const baseNormals = norm ? new Float32Array(numVerts * 3) : null;
const baseUvs = uv ? new Float32Array(numVerts * 2) : null;

for (let i = 0; i < numVerts; i++) {
  const srcIdx = startIdx + i;
  basePositions[i * 3] = pos.getX(srcIdx);
  basePositions[i * 3 + 1] = pos.getY(srcIdx);
  basePositions[i * 3 + 2] = pos.getZ(srcIdx);

  if (baseNormals) {
    baseNormals[i * 3] = norm.getX(srcIdx);
    baseNormals[i * 3 + 1] = norm.getY(srcIdx);
    baseNormals[i * 3 + 2] = norm.getZ(srcIdx);
  }
  if (baseUvs) {
    baseUvs[i * 2] = uv.getX(srcIdx);
    baseUvs[i * 2 + 1] = uv.getY(srcIdx);
  }
}

// FBXアニメーションクリップの再生準備
const clip = group.animations[0];
const mixer = new THREE.AnimationMixer(group);
const action = mixer.clipAction(clip);
action.play();

const SAFE_SIT_CLIP_PROGRESS = 0.85;
const numFrames = 120;
const framePositions = [];

const v = new THREE.Vector3();
const skinnedV = new THREE.Vector3();
const tempV = new THREE.Vector3();

// 全120フレームの各時点でスキニング計算を実行しスカート実頂点座標を記録
for (let f = 0; f < numFrames; f++) {
  const progress = f / (numFrames - 1);
  const clipProgress = progress * SAFE_SIT_CLIP_PROGRESS;
  mixer.setTime(clipProgress * clip.duration);
  mixer.update(0);
  group.updateMatrixWorld(true);
  bodyMesh.skeleton.update();

  const currentFrame = new Float32Array(numVerts * 3);

  // 頂点ごとの4ボーン加重平均スキニング位置計算
  for (let i = 0; i < numVerts; i++) {
    const srcIdx = startIdx + i;
    v.fromBufferAttribute(pos, srcIdx);
    skinnedV.set(0, 0, 0);

    for (let j = 0; j < 4; j++) {
      const weight = skinWeight.getComponent(srcIdx, j);
      if (weight === 0) continue;
      const boneIdx = skinIndex.getComponent(srcIdx, j);
      const bone = bodyMesh.skeleton.bones[boneIdx];
      const invMat = bodyMesh.skeleton.boneInverses[boneIdx];

      tempV.copy(v).applyMatrix4(invMat).applyMatrix4(bone.matrixWorld);
      skinnedV.addScaledVector(tempV, weight);
    }
    currentFrame[i * 3] = skinnedV.x;
    currentFrame[i * 3 + 1] = skinnedV.y;
    currentFrame[i * 3 + 2] = skinnedV.z;
  }
  framePositions.push(currentFrame);
}

// 基準フレーム（フレーム0立位）をPosition属性とするジオメトリ生成
const skirtGeom = new THREE.BufferGeometry();
skirtGeom.setAttribute('position', new THREE.BufferAttribute(framePositions[0], 3));
if (baseNormals) skirtGeom.setAttribute('normal', new THREE.BufferAttribute(baseNormals, 3));
if (baseUvs) skirtGeom.setAttribute('uv', new THREE.BufferAttribute(baseUvs, 2));

// Three.js GLTFExporter用に各フレームの絶対座標をモーフターゲット配列へ格納
// エクスポータ内部で初期頂点位置が減算されglTF仕様の相対変位へ自動変換される
const morphPositions = [];
for (let f = 1; f < numFrames; f++) {
  morphPositions.push(new THREE.BufferAttribute(framePositions[f], 3));
}
skirtGeom.morphAttributes.position = morphPositions;

const skirtMesh = new THREE.Mesh(
  skirtGeom,
  new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    side: THREE.DoubleSide,
    roughness: 0.5,
  })
);
skirtMesh.name = 'Skirt_Animated_Bottoms';
skirtMesh.updateMorphTargets();

// モーフターゲットウェイトを順次1.0にするタイムラインアニメーショントラック生成
const times = new Float32Array(numFrames);
const numTargets = numFrames - 1; // 119ターゲット
const trackValues = new Float32Array(numFrames * numTargets);
const duration = 5.0;

for (let f = 0; f < numFrames; f++) {
  times[f] = (f / (numFrames - 1)) * duration;
  if (f > 0) {
    trackValues[f * numTargets + (f - 1)] = 1.0;
  }
}

const track = new THREE.NumberKeyframeTrack(
  `${skirtMesh.name}.morphTargetInfluences`,
  times,
  trackValues,
  THREE.InterpolateLinear
);

const animClip = new THREE.AnimationClip('KeyAction', duration, [track]);

const scene = new THREE.Scene();
scene.add(skirtMesh);

console.log('Exporting GLB...');
const exporter = new GLTFExporter();
// モーフアニメーション付きGLBバイナリファイルのエクスポート
exporter.parse(
  scene,
  (glb) => {
    fs.writeFileSync('public/models/skirt_mesh_sitting_animation.glb', Buffer.from(glb));
    console.log('GLB successfully exported! Size:', Buffer.from(glb).length, 'bytes');
  },
  (err) => {
    console.error('Export error:', err);
  },
  {
    binary: true,
    animations: [animClip],
  }
);
