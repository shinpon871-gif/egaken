"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useFBX } from '@react-three/drei';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils';

// メッシュごとのカスタム色割り当て用の型定義
interface MeshColorMapping {
  [meshId: string]: 'clothing' | 'body' | 'default';
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
  console.debug('[ClothSimulator] applyCustomMaterials colors:', { clothingColorHex, skinColorHex });
  
  const discovered: { id: string; name: string; current: 'clothing' | 'body' | 'default' }[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      const meshId = mesh.uuid;
      const meshName = mesh.name || "Unnamed Mesh";
      const matName = mesh.material && !Array.isArray(mesh.material) ? (mesh.material.name || "") : "";
      
      const searchStr = `${meshName} ${matName}`.toLowerCase();

      // 1. 手動マッピングがあれば最優先、なければ名前から自動推測
      let type: 'clothing' | 'body' | 'default' = customMapping[meshId];
      if (!type) {
        const isClothing = /skirt|dress|shirt|top|pant|jacket|coat|sleeve|hood|blouse|cape|jumpsuit|tunic|cloth|clothes|bottom|wear|suit/i.test(searchStr);
        const isBody = /body|skin|torso|head|leg|arm|hand|foot|face|neck|eye|mouth|teeth|hair/i.test(searchStr);
        
        if (isClothing) type = 'clothing';
        else if (isBody) type = 'body';
        else type = 'default';
      }

      discovered.push({ id: meshId, name: meshName, current: type });

      // 2. 指定された色に合わせた新規マテリアルを強制生成（テクスチャ競合を100%回避）
      let hexColor = '#cccccc'; // デフォルト（グレー）
      if (type === 'clothing') {
        hexColor = clothingColorHex;
      } else if (type === 'body') {
        hexColor = skinColorHex;
      }

      const newMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hexColor),
        side: THREE.DoubleSide,
        roughness: 0.5,
        metalness: 0.1,
        wireframe: wireframe,
      });

      // 古いマテリアルを破棄して完全に差し替える
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
      mesh.material = newMat;
      // ensure three knows material changed
      if (Array.isArray(mesh.material)) {
        (mesh.material as THREE.Material[]).forEach((m) => { m.needsUpdate = true; });
      } else if (mesh.material) {
        (mesh.material as THREE.Material).needsUpdate = true;
      }
    }
  });

  // メッシュ一覧をUI側にフィードバック（一度だけ、あるいは変更時のみ走るよう親で制御）
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
  onDiscoverMeshes,
  fbxReloadKey
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
  fbxReloadKey: number;
}) {
  const fbx = useFBX(fbxPath) as THREE.Group & { animations?: THREE.AnimationClip[] };
  
  // スケルトンのクローンを作成
  const cloned = useMemo(() => {
    if (!fbx) return null;
    return skeletonClone(fbx) as THREE.Group;
  }, [fbx, fbxReloadKey]);

  const { camera } = useThree();
  const actionRef = useRef<THREE.AnimationAction | null>(null);

  // 【原因解決①】dreiのuseAnimationsを完全に廃止し、自前でAnimationMixerを完全管理
  const mixer = useMemo(() => {
    if (!cloned) return null;
    return new THREE.AnimationMixer(cloned);
  }, [cloned]);

  // アニメーションクリップの選択と初期化
  const selectedClip = useMemo(() => {
    if (!fbx?.animations || fbx.animations.length === 0) return null;
    // mixamoまたは一般的なテイク名からクリップを探索
    return fbx.animations.find((clip) => /mixamo.com|Take|take/i.test(clip.name)) || fbx.animations[0];
  }, [fbx]);

  // マテリアルの適用とメッシュ検出
  useEffect(() => {
    if (!cloned) return;
    applyCustomMaterials(cloned, wireframe, customMapping, clothingColorHex, skinColorHex, onDiscoverMeshes);
  }, [cloned, wireframe, customMapping, clothingColorHex, skinColorHex, onDiscoverMeshes]);

  // アクションの設定と一時停止（自動再生の競合を徹底排除）
  useEffect(() => {
    if (!mixer || !cloned || !selectedClip) return;
    const action = mixer.clipAction(selectedClip);
    action.reset();
    action.setEffectiveWeight(1.0);
    action.play();
    actionRef.current = action;

    return () => {
      mixer.stopAllAction();
      actionRef.current = null;
    };
  }, [mixer, cloned, selectedClip]);

  // 初期ポーズ適用および progress が外部から変わったときに即時反映する
  useEffect(() => {
    if (!mixer || !selectedClip) return;
    const duration = selectedClip.duration || 1;
    mixer.setTime(progress * duration);
    mixer.update(0);
  }, [mixer, selectedClip, progress]);

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

  // 【原因解決②】ボタン操作およびスライダーによるポーズの変更をボーンへリアルタイム強制反映
  useFrame((_, delta) => {
    if (!mixer || !actionRef.current || !selectedClip) return;

    const duration = selectedClip.duration || 1;

    if (playTarget !== null) {
      // Sit / Stand ボタンが押されている時の滑らかな自動シーク
      const speed = 1.2; // アニメーションの再生速度倍率
      let nextProgress = progress;

      if (progress < playTarget) {
        nextProgress = Math.min(progress + delta * speed, playTarget);
      } else if (progress > playTarget) {
        nextProgress = Math.max(progress - delta * speed, playTarget);
      }

      onProgressChange(nextProgress);
      mixer.setTime(nextProgress * duration);
      mixer.update(0); // デルタ0で即時ポーズをメッシュに反映

      if (nextProgress === playTarget) {
        console.debug('[ClothSimulator] reached playTarget', { nextProgress, playTarget });
        onFinished(); // 目標位置に到達したら停止
      }
    } else {
      // スライダー（Poseバー）の手動操作時
      mixer.setTime(progress * duration);
      mixer.update(0); // 即時ボーン反映
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
  const [progress, setProgress] = useState(0); // 0: Stand(立), 1: Sit(座)
  const [playTarget, setPlayTarget] = useState<number | null>(null);
  const [fbxReloadKey, setFbxReloadKey] = useState(0);
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

    // no-op discover handler (we don't expose per-mesh controls anymore)
    const handleDiscoverMeshes = useCallback(() => {}, []);

  // パーツのタイプ（服・肌・その他）を手動で切り替えるトグル関数
  // ※ 救済UIを統合したため、個別トグルは廃止しました。

  return (
    <div className="absolute inset-0 w-full h-full bg-[#0f172a] overflow-hidden select-none">
      {/* 3D キャンバス領域 */}
      <Canvas shadows camera={{ position: [0, 0, 4.5], fov: 32 }} className="w-full h-full" gl={{ alpha: false }}>
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
          fbxReloadKey={fbxReloadKey}
          key={fbxReloadKey}
        />

        <OrbitControls makeDefault enablePan={true} enableZoom={true} enableRotate={true} target={[0, 0, 0]} />
      </Canvas>

      {/* 右側：メイン操作コントロールパネル */}
      <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-4">
        <div className="pointer-events-auto rounded-2xl border border-slate-700/40 bg-slate-900/90 p-4 shadow-2xl backdrop-blur-md style-panel" style={{ width: 340 }}>
          <div className="text-sm font-bold text-slate-100 mb-3 flex items-center justify-between border-b border-slate-700/50 pb-2">
            <span>Pose & Color Controller</span>
            <span className="text-[11px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full font-mono">v4.0-Fixed</span>
          </div>

          {/* 1. Reload ボタン：完全に初期状態（起立して停止）へリセットする */}
          <div className="mb-4">
            <button
              className="w-full py-2 rounded-lg bg-rose-600/90 hover:bg-rose-600 text-sm font-semibold text-white transition-all shadow-md shadow-rose-900/20 active:scale-[0.98]"
              onClick={() => {
                setPlayTarget(null);
                setProgress(0); // 完全に「初期位置（立ち状態）」へ巻き戻す
                setFbxReloadKey(prev => prev + 1); // FBXオブジェクトインスタンスの完全再生成
              }}
            >
              🔄 Reload (Reset to Stand)
            </button>
          </div>

          {/* 2. Sit / Stand アニメーションボタン */}
          <div className="mb-4 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800">
            <div className="text-xs font-medium text-slate-400 mb-2">Animation Triggers</div>
            <div className="flex items-center gap-2">
              {/* Stand ボタン：0（立ち状態）に向けてアニメーション停止まで移行 */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress === 0 
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg' 
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                }`}
                onClick={() => setPlayTarget(0)}
              >
                🧍 Stand (立)
              </button>
              
              {/* Sit ボタン：1（座り状態）に向けてアニメーション停止まで移行 */}
              <button
                className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                  progress === 1 
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
                {playTarget !== null ? '⏳ Moving...' : progress === 1 ? '✅ Sitting' : progress === 0 ? '✅ Standing' : '⏸️ Paused'}
              </span>
            </div>
          </div>

          {/* 3. Poseバー（タイムラインスライダー） */}
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
              <div style={{ width: 36, height: 20, background: skinColorHex, borderRadius: 4, border: '1px solid rgba(255,255,255,0.06)' }} />
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
              <div style={{ width: 36, height: 20, background: clothingColorHex, borderRadius: 4, border: '1px solid rgba(255,255,255,0.06)' }} />
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

      {/* 救済パネルは統合済み。色コントロールは右側パネルのスライダーで行います。 */}
    </div>
  );
}
