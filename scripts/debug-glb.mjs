// FBXからGLBへのエクスポート処理の詳細デバッグおよびバイナリ検証スクリプト
import fs from 'fs';
import * as THREE from 'three';

// Node.js環境用ProgressEventポリフィル
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

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
    // バイナリバッファ読み込み処理
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
    // DataURL形式読み込み処理
    readAsDataURL(blob) {
      blob.arrayBuffer()
        .then((buffer) => {
          const base64 = Buffer.from(buffer).toString('base64');
          const type = blob.type || 'application/octet-stream';
          this.result = `data:${type};base64,${base64}`;
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

// Three.jsローダーとエクスポータの動的読み込み
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

// 検証対象モデルのパス定義
const inputPath = new URL('../public/models/Stand To Sit.fbx', import.meta.url);
const outputPath = new URL('../public/models/human.glb', import.meta.url);

// FBXファイル読み込みとアニメーション情報ログ出力
const fileBuffer = fs.readFileSync(inputPath);
const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

const loader = new FBXLoader();
const object = loader.parse(arrayBuffer, '');
console.log('FBX object animations:', object.animations?.map((clip) => clip.name) ?? []);

// GLBバイナリへのエクスポート実行
const exporter = new GLTFExporter();
const result = await exporter.parseAsync(object, {
  binary: true,
  trs: false,
  onlyVisible: false,
  truncateDrawRange: false,
  embedImages: true,
  animations: object.animations,
});

// エクスポート結果の型およびバイナリ長の詳細検証ログ
console.log('callback result type:', result?.constructor?.name);
console.log('typeof result:', typeof result);
console.log('ArrayBuffer.isView:', ArrayBuffer.isView(result));
console.log('instanceof ArrayBuffer:', result instanceof ArrayBuffer);
console.log('result byteLength:', result?.byteLength);
console.log('result buffer.byteLength:', result?.buffer?.byteLength);
console.log('result toString:', Object.prototype.toString.call(result));

// 判定されたバイナリ型に応じたファイル出力処理
if (result instanceof ArrayBuffer) {
  fs.writeFileSync(outputPath, Buffer.from(result));
  console.log('GLB exported to', outputPath.pathname);
} else if (result && typeof result === 'object' && 'byteLength' in result) {
  fs.writeFileSync(outputPath, Buffer.from(result));
  console.log('GLB exported from typed array to', outputPath.pathname);
} else {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log('GLTF exported to', outputPath.pathname);
}
