import React, { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Float,
  Html,
  OrbitControls,
  QuadraticBezierLine,
  Sparkles,
  Text,
} from '@react-three/drei';
import * as THREE from 'three';

import type {
  GardenScene,
  GardenSceneAnchor,
  GardenSceneArm,
  GardenSceneBrain,
  GardenSceneBubble,
  GardenSceneBug,
  GardenSceneLink,
  GardenSceneTask,
  GardenVec3,
} from '@/lib/api';

import type { GardenDisplaySettings, GardenSelection } from './types';

interface GardenCanvasProps {
  scene: GardenScene;
  settings: GardenDisplaySettings;
  selection: GardenSelection | null;
  onSelect: (selection: GardenSelection | null) => void;
}

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>;
const FLOOR_Y = -9.8;
const ANCHOR_SPOTLIGHT_SOURCE_Y = 46;

interface LabelCandidate {
  key: string;
  kind: GardenSelection['kind'];
  id: string;
  label: string;
  position: GardenVec3;
  offsetY: number;
  tone: 'default' | 'accent' | 'warning' | 'danger' | 'muted';
  importance: number;
}

function hashNumber(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function hashFraction(input: string): number {
  return (hashNumber(input) % 10000) / 10000;
}

function inferTimestampFromId(id: string): number | null {
  const match = id.match(/(\d{10,})/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value)) return null;
  return match[1].length === 10 ? value * 1000 : value;
}

function ageDepthFromId(id: string, newestY: number, oldestY: number, maxAgeDays: number, fallbackY: number): number {
  const timestamp = inferTimestampFromId(id);
  if (timestamp == null) return fallbackY;
  const ageMs = Math.max(0, Date.now() - timestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const normalized = THREE.MathUtils.clamp(ageDays / Math.max(maxAgeDays, 1), 0, 1);
  return THREE.MathUtils.lerp(newestY, oldestY, normalized);
}

function reefPositionFromId(
  id: string,
  kind: 'bug' | 'discovery',
  fallbackY: number,
): GardenVec3 {
  const radius = kind === 'bug' ? 76 : 90;
  const jitter = kind === 'bug' ? 4.2 : 5.8;
  const newestY = kind === 'bug' ? -1.6 : -0.8;
  const oldestY = kind === 'bug' ? -6.4 : -5.8;
  const angle = hashFraction(`${id}:angle`) * Math.PI * 2;
  const ringRadius = radius + (hashFraction(`${id}:radius`) - 0.5) * jitter;
  const tangentOffset = (hashFraction(`${id}:tangent`) - 0.5) * 2.4;

  return {
    x: Math.cos(angle) * ringRadius - Math.sin(angle) * tangentOffset,
    y: ageDepthFromId(id, newestY, oldestY, 21, fallbackY),
    z: Math.sin(angle) * ringRadius + Math.cos(angle) * tangentOffset,
  };
}

function vectorFrom(position: GardenVec3): THREE.Vector3 {
  return new THREE.Vector3(position.x, position.y, position.z);
}

function positionArray(position: GardenVec3): [number, number, number] {
  return [position.x, position.y, position.z];
}

function isSelected(selection: GardenSelection | null, kind: GardenSelection['kind'], id: string): boolean {
  return selection?.kind === kind && selection.id === id;
}

function taskColor(task: GardenSceneTask): string {
  if (task.status === 'blocked') return '#f59e0b';
  if (task.status === 'completed') return '#34d399';
  if (task.priority === 'critical') return '#fb7185';
  if (task.priority === 'high') return '#22d3ee';
  return '#7dd3fc';
}

function bugColor(bug: GardenSceneBug): string {
  if (bug.priority === 'critical') return '#ff5a7a';
  if (bug.priority === 'high') return '#ff7a3c';
  return '#ffb24a';
}

function bubbleColor(bubble: GardenSceneBubble): string {
  if (bubble.kind === 'proposal') {
    return bubble.status === 'open' ? '#e879f9' : '#c084fc';
  }
  if (bubble.kind === 'health') {
    return bubble.status.includes('error') ? '#fb7185' : bubble.status.includes('optional') ? '#f59e0b' : '#34d399';
  }
  if (bubble.kind === 'discovery') {
    if (bubble.severity === 'error') return '#34f5c5';
    if (bubble.severity === 'warning') return '#5eead4';
    return '#7dd3fc';
  }
  if (bubble.severity === 'error') return '#fb7185';
  if (bubble.severity === 'warning') return '#fbbf24';
  return '#67e8f9';
}

function SceneLabel({
  label,
  position,
  distanceFactor,
  tone = 'default',
}: {
  label: string;
  position: [number, number, number];
  distanceFactor: number;
  tone?: LabelCandidate['tone'];
}) {
  const toneClasses: Record<LabelCandidate['tone'], string> = {
    default: 'text-cyan-50',
    accent: 'text-emerald-50',
    warning: 'text-amber-50',
    danger: 'text-rose-50',
    muted: 'text-cyan-100/85',
  };
  const effectiveDistanceFactor = distanceFactor * 1.28;

  return (
    <Html center position={position} distanceFactor={effectiveDistanceFactor} transform={false} sprite>
      <div
        className={`rounded bg-slate-950/82 px-2.5 py-1 text-[12px] font-medium shadow-lg ${toneClasses[tone]}`}
        style={{
          maxWidth: '180px',
          width: '180px',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1.25,
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
        }}
      >
        {label}
      </div>
    </Html>
  );
}

function labelImportanceForArm(arm: GardenSceneArm, selected: boolean): number {
  let score = 70;
  if (selected) score += 300;
  switch (arm.lifecycleState || arm.legacyStatus) {
    case 'working':
      score += 60;
      break;
    case 'task_assigned':
    case 'completing':
      score += 48;
      break;
    case 'error':
    case 'disconnected':
      score += 56;
      break;
    case 'idle':
      score += 24;
      break;
    default:
      score += 16;
      break;
  }
  if (arm.currentTaskId || arm.currentBugId) score += 18;
  return score;
}

function labelImportanceForTask(task: GardenSceneTask, selected: boolean): number {
  let score = 54;
  if (selected) score += 300;
  if (task.status === 'blocked') score += 58;
  if (task.status === 'in_progress') score += 44;
  if (task.status === 'completing') score += 36;
  if (task.priority === 'critical') score += 50;
  else if (task.priority === 'high') score += 28;
  if (task.progress != null) score += Math.min(task.progress / 10, 8);
  return score;
}

function labelImportanceForBug(bug: GardenSceneBug, selected: boolean): number {
  let score = 60;
  if (selected) score += 300;
  if (bug.priority === 'critical') score += 64;
  else if (bug.priority === 'high') score += 36;
  if (bug.status === 'open' || bug.status === 'investigating') score += 30;
  return score;
}

function labelImportanceForBubble(bubble: GardenSceneBubble, selected: boolean): number {
  let score = 24;
  if (selected) score += 300;
  if (bubble.kind === 'proposal') score += bubble.status === 'open' ? 22 : 8;
  if (bubble.kind === 'discovery') score += bubble.severity === 'error' ? 26 : bubble.severity === 'warning' ? 16 : 8;
  if (bubble.kind === 'health') score += bubble.status.includes('error') ? 24 : 6;
  return score;
}

function toneForTask(task: GardenSceneTask): LabelCandidate['tone'] {
  if (task.status === 'blocked') return 'warning';
  if (task.priority === 'critical') return 'danger';
  if (task.status === 'completed') return 'muted';
  return 'accent';
}

function toneForBug(bug: GardenSceneBug): LabelCandidate['tone'] {
  if (bug.priority === 'critical') return 'danger';
  return 'warning';
}

function toneForBubble(bubble: GardenSceneBubble): LabelCandidate['tone'] {
  if (bubble.kind === 'health' && bubble.status.includes('error')) return 'danger';
  if (bubble.kind === 'discovery' && bubble.severity === 'error') return 'danger';
  if (bubble.kind === 'discovery' && bubble.severity === 'warning') return 'warning';
  if (bubble.kind === 'proposal') return 'accent';
  return 'muted';
}

function toneForArm(arm: GardenSceneArm): LabelCandidate['tone'] {
  if (arm.lifecycleState === 'error' || arm.legacyStatus === 'error') return 'danger';
  if (arm.lifecycleState === 'disconnected') return 'warning';
  return 'default';
}

function OceanFloor() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;

    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#ead6a8');
    gradient.addColorStop(0.55, '#dcbc82');
    gradient.addColorStop(1, '#cda064');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let row = 0; row < 18; row += 1) {
      const y = (row / 18) * canvas.height;
      context.strokeStyle = `rgba(255, 243, 211, ${0.08 + (row % 3) * 0.015})`;
      context.lineWidth = 6 + (row % 4);
      context.beginPath();
      for (let x = 0; x <= canvas.width; x += 16) {
        const wave = Math.sin(x * 0.018 + row * 0.55) * 7;
        const dune = Math.cos(x * 0.005 + row) * 3;
        const py = y + wave + dune;
        if (x === 0) {
          context.moveTo(x, py);
        } else {
          context.lineTo(x, py);
        }
      }
      context.stroke();
    }

    for (let index = 0; index < 5000; index += 1) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const alpha = 0.035 + Math.random() * 0.08;
      const size = 0.7 + Math.random() * 1.8;
      context.fillStyle = Math.random() > 0.5
        ? `rgba(130, 92, 46, ${alpha})`
        : `rgba(255, 247, 225, ${alpha})`;
      context.beginPath();
      context.arc(x, y, size, 0, Math.PI * 2);
      context.fill();
    }

    for (let shell = 0; shell < 36; shell += 1) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      context.fillStyle = 'rgba(255, 249, 232, 0.24)';
      context.beginPath();
      context.ellipse(x, y, 6 + Math.random() * 10, 2 + Math.random() * 5, Math.random() * Math.PI, 0, Math.PI * 2);
      context.fill();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(7, 7);
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  }, []);

  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  if (!texture) {
    return null;
  }

  return (
    <group position={[0, FLOOR_Y, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[88, 80]} />
        <meshStandardMaterial
          map={texture}
          color="#ecd4a0"
          roughness={0.96}
          metalness={0}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]}>
        <ringGeometry args={[88, 104, 80]} />
        <meshBasicMaterial color="#11324a" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}

function AnchorSpotlightNode({
  anchor,
  selected,
  showLabel,
}: {
  anchor: GardenSceneAnchor;
  selected: boolean;
  showLabel: boolean;
}) {
  const sourceY = ANCHOR_SPOTLIGHT_SOURCE_Y + (anchor.kind === 'workspace' ? 4 : 0);
  const beamColor = anchor.kind === 'workspace' ? '#ffe0a8' : '#94ebff';
  const glowColor = anchor.kind === 'workspace' ? '#fff0cb' : '#d4f7ff';
  const beamHeight = sourceY - FLOOR_Y;
  const beamRadius = anchor.kind === 'workspace' ? 6.6 : 5.4;
  const textWidth = beamRadius * 1.45;
  const textSize = anchor.kind === 'workspace' ? 1.35 : 1.12;

  return (
    <group>
      <mesh
        position={[anchor.position.x, FLOOR_Y + beamHeight / 2, anchor.position.z]}
        raycast={() => null}
      >
        <coneGeometry args={[beamRadius, beamHeight, 28, 1, true]} />
        <meshBasicMaterial color={beamColor} transparent opacity={selected ? 0.12 : 0.07} depthWrite={false} />
      </mesh>

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[anchor.position.x, FLOOR_Y + 0.04, anchor.position.z]}
        raycast={() => null}
      >
        <circleGeometry args={[beamRadius * (selected ? 1.14 : 1), 48]} />
        <meshBasicMaterial color={glowColor} transparent opacity={selected ? 0.22 : 0.13} depthWrite={false} />
      </mesh>

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[anchor.position.x, FLOOR_Y + 0.03, anchor.position.z]}
        raycast={() => null}
      >
        <circleGeometry args={[beamRadius * 0.52, 40]} />
        <meshBasicMaterial color={glowColor} transparent opacity={selected ? 0.12 : 0.07} depthWrite={false} />
      </mesh>

      {showLabel ? (
        <Text
          position={[anchor.position.x, FLOOR_Y + 0.08, anchor.position.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          anchorX="center"
          anchorY="middle"
          maxWidth={textWidth}
          fontSize={textSize}
          color="#0f172a"
          fillOpacity={selected ? 0.58 : 0.42}
          outlineWidth={0}
          raycast={() => null}
        >
          {anchor.label}
        </Text>
      ) : null}
    </group>
  );
}

function scaleForDistance(cameraPosition: THREE.Vector3, target: GardenVec3, nearScale: number, farScale: number): number {
  const distance = cameraPosition.distanceTo(vectorFrom(target));
  const normalized = THREE.MathUtils.clamp((distance - 18) / 60, 0, 1);
  return THREE.MathUtils.lerp(nearScale, farScale, normalized);
}

function brainIsFrowning(brain: GardenSceneBrain, arms: GardenSceneArm[]): boolean {
  if (brain.status === 'stopped') return true;
  if (arms.length === 0) return false;

  return arms.every((arm) => {
    const states = [arm.lifecycleState, arm.legacyStatus].filter((state): state is string => Boolean(state));
    return states.some((state) => ['stuck', 'dead'].includes(state.toLowerCase()));
  });
}

function BrainNode({
  brain,
  scene,
  brightness,
  selected,
  showLabel,
  onSelect,
}: {
  brain: GardenSceneBrain;
  scene: GardenScene;
  brightness: number;
  selected: boolean;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const coreRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const faceRef = useRef<THREE.Group>(null);
  const leftEyeRef = useRef<THREE.Group>(null);
  const rightEyeRef = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const isFrowning = brainIsFrowning(brain, scene.arms);
  
  // Eye tracking state
  const lookTargetRef = useRef<THREE.Vector3>(new THREE.Vector3(10, 0, 10));
  const lastTargetChangeRef = useRef(0);
  const currentTargetIndexRef = useRef(0);
  
  // Get all possible look targets from the scene
  const lookTargets = useMemo(() => {
    const targets: GardenVec3[] = [];
    for (const arm of scene.arms) targets.push(arm.position);
    for (const task of scene.tasks) targets.push(task.position);
    for (const bug of scene.bugs) targets.push(bug.position);
    for (const bubble of scene.bubbles) targets.push(bubble.position);
    for (const anchor of scene.anchors) targets.push(anchor.position);
    // Add some random points in space too
    for (let i = 0; i < 5; i++) {
      targets.push({
        x: (Math.random() - 0.5) * 40,
        y: (Math.random() - 0.5) * 20,
        z: (Math.random() - 0.5) * 40
      });
    }
    return targets;
  }, [scene]);

  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    const distanceScale = scaleForDistance(camera.position, brain.position, 1, 1.32);
    
    // Static scale - no pulsing
    if (coreRef.current) {
      coreRef.current.scale.setScalar((selected ? 1.08 : 1) * distanceScale);
    }
    if (haloRef.current) {
      haloRef.current.scale.setScalar((selected ? 1.08 : 1) * distanceScale);
    }
    
    // Change look target every 3-6 seconds
    if (time - lastTargetChangeRef.current > 3 + Math.random() * 3) {
      lastTargetChangeRef.current = time;
      if (lookTargets.length > 0) {
        currentTargetIndexRef.current = Math.floor(Math.random() * lookTargets.length);
        const target = lookTargets[currentTargetIndexRef.current];
        lookTargetRef.current.set(target.x, target.y, target.z);
      }
    }
    
    // Calculate direction to target
    const brainPos = vectorFrom(brain.position);
    const targetDir = lookTargetRef.current.clone().sub(brainPos).normalize();
    
    // Rotate the entire face assembly toward target
    if (faceRef.current) {
      const targetRotation = new THREE.Quaternion();
      targetRotation.setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetDir);
      faceRef.current.quaternion.slerp(targetRotation, 0.03);
    }
    
    // Eyes track target - pupils move within eyes
    if (leftEyeRef.current && rightEyeRef.current) {
      // Get world direction to target in local eye space
      const leftEyePos = new THREE.Vector3();
      leftEyeRef.current.getWorldPosition(leftEyePos);
      const rightEyePos = new THREE.Vector3();
      rightEyeRef.current.getWorldPosition(rightEyePos);
      
      // Calculate look direction for each eye
      const leftLookDir = lookTargetRef.current.clone().sub(leftEyePos).normalize();
      const rightLookDir = lookTargetRef.current.clone().sub(rightEyePos).normalize();
      
      // Transform to local eye space and limit movement
      const maxPupilOffset = 0.1;
      
      // Left pupil tracking
      const leftPupil = leftEyeRef.current.children[1] as THREE.Mesh;
      if (leftPupil) {
        const localTarget = leftLookDir.clone().applyQuaternion(leftEyeRef.current.quaternion.clone().invert());
        const pupilX = THREE.MathUtils.clamp(localTarget.x * 0.2, -maxPupilOffset, maxPupilOffset);
        const pupilY = THREE.MathUtils.clamp(localTarget.y * 0.2, -maxPupilOffset, maxPupilOffset);
        leftPupil.position.x = THREE.MathUtils.lerp(leftPupil.position.x, pupilX, 0.08);
        leftPupil.position.y = THREE.MathUtils.lerp(leftPupil.position.y, pupilY, 0.08);
      }
      
      // Right pupil tracking
      const rightPupil = rightEyeRef.current.children[1] as THREE.Mesh;
      if (rightPupil) {
        const localTarget = rightLookDir.clone().applyQuaternion(rightEyeRef.current.quaternion.clone().invert());
        const pupilX = THREE.MathUtils.clamp(localTarget.x * 0.2, -maxPupilOffset, maxPupilOffset);
        const pupilY = THREE.MathUtils.clamp(localTarget.y * 0.2, -maxPupilOffset, maxPupilOffset);
        rightPupil.position.x = THREE.MathUtils.lerp(rightPupil.position.x, pupilX, 0.08);
        rightPupil.position.y = THREE.MathUtils.lerp(rightPupil.position.y, pupilY, 0.08);
      }
    }
  });

  return (
    <group position={positionArray(brain.position)} onClick={(event) => {
      event.stopPropagation();
      onSelect();
    }}>
      {/* Glow halo */}
      <mesh ref={haloRef}>
        <sphereGeometry args={[3.3, 32, 32]} />
        <meshBasicMaterial color="#7a2b09" transparent opacity={selected ? 0.34 : 0.18} />
      </mesh>
      
      {/* Bulbous head shape - wider at bottom like a cute character */}
      <mesh ref={coreRef} scale={[1.15, 1, 1.15]}>
        <sphereGeometry args={[2.1, 32, 32]} />
        <meshStandardMaterial
          color="#f3621b"
          emissive="#f3621b"
          emissiveIntensity={selected ? 1.4 : 0.95 * brightness}
          roughness={0.22}
          metalness={0.08}
        />
      </mesh>
      
      {/* Face assembly - rotates to look at targets, positioned on sphere surface */}
      <group ref={faceRef} position={[0, 0, 0]}>
        {/* Left eye - positioned protruding from sphere surface */}
        <group ref={leftEyeRef} position={[-0.6, 0.3, 2.4]}>
          {/* Eye white */}
          <mesh>
            <sphereGeometry args={[0.32, 16, 16]} />
            <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.3} />
          </mesh>
          {/* Pupil - index 1, can move */}
          <mesh position={[0, 0, 0.22]}>
            <sphereGeometry args={[0.16, 12, 12]} />
            <meshBasicMaterial color="#1a1a2e" />
          </mesh>
          {/* Highlight */}
          <mesh position={[0.08, 0.1, 0.28]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        </group>
        
        {/* Right eye - positioned protruding from sphere surface */}
        <group ref={rightEyeRef} position={[0.6, 0.3, 2.4]}>
          {/* Eye white */}
          <mesh>
            <sphereGeometry args={[0.32, 16, 16]} />
            <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.3} />
          </mesh>
          {/* Pupil - index 1, can move */}
          <mesh position={[0, 0, 0.22]}>
            <sphereGeometry args={[0.16, 12, 12]} />
            <meshBasicMaterial color="#1a1a2e" />
          </mesh>
          {/* Highlight */}
          <mesh position={[0.08, 0.1, 0.28]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        </group>
        
        {/* Infrastructure health bubbles do not affect the brain's expression. */}
        <mesh position={[0, -0.4, 2.35]} rotation={[0.2, 0, isFrowning ? 0 : Math.PI]}>
          <torusGeometry args={[0.4, 0.09, 8, 16, Math.PI]} />
          <meshStandardMaterial color="#ff6b8a" emissive="#ff4d6d" emissiveIntensity={0.4} />
        </mesh>
        
        {/* Rosy cheeks - protruding from sphere surface */}
        <mesh position={[-1.0, -0.15, 2.1]}>
          <sphereGeometry args={[0.2, 12, 12]} />
          <meshBasicMaterial color="#ffb3c1" transparent opacity={0.5} />
        </mesh>
        <mesh position={[1.0, -0.15, 2.1]}>
          <sphereGeometry args={[0.2, 12, 12]} />
          <meshBasicMaterial color="#ffb3c1" transparent opacity={0.5} />
        </mesh>
      </group>
      
      {/* Decorative wireframe overlay */}
      <mesh scale={[1.2, 1.05, 1.2]}>
        <icosahedronGeometry args={[1.5, 1]} />
        <meshStandardMaterial
          color="#ffd7c2"
          emissive="#f3621b"
          emissiveIntensity={selected ? 1 : 0.55 * brightness}
          transparent
          opacity={0.5}
          wireframe
        />
      </mesh>
      {showLabel ? (
        <SceneLabel label={brain.label} position={[0, 4.6, 0]} distanceFactor={14} tone="default" />
      ) : null}
    </group>
  );
}

function TentacleLink({
  start,
  end,
  color,
  opacity,
  selected,
}: {
  start: GardenVec3;
  end: GardenVec3;
  color: string;
  opacity: number;
  selected: boolean;
}) {
  const mid = useMemo<[number, number, number]>(() => {
    const center = {
      x: (start.x + end.x) * 0.5,
      y: Math.max(start.y, end.y) + (selected ? 6 : 4),
      z: (start.z + end.z) * 0.5,
    };
    return positionArray(center);
  }, [end.x, end.y, end.z, selected, start.x, start.y, start.z]);

  return (
    <QuadraticBezierLine
      start={positionArray(start)}
      end={positionArray(end)}
      mid={mid}
      color={color}
      lineWidth={selected ? 2.1 : 1.2}
      transparent
      opacity={selected ? Math.min(0.48, opacity + 0.18) : opacity}
    />
  );
}

// Pre-computed segment data for ArmTip - computed once, reused for all arms
const ARM_SEGMENT_COUNT = 16;
const ARM_JOINT_RADII = Array.from({ length: ARM_SEGMENT_COUNT + 1 }, (_, index) =>
  // index 0 = root (large, near brain), index 15 = tip (small, free end)
  THREE.MathUtils.lerp(0.68, 0.04, index / ARM_SEGMENT_COUNT),
);
const ARM_SEGMENT_DEFS = Array.from({ length: ARM_SEGMENT_COUNT }, (_, index) => {
  const t = index / (ARM_SEGMENT_COUNT - 1); // 0 = root, 1 = tip
  // Segments get shorter toward the tip
  const lengthMultiplier = 1.2 - t * 0.4;
  return {
    key: `segment-${index}`,
    length: THREE.MathUtils.lerp(1.0, 0.35, t) * lengthMultiplier,
    // index 0 uses radii [0], [1]; index 15 uses radii [15], [16]
    startRadius: ARM_JOINT_RADII[index],
    endRadius: ARM_JOINT_RADII[index + 1],
    // Most flex in middle sections, least at root and tip
    flex: THREE.MathUtils.lerp(0.05, 0.15, Math.sin(t * Math.PI)),
    suckerRadius: THREE.MathUtils.lerp(0.12, 0.05, t),
  };
});
const ARM_BASE_COLOR = new THREE.Color('#e06020');
const ARM_TIP_COLOR = new THREE.Color('#f07838');
const ARM_SEGMENT_COLORS = ARM_SEGMENT_DEFS.map((_, index) => {
  const t = index / (ARM_SEGMENT_DEFS.length - 1); // 0 = root (base color), 1 = tip (tip color)
  return ARM_BASE_COLOR.clone().lerp(ARM_TIP_COLOR, t);
});
const ARM_MAX_JOINT_ANGLE = Math.PI / 4;
const ARM_X_AXIS = new THREE.Vector3(1, 0, 0);

const ArmTip = React.memo(function ArmTip({
  arm,
  scene,
  selection,
  settings,
  showLabel,
  onSelect,
}: {
  arm: GardenSceneArm;
  scene: GardenScene;
  selection: GardenSelection | null;
  settings: GardenDisplaySettings;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const segmentRefs = useRef<Array<THREE.Group | null>>([]);
  const selected = isSelected(selection, 'arm', arm.id);
  const { camera } = useThree();
  const segmentScale = selected ? 1.08 : 1;
  
  // Find target entity position (task, bug, or anchor the arm is working on)
  const targetPosition = useMemo(() => {
    if (arm.currentTaskId) {
      const task = scene.tasks.find(t => t.id === arm.currentTaskId);
      if (task) return task.position;
    }
    if (arm.currentBugId) {
      const bug = scene.bugs.find(b => b.id === arm.currentBugId);
      if (bug) return bug.position;
    }
    if (arm.targetAnchorId) {
      const anchor = scene.anchors.find(a => a.id === arm.targetAnchorId);
      if (anchor) return anchor.position;
    }
    // Default to arm's own position if no target
    return arm.position;
  }, [arm, scene]);
  
  // Calculate root position: offset from brain toward arm position, but constrained near brain
  const rootPosition = useMemo(() => {
    const brainPos = vectorFrom(scene.brain.position);
    const armPos = vectorFrom(arm.position);
    const direction = armPos.clone().sub(brainPos).normalize();
    // Root is 2-4 units from brain in the direction of the arm
    const rootOffset = direction.multiplyScalar(2.5);
    return {
      x: brainPos.x + rootOffset.x,
      y: brainPos.y + rootOffset.y,
      z: brainPos.z + rootOffset.z,
    };
  }, [scene.brain.position, arm.position]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const time = clock.getElapsedTime();
    
    // Root stays near brain with very slight drift
    const drift = settings.motion * 0.08;
    groupRef.current.position.set(
      rootPosition.x + Math.sin(time * 0.2) * drift,
      rootPosition.y + Math.cos(time * 0.15) * drift,
      rootPosition.z + Math.sin(time * 0.25) * drift,
    );

    // Orient root toward target entity
    const targetVec = vectorFrom(targetPosition);
    const rootVec = vectorFrom(rootPosition);
    const direction = targetVec.clone().sub(rootVec).normalize();
    
    // Add orbital motion to the tip direction
    const orbitSpeed = 0.15;
    const orbitRadius = 0.15;
    const orbitX = Math.sin(time * orbitSpeed) * orbitRadius;
    const orbitY = Math.cos(time * orbitSpeed * 0.7) * orbitRadius;
    const orbitZ = Math.sin(time * orbitSpeed * 0.5) * orbitRadius;
    
    direction.x += orbitX;
    direction.y += orbitY;
    direction.z += orbitZ;
    direction.normalize();
    
    const targetQuat = new THREE.Quaternion().setFromUnitVectors(ARM_X_AXIS, direction);
    groupRef.current.quaternion.slerp(targetQuat, 0.12);

    const distanceScale = scaleForDistance(camera.position, rootPosition, 1, 1.3);
    groupRef.current.scale.setScalar(distanceScale);

    // Animate segments: root fixed, middle undulates, tip follows orbital motion
    for (let index = 0; index < ARM_SEGMENT_COUNT; index += 1) {
      const segment = ARM_SEGMENT_DEFS[index];
      const joint = segmentRefs.current[index];
      if (!joint) continue;

      // Progress from root (0) to tip (1)
      const t = index / (ARM_SEGMENT_COUNT - 1);
      
      // Root segments (0-2) stay relatively fixed
      // Middle segments (3-10) undulate with sine waves
      // Tip segments (11-15) follow the orbital motion
      
      let flex = 0;
      let yaw = 0;
      let pitch = 0;
      
      if (t < 0.2) {
        // Root: very minimal movement
        flex = segment.flex * settings.motion * 0.2;
        yaw = Math.sin(time * 0.3 + index * 0.5) * flex * 0.5;
        pitch = Math.cos(time * 0.25 + index * 0.4) * flex * 0.5;
      } else if (t < 0.7) {
        // Middle: undulating sine waves
        const wavePhase = (t - 0.2) * 8; // phase shifts through middle section
        flex = segment.flex * settings.motion * (selected ? 1.4 : 1.0);
        
        const primaryWave = Math.sin(time * 0.5 + wavePhase);
        const secondaryWave = Math.cos(time * 0.35 + wavePhase * 0.8);
        
        yaw = primaryWave * flex;
        pitch = secondaryWave * flex * 0.8;
      } else {
        // Tip: follows orbital direction with reduced flex
        flex = segment.flex * settings.motion * 0.6;
        const tipPhase = (t - 0.7) * 5;
        yaw = Math.sin(time * 0.4 + tipPhase) * flex;
        pitch = Math.cos(time * 0.3 + tipPhase) * flex;
      }

      joint.rotation.z = THREE.MathUtils.clamp(yaw, -ARM_MAX_JOINT_ANGLE, ARM_MAX_JOINT_ANGLE);
      joint.rotation.y = THREE.MathUtils.clamp(pitch, -ARM_MAX_JOINT_ANGLE, ARM_MAX_JOINT_ANGLE);
    }
  });

  return (
    <group
      ref={groupRef}
      position={positionArray(rootPosition)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {/* Recursive segment chain - segments nest inside each other so rotation propagates */}
      {/* Index 0 is root (near brain), segments extend toward +X direction */}
      {(() => {
        const renderSegmentChain = (index: number): React.ReactNode => {
          if (index >= ARM_SEGMENT_COUNT) return null;
          
          const segment = ARM_SEGMENT_DEFS[index];
          const segmentColor = ARM_SEGMENT_COLORS[index];
          const jointRadius = segment.endRadius * segmentScale;
          // Opacity: fade along the length - full at tip, fading to 0 at root
          // Linear fade from segment 0 (root, opacity 0) to segment 15 (tip, opacity 1)
          const t = index / (ARM_SEGMENT_COUNT - 1);
          // Ease the fade for smoother appearance - slower fade at tip, faster at root
          const opacity = Math.pow(t, 0.7);
          const isLast = index === ARM_SEGMENT_COUNT - 1;
          
          // Next segment is rendered as a child, so it follows this segment's rotation
          const nextSegment = renderSegmentChain(index + 1);
          
          return (
            <group
              key={segment.key}
              ref={(node) => {
                segmentRefs.current[index] = node;
              }}
            >
              {/* Cylinder body - extends from origin toward +X */}
              <mesh position={[(segment.length * segmentScale) / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry
                  args={[
                    segment.startRadius * segmentScale,
                    segment.endRadius * segmentScale,
                    segment.length * segmentScale,
                    12,
                  ]}
                />
                <meshStandardMaterial
                  color={segmentColor}
                  emissive={segmentColor}
                  emissiveIntensity={selected ? 1.04 : 0.68 * settings.brightness}
                  roughness={0.34}
                  metalness={0.08}
                  transparent={opacity < 0.999}
                  opacity={opacity}
                />
              </mesh>

              {/* Joint sphere at the end (+X direction) */}
              <mesh position={[segment.length * segmentScale, 0, 0]}>
                <sphereGeometry args={[jointRadius * 0.96, 8, 8]} />
                <meshStandardMaterial
                  color={segmentColor}
                  emissive={segmentColor}
                  emissiveIntensity={selected ? 0.9 : 0.52 * settings.brightness}
                  roughness={0.38}
                  metalness={0.05}
                  transparent={opacity < 0.999}
                  opacity={opacity}
                />
              </mesh>

              {/* Sucker on the underside */}
              {!isLast && index > 1 && index < ARM_SEGMENT_COUNT - 2 ? (
                <mesh position={[segment.length * segmentScale * 0.5, -segment.endRadius * segmentScale * 0.8, 0]}>
                  <sphereGeometry args={[segment.suckerRadius * segmentScale, 6, 6]} />
                  <meshStandardMaterial
                    color="#f5e9cf"
                    emissive="#f5e9cf"
                    emissiveIntensity={selected ? 0.34 : 0.18 * settings.brightness}
                    roughness={0.6}
                    metalness={0.02}
                    transparent={opacity < 0.999}
                    opacity={opacity}
                  />
                </mesh>
              ) : null}

              {/* Next segment is a child, positioned at the end of this segment */}
              {nextSegment && (
                <group position={[segment.length * segmentScale, 0, 0]}>
                  {nextSegment}
                </group>
              )}
            </group>
          );
        };
        
        return renderSegmentChain(0);
      })()}

      {/* Tip glow */}
      <mesh position={[ARM_SEGMENT_DEFS.reduce((sum, s) => sum + s.length, 0) * segmentScale + 0.1, 0, 0]}>
        <sphereGeometry args={[0.08 * segmentScale, 8, 8]} />
        <meshStandardMaterial
          color="#f8fafc"
          emissive={ARM_TIP_COLOR}
          emissiveIntensity={selected ? 1.2 : 0.75 * settings.brightness}
          roughness={0.16}
          metalness={0.05}
        />
      </mesh>

      {showLabel ? (
        <SceneLabel label={arm.label} position={[2, 1.5, 0]} distanceFactor={12} tone={toneForArm(arm)} />
      ) : null}
    </group>
  );
});

function TaskNode({
  task,
  selected,
  settings,
  showLabel,
  onSelect,
}: {
  task: GardenSceneTask;
  selected: boolean;
  settings: GardenDisplaySettings;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const color = taskColor(task);
  const { camera } = useThree();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y += 0.003 * settings.motion;
    const pulseScale =
      (selected ? 1.2 : 1) + Math.sin(clock.getElapsedTime() * 1.5 + task.position.x * 0.2) * 0.04 * settings.motion;
    const distanceScale = scaleForDistance(camera.position, task.position, 1.08, 1.58);
    ref.current.scale.setScalar(pulseScale * distanceScale);
  });

  return (
    <group position={positionArray(task.position)} onClick={(event) => {
      event.stopPropagation();
      onSelect();
    }}>
      <mesh ref={ref}>
        <icosahedronGeometry args={[selected ? 1.8 : 1.45, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 1.05 : 0.52 * settings.brightness}
          roughness={0.4}
          metalness={0.08}
        />
      </mesh>
      {showLabel ? (
        <SceneLabel label={task.label} position={[0, 2.5, 0]} distanceFactor={16} tone={toneForTask(task)} />
      ) : null}
    </group>
  );
}

function BugNode({
  bug,
  selected,
  settings,
  showLabel,
  onSelect,
}: {
  bug: GardenSceneBug;
  selected: boolean;
  settings: GardenDisplaySettings;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const color = bugColor(bug);
  const { camera } = useThree();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.x += 0.004 * settings.motion;
    ref.current.rotation.y += 0.01 * settings.motion;
    ref.current.position.y = Math.sin(clock.getElapsedTime() * 2.1 + bug.position.z * 0.1) * 0.18 * settings.motion;
    ref.current.scale.setScalar(scaleForDistance(camera.position, bug.position, 1.12, 1.66));
  });

  return (
    <group position={positionArray(bug.position)} onClick={(event) => {
      event.stopPropagation();
      onSelect();
    }}>
      <mesh ref={ref}>
        <octahedronGeometry args={[selected ? 1.55 : 1.25, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 1.25 : 0.72 * settings.brightness}
          roughness={0.25}
          metalness={0.14}
        />
      </mesh>
      {showLabel ? (
        <SceneLabel label={bug.label} position={[0, 2.3, 0]} distanceFactor={16} tone={toneForBug(bug)} />
      ) : null}
    </group>
  );
}

function BubbleNode({
  bubble,
  selected,
  settings,
  showLabel,
  onSelect,
}: {
  bubble: GardenSceneBubble;
  selected: boolean;
  settings: GardenDisplaySettings;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const color = bubbleColor(bubble);
  const scale = bubble.kind === 'health' ? 0.95 : bubble.kind === 'proposal' ? 1.15 : 0.85;
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.scale.setScalar(scaleForDistance(camera.position, bubble.position, 0.98, 1.55));
  });

  return (
    <Float
      speed={1 + settings.motion * 0.65}
      floatIntensity={0.35 * settings.motion}
      rotationIntensity={0.12 * settings.motion}
      position={positionArray(bubble.position)}
    >
      <group
        ref={groupRef}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <mesh scale={scale * settings.bubbleScale * (selected ? 1.28 : 1)}>
          <sphereGeometry args={[1, 20, 20]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={selected ? 1.05 : 0.6 * settings.brightness}
            transparent
            opacity={bubble.kind === 'health' ? 0.72 : 0.82}
            roughness={0.12}
            metalness={0.04}
          />
        </mesh>
        <mesh scale={scale * settings.bubbleScale * 1.35}>
          <sphereGeometry args={[1, 16, 16]} />
          <meshBasicMaterial color={color} transparent opacity={selected ? 0.18 : 0.08} />
        </mesh>
        {showLabel ? (
          <SceneLabel label={bubble.label} position={[0, 2, 0]} distanceFactor={18} tone={toneForBubble(bubble)} />
        ) : null}
      </group>
    </Float>
  );
}

function AnchorNodeRegular({
  anchor,
  selected,
  showLabel,
  onSelect,
}: {
  anchor: GardenSceneAnchor;
  selected: boolean;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.scale.setScalar(scaleForDistance(camera.position, anchor.position, 1, 1.4));
  });

  return (
    <group
      ref={groupRef}
      position={positionArray(anchor.position)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <mesh>
        <sphereGeometry args={[selected ? 1.3 : 1.1, 16, 16]} />
        <meshBasicMaterial color="#0f766e" transparent opacity={selected ? 0.42 : 0.18} />
      </mesh>
      {showLabel ? (
        <SceneLabel label={anchor.label} position={[0, 1.8, 0]} distanceFactor={22} tone="muted" />
      ) : null}
    </group>
  );
}

function AnchorNode({
  anchor,
  selected,
  showLabel,
  onSelect,
}: {
  anchor: GardenSceneAnchor;
  selected: boolean;
  showLabel: boolean;
  onSelect: () => void;
}) {
  if (anchor.kind === 'workspace' || anchor.kind === 'domain') {
    return (
      <AnchorSpotlightNode
        anchor={anchor}
        selected={selected}
        showLabel
      />
    );
  }

  return (
    <AnchorNodeRegular
      anchor={anchor}
      selected={selected}
      showLabel={showLabel}
      onSelect={onSelect}
    />
  );
}

function AmbientLinks({
  links,
  positions,
  selection,
  settings,
}: {
  links: GardenSceneLink[];
  positions: Map<string, GardenVec3>;
  selection: GardenSelection | null;
  settings: GardenDisplaySettings;
}) {
  return (
    <>
      {links.map((link) => {
        const start = positions.get(link.sourceId);
        const end = positions.get(link.targetId);
        if (!start || !end) return null;

        const highlighted =
          selection?.id === link.sourceId ||
          selection?.id === link.targetId;

        if (link.kind === 'brain_arm') {
          return (
            <TentacleLink
              key={link.id}
              start={start}
              end={end}
              color="#67e8f9"
              opacity={highlighted ? 0.28 : link.opacity}
              selected={highlighted}
            />
          );
        }

        const visible = link.kind === 'claim' ? settings.showClaims : settings.showLinks;
        if (!visible) return null;

        const controlLift = link.kind === 'task_assignment' ? 2.5 : link.kind === 'consensus' ? 3.5 : 1.2;
        const mid: [number, number, number] = [
          (start.x + end.x) * 0.5,
          Math.max(start.y, end.y) + controlLift,
          (start.z + end.z) * 0.5,
        ];

        const color = link.kind === 'claim'
          ? '#38bdf8'
          : link.kind === 'task_assignment'
            ? '#a3e635'
            : '#f0abfc';

        return (
          <QuadraticBezierLine
            key={link.id}
            start={positionArray(start)}
            end={positionArray(end)}
            mid={mid}
            color={color}
            lineWidth={highlighted ? Math.min(link.weight + 0.8, 2.8) : link.weight}
            transparent
            opacity={highlighted ? Math.min(link.opacity + 0.16, 0.4) : link.opacity}
            dashed={link.kind === 'consensus'}
            dashScale={link.kind === 'consensus' ? 18 : undefined}
          />
        );
      })}
    </>
  );
}

function KeyboardNavigator({ controlsRef }: { controlsRef: RefObject<OrbitControlsHandle | null> }) {
  const keysRef = useRef<Record<string, boolean>>({});
  const { camera } = useThree();

  useEffect(() => {
    const handledKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!handledKeys.has(key)) return;
      keysRef.current[key] = true;
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!handledKeys.has(key)) return;
      keysRef.current[key] = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const forwardAmount =
      (keysRef.current.w || keysRef.current.arrowup ? 1 : 0) -
      (keysRef.current.s || keysRef.current.arrowdown ? 1 : 0);
    const rightAmount =
      (keysRef.current.d || keysRef.current.arrowright ? 1 : 0) -
      (keysRef.current.a || keysRef.current.arrowleft ? 1 : 0);

    if (forwardAmount === 0 && rightAmount === 0) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const translation = new THREE.Vector3()
      .addScaledVector(forward, forwardAmount * delta * 18)
      .addScaledVector(right, rightAmount * delta * 18);

    controls.object.position.add(translation);
    controls.target.add(translation);
    controls.update();
  });

  return null;
}

function FollowSelection({
  controlsRef,
  targetPosition,
  enabled,
}: {
  controlsRef: RefObject<OrbitControlsHandle | null>;
  targetPosition: GardenVec3 | null;
  enabled: boolean;
}) {
  const desiredTargetRef = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    if (!enabled || !targetPosition || !controlsRef.current) return;
    desiredTargetRef.current = vectorFrom(targetPosition);
  }, [controlsRef, enabled, targetPosition]);

  useFrame(() => {
    const controls = controlsRef.current;
    const desiredTarget = desiredTargetRef.current;
    if (!controls || !desiredTarget) return;

    controls.target.lerp(desiredTarget, 0.08);

    const offset = new THREE.Vector3(9, 5.5, 9.5);
    const desiredCamera = desiredTarget.clone().add(offset);
    controls.object.position.lerp(desiredCamera, 0.04);
    controls.update();

    if (controls.target.distanceTo(desiredTarget) < 0.2) {
      desiredTargetRef.current = null;
    }
  });

  return null;
}

function SceneContent({
  scene,
  settings,
  selection,
  onSelect,
}: GardenCanvasProps) {
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const { camera, size } = useThree();
  const [visibleLabelKeys, setVisibleLabelKeys] = useState<string[]>([]);
  const labelUpdateRef = useRef(0);
  const visibleLabelSignatureRef = useRef('');

  const visibleTasks = useMemo(() => {
    if (settings.showTasks) {
      return scene.tasks.filter((task) => settings.showCompleted || task.status !== 'completed');
    }
    return [];
  }, [scene.tasks, settings.showCompleted, settings.showTasks]);

  const visibleBugs = useMemo(() => (settings.showBugs ? scene.bugs : []), [scene.bugs, settings.showBugs]);
  const visibleBubbles = useMemo(
    () =>
      scene.bubbles.filter((bubble) => {
        if (bubble.kind === 'proposal') return settings.showProposals;
        if (bubble.kind === 'discovery') return settings.showDiscoveries;
        if (bubble.kind === 'health') return settings.showHealth;
        return true;
      }),
    [scene.bubbles, settings.showDiscoveries, settings.showHealth, settings.showProposals],
  );
  const normalizedBugs = useMemo(
    () => visibleBugs.map((bug) => ({ ...bug, position: reefPositionFromId(bug.id, 'bug', bug.position.y) })),
    [visibleBugs],
  );
  const normalizedBubbles = useMemo(
    () =>
      visibleBubbles.map((bubble) =>
        bubble.kind === 'discovery'
          ? { ...bubble, position: reefPositionFromId(bubble.id, 'discovery', bubble.position.y) }
          : bubble,
      ),
    [visibleBubbles],
  );

  const positions = useMemo(() => {
    const map = new Map<string, GardenVec3>();
    map.set(scene.brain.id, scene.brain.position);
    for (const anchor of scene.anchors) {
      map.set(anchor.id, anchor.position);
    }
    for (const arm of scene.arms) {
      map.set(arm.id, arm.position);
    }
    for (const task of visibleTasks) {
      map.set(task.id, task.position);
    }
    for (const bug of normalizedBugs) {
      map.set(bug.id, bug.position);
    }
    for (const bubble of normalizedBubbles) {
      map.set(bubble.id, bubble.position);
    }
    return map;
  }, [normalizedBubbles, normalizedBugs, scene, visibleTasks]);

  const selectedPosition = selection ? positions.get(selection.id) || null : null;

  const labelCandidates = useMemo<LabelCandidate[]>(() => {
    const candidates: LabelCandidate[] = [
      {
        key: 'brain:brain',
        kind: 'brain',
        id: scene.brain.id,
        label: scene.brain.label,
        position: scene.brain.position,
        offsetY: 3.8,
        tone: 'default',
        importance: selection?.kind === 'brain' ? 1000 : 88,
      },
    ];

    scene.arms.forEach((arm) => {
      const selected = isSelected(selection, 'arm', arm.id);
      candidates.push({
        key: `arm:${arm.id}`,
        kind: 'arm',
        id: arm.id,
        label: arm.label,
        position: arm.position,
        offsetY: 2.2,
        tone: toneForArm(arm),
        importance: labelImportanceForArm(arm, selected),
      });
    });

    visibleTasks.forEach((task) => {
      const selected = isSelected(selection, 'task', task.id);
      candidates.push({
        key: `task:${task.id}`,
        kind: 'task',
        id: task.id,
        label: task.label,
        position: task.position,
        offsetY: 2.5,
        tone: toneForTask(task),
        importance: labelImportanceForTask(task, selected),
      });
    });

    normalizedBugs.forEach((bug) => {
      const selected = isSelected(selection, 'bug', bug.id);
      candidates.push({
        key: `bug:${bug.id}`,
        kind: 'bug',
        id: bug.id,
        label: bug.label,
        position: bug.position,
        offsetY: 2.3,
        tone: toneForBug(bug),
        importance: labelImportanceForBug(bug, selected),
      });
    });

    normalizedBubbles.forEach((bubble) => {
      if (bubble.kind === 'health') return;
      const selected = isSelected(selection, 'bubble', bubble.id);
      candidates.push({
        key: `bubble:${bubble.id}`,
        kind: 'bubble',
        id: bubble.id,
        label: bubble.label,
        position: bubble.position,
        offsetY: 2,
        tone: toneForBubble(bubble),
        importance: labelImportanceForBubble(bubble, selected),
      });
    });

    scene.anchors.forEach((anchor) => {
      const selected = isSelected(selection, 'anchor', anchor.id);
      candidates.push({
        key: `anchor:${anchor.id}`,
        kind: 'anchor',
        id: anchor.id,
        label: anchor.label,
        position: anchor.position,
        offsetY: 1.8,
        tone: 'muted',
        importance: (selected ? 250 : 6) + Math.min(anchor.itemCount, 8),
      });
    });

    return candidates;
  }, [normalizedBubbles, normalizedBugs, scene, selection, visibleTasks]);

  const applyVisibleLabels = useCallback((nextKeys: string[]) => {
    const nextSignature = nextKeys.join('|');
    if (nextSignature === visibleLabelSignatureRef.current) {
      return;
    }
    visibleLabelSignatureRef.current = nextSignature;
    setVisibleLabelKeys(nextKeys);
  }, []);

  useEffect(() => {
    if (!settings.showLabels) {
      if (selection) {
        applyVisibleLabels([`${selection.kind}:${selection.id}`]);
      } else {
        applyVisibleLabels([]);
      }
    }
  }, [applyVisibleLabels, selection, settings.showLabels]);

  useFrame((_, delta) => {
    labelUpdateRef.current += delta;
    if (labelUpdateRef.current < 0.16) {
      return;
    }
    labelUpdateRef.current = 0;

    const selectedKeys = new Set<string>();
    if (selection) {
      selectedKeys.add(`${selection.kind}:${selection.id}`);
    }

    if (!settings.showLabels) {
      const fallback = Array.from(selectedKeys);
      applyVisibleLabels(fallback);
      return;
    }

    const projectedCandidates = labelCandidates
      .map((candidate) => {
        const world = vectorFrom(candidate.position);
        const screen = world.clone().project(camera);
        if (screen.z < -1 || screen.z > 1.15) {
          return null;
        }
        const x = ((screen.x + 1) / 2) * size.width;
        const y = ((1 - screen.y) / 2) * size.height;
        if (x < -120 || x > size.width + 120 || y < -80 || y > size.height + 80) {
          return null;
        }

        const distance = camera.position.distanceTo(world);
        const distanceBonus = THREE.MathUtils.clamp(40 - distance, -12, 22);
        return {
          ...candidate,
          screenX: x,
          screenY: y,
          distance,
          score: candidate.importance + distanceBonus,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => right.score - left.score);

    const kept = new Set<string>(selectedKeys);
    const cellCounts = new Map<string, number>();
    const volumeCounts = new Map<string, number>();
    const keptPositions: Array<{ x: number; y: number }> = [];
    const nextKeys: string[] = [];
    const maxLabels = 24;
    const cellWidth = 240;
    const cellHeight = 148;

    for (const key of selectedKeys) {
      nextKeys.push(key);
    }

    for (const candidate of projectedCandidates) {
      if (nextKeys.length >= maxLabels) {
        break;
      }
      if (kept.has(candidate.key)) {
        continue;
      }

      const cellKey = `${Math.floor(candidate.screenX / cellWidth)}:${Math.floor(candidate.screenY / cellHeight)}`;
      const volumeKey = `${Math.floor(candidate.position.x / 18)}:${Math.floor(candidate.position.y / 12)}:${Math.floor(candidate.position.z / 18)}`;
      const cellLimit = candidate.kind === 'brain' ? 1 : candidate.kind === 'arm' || candidate.kind === 'bug' || candidate.kind === 'task' ? 2 : 1;
      const volumeLimit = candidate.kind === 'brain' ? 1 : candidate.kind === 'arm' || candidate.kind === 'task' || candidate.kind === 'bug' ? 2 : 1;

      if ((cellCounts.get(cellKey) || 0) >= cellLimit) {
        continue;
      }
      if ((volumeCounts.get(volumeKey) || 0) >= volumeLimit) {
        continue;
      }

      const tooClose = keptPositions.some((position) => {
        const dx = Math.abs(position.x - candidate.screenX);
        const dy = Math.abs(position.y - candidate.screenY);
        return dx < 124 && dy < 50;
      });
      if (tooClose) {
        continue;
      }

      kept.add(candidate.key);
      nextKeys.push(candidate.key);
      keptPositions.push({ x: candidate.screenX, y: candidate.screenY });
      cellCounts.set(cellKey, (cellCounts.get(cellKey) || 0) + 1);
      volumeCounts.set(volumeKey, (volumeCounts.get(volumeKey) || 0) + 1);
    }

    applyVisibleLabels(nextKeys);
  });

  const visibleLabelSet = useMemo(() => new Set(visibleLabelKeys), [visibleLabelKeys]);

  return (
    <>
      <color attach="background" args={['#0a2030']} />
      <fog attach="fog" args={['#0a2030', 88, 210]} />

      <ambientLight intensity={0.72 * settings.brightness} color="#a9ddff" />
      <hemisphereLight args={['#bcecff', '#d8b980', 0.72 * settings.brightness]} />
      <pointLight position={[0, 18, 0]} intensity={56 * settings.brightness} distance={110} color="#7dd3fc" />
      <pointLight position={[24, 14, -20]} intensity={24 * settings.brightness} distance={125} color="#f0f9ff" />
      <pointLight position={[-28, 10, 22]} intensity={16 * settings.brightness} distance={130} color="#86efac" />

      <Sparkles
        count={65}
        size={2.2}
        speed={0.25 * settings.motion}
        scale={[90, 55, 90]}
        color="#7dd3fc"
      />

      <OceanFloor />

      <BrainNode
        brain={scene.brain}
        scene={scene}
        brightness={settings.brightness}
        selected={isSelected(selection, 'brain', scene.brain.id)}
        showLabel={visibleLabelSet.has('brain:brain')}
        onSelect={() => onSelect({ kind: 'brain', id: scene.brain.id })}
      />

      <AmbientLinks links={scene.links} positions={positions} selection={selection} settings={settings} />

      {scene.anchors.map((anchor) => (
        <AnchorNode
          key={anchor.id}
          anchor={anchor}
          selected={isSelected(selection, 'anchor', anchor.id)}
          showLabel={visibleLabelSet.has(`anchor:${anchor.id}`)}
          onSelect={() => onSelect({ kind: 'anchor', id: anchor.id })}
        />
      ))}

      {scene.arms.map((arm) => {
        return (
          <group key={arm.id}>
            <ArmTip
              arm={arm}
              scene={scene}
              selection={selection}
              settings={settings}
              showLabel={visibleLabelSet.has(`arm:${arm.id}`)}
              onSelect={() => onSelect({ kind: 'arm', id: arm.id })}
            />
          </group>
        );
      })}

      {visibleTasks.map((task) => (
        <TaskNode
          key={task.id}
          task={task}
          selected={isSelected(selection, 'task', task.id)}
          settings={settings}
          showLabel={visibleLabelSet.has(`task:${task.id}`)}
          onSelect={() => onSelect({ kind: 'task', id: task.id })}
        />
      ))}

      {normalizedBugs.map((bug) => (
        <BugNode
          key={bug.id}
          bug={bug}
          selected={isSelected(selection, 'bug', bug.id)}
          settings={settings}
          showLabel={visibleLabelSet.has(`bug:${bug.id}`)}
          onSelect={() => onSelect({ kind: 'bug', id: bug.id })}
        />
      ))}

      {normalizedBubbles.map((bubble) => (
        <BubbleNode
          key={bubble.id}
          bubble={bubble}
          selected={isSelected(selection, 'bubble', bubble.id)}
          settings={settings}
          showLabel={visibleLabelSet.has(`bubble:${bubble.id}`)}
          onSelect={() => onSelect({ kind: 'bubble', id: bubble.id })}
        />
      ))}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan
        enableZoom
        enableRotate
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={84}
        maxPolarAngle={Math.PI * 0.48}
      />
      <KeyboardNavigator controlsRef={controlsRef} />
      <FollowSelection controlsRef={controlsRef} targetPosition={selectedPosition} enabled={settings.followSelection} />
    </>
  );
}

export function GardenCanvas({ scene, settings, selection, onSelect }: GardenCanvasProps) {
  return (
    <div className="h-[74vh] min-h-[620px] overflow-hidden rounded-2xl border border-cyan-400/20 bg-[#020817] shadow-[0_0_0_1px_rgba(8,145,178,0.05),0_22px_60px_rgba(2,8,23,0.65)] lg:h-[78vh]">
      <Canvas
        camera={{ position: [13, 10, 18], fov: 44, near: 0.1, far: 200 }}
        onPointerMissed={() => onSelect(null)}
        frameloop="always"
        performance={{ min: 0.5 }}
        dpr={[1, 1.5]}
      >
        <SceneContent scene={scene} settings={settings} selection={selection} onSelect={onSelect} />
      </Canvas>
      <div className="border-t border-cyan-400/10 bg-slate-950/80 px-4 py-2 text-xs text-cyan-100/75">
        Drag to orbit, right-drag to pan, wheel to zoom, and use WASD or arrow keys to move through the water.
      </div>
    </div>
  );
}
