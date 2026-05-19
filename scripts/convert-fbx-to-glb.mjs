import fs from 'fs';
import * as THREE from 'three';

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

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

const inputPath = new URL('../public/models/Stand To Sit.fbx', import.meta.url);
const outputPath = new URL('../public/models/human.glb', import.meta.url);

const fileBuffer = fs.readFileSync(inputPath);
const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

const loader = new FBXLoader();
const object = loader.parse(arrayBuffer, '');

const exporter = new GLTFExporter();

console.log('FBX loaded. Exporting to GLB...');

const result = await exporter.parseAsync(object, {
  binary: true,
  trs: false,
  onlyVisible: false,
  truncateDrawRange: false,
  embedImages: true,
  animations: object.animations,
});

console.log('parse returned type:', result?.constructor?.name);

if (result instanceof ArrayBuffer) {
  fs.writeFileSync(outputPath, Buffer.from(result));
  console.log('GLB exported to', outputPath.pathname);
} else if (result && typeof result === 'object') {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log('GLTF exported to', outputPath.pathname);
} else {
  console.error('Unexpected exporter result type:', typeof result);
}

