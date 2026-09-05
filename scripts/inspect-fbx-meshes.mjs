#!/usr/bin/env node

// FBXモデル内のメッシュ構成・頂点数・マテリアル・部位別カテゴリを抽出・比較するスクリプト
import fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Node.js環境用FileReaderポリフィル
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

// Node.js環境用Blobポリフィル
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

// FBXLoaderのテクスチャ読み込み用documentポリフィル
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({ style: {}, addEventListener: () => {}, src: '' }),
    createElement: () => ({ style: {}, addEventListener: () => {}, src: '' }),
  };
}

const loader = new FBXLoader();

// モデル内の全メッシュ属性（頂点数マテリアル数可視性）を走査して出力する関数
function inspectMeshes(object, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}`);
  console.log(`${'='.repeat(60)}`);

  const meshes = [];
  const materials = new Set();

  // メッシュオブジェクトの探索と情報収集
  object.traverse((child) => {
    if (child.isMesh) {
      const matArray = Array.isArray(child.material) ? child.material : [child.material];
      matArray.forEach((mat) => {
        if (mat) materials.add(mat.name || mat.uuid);
      });

      meshes.push({
        name: child.name,
        geometry: child.geometry ? `${child.geometry.attributes.position?.count || 0} vertices` : 'N/A',
        materialCount: matArray.length,
        materials: matArray.map((m) => m.name || 'unnamed').join(', '),
        visible: child.visible,
      });
    }
  });

  console.log(`\nTotal Meshes: ${meshes.length}`);
  console.log(`Total Materials: ${materials.size}\n`);

  console.log('Mesh List:');
  meshes.forEach((mesh, i) => {
    console.log(
      `  [${i}] ${mesh.name}`,
      `(${mesh.geometry}, mats: ${mesh.materials})`,
      mesh.visible ? '' : '(hidden)'
    );
  });

  // メッシュ名パターンに基づく部位別カテゴリ分類
  console.log('\nMesh Categories (by name patterns):');
  const categories = {
    clothing: meshes.filter((m) => /dress|shirt|coat|skirt|cloth|wear|outfit/i.test(m.name)),
    body: meshes.filter((m) => /body|skin|torso|leg|arm|face|head/i.test(m.name)),
    hair: meshes.filter((m) => /hair/i.test(m.name)),
    accessory: meshes.filter((m) => /accesory|prop|object|item/i.test(m.name)),
    other: [],
  };

  // 未分類メッシュの割り当て
  const categorized = new Set();
  Object.values(categories).forEach((arr) => {
    arr.forEach((m) => categorized.add(m.name));
  });
  meshes.forEach((m) => {
    if (!categorized.has(m.name)) {
      categories.other.push(m);
    }
  });

  Object.entries(categories).forEach(([cat, arr]) => {
    if (arr.length > 0) {
      console.log(`  ${cat}: ${arr.length} meshes`);
      arr.slice(0, 3).forEach((m) => console.log(`    - ${m.name}`));
      if (arr.length > 3) console.log(`    ... and ${arr.length - 3} more`);
    }
  });

  return { meshCount: meshes.length, meshes };
}

// FBXファイル読み込み処理
async function analyzeFBX(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
  return loader.parse(arrayBuffer, '');
}

// 2つのFBXモデル間でメッシュ数と構成を比較するメイン処理
async function main() {
  try {
    console.log('FBX Mesh Structure Comparison');
    console.log('=============================\n');

    const basePath = path.resolve('./public/models');
    const model1Path = path.join(basePath, 'StandToSit.fbx');
    const model2Path = path.join(basePath, 'StandToSit_model.fbx');

    console.log(`Loading: ${model1Path}`);
    const fbx1 = await analyzeFBX(model1Path);
    const result1 = inspectMeshes(fbx1, 'StandToSit.fbx (Current Model)');

    console.log('\n\n');

    console.log(`Loading: ${model2Path}`);
    const fbx2 = await analyzeFBX(model2Path);
    const result2 = inspectMeshes(fbx2, 'StandToSit_model.fbx (Alternative)');

    // 比較結果のサマリー出力
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY & MIGRATION IMPACT');
    console.log(`${'='.repeat(60)}`);

    console.log(`\nCurrent model has: ${result1.meshCount} meshes`);
    console.log(`Alternative has: ${result2.meshCount} meshes`);

    if (result2.meshCount > result1.meshCount) {
      console.log(`✅ Alternative model has MORE meshes (${result2.meshCount - result1.meshCount} extra)`);
      console.log('   → Can replace without losing geometry');
    } else if (result2.meshCount === result1.meshCount) {
      console.log('⚠️  Same mesh count - check mesh names for changes');
    } else {
      console.log(
        `❌ Alternative model has FEWER meshes (${result1.meshCount - result2.meshCount} fewer)`,
        '\n   → Some clothing meshes may be missing'
      );
    }

    console.log('\n');
  } catch (error) {
    console.error('Error during analysis:', error);
    process.exit(1);
  }
}

main();
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
