'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useFBX } from '@react-three/drei';
import { Physics, useBox, useSphere, useDistanceConstraint, type PublicApi } from '@react-three/cannon';
import * as THREE from 'three';
import { DoubleSide } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const CHECKER_TEXTURE_SIZE = 256;
const COLLISION_GROUP_GROUND = 1;
const COLLISION_GROUP_CLOTH = 2;
const COLLISION_GROUP_HUMAN = 4;
const MODEL_SCALE = 0.01;
const SIT_AUTO_LIFT = 0.18;
const STAND_RECOVER_LIFT = 0.15;
const SIT_TIME_RATIO = 0.80;
const WAIST_Y_OFFSET_STAND = 0.02;
const WAIST_Y_OFFSET_SIT = -0.02;
const WAIST_FOLLOW_LERP = 0.22;
const WAIST_SLACK = 0.015;
const WAIST_MAX_RISE = 0.01;
const WAIST_MAX_DROP = 0.34;
const CLOTH_PARTICLE_RADIUS = 0.034;

type BodyRef = RefObject<THREE.Object3D>;
type BodyApi = PublicApi;
type HipPositionRef = { current: [number, number, number] };
type ParticleCallback = (index: number, ref: BodyRef, api: BodyApi, position: [number, number, number]) => void;
type SimulatorTuning = {
  waistAnchorLift: number;
  waistSlimness: number;
  hemYOffset: number;
};

type DistanceConstraintProps = {
  bodyA: BodyRef;
  bodyB: BodyRef;
  distance: number;
};

function DistanceConstraint({ bodyA, bodyB, distance }: DistanceConstraintProps) {
  useDistanceConstraint(bodyA, bodyB, { distance, maxForce: 2.4e3 });
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
  tuning,
  onStandRecoverComplete,
  onDebugInfo,
}: {
  isSitting: boolean;
  modelYOffset: number;
  modelBasePosition: [number, number, number];
  onPelvisPositionUpdate: (position: [number, number, number]) => void;
  tuning: SimulatorTuning;
  onStandRecoverComplete?: () => void;
  onDebugInfo?: (bones: string[], animations: string[]) => void;
}) {
  const fbxScene = useFBX('/models/Stand To Sit.fbx') as THREE.Group & { animations?: THREE.AnimationClip[] };
  const scene = useMemo(() => skeletonClone(fbxScene) as THREE.Group, [fbxScene]);
  const animations = useMemo(() => fbxScene.animations ?? [], [fbxScene]);
  const modelRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const animationRootRef = useRef<THREE.Object3D | null>(null);
  const standActionRef = useRef<THREE.AnimationAction | null>(null);
  const activeActionRef = useRef<THREE.AnimationAction | null>(null);
  const lastSittingStateRef = useRef<boolean | null>(null);
  const pelvisBoneRef = useRef<THREE.Object3D | null>(null);
  const leftThighBoneRef = useRef<THREE.Object3D | null>(null);
  const rightThighBoneRef = useRef<THREE.Object3D | null>(null);
  const sitLiftRef = useRef(0);

  const [pelvisColliderRef, pelvisColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.22, 0.20, 0.18],
    position: [0, 1.0, 0],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));

  const [leftThighColliderRef, leftThighColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.28, 0.56, 0.50],
    position: [-0.14, 0.65, 0.10],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [rightThighColliderRef, rightThighColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.28, 0.56, 0.50],
    position: [0.14, 0.65, 0.10],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  // ① 股間コライダーのZオフセットを0に修正
  const [crotchColliderRef, crotchColliderApi] = useSphere<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.10],
    position: [0, 0.82, 0.0],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [hipBackColliderRef, hipBackColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.32, 0.16, 0.46], // お尻〜太もも裏の支持面
    position: [0, 0.4, -0.2], // 椅子との接触位置
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));

  const [leftKneeColliderRef, leftKneeColliderApi] = useSphere<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.12],
    position: [-0.14, 0.42, 0.16],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [rightKneeColliderRef, rightKneeColliderApi] = useSphere<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.12],
    position: [0.14, 0.42, 0.16],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [lapFrontColliderRef, lapFrontColliderApi] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.58, 0.16, 0.50],
    position: [0, 0.55, 0.16],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_CLOTH,
  }));
  const [leftHandColliderRef, leftHandColliderApi] = useSphere<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.045],
    position: [-0.22, 1.05, 0.05],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_GROUND,
  }));
  const [rightHandColliderRef, rightHandColliderApi] = useSphere<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.045],
    position: [0.22, 1.05, 0.05],
    collisionFilterGroup: COLLISION_GROUP_HUMAN,
    collisionFilterMask: COLLISION_GROUP_GROUND,
  }));

  const leftKneeBoneRef = useRef<THREE.Object3D | null>(null);
  const rightKneeBoneRef = useRef<THREE.Object3D | null>(null);
  const leftHandBoneRef = useRef<THREE.Object3D | null>(null);
  const rightHandBoneRef = useRef<THREE.Object3D | null>(null);
  const standRecoverNotifiedRef = useRef(false);

  const isUsableClip = useCallback((clip?: THREE.AnimationClip) => {
    if (!clip) return false;
    return clip.tracks.length > 0 && clip.duration > 0;
  }, []);

  const standClip = useMemo(() => {
    const byName = animations.find((clip) => clip.name === 'mixamo.com' && isUsableClip(clip));
    if (byName) return byName;
    return animations.find((clip) => isUsableClip(clip));
  }, [animations, isUsableClip]);

  useEffect(() => {
    if (!scene) return;

    // Collect all bone names
    const bones: string[] = [];
    scene.traverse((obj: THREE.Object3D) => {
      if (obj !== scene && obj.name) {
        bones.push(obj.name);
      }
    });
    console.log('Bones found in model:', bones);

    // Collect all animation names
    const anims = animations.map((clip) => clip.name);
    console.log('Animations found:', anims);

    // Call debug callback
    if (onDebugInfo) {
      onDebugInfo(bones, anims);
    }

    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && mesh.skeleton?.bones?.length) {
        skinnedMeshes.push(mesh);
      }
    });

    const primarySkinnedMesh =
      skinnedMeshes.find((mesh) => /surface/i.test(mesh.name)) ??
      [...skinnedMeshes].sort((a, b) => (b.skeleton?.bones.length ?? 0) - (a.skeleton?.bones.length ?? 0))[0] ??
      null;

    const bonesByName = new Map<string, THREE.Bone>();
    (primarySkinnedMesh?.skeleton?.bones ?? []).forEach((bone) => {
      if (!bonesByName.has(bone.name)) {
        bonesByName.set(bone.name, bone);
      }
    });

    let skeletonRoot: THREE.Object3D | null = null;
    if (primarySkinnedMesh?.skeleton?.bones?.length) {
      const hipsCandidates = primarySkinnedMesh.skeleton.bones.filter((bone) => bone.name === 'mixamorigHips' || bone.name === 'Hips');
      skeletonRoot =
        hipsCandidates.sort((a, b) => b.children.length - a.children.length)[0] ??
        primarySkinnedMesh.skeleton.bones[0] ??
        primarySkinnedMesh;
    }

    const findBone = (names: string[]) => {
      for (const name of names) {
        const b = bonesByName.get(name);
        if (b) return b;
      }
      // fallback: search for bones that include any of the provided substrings
      const lowerNames = names.map((n) => n.toLowerCase());
      for (const [key, bone] of bonesByName.entries()) {
        const lk = key.toLowerCase();
        for (const substr of lowerNames) {
          if (lk.includes(substr)) return bone;
        }
      }
      return null;
    };

    animationRootRef.current = skeletonRoot ?? scene;
    pelvisBoneRef.current = findBone(['mixamorigHips', 'Hips', 'Pelvis', 'pelvis', 'hips']);
    leftThighBoneRef.current = findBone(['mixamorigLeftUpLeg', 'LeftUpLeg', 'left_up_leg', 'LeftLeg', 'thigh_l']);
    rightThighBoneRef.current = findBone(['mixamorigRightUpLeg', 'RightUpLeg', 'right_up_leg', 'RightLeg', 'thigh_r']);
    leftKneeBoneRef.current = findBone(['mixamorigLeftLeg', 'LeftLeg', 'left_leg', 'knee_l', 'knee']);
    rightKneeBoneRef.current = findBone(['mixamorigRightLeg', 'RightLeg', 'right_leg', 'knee_r', 'knee']);
    leftHandBoneRef.current = findBone(['mixamorigLeftHand', 'LeftHand', 'left_hand']);
    rightHandBoneRef.current = findBone(['mixamorigRightHand', 'RightHand', 'right_hand']);

    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;

    const standAction = standClip ? mixer.clipAction(standClip, animationRootRef.current ?? scene) : null;
    standActionRef.current = standAction;
    activeActionRef.current = null;

    if (standAction) {
      standAction.reset();
      standAction.enabled = true;
      standAction.setEffectiveWeight(1);
      standAction.setEffectiveTimeScale(1);
      standAction.setLoop(THREE.LoopOnce, 1);
      standAction.clampWhenFinished = true;
      standAction.paused = true;
      standAction.play();
      standAction.time = 0;
      activeActionRef.current = standAction;
      lastSittingStateRef.current = false;
    }

    return () => {
      standAction?.stop();
      mixer.stopAllAction();
      mixerRef.current = null;
      animationRootRef.current = null;
      standActionRef.current = null;
      activeActionRef.current = null;
      lastSittingStateRef.current = null;
    };
  }, [scene, animations, standClip, onDebugInfo]);

  useEffect(() => {
    const standAction = standActionRef.current;
    if (!standAction) return;
    const duration = standAction.getClip().duration;
    const wasSitting = lastSittingStateRef.current;

    if (wasSitting === isSitting) return;

    standAction.paused = false;
    standAction.enabled = true;
    if (isSitting) {
      if (standAction.time <= 0.01 || standAction.time >= duration - 0.01) {
        standAction.time = 0;
      }
      standAction.timeScale = 0.35;
    } else {
      if (standAction.time <= 0.01 || standAction.time >= duration - 0.01) {
        standAction.time = duration * SIT_TIME_RATIO;
      }
      standAction.timeScale = -0.35;
    }
    standAction.play();
    activeActionRef.current = standAction;
    lastSittingStateRef.current = isSitting;
    standRecoverNotifiedRef.current = false;
  }, [isSitting]);

  useFrame((_, delta) => {
    const targetSitLift = isSitting ? SIT_AUTO_LIFT : STAND_RECOVER_LIFT;
    sitLiftRef.current = THREE.MathUtils.lerp(sitLiftRef.current, targetSitLift, Math.min(1, delta * 3.5));

    if (modelRef.current) {
      modelRef.current.position.set(
        modelBasePosition[0],
        modelBasePosition[1] + modelYOffset + sitLiftRef.current,
        modelBasePosition[2]
      );
    }

    // Update world matrix first so bone transforms are always based on the latest animation/model transform.
    scene.updateMatrixWorld(true);

    const mixer = mixerRef.current;
    if (mixer) {
      mixer.update(delta);
      const action = standActionRef.current;
      if (action) {
        const duration = action.getClip().duration;
        const sitStop = duration * SIT_TIME_RATIO;
        if (action.timeScale > 0 && action.time >= sitStop - 0.002) {
          action.time = sitStop;
          action.timeScale = 0;
          action.paused = true;
        } else if (action.timeScale < 0 && action.time <= 0.002) {
          action.time = 0;
          action.timeScale = 0;
          action.paused = true;
          if (!standRecoverNotifiedRef.current) {
            standRecoverNotifiedRef.current = true;
            onStandRecoverComplete?.();
          }
        }
      }
    }

    scene.updateMatrixWorld(true);

    const updateBone = (bone: THREE.Object3D | null, api: PublicApi, localOffset?: THREE.Vector3) => {
      if (!bone) return;
      const position = new THREE.Vector3();
      bone.getWorldPosition(position);
      const quaternion = new THREE.Quaternion();
      bone.getWorldQuaternion(quaternion);

      if (localOffset) {
        const worldOffset = localOffset.clone().applyQuaternion(quaternion);
        position.add(worldOffset);
      }

      api.position.set(position.x, position.y, position.z);
      const euler = new THREE.Euler().setFromQuaternion(quaternion);
      api.rotation.set(euler.x, euler.y, euler.z);
    };

    updateBone(pelvisBoneRef.current, pelvisColliderApi);
    if (isSitting) {
      updateBone(leftThighBoneRef.current, leftThighColliderApi, new THREE.Vector3(0, 0.08, 0.16));
      updateBone(rightThighBoneRef.current, rightThighColliderApi, new THREE.Vector3(0, 0.08, 0.16));
    } else {
      updateBone(leftThighBoneRef.current, leftThighColliderApi);
      updateBone(rightThighBoneRef.current, rightThighColliderApi);
    }
    updateBone(pelvisBoneRef.current, crotchColliderApi, new THREE.Vector3(0.0, -0.28, 0.0));
    if (isSitting) {
      updateBone(pelvisBoneRef.current, hipBackColliderApi, new THREE.Vector3(0.0, -0.28, -0.14));
    } else {
      updateBone(pelvisBoneRef.current, hipBackColliderApi, new THREE.Vector3(0.0, -0.10, -0.05));
    }
    // Update knee colliders to follow actual knee bones if available, otherwise fall back to thigh+offset
    if (leftKneeBoneRef.current) {
      updateBone(leftKneeBoneRef.current, leftKneeColliderApi);
    } else if (isSitting) {
      updateBone(leftThighBoneRef.current, leftKneeColliderApi, new THREE.Vector3(0, -0.33, 0.12));
    }
    if (rightKneeBoneRef.current) {
      updateBone(rightKneeBoneRef.current, rightKneeColliderApi);
    } else if (isSitting) {
      updateBone(rightThighBoneRef.current, rightKneeColliderApi, new THREE.Vector3(0, -0.33, 0.12));
    }
    // Update hand colliders to follow hand bones if available
    if (leftHandBoneRef.current) {
      if (isSitting) {
        updateBone(leftHandBoneRef.current, leftHandColliderApi, new THREE.Vector3(-0.09, 0.05, 0.10));
      } else {
        updateBone(leftHandBoneRef.current, leftHandColliderApi, new THREE.Vector3(-0.14, 0.04, 0.06));
      }
    }
    if (rightHandBoneRef.current) {
      if (isSitting) {
        updateBone(rightHandBoneRef.current, rightHandColliderApi, new THREE.Vector3(0.09, 0.05, 0.10));
      } else {
        updateBone(rightHandBoneRef.current, rightHandColliderApi, new THREE.Vector3(0.14, 0.04, 0.06));
      }
    }

    const leftKneePos = new THREE.Vector3();
    const rightKneePos = new THREE.Vector3();
    if (leftKneeBoneRef.current) {
      leftKneeBoneRef.current.getWorldPosition(leftKneePos);
    } else if (leftThighBoneRef.current) {
      leftThighBoneRef.current.getWorldPosition(leftKneePos);
      leftKneePos.y -= 0.32;
      leftKneePos.z += 0.16;
    }
    if (rightKneeBoneRef.current) {
      rightKneeBoneRef.current.getWorldPosition(rightKneePos);
    } else if (rightThighBoneRef.current) {
      rightThighBoneRef.current.getWorldPosition(rightKneePos);
      rightKneePos.y -= 0.32;
      rightKneePos.z += 0.16;
    }

    // Add a front-lap blocker while sitting so the skirt front does not fall through thighs.
    if (isSitting) {
      const lapCenter = leftKneePos.clone().add(rightKneePos).multiplyScalar(0.5);
      lapCenter.y += 0.11;
      lapCenter.z += 0.14;
      lapFrontColliderApi.position.set(lapCenter.x, lapCenter.y, lapCenter.z);
      lapFrontColliderApi.rotation.set(-0.33, 0, 0);
    } else {
      lapFrontColliderApi.position.set(0, -5, 0);
      lapFrontColliderApi.rotation.set(0, 0, 0);
    }



    if (pelvisBoneRef.current) {
      const position = new THREE.Vector3();
      pelvisBoneRef.current.getWorldPosition(position);
      const waistAnchorLift = tuning.waistAnchorLift;
      onPelvisPositionUpdate([position.x, position.y + waistAnchorLift, position.z + (isSitting ? -0.005 : 0)]);
    } else if (leftThighBoneRef.current && rightThighBoneRef.current) {
      const leftThighPosition = new THREE.Vector3();
      const rightThighPosition = new THREE.Vector3();
      leftThighBoneRef.current.getWorldPosition(leftThighPosition);
      rightThighBoneRef.current.getWorldPosition(rightThighPosition);
      const anchor = leftThighPosition.clone().add(rightThighPosition).multiplyScalar(0.5);
      anchor.y += isSitting ? 0.07 : 0.13;
      anchor.z += isSitting ? -0.01 : 0.0;
      onPelvisPositionUpdate([anchor.x, anchor.y, anchor.z]);
    } else if (modelRef.current) {
      const fallback = new THREE.Vector3();
      modelRef.current.getWorldPosition(fallback);
      onPelvisPositionUpdate([fallback.x, fallback.y + 1.0, fallback.z + 0.05]);
    }
  }, -100);

  return (
    <group ref={modelRef} position={modelBasePosition}>
      <primitive object={scene} scale={[MODEL_SCALE, MODEL_SCALE, MODEL_SCALE]} />
      <mesh ref={pelvisColliderRef} visible={false}>
        <boxGeometry args={[0.22, 0.20, 0.18]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={leftThighColliderRef} visible={false}>
        <boxGeometry args={[0.28, 0.56, 0.50]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={rightThighColliderRef} visible={false}>
        <boxGeometry args={[0.28, 0.56, 0.50]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={crotchColliderRef} visible={false}>
        <sphereGeometry args={[0.10, 8, 8]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={hipBackColliderRef} visible={false}>
        <boxGeometry args={[0.32, 0.16, 0.46]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={leftKneeColliderRef} visible={false}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={rightKneeColliderRef} visible={false}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={lapFrontColliderRef} visible={false}>
        <boxGeometry args={[0.58, 0.16, 0.50]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={leftHandColliderRef} visible={false}>
        <sphereGeometry args={[0.045, 8, 8]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>
      <mesh ref={rightHandColliderRef} visible={false}>
        <sphereGeometry args={[0.045, 8, 8]} />
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
  isSitting,
  waistRadius,
  waistAngle,
  hipPositionRef,
}: {
  position: [number, number, number];
  wireframe: boolean;
  index: number;
  onReady: ParticleCallback;
  isWaist: boolean;
  isSitting: boolean;
  waistRadius: number;
  waistAngle: number;
  hipPositionRef: HipPositionRef;
}) {
  const [ref, api] = useSphere<THREE.Object3D>(() => ({
    type: isWaist ? 'Kinematic' : 'Dynamic',
    mass: isWaist ? 0 : 0.5,
    args: [CLOTH_PARTICLE_RADIUS],
    position,
    linearDamping: isWaist ? 0.92 : 0.9,
    angularDamping: isWaist ? 0.96 : 0.93,
    allowSleep: true,
    sleepSpeedLimit: 0.03,
    sleepTimeLimit: 1.0,
    collisionFilterGroup: COLLISION_GROUP_CLOTH,
    collisionFilterMask: COLLISION_GROUP_GROUND | COLLISION_GROUP_HUMAN,
  }));

  // keep latest physics position locally for smoothing
  const currentPosRef = useRef<[number, number, number] | null>(null);
  useEffect(() => {
    const unsub = api.position.subscribe((v: number[]) => {
      currentPosRef.current = [v[0], v[1], v[2]];
    });
    onReady(index, ref, api, position);
    return () => unsub();
  }, [index, onReady, position, ref, api]);

  useFrame(() => {
    if (isWaist) {
      const [hipX, hipY, hipZ] = hipPositionRef.current;
      const targetX = hipX + Math.cos(waistAngle) * waistRadius;
      const targetZ = hipZ + Math.sin(waistAngle) * waistRadius;
      let targetY = hipY + (isSitting ? WAIST_Y_OFFSET_SIT : WAIST_Y_OFFSET_STAND) - WAIST_SLACK;
      const maxY = hipY + WAIST_MAX_RISE;
      const minY = hipY - WAIST_MAX_DROP;
      if (targetY > maxY) targetY = maxY;
      if (targetY < minY) targetY = minY;

      const current = currentPosRef.current ?? position;
      const lerp = WAIST_FOLLOW_LERP;
      const newX = THREE.MathUtils.lerp(current[0], targetX, lerp);
      const newY = THREE.MathUtils.lerp(current[1], targetY, lerp);
      const newZ = THREE.MathUtils.lerp(current[2], targetZ, lerp);
      api.position.set(newX, newY, newZ);
    }
  });

  return (
    <mesh ref={ref} castShadow visible={wireframe} scale={wireframe ? [1, 1, 1] : [0.001, 0.001, 0.001]}>
      <sphereGeometry args={[0.015, 8, 8]} />
      <meshStandardMaterial color="#7dd3fc" metalness={0.1} roughness={0.5} wireframe={wireframe} />
    </mesh>
  );
}

function ClothGrid({
  wireframe,
  hipPositionRef,
  isSitting,
  tuning,
}: {
  wireframe: boolean;
  hipPositionRef: HipPositionRef;
  isSitting: boolean;
  tuning: SimulatorTuning;
}) {
  const radialSegments = 20;
  const heightSegments = 10;
  const baseTopRadius = 0.18;
  const bottomRadius = 0.30;
  const skirtHeight = 0.68;
  const waistRadius = THREE.MathUtils.clamp(baseTopRadius - tuning.waistSlimness * 0.6, 0.12, 0.22);
  const hipX = hipPositionRef.current[0];
  const hipY = hipPositionRef.current[1];
  const hipZ = hipPositionRef.current[2];
  const topY = hipY + (isSitting ? WAIST_Y_OFFSET_SIT : WAIST_Y_OFFSET_STAND);
  const angleStep = (Math.PI * 2) / radialSegments;

  const gridPoints = useMemo(
    () => {
      const startX = hipX;
      const startZ = hipZ;
      return Array.from({ length: radialSegments * heightSegments }, (_, index) => {
        const row = Math.floor(index / radialSegments);
        const col = index % radialSegments;
        const t = row / (heightSegments - 1);
        const radius = baseTopRadius + (bottomRadius - baseTopRadius) * t;
        const y = topY - t * skirtHeight;
        const angle = col * angleStep;
        return {
          position: [startX + Math.cos(angle) * radius, y, startZ + Math.sin(angle) * radius] as [number, number, number],
          row,
          angle,
          radius,
        };
      });
    },
    // Recompute when hip position or sitting state changes so the top row follows the pelvis correctly
    [angleStep, bottomRadius, heightSegments, radialSegments, baseTopRadius, topY, skirtHeight, hipX, hipZ]
  );

  const [particleRefsState, setParticleRefsState] = useState<BodyRef[]>([]);
  const particleApisRef = useRef<Array<BodyApi | undefined>>([]);
  const particlePositions = useRef<Array<[number, number, number]>>(gridPoints.map((point) => point.position));

  const registerParticle = useCallback(
    (index: number, ref: BodyRef, api: BodyApi, position: [number, number, number]) => {
      setParticleRefsState((current) => {
        if (current[index] === ref) {
          return current;
        }
        const next = [...current];
        next[index] = ref;
        return next;
      });
      particleApisRef.current[index] = api;
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
      const point = gridPoints[index];
      const api = particleApisRef.current[index];
      if (point && api && point.row > 0) {
        const rowRatio = point.row / (heightSegments - 1);

        // Waist slider: pull upper rows toward fitted silhouette without rebuilding constraints.
        if (tuning.waistSlimness > 0.0005 && rowRatio < 0.24) {
          const dx = value[0] - hipPositionRef.current[0];
          const dz = value[2] - hipPositionRef.current[2];
          const currentR = Math.hypot(dx, dz);
          if (currentR > 1e-5) {
            const baseR = THREE.MathUtils.lerp(baseTopRadius, bottomRadius, rowRatio);
            const targetR = Math.max(0.12, baseR - tuning.waistSlimness * (1 - rowRatio) * 0.52);
            const scale = THREE.MathUtils.clamp(targetR / currentR, 0.94, 1.01);
            const correctedX = hipPositionRef.current[0] + dx * scale;
            const correctedZ = hipPositionRef.current[2] + dz * scale;
            api.position.set(correctedX, value[1], correctedZ);
            value = [correctedX, value[1], correctedZ];
            particlePositions.current[index] = value;
          }
        }

        if (Math.abs(tuning.hemYOffset) > 0.001) {
          // Hem slider: converge to target height (non-accumulating) to avoid runaway/bucket shape.
          const targetHemY =
            hipPositionRef.current[1] +
            (isSitting ? WAIST_Y_OFFSET_SIT : WAIST_Y_OFFSET_STAND) -
            WAIST_SLACK -
            rowRatio * skirtHeight +
            rowRatio * tuning.hemYOffset * 0.55;
          const yError = targetHemY - value[1];
          if (Math.abs(yError) > 0.008) {
            const correctedY = value[1] + THREE.MathUtils.clamp(yError * 0.07, -0.005, 0.005);
            api.position.set(value[0], correctedY, value[2]);
            value = [value[0], correctedY, value[2]];
            particlePositions.current[index] = value;
          }
        }
      }

      if (isSitting) {
        if (point && api && point.row > Math.floor(heightSegments * 0.55)) {
          const rowRatio = point.row / (heightSegments - 1);
          const backFactor = Math.max(0, -Math.sin(point.angle));
          if (backFactor > 0.2) {
            const targetBackY = hipPositionRef.current[1] - 0.27 - rowRatio * 0.38;
            const backError = value[1] - targetBackY;
            if (backError > 0.003) {
              const correctedY = value[1] - Math.min(0.015, backError * 0.2);
              api.position.set(value[0], correctedY, value[2]);
              api.velocity.set(0, -0.18, 0);
              value = [value[0], correctedY, value[2]];
              particlePositions.current[index] = value;
            }
          }
        }
      }
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
          pairs.push({
            a: index,
            b: nextRow,
            distance: Math.hypot(
              gridPoints[index].position[0] - gridPoints[nextRow].position[0],
              gridPoints[index].position[1] - gridPoints[nextRow].position[1],
              gridPoints[index].position[2] - gridPoints[nextRow].position[2]
            ),
          });
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
          isSitting={isSitting}
          waistRadius={waistRadius}
          waistAngle={point.angle}
          hipPositionRef={hipPositionRef}
        />
      ))}

      {constraintPairs.map(({ a, b, distance }, index) => {
        const bodyA = particleRefsState[a];
        const bodyB = particleRefsState[b];
        return bodyA && bodyB ? <DistanceConstraint key={'constraint-' + index} bodyA={bodyA} bodyB={bodyB} distance={distance} /> : null;
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
  const [waistAnchorLift, setWaistAnchorLift] = useState(0.02);
  const [waistSlimness, setWaistSlimness] = useState(0.0);
  const [hemYOffset, setHemYOffset] = useState(0.0);
  const [sliderLocked, setSliderLocked] = useState(false);
  const modelBasePosition: [number, number, number] = [0, 0, -0.55];
  const hipPositionRef = useRef<[number, number, number]>([0, 1.0, -0.55]);
  const tuning = useMemo<SimulatorTuning>(
    () => ({
      waistAnchorLift,
      waistSlimness,
      hemYOffset,
    }),
    [waistAnchorLift, waistSlimness, hemYOffset]
  );
  const handleDebugInfo = useCallback((bones: string[], animations: string[]) => {
    setDebugInfo({ bones, animations });
  }, []);

  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [0, 1.9, 5.4], fov: 40 }} className="w-full h-full">
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 2]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
        <spotLight position={[-4, 6, 4]} intensity={0.6} penumbra={0.4} />
        <Physics
          gravity={[0, -9.8, 0]}
          iterations={72}
          broadphase="SAP"
          allowSleep
          defaultContactMaterial={{ friction: 0.95, restitution: 0 }}
        >
          <BasePlane />
          <StaticBox position={[0, 0.55, -1.45]} args={[1.0, 0.12, 1.0]} />
          <HumanModel
            isSitting={isSitting}
            modelYOffset={modelYOffset}
            modelBasePosition={modelBasePosition}
            tuning={tuning}
            onStandRecoverComplete={() => {
              setSliderLocked(false);
            }}
            onPelvisPositionUpdate={(position) => {
              hipPositionRef.current = position;
            }}
            onDebugInfo={handleDebugInfo}
          />
          <ClothGrid wireframe={wireframe} hipPositionRef={hipPositionRef} isSitting={isSitting} tuning={tuning} />
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
            onClick={() => {
              setIsSitting((value) => {
                const next = !value;
                if (next) {
                  setSliderLocked(true);
                }
                return next;
              });
            }}
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

          <div className="mb-1 border-t border-slate-600 pt-3 text-slate-200">
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