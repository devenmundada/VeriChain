// Webpack loader: adds webpackIgnore comment to dynamic import() calls
// in RunAnywhere SDK bridge files so the browser's native import() is used.
module.exports = function wasmImportLoader(source) {
  // Replace @vite-ignore with webpackIgnore: true
  let result = source.replace(
    /import\(\s*\/\*\s*@vite-ignore\s*\*\//g,
    'import(/* webpackIgnore: true */'
  );
  // Also handle bare import(moduleUrl) without any magic comment
  result = result.replace(
    /import\(\s*moduleUrl\s*\)/g,
    'import(/* webpackIgnore: true */ moduleUrl)'
  );
  return result;
};
