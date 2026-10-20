import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';

// TalkingHead keeps its GLTFLoader instance private, so attach the decoder at
// the class level. Every loader instance (including TalkingHead's) picks it up
// on first load. Vite dedupes the 'three/addons' specifier, so this is the same
// class object the library imports.
const originalLoad = GLTFLoader.prototype.load;
GLTFLoader.prototype.load = function (
  this: GLTFLoader & { __meshoptReady?: boolean },
  ...args: Parameters<GLTFLoader['load']>
) {
  if (!this.__meshoptReady) {
    this.setMeshoptDecoder(MeshoptDecoder);
    this.__meshoptReady = true;
  }
  return originalLoad.apply(this, args);
};
