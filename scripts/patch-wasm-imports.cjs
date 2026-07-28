// Postinstall script: patches RunAnywhere SDK files so dynamic import() calls
// bypass bundler static analysis (works with webpack, Turbopack, Vite, etc.)
const fs = require("fs");
const path = require("path");

const FILES = [
  "node_modules/@runanywhere/web-llamacpp/dist/Foundation/LlamaCppBridge.js",
  "node_modules/@runanywhere/web-llamacpp/dist/Infrastructure/VLMWorkerRuntime.js",
  "node_modules/@runanywhere/web-onnx/dist/Foundation/SherpaONNXBridge.js",
  "node_modules/@runanywhere/web-onnx/dist/Foundation/SherpaHelperLoader.js",
];

let patched = 0;
for (const rel of FILES) {
  const file = path.resolve(__dirname, "..", rel);
  if (!fs.existsSync(file)) continue;
  let src = fs.readFileSync(file, "utf8");
  // Replace: import(/* @vite-ignore */ varName)
  // With:    (new Function('u','return import(u)'))(varName)
  const next = src.replace(
    /await import\(\/\* @vite-ignore \*\/ (\w+)\)/g,
    'await (new Function("u","return import(u)"))($1)'
  );
  if (next !== src) {
    fs.writeFileSync(file, next, "utf8");
    patched++;
    console.log(`  patched: ${rel}`);
  }
}
console.log(`patch-wasm-imports: ${patched} file(s) patched`);
