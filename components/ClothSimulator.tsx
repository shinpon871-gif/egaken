'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, useAnimations } from '@react-three/drei';
import { Physics, useBox, useSphere, useDistanceConstraint, type PublicApi } from '@react-three/cannon';
import * as THREE from 'three';
import { DoubleSide } from 'three';

const CHECKER_TEXTURE_SIZE = 256;
const COLLISION_GROUP_GROUND = 1;
const COLLISION_GROUP_CLOTH = 2;
const COLLISION_GROUP_HUMAN = 4;
const MODEL_SCALE = 0.01;

type BodyRef = RefObject<THREE.Object3D>;
type BodyApi = PublicApi;
type HipPositionRef = { current: [number, number, number] };
type ParticleCallback = (index: number, ref: BodyRef, api: BodyApi, position: [number, number, number]) => void;

type DistanceConstraintProps = {
  bodyA: BodyRef;
  bodyB: BodyRef;
  distance: number;
};

function DistanceConstraint({ bodyA, bodyB, distance }: DistanceConstraintProps) {
  useDistanceConstraint(bodyA, bodyB, { distance });
  return null;
}

function createCheckerTexture(colorA = '#caf0f8', colorB = '#9be7ff') {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_TEXTURE_SIZE;
  canvas.height = CHECKER_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return null;
  }

  const squareSize = CHECKER_TEXTURE_SIZE / 8;
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, CHECKER_TEXTURE_SIZE, CHECKER_TEXTURE_SIZE);

  ctx.fillStyle = colorB;
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if ((row + col) % 2 === 0) {
        ctx.fillRect(col * squareSize, row * squareSize, squareSize, squareSize);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.anisotropy = 16;
  return texture;
}

function BasePlane() {
  const [ref] = useBox(() => ({
    type: 'Static',
    args: [20, 0.5, 20],
    position: [0, -0.25, 0],
    collisionFilterGroup: COLLISION_GROUP_GROUND,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));

  return (
    <mesh ref={ref} receiveShadow>
      <boxGeometry args={[20, 0.5, 20]} />
      <meshStandardMaterial color="#111827" metalness={0.2} roughness={0.9} />
    </mesh>
  );
}

function StaticBox({ position, args }: { position: [number, number, number]; args: [number, number, number] }) {
  const [ref] = useBox(() => ({
    type: 'Static',
    args,
    position,
    collisionFilterGroup: COLLISION_GROUP_GROUND,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color="#2563eb" metalness={0.2} roughness={0.5} />
    </mesh>
  );
}

function HumanModel({
  isSitting,
  modelYOffset,
  modelBasePosition,
  onPelvisPositionUpdate,
  onDebugInfo,
}: {
  isSitting: boolean;
  modelYOffset: number;
  modelBasePosition: [number, number, number];
  onPelvisPositionUpdate: (position: [number, number, number]) => void;
  onDebugInfo?: (bones: string[], animations: string[]) => void;
}) {
  const gltf = useGLTF('/models/human.glb');
  const { scene, animations } = gltf as unknown as { scene: THREE.Group; animations: THREE.AnimationClip[] };
  const modelRef = useRef<THREE.Group>(null);
  const { actions, mixer } = useAnimations(animations, modelRef) as unknown as {
    actions: Record<string, THREE.AnimationAction | undefined>;
    mixer: THREE.AnimationMixer;
  };
  const activeActionRef = useRef<THREE.AnimationAction | null>(null);
  const pelvisBoneRef = useRef<THREE.Object3D | null>(null);
  const leftThighBoneRef = useRef<THREE.Object3D | null>(null);
  const rightThighBoneRef = useRef<THREE.Object3D | null>(null);

  const [pelvisColliderRef, pelvisColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.22, 0.18, 0.2],
    position: [0, 1.0, 0],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [leftThighColliderRef, leftThighColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.12, 0.35, 0.12],
    position: [-0.14, 0.65, 0.05],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [rightThighColliderRef, rightThighColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.12, 0.35, 0.12],
    position: [0.14, 0.65, 0.05],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));

  const isUsableAction = useCallback((action?: THREE.AnimationAction) => {
    if (!action) return false;
    return action.getClip().tracks.length > 0;
  }, []);

  const standAction = useMemo(() => {
    if (!actions || typeof actions !== 'object') return undefined;
    const a = actions as Record<string, THREE.AnimationAction | undefined>;
    const candidates = [a['mixamo.com'], a['Stand'], a['stand'], a['Idle'], a['idle'], a['Take 001']];
    const named = candidates.find((action) => isUsableAction(action));
    if (named) return named;
    return Object.values(a).find((action) => isUsableAction(action));
  }, [actions, isUsableAction]);

  const sitAction = useMemo(() => {
    if (!actions || typeof actions !== 'object') return undefined;
    const a = actions as Record<string, THREE.AnimationAction | undefined>;
    const candidates = [a['Take 001'], a['Sit'], a['sit'], a['SitDown'], a['sit_down']];
    const named = candidates.find((action) => isUsableAction(action));
    if (named) return named;

    return Object.values(a).find((action) => isUsableAction(action) && action !== standAction);
  }, [actions, standAction, isUsableAction]);

  useEffect(() => {
    if (!actions || !scene) return;

    // Collect all bone names
    const bones: string[] = [];
    scene.traverse((obj: THREE.Object3D) => {
      if (obj !== scene && obj.name) {
        bones.push(obj.name);
      }
    });
    console.log('Bones found in model:', bones);

    // Collect all animation names
    const anims = Object.keys(actions);
    console.log('Animations found:', anims);

    // Call debug callback
    if (onDebugInfo) {
      onDebugInfo(bones, anims);
    }

    const findBone = (names: string[]) => {
      for (const name of names) {
        const bone = scene.getObjectByName(name);
        if (bone) return bone;
      }
      return null;
    };

    pelvisBoneRef.current = findBone(['Pelvis', 'pelvis', 'Hips', 'hips', 'mixamorigHips', 'mixamorigHips_1']);
    leftThighBoneRef.current = findBone(['LeftUpLeg', 'left_up_leg', 'LeftLeg', 'thigh_l', 'mixamorigLeftUpLeg', 'mixamorigLeftUpLeg_1']);
    rightThighBoneRef.current = findBone(['RightUpLeg', 'right_up_leg', 'RightLeg', 'thigh_r', 'mixamorigRightUpLeg', 'mixamorigRightUpLeg_1']);

    Object.values(actions).forEach((action) => {
      if (!action) return;
      action.stop();
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.setEffectiveTimeScale(1);
      action.loop = THREE.LoopRepeat;
    });

    if (standAction) {
      standAction.reset().setEffectiveWeight(1).fadeIn(0.2).play();
      if (!sitAction) {
        const duration = standAction.getClip().duration;
        standAction.setLoop(THREE.LoopOnce, 1);
        standAction.setEffectiveTimeScale(0);
        mixer.setTime(isSitting ? duration : 0);
      } else {
        standAction.setLoop(THREE.LoopRepeat, Infinity);
        standAction.setEffectiveTimeScale(1);
      }
      activeActionRef.current = standAction;
    }

    return () => {
      Object.values(actions).forEach((action) => {
        action?.stop();
      });
    };
  }, [actions, scene, standAction, sitAction, isSitting, mixer, onDebugInfo]);

  useEffect(() => {
    if (!standAction && !sitAction) return;

    // Fallback mode: only one usable clip exists (Take 001 is empty), so use forward/reverse playback.
    if (!sitAction && standAction) {
      const duration = standAction.getClip().duration;
      standAction.stop();
      standAction.reset().setEffectiveWeight(1).fadeIn(0.15);
      standAction.setLoop(THREE.LoopOnce, 1);

      if (isSitting) {
        mixer.setTime(0);
        standAction.setEffectiveTimeScale(1).play();
      } else {
        mixer.setTime(duration);
        standAction.setEffectiveTimeScale(-1).play();
      }

      activeActionRef.current = standAction;
      return;
    }

    const target = isSitting ? sitAction : standAction;
    const previous = activeActionRef.current;

    if (!target) {
      if (previous) {
        previous.fadeOut(0.2);
        previous.setEffectiveWeight(0);
      }
      activeActionRef.current = null;
      return;
    }

    if (target && previous !== target) {
      if (previous) {
        previous.fadeOut(0.2);
        previous.setEffectiveWeight(0);
      }

      if (target === sitAction) {
        target.setLoop(THREE.LoopOnce, 1);
      } else {
        target.setLoop(THREE.LoopRepeat, Infinity);
      }

      target.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
      activeActionRef.current = target;
      return;
    }

    if (previous && previous === target) {
      target.setEffectiveWeight(1);
      target.play();
    }
  }, [isSitting, sitAction, standAction, mixer]);

  useFrame(() => {
    if (modelRef.current) {
      modelRef.current.position.set(
        modelBasePosition[0],
        modelBasePosition[1] + modelYOffset,
        modelBasePosition[2]
      );
    }

    scene.updateMatrixWorld(true);

    const updateBone = (bone: THREE.Object3D | null, api: PublicApi) => {
      if (!bone) return;
      const position = new THREE.Vector3();
      bone.getWorldPosition(position);
      api.position.set(position.x, position.y, position.z);
      const quaternion = new THREE.Quaternion();
      bone.getWorldQuaternion(quaternion);
      const euler = new THREE.Euler().setFromQuaternion(quaternion);
      api.rotation.set(euler.x, euler.y, euler.z);
    };

    updateBone(pelvisBoneRef.current, pelvisColliderApi);
    updateBone(leftThighBoneRef.current, leftThighColliderApi);
    updateBone(rightThighBoneRef.current, rightThighColliderApi);

    if (pelvisBoneRef.current) {
      const position = new THREE.Vector3();
      pelvisBoneRef.current.getWorldPosition(position);
      onPelvisPositionUpdate([position.x, position.y, position.z]);
    } else if (modelRef.current) {
      const fallback = new THREE.Vector3();
      modelRef.current.getWorldPosition(fallback);
      onPelvisPositionUpdate([fallback.x, fallback.y + 1.0, fallback.z + 0.05]);
    }
  });

  return (
    <group ref={modelRef} position={modelBasePosition}>
      <primitive object={scene} scale={[MODEL_SCALE, MODEL_SCALE, MODEL_SCALE]} />
      <mesh ref={pelvisColliderRef} visible={false}>
        <boxGeometry args={[0.22, 0.18, 0.2]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={leftThighColliderRef} visible={false}>
        <boxGeometry args={[0.12, 0.35, 0.12]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={rightThighColliderRef} visible={false}>
        <boxGeometry args={[0.12, 0.35, 0.12]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
    </group>
  );
}

function ClothParticle({
  position,
  wireframe,
  index,
  onReady,
  isWaist,
  waistRadius,
  waistAngle,
  hipPositionRef,
}: {
  position: [number, number, number];
  wireframe: boolean;
  index: number;
  onReady: ParticleCallback;
  isWaist: boolean;
  waistRadius: number;
  waistAngle: number;
  hipPositionRef: HipPositionRef;
}) {
  const [ref, api] = useSphere<THREE.Object3D>(() => ({
    type: isWaist ? 'Kinematic' : 'Dynamic',
    mass: isWaist ? 0 : 0.045,
    args: [0.06],
    position,
    linearDamping: 0.96,
    angularDamping: 0.95,
    collisionFilterGroup: COLLISION_GROUP_CLOTH,
    collisionFilterMask: COLLISION_GROUP_GROUND | COLLISION_GROUP_HUMAN,
  }));

  useEffect(() => {
    const unsubscribe = api.position.subscribe((value: number[]) => {
      onReady(index, ref, api, [value[0], value[1], value[2]] as [number, number, number]);
    });
    onReady(index, ref, api, position);
    return unsubscribe;
  }, [index, onReady, position, ref, api]);

  const lastPosRef = useRef<[number, number, number] | null>(null);
  useFrame(() => {
    if (isWaist) {
      const [hipX, hipY, hipZ] = hipPositionRef.current;
      const targetX = hipX + Math.cos(waistAngle) * waistRadius;
      const targetZ = hipZ + Math.sin(waistAngle) * waistRadius;
      const targetY = hipY + 0.06;

      const prev = lastPosRef.current || [targetX, targetY, targetZ];
      const lerp = 0.6;
      const x = prev[0] + (targetX - prev[0]) * lerp;
      const y = prev[1] + (targetY - prev[1]) * lerp;
      const z = prev[2] + (targetZ - prev[2]) * lerp;
      lastPosRef.current = [x, y, z];

      api.position.set(x, y, z);
    }
  });

  return (
    <mesh ref={ref} castShadow visible={wireframe} scale={wireframe ? [1, 1, 1] : [0.001, 0.001, 0.001]}>
      <sphereGeometry args={[0.015, 8, 8]} />
      <meshStandardMaterial color="#7dd3fc" metalness={0.1} roughness={0.5} wireframe={wireframe} />
    </mesh>
  );
}

function ClothGrid({ wireframe, hipPositionRef }: { wireframe: boolean; hipPositionRef: HipPositionRef }) {
  const radialSegments = 16;
  const heightSegments = 8;
  const topRadius = 0.18;
  const bottomRadius = 0.38;
  const skirtHeight = 0.74;
  const topY = 1.06;
  const angleStep = (Math.PI * 2) / radialSegments;

  const gridPoints = useMemo(
    () =>
      Array.from({ length: radialSegments * heightSegments }, (_, index) => {
        const row = Math.floor(index / radialSegments);
        const col = index % radialSegments;
        const t = row / (heightSegments - 1);
        const radius = topRadius + (bottomRadius - topRadius) * t;
        const y = topY - t * skirtHeight;
        const angle = col * angleStep;
        return {
          position: [Math.cos(angle) * radius, y, Math.sin(angle) * radius] as [number, number, number],
          row,
          angle,
          radius,
        };
      }),
    [angleStep, bottomRadius, heightSegments, radialSegments, topRadius, topY, skirtHeight]
  );

  const [particleRefsState, setParticleRefsState] = useState<BodyRef[]>([]);
  const particlePositions = useRef<Array<[number, number, number]>>(gridPoints.map((point) => point.position));

  const registerParticle = useCallback(
    (index: number, ref: BodyRef, api: BodyApi, position: [number, number, number]) => {
      setParticleRefsState((current) => {
        const next = [...current];
        next[index] = ref;
        return next;
      });
      particlePositions.current[index] = position;
      const unsubscribe = api.position.subscribe((value: number[]) => {
        particlePositions.current[index] = [value[0], value[1], value[2]] as [number, number, number];
      });
      return unsubscribe;
    },
    []
  );

  const checkerTexture = useMemo(() => createCheckerTexture(), []);
  const clothGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(radialSegments * heightSegments * 3);
    const indices: number[] = [];

    gridPoints.forEach((point, index) => {
      positions[index * 3] = point.position[0];
      positions[index * 3 + 1] = point.position[1];
      positions[index * 3 + 2] = point.position[2];
    });

    for (let row = 0; row < heightSegments - 1; row += 1) {
      for (let col = 0; col < radialSegments; col += 1) {
        const current = row * radialSegments + col;
        const nextCol = row * radialSegments + ((col + 1) % radialSegments);
        const nextRow = (row + 1) * radialSegments + col;
        const nextRowCol = (row + 1) * radialSegments + ((col + 1) % radialSegments);

        indices.push(current, nextRow, nextCol);
        indices.push(nextCol, nextRow, nextRowCol);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [gridPoints, heightSegments, radialSegments]);

  useFrame(() => {
    const position = clothGeometry.attributes.position as THREE.BufferAttribute;
    particlePositions.current.forEach((value, index) => {
      position.setXYZ(index, value[0], value[1], value[2]);
    });
    // eslint-disable-next-line react-hooks/immutability
    position.needsUpdate = true;
    clothGeometry.computeVertexNormals();
  });

  const constraintPairs = useMemo(() => {
    const pairs: Array<{ a: number; b: number; distance: number }> = [];
    for (let row = 0; row < heightSegments; row += 1) {
      for (let col = 0; col < radialSegments; col += 1) {
        const index = row * radialSegments + col;
        const nextCol = row * radialSegments + ((col + 1) % radialSegments);
        pairs.push({
          a: index,
          b: nextCol,
          distance: Math.hypot(
            gridPoints[index].position[0] - gridPoints[nextCol].position[0],
            gridPoints[index].position[1] - gridPoints[nextCol].position[1],
            gridPoints[index].position[2] - gridPoints[nextCol].position[2]
          ),
        });

        if (row < heightSegments - 1) {
          const nextRow = (row + 1) * radialSegments + col;
          const nextRowCol = (row + 1) * radialSegments + ((col + 1) % radialSegments);
          pairs.push({
            a: index,
            b: nextRow,
            distance: Math.hypot(
              gridPoints[index].position[0] - gridPoints[nextRow].position[0],
              gridPoints[index].position[1] - gridPoints[nextRow].position[1],
              gridPoints[index].position[2] - gridPoints[nextRow].position[2]
            ),
          });
          pairs.push({
            a: index,
            b: nextRowCol,
            distance: Math.hypot(
              gridPoints[index].position[0] - gridPoints[nextRowCol].position[0],
              gridPoints[index].position[1] - gridPoints[nextRowCol].position[1],
              gridPoints[index].position[2] - gridPoints[nextRowCol].position[2]
            ),
          });
          const nextRowPrev = (row + 1) * radialSegments + ((col - 1 + radialSegments) % radialSegments);
          pairs.push({
            a: index,
            b: nextRowPrev,
            distance: Math.hypot(
              gridPoints[index].position[0] - gridPoints[nextRowPrev].position[0],
              gridPoints[index].position[1] - gridPoints[nextRowPrev].position[1],
              gridPoints[index].position[2] - gridPoints[nextRowPrev].position[2]
            ),
          });

          const nextCol2 = row * radialSegments + ((col + 2) % radialSegments);
          pairs.push({
            a: index,
            b: nextCol2,
            distance: Math.hypot(
              gridPoints[index].position[0] - gridPoints[nextCol2].position[0],
              gridPoints[index].position[1] - gridPoints[nextCol2].position[1],
              gridPoints[index].position[2] - gridPoints[nextCol2].position[2]
            ),
          });
          if (row < heightSegments - 2) {
            const nextRow2 = (row + 2) * radialSegments + col;
            pairs.push({
              a: index,
              b: nextRow2,
              distance: Math.hypot(
                gridPoints[index].position[0] - gridPoints[nextRow2].position[0],
                gridPoints[index].position[1] - gridPoints[nextRow2].position[1],
                gridPoints[index].position[2] - gridPoints[nextRow2].position[2]
              ),
            });
          }
        }
      }
    }
    return pairs;
  }, [gridPoints, heightSegments, radialSegments]);

  return (
    <group>
      {gridPoints.map((point, index) => (
        <ClothParticle
          key={'particle-' + index}
          index={index}
          position={point.position}
          wireframe={wireframe}
          onReady={registerParticle}
          isWaist={point.row === 0}
          waistRadius={topRadius}
          waistAngle={point.angle}
          hipPositionRef={hipPositionRef}
        />
      ))}

      {constraintPairs.map(({ a, b, distance }, index) => {
        const bodyA = particleRefsState[a];
        const bodyB = particleRefsState[b];
        return bodyA && bodyB ? (
          <DistanceConstraint key={'constraint-' + index} bodyA={bodyA} bodyB={bodyB} distance={distance} />
        ) : null;
      })}

      <mesh geometry={clothGeometry} castShadow receiveShadow>
        <meshStandardMaterial
          map={checkerTexture || undefined}
          color="#7dd3fc"
          side={DoubleSide}
          wireframe={wireframe}
          flatShading
          metalness={0.15}
          roughness={0.55}
        />
      </mesh>
    </group>
  );
}

export default function ClothSimulator() {
  const [wireframe, setWireframe] = useState(false);
  const [isSitting, setIsSitting] = useState(false);
  const [modelYOffset, setModelYOffset] = useState(0.0);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{ bones: string[]; animations: string[] }>({ bones: [], animations: [] });
  const modelBasePosition: [number, number, number] = [0, 0, -0.55];
  const hipPositionRef = useRef<[number, number, number]>([0, 1.0, -0.55]);

  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [0, 1.9, 5.4], fov: 40 }} className="w-full h-full">
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 2]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
        <spotLight position={[-4, 6, 4]} intensity={0.6} penumbra={0.4} />
        <Physics gravity={[0, -9.8, 0]} iterations={12} broadphase="SAP">
          <BasePlane />
          <StaticBox position={[0, 0.55, -1.45]} args={[1.0, 0.12, 1.0]} />
          <HumanModel
            isSitting={isSitting}
            modelYOffset={modelYOffset}
            modelBasePosition={modelBasePosition}
            onPelvisPositionUpdate={(position) => {
              hipPositionRef.current = position;
            }}
            onDebugInfo={(bones, animations) => {
              setDebugInfo({ bones, animations });
            }}
          />
          <ClothGrid wireframe={wireframe} hipPositionRef={hipPositionRef} />
        </Physics>
        <OrbitControls makeDefault enablePan enableZoom enableRotate />
      </Canvas>

      <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-4">
        <div className="pointer-events-auto rounded-2xl border border-slate-300/20 bg-slate-900/80 p-3 shadow-2xl backdrop-blur">
          <button
            type="button"
            onClick={() => setWireframe((value) => !value)}
            className="mb-2 w-full rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
          >
            {wireframe ? '通常表示に切り替え' : 'ワイヤーフレーム表示'}
          </button>
          <button
            type="button"
            onClick={() => setIsSitting((value) => !value)}
            className="mb-3 w-full rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            {isSitting ? '立つ' : '座る'}
          </button>
          <button
            type="button"
            onClick={() => setShowDebugPanel((value) => !value)}
            className="mb-3 w-full rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            {showDebugPanel ? 'デバッグ非表示' : '骨名/アニメーション確認'}
          </button>
          <p className="mt-1 text-xs text-slate-200">
            GLBモデルのスタンド/シットアニメーションを再生し、モデルYオフセットで座面接地を調整できます。
          </p>
        </div>
      </div>

      {showDebugPanel && (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-start p-4">
          <div className="pointer-events-auto rounded-2xl border border-slate-300/20 bg-slate-900/80 p-4 shadow-2xl backdrop-blur max-h-96 overflow-y-auto max-w-96">
            <h3 className="mb-3 font-bold text-yellow-300">🔍 モデル構造情報</h3>
            
            <div className="mb-3">
              <h4 className="mb-2 text-sm font-semibold text-sky-300">ボーン名 (Bones):</h4>
              <div className="space-y-1">
                {debugInfo.bones.length > 0 ? (
                  debugInfo.bones.map((bone) => (
                    <div key={bone} className="font-mono text-xs text-slate-300 break-all">
                      • {bone}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400">モデルロード中...</p>
                )}
              </div>
            </div>

            <div className="mb-3 border-t border-slate-600 pt-3">
              <h4 className="mb-2 text-sm font-semibold text-emerald-300">アニメーション (Animations):</h4>
              <div className="space-y-1">
                {debugInfo.animations.length > 0 ? (
                  debugInfo.animations.map((anim) => (
                    <div key={anim} className="font-mono text-xs text-slate-300 break-all">
                      • {anim}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400">アニメーションなし</p>
                )}
              </div>
            </div>

            <div className="mb-3 border-t border-slate-600 pt-3">
              <h4 className="mb-2 text-sm font-semibold text-amber-300">Y軸デバッグ調整:</h4>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value={modelYOffset}
                onChange={(event) => setModelYOffset(Number(event.target.value))}
                className="w-full"
              />
              <div className="mt-2 text-xs text-slate-200">Y Offset: {modelYOffset.toFixed(2)}</div>
            </div>

            <p className="mt-3 text-xs text-slate-400">
              💡 通常運用ではY調整は不要です。必要時のみデバッグで使ってください。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}