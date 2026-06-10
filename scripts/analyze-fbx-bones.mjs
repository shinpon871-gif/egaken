#!/usr/bin/env node

import fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// FileReader polyfill for Node.js
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    constructor() {
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
      this.result = null;
    }
    _emit(eventName) {
      if (typeof this[eventName] === 'function') {
        this[eventName]({ target: this });
      }
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((buffer) => {
          this.result = buffer;
          this._emit('onload');
          this._emit('onloadend');
        })
        .catch((error) => {
          if (typeof this.onerror === 'function') {
            this.onerror(error);
          }
          this._emit('onloadend');
        });
    }
  }
  globalThis.FileReader = NodeFileReader;
}

// Blob polyfill
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(chunks, options = {}) {
      this.chunks = chunks;
      this.type = options.type || '';
    }

    async arrayBuffer() {
      if (this.chunks.length === 0) return new ArrayBuffer(0);
      if (this.chunks.length === 1) {
        const chunk = this.chunks[0];
        if (typeof chunk === 'string') {
          return new TextEncoder().encode(chunk).buffer;
        }
        return chunk;
      }

      let totalLength = 0;
      this.chunks.forEach((chunk) => {
        totalLength += typeof chunk === 'string' ? new TextEncoder().encode(chunk).length : chunk.length;
      });

      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      this.chunks.forEach((chunk) => {
        if (typeof chunk === 'string') {
          const encoded = new TextEncoder().encode(chunk);
          buffer.set(encoded, offset);
          offset += encoded.length;
        } else {
          buffer.set(new Uint8Array(chunk), offset);
          offset += chunk.length;
        }
      });

      return buffer.buffer;
    }
  };
}

// Document polyfill for FBXLoader texture loading
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({
      style: {},
      addEventListener: () => {},
      onload: null,
      onerror: null,
      src: '',
    }),
    createElement: () => ({
      style: {},
      addEventListener: () => {},
      onload: null,
      onerror: null,
      src: '',
    }),
  };
}

const loader = new FBXLoader();

function dumpBoneHierarchy(object, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}`);
  console.log(`${'='.repeat(60)}`);

  const bones = [];
  const tracks = [];
  let boneCount = 0;

  object.traverse((child) => {
    if (child.isBone) {
      boneCount++;
      bones.push(child.name);
    }
  });

  if (object.animations && object.animations.length > 0) {
    object.animations.forEach((clip) => {
      console.log(`\nAnimationClip: "${clip.name}" (duration: ${clip.duration.toFixed(3)}s)`);
      clip.tracks.forEach((track) => {
        tracks.push(track.name);
        console.log(`  Track: ${track.name}`);
      });
    });
  }

  console.log(`\nBone Hierarchy (${boneCount} bones):`);
  let hierarchyStr = '';
  
  object.traverse((child) => {
    if (!child.isBone) return;
    
    let depth = 0;
    let p = child.parent;
    while (p && p !== object) {
      depth++;
      p = p.parent;
    }
    
    hierarchyStr += '  '.repeat(depth) + `[Bone] ${child.name}\n`;
  });

  console.log(hierarchyStr);

  // ボーン名の共通パターンを抽出
  console.log('\nBone Names Analysis:');
  const patterns = {};
  bones.forEach((name) => {
    const match = name.match(/^([a-zA-Z_]+)/);
    const prefix = match ? match[1] : 'OTHER';
    patterns[prefix] = (patterns[prefix] || 0) + 1;
  });
  
  console.log('Name Patterns:');
  Object.entries(patterns)
    .sort((a, b) => b[1] - a[1])
    .forEach(([prefix, count]) => {
      console.log(`  ${prefix}: ${count} bones`);
    });

  return { boneCount, bones, tracks };
}

async function analyzeFBX(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
  
  return new Promise((resolve, reject) => {
    try {
      const object = loader.parse(arrayBuffer, '');
      resolve(object);
    } catch (error) {
      reject(error);
    }
  });
}

async function main() {
  try {
    console.log('FBX Bone Structure Analysis');
    console.log('===========================\n');

    const basePath = path.resolve('./public/models');
    const model1Path = path.join(basePath, 'StandToSit.fbx');
    const model2Path = path.join(basePath, 'StandToSit_model.fbx');

    if (!fs.existsSync(model1Path)) {
      console.error(`❌ File not found: ${model1Path}`);
      process.exit(1);
    }

    if (!fs.existsSync(model2Path)) {
      console.error(`❌ File not found: ${model2Path}`);
      process.exit(1);
    }

    console.log(`Loading: ${model1Path}`);
    const fbx1 = await analyzeFBX(model1Path);
    const result1 = dumpBoneHierarchy(fbx1, 'StandToSit.fbx (Model Geometry + Base Skeleton)');

    console.log('\n\n');

    console.log(`Loading: ${model2Path}`);
    const fbx2 = await analyzeFBX(model2Path);
    const result2 = dumpBoneHierarchy(fbx2, 'StandToSit_model.fbx (Animation Source)');

    // 比較
    console.log(`\n${'='.repeat(60)}`);
    console.log('COMPARISON');
    console.log(`${'='.repeat(60)}`);

    const bones1Set = new Set(result1.bones);
    const bones2Set = new Set(result2.bones);

    const onlyInModel = Array.from(bones1Set).filter((b) => !bones2Set.has(b));
    const onlyInAnimation = Array.from(bones2Set).filter((b) => !bones1Set.has(b));
    const inBoth = Array.from(bones1Set).filter((b) => bones2Set.has(b));

    console.log(`\nTotal bones in StandToSit.fbx: ${result1.bones.length}`);
    console.log(`Total bones in StandToSit_model.fbx: ${result2.bones.length}`);
    console.log(`Bones in common: ${inBoth.length}`);

    if (onlyInModel.length > 0) {
      console.log(`\nBones ONLY in Model (${onlyInModel.length}):`);
      onlyInModel.slice(0, 10).forEach((b) => console.log(`  - ${b}`));
      if (onlyInModel.length > 10) console.log(`  ... and ${onlyInModel.length - 10} more`);
    }

    if (onlyInAnimation.length > 0) {
      console.log(`\nBones ONLY in Animation (${onlyInAnimation.length}):`);
      onlyInAnimation.slice(0, 10).forEach((b) => console.log(`  - ${b}`));
      if (onlyInAnimation.length > 10) console.log(`  ... and ${onlyInAnimation.length - 10} more`);
    }

    // トラック分析
    if (result2.tracks.length > 0) {
      console.log(`\nAnimation Tracks in StandToSit_model.fbx (${result2.tracks.length}):`);
      const trackBones = new Set();
      result2.tracks.forEach((track) => {
        const boneName = track.split('.')[0];
        trackBones.add(boneName);
      });
      
      const missingBones = Array.from(trackBones).filter((b) => !bones1Set.has(b));
      if (missingBones.length > 0) {
        console.log(`\n⚠️  Animation tracks reference bones NOT in Model skeleton (${missingBones.length}):`);
        missingBones.slice(0, 10).forEach((b) => console.log(`  - ${b}`));
        if (missingBones.length > 10) console.log(`  ... and ${missingBones.length - 10} more`);
      } else {
        console.log('\n✅ All animation track bones exist in model skeleton');
      }
    }

    console.log('\n');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
