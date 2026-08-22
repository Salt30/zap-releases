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
  if (environment.BLOB_READ_WRITE_TOKEN?.trim().startsWith('vercel_blob_rw_')) {
    return environment.BLOB_READ_WRITE_TOKEN.trim();
  }

  // Vercel lets a project connection add a custom prefix to integration
  // variables. Accept that generated name only when it resolves unambiguously.
  const candidates = Object.entries(environment)
    .filter(([name, value]) =>
      /(?:^|_)BLOB(?:_|$)/.test(name) &&
      /_READ_WRITE_TOKEN$/.test(name) &&
      typeof value === 'string' &&
      value.trim().startsWith('vercel_blob_rw_'))
    .map(([name, value]) => ({ name, value: value.trim() }));

  if (candidates.length === 1) return candidates[0].value;
  if (candidates.length > 1) {
    fail(`multiple read-write token variables are configured (${candidates.map(({ name }) => name).join(', ')})`);
  }
  fail('no Blob read-write token is configured; reconnect the Blob store with a read-write token enabled');
}

function resolveBlobStoreId(environment = process.env) {
  if (environment.BLOB_STORE_ID?.trim()) return environment.BLOB_STORE_ID.trim();

  const candidates = Object.entries(environment)
    .filter(([name, value]) =>
      /(?:^|_)BLOB(?:_|$)/.test(name) &&
      /_STORE_ID$/.test(name) &&
      typeof value === 'string' &&
      value.trim())
    .map(([name, value]) => ({ name, value: value.trim() }));

  const distinctValues = [...new Set(candidates.map(({ value }) => value))];
  if (distinctValues.length === 1) return distinctValues[0];
  if (distinctValues.length > 1) {
    fail(`multiple Blob store IDs are configured (${candidates.map(({ name }) => name).join(', ')})`);
  }
  fail('no Blob store ID is configured for the Vercel project connection');
}

function readLinkedProject() {
  const configPath = path.join(updateSiteDir, '.vercel', 'project.json');
  if (!fs.existsSync(configPath)) fail('the update site is not linked to a Vercel project');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.projectId || !config.orgId) fail('the Vercel project link is incomplete');
  return config;
}

async function requestProjectOidcToken({ accessToken, projectId, orgId }, request = fetch) {
  const endpoint = new URL(`https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/token`);
  endpoint.searchParams.set('source', 'vercel-oidc-refresh');
  endpoint.searchParams.set('teamId', orgId);
  const response = await request(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) fail(`Vercel project authentication was denied (${response.status})`);
  const payload = await response.json();
  if (typeof payload.token !== 'string' || !payload.token.trim()) {
    fail('Vercel project authentication returned no token');
  }
  return payload.token.trim();
}

async function resolveBlobAuthentication(environment = process.env) {
  const storeId = resolveBlobStoreId(environment);
  const pulledOidcToken = environment.VERCEL_OIDC_TOKEN?.trim();
  if (pulledOidcToken) {
    return { oidcToken: pulledOidcToken, storeId };
  }

  const accessToken = environment.VERCEL_TOKEN?.trim();
  if (accessToken) {
    const { projectId, orgId } = readLinkedProject();
    const oidcToken = await requestProjectOidcToken({ accessToken, projectId, orgId });
    return { oidcToken, storeId };
  }
  return { token: resolveBlobToken(environment) };
}

function listReleaseFiles() {
  if (!fs.existsSync(distDir)) fail(`missing dist directory: ${distDir}`);

  const files = fs.readdirSync(distDir)
    .filter((name) => /\.(?:dmg|zip|exe|blockmap)$/.test(name))
    .sort();

  for (const extension of ['.dmg', '.zip', '.exe', '.blockmap']) {
    if (!files.some((name) => name.endsWith(extension))) {
      fail(`no ${extension} artifact found`);
    }
  }

  for (const name of files) {
    if (!/^Drip-Type-[0-9]+\.[0-9]+\.[0-9]+-(?:mac\.(?:dmg|zip)|windows\.exe)(?:\.blockmap)?$/.test(name)) {
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

function supersededReleaseUrls(blobs, currentVersion = packageVersion) {
  const currentPrefix = `releases/v${currentVersion}/`;
  return blobs
    .filter(({ pathname, url }) =>
      typeof pathname === 'string' &&
      typeof url === 'string' &&
      /^releases\/v\d+\.\d+\.\d+\//.test(pathname) &&
      !pathname.startsWith(currentPrefix))
    .map(({ url }) => url);
}

async function pruneSupersededReleases(blobApi, blobAuthentication) {
  const blobs = [];
  let cursor;
  do {
    const page = await blobApi.list({
      prefix: 'releases/',
      limit: 1000,
      ...(cursor ? { cursor } : {}),
      ...blobAuthentication,
    });
    blobs.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor);

  const urls = supersededReleaseUrls(blobs);
  if (urls.length === 0) return;
  await blobApi.del(urls, blobAuthentication);
  process.stdout.write(`Pruned ${urls.length} superseded release blobs after publishing v${packageVersion}.\n`);
}

async function main() {
  const dryRun = process.env.PUBLISH_UPDATE_DRY_RUN === '1';
  const blobAuthentication = dryRun
    ? { token: 'vercel_blob_rw_dry_run_token' }
    : await resolveBlobAuthentication();

  const blobApi = dryRun ? null : await import('@vercel/blob');
  const put = dryRun
    ? async (blobPath) => ({ url: `https://dry-run.invalid/${blobPath}` })
    : blobApi.put;
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
      ...blobAuthentication,
    });

    redirects.push({
      source: `/${name}`,
      destination: blob.url,
      permanent: false,
    });
    process.stdout.write(`Published ${name} -> ${blob.url}\n`);
  }

  if (!dryRun) await pruneSupersededReleases(blobApi, blobAuthentication);

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

module.exports = {
  pruneSupersededReleases,
  requestProjectOidcToken,
  resolveBlobAuthentication,
  resolveBlobStoreId,
  resolveBlobToken,
  supersededReleaseUrls,
};
