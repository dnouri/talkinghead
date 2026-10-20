import ortModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export function assetURL(path: string): string {
  return new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
}

export function runtimeAssets() {
  return {
    modelPath: assetURL('models/'),
    dictionaryURL: assetURL('headtts/dictionaries/'),
    voiceURL: assetURL('models/kokoro/voices/'),
    wasmPaths: {
      mjs: new URL(ortModuleURL, document.baseURI).href,
      wasm: new URL(ortWasmURL, document.baseURI).href,
    },
  };
}
