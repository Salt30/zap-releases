/**
 * compile-bytecode.js — Compiles JS source files to V8 bytecode (.jsc)
 *
 * This runs AFTER key injection and obfuscation, BEFORE electron-builder packs the ASAR.
 * The original .js files are replaced with tiny bootstrap loaders that load the .jsc bytecode.
 *
 * Result: extracting the ASAR yields only bytecode blobs (not readable source).
 */

const bytenode = require('bytenode');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Files to compile to bytecode
const FILES_TO_COMPILE = ['main.js', 'preload.js'];

async function compile() {
  for (const filename of FILES_TO_COMPILE) {
    const srcPath = path.join(SRC_DIR, filename);
    const jscPath = srcPath.replace('.js', '.jsc');

    if (!fs.existsSync(srcPath)) {
      console.warn(`[BYTECODE] Skipping ${filename} — file not found`);
      continue;
    }

    console.log(`[BYTECODE] Compiling ${filename} → ${path.basename(jscPath)}...`);

    // Compile to V8 bytecode
    await bytenode.compileFile({
      filename: srcPath,
      output: jscPath,
      electron: true
    });

    // Verify .jsc was created
    if (!fs.existsSync(jscPath)) {
      console.error(`[BYTECODE] FAILED — ${jscPath} not created`);
      process.exit(1);
    }

    const originalSize = fs.statSync(srcPath).size;
    const compiledSize = fs.statSync(jscPath).size;
    console.log(`[BYTECODE] ${filename}: ${(originalSize / 1024).toFixed(0)}KB → ${(compiledSize / 1024).toFixed(0)}KB bytecode`);

    // Replace original .js with a tiny bootstrap loader
    const loaderContent = `// V8 Bytecode Loader — source is compiled
'use strict';
require('bytenode');
require('./${path.basename(jscPath)}');
`;
    fs.writeFileSync(srcPath, loaderContent);
    console.log(`[BYTECODE] ${filename} replaced with bytecode loader`);
  }

  console.log('[BYTECODE] All files compiled successfully');
}

compile().catch(err => {
  console.error('[BYTECODE] Compilation failed:', err);
  process.exit(1);
});
