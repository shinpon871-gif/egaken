'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Physics, useBox, useSphere, useDistanceConstraint, type PublicApi } from '@react-three/cannon';
import * as THREE from 'three';
import { DoubleSide } from 'three';

const CHECKER_TEXTURE_SIZE = 256;

type BodyRef = RefObject<THREE.Object3D>;
type BodyApi = PublicApi;

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

function StaticSphere({ position }: { position: [number, number, number] }) {
  const [ref] = useSphere(() => ({
    type: 'Static',
    args: [1.2],
    position,
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow>
      <sphereGeometry args={[1.2, 32, 32]} />
      <meshStandardMaterial color="#3b82f6" metalness={0.2} roughness={0.4} />
    </mesh>
  );
}

function StaticBox({ position }: { position: [number, number, number] }) {
  const [ref] = useBox(() => ({
    type: 'Static',
    args: [3.2, 0.8, 2.8],
    position,
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow>
      <boxGeometry args={[3.2, 0.8, 2.8]} />
      <meshStandardMaterial color="#2563eb" metalness={0.2} roughness={0.5} />
    </mesh>
  );
}

type ConstraintProps = {
  bodyA: BodyRef;
  bodyB: BodyRef;
  distance: number;
};

function DistanceConstraint({ bodyA, bodyB, distance }: ConstraintProps) {
  useDistanceConstraint(bodyA, bodyB, {
    distance,
    maxForce: 1e4,
  });
  return null;
}

function ClothParticle({
  position,
  wireframe,
  index,
  onReady,
}: {
  position: [number, number, number];
  wireframe: boolean;
  index: number;
  onReady: (index: number, ref: BodyRef, api: BodyApi) => void;
}) {
  const [ref, api] = useSphere<THREE.Object3D>(() => ({
    type: 'Dynamic',
    mass: 0.08,
    args: [0.08],
    position,
    linearDamping: 0.9,
    angularDamping: 0.9,
  }));

  useEffect(() => {
    onReady(index, ref, api);
  }, [index, onReady, ref, api]);

  return (
    <mesh ref={ref} castShadow>
      <sphereGeometry args={[0.08, 10, 10]} />
      <meshStandardMaterial color="#7dd3fc" metalness={0.1} roughness={0.5} wireframe={wireframe} />
    </mesh>
  );
}

function ClothGrid({ wireframe }: { wireframe: boolean }) {
  const rows = 12;
  const cols = 12;
  const width = 3.0;
  const height = 3.0;
  const gapX = width / (cols - 1);
  const gapZ = height / (rows - 1);
  const startX = -width / 2;
  const startZ = -height / 2;
  const startY = 4.5;

  const startPositions = useMemo(
    () =>
      Array.from({ length: rows * cols }, (_, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        return [startX + col * gapX, startY - row * 0.12, startZ + row * gapZ] as [number, number, number];
      }),
    [cols, rows, gapX, gapZ, startX, startY, startZ]
  );

  const [particleRefsState, setParticleRefsState] = useState<BodyRef[]>([]);
  const particleApis = useRef<BodyApi[]>([]);
  const particlePositions = useRef<Array<[number, number, number]>>(Array.from({ length: rows * cols }, () => [0, 0, 0] as [number, number, number]));
  const meshRef = useRef<THREE.Mesh | null>(null);

  const registerParticle = useCallback((index: number, ref: BodyRef, api: BodyApi) => {
    setParticleRefsState((current) => {
      const next = [...current];
      next[index] = ref;
      return next;
    });
    particleApis.current[index] = api;
    particlePositions.current[index] = [0, 0, 0];

    api.position.subscribe((value) => {
      particlePositions.current[index] = [value[0], value[1], value[2]];
    });
  }, []);

  const checkerTexture = useMemo(() => createCheckerTexture(), []);
  const clothGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(rows * cols * 3);
    const indices: number[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const x = startX + col * gapX;
        const y = startY - row * 0.12;
        const z = startZ + row * gapZ;
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
      }
    }

    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        const a = row * cols + col;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [cols, rows, gapX, gapZ, startX, startY, startZ]);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.geometry = clothGeometry;
    }
  }, [clothGeometry]);

  useFrame(() => {
    const geometry = clothGeometry;
    if (!geometry) return;
    const position = geometry.attributes.position as THREE.BufferAttribute;
    particlePositions.current.forEach((value, index) => {
      position.setXYZ(index, value[0], value[1], value[2]);
    });
    // eslint-disable-next-line react-hooks/immutability
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  });

  const constraintPairs = useMemo(() => {
    const pairs: Array<[number, number]> = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        if (col < cols - 1) pairs.push([index, index + 1]);
        if (row < rows - 1) pairs.push([index, index + cols]);
        if (col < cols - 1 && row < rows - 1) {
          pairs.push([index, index + cols + 1]);
          pairs.push([index + 1, index + cols]);
        }
      }
    }
    return pairs;
  }, [cols, rows]);

  return (
    <group>
      {startPositions.map((position, index) => (
        <ClothParticle
          key={`particle-${index}`}
          index={index}
          position={position}
          wireframe={wireframe}
          onReady={registerParticle}
        />
      ))}

      {constraintPairs.map(([a, b], index) => {
        const bodyA = particleRefsState[a];
        const bodyB = particleRefsState[b];
        return bodyA && bodyB ? (
          <DistanceConstraint
            key={`constraint-${index}`}
            bodyA={bodyA}
            bodyB={bodyB}
            distance={gapX}
          />
        ) : null;
      })}

      <mesh ref={meshRef} castShadow receiveShadow>
        <meshStandardMaterial
          map={checkerTexture || undefined}
          color="#bae6fd"
          side={DoubleSide}
          wireframe={wireframe}
          metalness={0.15}
          roughness={0.65}
        />
      </mesh>
    </group>
  );
}

export default function ClothSimulator() {
  const [wireframe, setWireframe] = useState(false);

  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [0, 4, 8], fov: 45 }} className="w-full h-full">
        <ambientLight intensity={0.35} />
        <directionalLight position={[5, 8, 2]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
        <spotLight position={[-4, 6, 4]} intensity={0.6} penumbra={0.4} />
        <Physics gravity={[0, -9.8, 0]} iterations={10} broadphase="SAP">
          <BasePlane />
          <StaticSphere position={[0, 0.9, 0]} />
          <StaticBox position={[0, 0.35, 1.8]} />
          <ClothGrid wireframe={wireframe} />
        </Physics>
        <OrbitControls makeDefault enablePan enableZoom enableRotate />
      </Canvas>

      <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-4">
        <div className="pointer-events-auto rounded-2xl border border-slate-300/20 bg-slate-900/80 p-3 shadow-2xl backdrop-blur">
          <button
            type="button"
            onClick={() => setWireframe((value) => !value)}
            className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
          >
            {wireframe ? '通常表示に切り替え' : 'ワイヤーフレーム表示'}
          </button>
          <p className="mt-2 text-xs text-slate-200">
            3D布シミュレーター: ワイヤーフレームで構造確認ができます。
          </p>
        </div>
      </div>
    </div>
  );
}
