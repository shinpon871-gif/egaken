'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Physics, useBox, useSphere, useCylinder, useDistanceConstraint, type PublicApi } from '@react-three/cannon';
import * as THREE from 'three';
import { DoubleSide } from 'three';

const CHECKER_TEXTURE_SIZE = 256;

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
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color="#2563eb" metalness={0.2} roughness={0.5} />
    </mesh>
  );
}

function Hip({ isSitting, hipPositionRef }: { isSitting: boolean; hipPositionRef: HipPositionRef }) {
  const [ref, api] = useBox<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.85, 0.6, 0.78],
    position: [0, 4.5, 0],
  }));

  const currentHeight = useRef(4.5);
  const currentZ = useRef(0);

  useFrame(() => {
    const targetHeight = isSitting ? 3.2 : 4.5;
    const targetZ = isSitting ? 0.1 : 0;
    currentHeight.current += (targetHeight - currentHeight.current) * 0.08;
    currentZ.current += (targetZ - currentZ.current) * 0.08;

    api.position.set(0, currentHeight.current, currentZ.current);
    hipPositionRef.current = [0, currentHeight.current, currentZ.current];
  });

  // Keep physics body as a box for stability, but render two squashed spheres
  return (
    <group ref={ref} castShadow receiveShadow>
      <mesh position={[-0.2, -0.05, -0.05]} scale={[0.42, 0.32, 0.38]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="#f8b4d9" metalness={0.05} roughness={0.75} opacity={0.95} transparent />
      </mesh>
      <mesh position={[0.2, -0.05, -0.05]} scale={[0.42, 0.32, 0.38]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="#f8b4d9" metalness={0.05} roughness={0.75} opacity={0.95} transparent />
      </mesh>
    </group>
  );
}

function Thigh({ side, isSitting, hipPositionRef }: { side: 'left' | 'right'; isSitting: boolean; hipPositionRef: HipPositionRef }) {
  const offsetX = side === 'left' ? -0.35 : 0.35;
  // Pivot-aware thigh: rotate around hip joint so the thigh-root stays at the hip
  const jointOffsetY = -0.1; // local joint Y offset from hip
  const thighLength = 0.9;
  const halfLength = thighLength / 2; // distance from joint to mesh center
  const targetAngle = isSitting ? Math.PI * 0.5 : 0; // requested approx 90deg when sitting

  const [ref, api] = useCylinder<THREE.Object3D>(() => ({
    type: 'Kinematic',
    args: [0.22, 0.22, thighLength, 16],
    position: [offsetX, 3.65, 0],
  }));

  const currentAngle = useRef(0);

  useFrame(() => {
    const hipPos = hipPositionRef.current;
    // ease only the angle
    currentAngle.current += (targetAngle - currentAngle.current) * 0.08;
    const angle = currentAngle.current;

    // Compute mesh center so that the joint (thigh top) stays fixed at hip + joint offset
    const x = hipPos[0] + offsetX;
    const y = (hipPos[1] + jointOffsetY) - halfLength * Math.cos(angle);
    const z = hipPos[2] + halfLength * Math.sin(angle);

    api.rotation.set(angle, 0, 0);
    api.position.set(x, y, z);
  });

  // Render as elongated rugby-ball shaped mesh while keeping cylinder physics
  return (
    <mesh ref={ref} castShadow receiveShadow scale={[0.22, 0.45, 0.22]}>
      <sphereGeometry args={[1, 32, 32]} />
      <meshStandardMaterial color="#e2e8f0" metalness={0.05} roughness={0.75} />
    </mesh>
  );
}

function SeatAndThighs({ isSitting, hipPositionRef }: { isSitting: boolean; hipPositionRef: HipPositionRef }) {
  return (
    <>
      <StaticBox position={[0, 3.1, 0.2]} args={[1.4, 0.24, 1.2]} />
      <Hip isSitting={isSitting} hipPositionRef={hipPositionRef} />
      <Thigh side="left" isSitting={isSitting} hipPositionRef={hipPositionRef} />
      <Thigh side="right" isSitting={isSitting} hipPositionRef={hipPositionRef} />
    </>
  );
}

type ClothParticleProps = {
  position: [number, number, number];
  wireframe: boolean;
  index: number;
  onReady: ParticleCallback;
  isWaist: boolean;
  waistRadius: number;
  waistAngle: number;
  hipPositionRef: HipPositionRef;
};

function ClothParticle({
  position,
  wireframe,
  index,
  onReady,
  isWaist,
  waistRadius,
  waistAngle,
  hipPositionRef,
}: ClothParticleProps) {
  const [ref, api] = useSphere<THREE.Object3D>(() => ({
    type: isWaist ? 'Kinematic' : 'Dynamic',
    mass: isWaist ? 0 : 0.045,
    args: [0.06],
    position,
    linearDamping: 0.96,
    angularDamping: 0.95,
  }));

  useEffect(() => {
    const unsubscribe = api.position.subscribe((value) => {
      onReady(index, ref, api, [value[0], value[1], value[2]] as [number, number, number]);
    });
    onReady(index, ref, api, position);
    return unsubscribe;
  }, [index, onReady, position, ref, api]);

  useFrame(() => {
    if (isWaist) {
      const [hipX, hipY, hipZ] = hipPositionRef.current;
      const x = hipX + Math.cos(waistAngle) * waistRadius;
      const z = hipZ + Math.sin(waistAngle) * waistRadius;
      const y = hipY + 0.3;
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
  const topRadius = 0.64;
  const bottomRadius = 0.88;
  const skirtHeight = 1.35;
  const topY = 4.8;
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
      const unsubscribe = api.position.subscribe((value) => {
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
        }
      }
    }
    return pairs;
  }, [gridPoints, heightSegments, radialSegments]);

  return (
    <group>
      {gridPoints.map((point, index) => (
        <ClothParticle
          key={`particle-${index}`}
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
          <DistanceConstraint
            key={`constraint-${index}`}
            bodyA={bodyA}
            bodyB={bodyB}
            distance={distance}
          />
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
  const hipPositionRef = useRef<[number, number, number]>([0, 4.5, 0]);

  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [0, 4, 8], fov: 45 }} className="w-full h-full">
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 2]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
        <spotLight position={[-4, 6, 4]} intensity={0.6} penumbra={0.4} />
        <Physics gravity={[0, -9.8, 0]} iterations={12} broadphase="SAP">
          <BasePlane />
          <SeatAndThighs isSitting={isSitting} hipPositionRef={hipPositionRef} />
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
            className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            {isSitting ? '立つ' : '座る'}
          </button>
          <p className="mt-3 text-xs text-slate-200">
            座ると腰が沈み、お尻が椅子に乗り、太ももが前に突き出る着座ポーズを表現します。
          </p>
        </div>
      </div>
    </div>
  );
}
