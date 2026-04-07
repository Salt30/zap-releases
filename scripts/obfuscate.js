/**
 * obfuscate.js — Applies javascript-obfuscator to source files
 *
 * Runs AFTER API key injection, BEFORE bytenode compilation.
 * This adds a layer of protection even if someone bypasses bytecode
 * (e.g., by downgrading Electron to decompile the .jsc).
 *
 * Obfuscation includes:
 * - String encryption (hides API keys, URLs, identifiers)
 * - Control flow flattening (makes logic unreadable)
 * - Dead code injection (wastes reverse-engineer's time)
 * - Identifier renaming (strips all meaningful names)
 * - Self-defending (code breaks if reformatted)
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const FILES_TO_OBFUSCATE = ['main.js', 'preload.js'];

const OBFUSCATION_OPTIONS = {
  // High protection level
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5, // 50% of blocks — higher = slower startup
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false, // Don't enable — breaks Electron DevTools for us
  disableConsoleOutput: false, // We need console.log for debugging
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false, // Don't rename — breaks Node.js require/module
  selfDefending: false, // Don't enable — can break in Electron
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayEncoding: ['rc4'], // RC4 encrypt all strings (hides API keys)
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  // Node.js target — preserves require(), module.exports, etc.
  target: 'node',
  // Don't rename these — they're Electron/Node APIs
  reservedNames: [
    '^require$', '^module$', '^exports$', '^__dirname$', '^__filename$',
    '^process$', '^global$', '^Buffer$', '^console$', '^setTimeout$',
    '^setInterval$', '^clearTimeout$', '^clearInterval$', '^Promise$'
  ],
  reservedStrings: [
    // Don't obfuscate import paths (breaks require)
    '^\\./', '^\\.\\.\\/','bytenode', 'electron', 'stripe', 'path', 'fs',
    'os', 'child_process', 'crypto', 'net', 'http', 'https', 'url'
  ]
};

for (const filename of FILES_TO_OBFUSCATE) {
  const filePath = path.join(SRC_DIR, filename);

  if (!fs.existsSync(filePath)) {
    console.warn(`[OBFUSCATE] Skipping ${filename} — not found`);
    continue;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const originalSize = source.length;

  console.log(`[OBFUSCATE] Processing ${filename} (${(originalSize / 1024).toFixed(0)}KB)...`);

  const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATION_OPTIONS);
  const obfuscated = result.getObfuscatedCode();

  fs.writeFileSync(filePath, obfuscated);
  console.log(`[OBFUSCATE] ${filename}: ${(originalSize / 1024).toFixed(0)}KB → ${(obfuscated.length / 1024).toFixed(0)}KB (obfuscated)`);
}

console.log('[OBFUSCATE] All files obfuscated successfully');
