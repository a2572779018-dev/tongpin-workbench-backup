import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 语音通话 speech detection files, served in development and emitted next to
 * the app under vad/: the Silero VAD model and audio worklet of
 * @ricky0123/vad-web and the ONNX Runtime Web WebAssembly build it runs on
 * (see src/features/tongpin-ai/voice/call/sileroVad.ts).
 */
function voiceCallVadAssets(): Plugin {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files: Record<string, string> = {
    "vad/vad.worklet.bundle.min.js": "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    "vad/silero_vad_v5.onnx": "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
    "vad/ort-wasm-simd-threaded.wasm": "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "vad/ort-wasm-simd-threaded.mjs": "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
  };
  const types: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".onnx": "application/octet-stream", ".wasm": "application/wasm" };
  return {
    name: "tongpin-voice-call-vad-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = (request.url ?? "").split("?")[0].replace(/^\/+/, "");
        const source = files[name];
        if (!source) { next(); return; }
        response.setHeader("Content-Type", types[path.extname(name)] ?? "application/octet-stream");
        createReadStream(path.join(root, source)).pipe(response);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files)) this.emitFile({ type: "asset", fileName, source: readFileSync(path.join(root, source)) });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), voiceCallVadAssets()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
});
