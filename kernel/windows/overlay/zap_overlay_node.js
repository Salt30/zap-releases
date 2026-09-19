/**
 * zap_overlay_node.js — Node bridge to the in-process D3D11 overlay DLL
 *
 * Loads zap_overlay.dll via ffi-napi and exposes:
 *   available()        → is the DLL present and loadable
 *   init()             → hook Present/ResizeBuffers on host swapchain
 *   ready()            → true once the first Present has fired
 *   shutdown()         → tear down hooks, release device
 *
 * ffi-napi is an optionalDependency — if it's not installed (dev machine
 * without VS build tools), every function returns false and the app runs
 * without the overlay, exactly like the existing shield fallback.
 */

'use strict';

const path = require('path');
const fs = require('fs');

let ffi = null;
let lib = null;

function dllPath() {
  const candidates = [
    // Packaged: electron-builder places extraResources next to app.asar
    process.resourcesPath && path.join(process.resourcesPath, 'zap_overlay.dll'),
    // Dev: freshly built
    path.join(__dirname, '..', '..', '..', 'dist', 'shield', 'zap_overlay.dll'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).size > 0) return p; } catch (_) {}
  }
  return null;
}

function load() {
  if (lib || process.platform !== 'win32') return lib;
  try {
    ffi = require('ffi-napi');
  } catch (_) {
    return null;
  }
  const p = dllPath();
  if (!p) return null;
  try {
    lib = ffi.Library(p, {
      zap_overlay_init:     ['int',  []],
      zap_overlay_shutdown: ['void', []],
      zap_overlay_is_ready: ['int',  []],
    });
  } catch (_) {
    lib = null;
  }
  return lib;
}

function available() { return !!load(); }

function init() {
  const l = load();
  if (!l) return false;
  try { return l.zap_overlay_init() === 1; } catch (_) { return false; }
}

function ready() {
  const l = load();
  if (!l) return false;
  try { return l.zap_overlay_is_ready() === 1; } catch (_) { return false; }
}

function shutdown() {
  const l = load();
  if (!l) return false;
  try { l.zap_overlay_shutdown(); return true; } catch (_) { return false; }
}

module.exports = { available, init, ready, shutdown };
