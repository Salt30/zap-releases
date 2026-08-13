#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));
const updateSiteDir = path.resolve(process.env.UPDATE_SITE_DIR || path.join(root, 'update-site'));
const baseConfigPath = path.join(root, 'updates-host', 'vercel.json');
const packageVersion = require(path.join(root, 'package.json')).version;

function fail(message) {
  throw new Error(`Update publish failed: ${message}`);
}

function resolveBlobToken(environment = process.env) {
  if (environment.BLOB_READ_WRITE_TOKEN?.trim()) {
    return environment.BLOB_READ_WRITE_TOKEN.trim();
  }

  // Vercel lets a project connection add a custom prefix to integration
  // variables. Accept that generated name only when it resolves unambiguously.
  const candidates = Object.entries(environment)
    .filter(([name, value]) =>
      /^[A-Z0-9_]+_READ_WRITE_TOKEN$/.test(name) &&
      typeof value === 'string' &&
      value.trim())
    .map(([name, value]) => ({ name, value: value.trim() }));

  if (candidates.length === 1) return candidates[0].value;
  if (candidates.length > 1) {
    fail(`multiple read-write token variables are configured (${candidates.map(({ name }) => name).join(', ')})`);
  }
  fail('no Blob read-write token is configured; reconnect the Blob store with a read-write token enabled');
}

function listReleaseFiles() {
  if (!fs.existsSync(distDir)) fail(`missing dist directory: ${distDir}`);

  const files = fs.readdirSync(distDir)
    .filter((name) => /\.(?:dmg|zip|blockmap)$/.test(name))
    .sort();

  for (const extension of ['.dmg', '.zip', '.blockmap']) {
    if (!files.some((name) => name.endsWith(extension))) {
      fail(`no ${extension} artifact found`);
    }
  }

  for (const name of files) {
    if (!/^Drip-Type-[0-9]+\.[0-9]+\.[0-9]+-mac\.(?:dmg|zip)(?:\.blockmap)?$/.test(name)) {
      fail(`unexpected artifact name: ${name}`);
    }
    if (!name.includes(`-${packageVersion}-`)) {
      fail(`artifact version does not match package version: ${name}`);
    }
    const stats = fs.statSync(path.join(distDir, name));
    if (!stats.isFile() || stats.size === 0) fail(`artifact is empty: ${name}`);
  }

  return files;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const dryRun = process.env.PUBLISH_UPDATE_DRY_RUN === '1';
  const blobToken = dryRun ? 'dry-run-token' : resolveBlobToken();

  const put = dryRun
    ? async (blobPath) => ({ url: `https://dry-run.invalid/${blobPath}` })
    : (await import('@vercel/blob')).put;
  const files = listReleaseFiles();
  const redirects = [];

  for (const name of files) {
    const filePath = path.join(distDir, name);
    const digest = await sha256(filePath);
    const blobPath = `releases/v${packageVersion}/${digest}/${name}`;
    const blob = await put(blobPath, fs.createReadStream(filePath), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 31536000,
      multipart: true,
      token: blobToken,
    });

    redirects.push({
      source: `/${name}`,
      destination: blob.url,
      permanent: false,
    });
    process.stdout.write(`Published ${name} -> ${blob.url}\n`);
  }

  const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));
  fs.mkdirSync(updateSiteDir, { recursive: true });
  fs.writeFileSync(
    path.join(updateSiteDir, 'vercel.json'),
    `${JSON.stringify({ ...baseConfig, redirects }, null, 2)}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { resolveBlobToken };
