const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src');
const output = path.join(root, 'build-app');

async function bundle(entry, outfile, platform) {
  await esbuild.build({
    entryPoints: [path.join(source, entry)],
    outfile: path.join(output, outfile),
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    platform,
    format: 'cjs',
    target: platform === 'node' ? 'node22' : 'chrome136',
    packages: platform === 'node' ? 'external' : undefined,
    external: platform === 'node' ? ['electron'] : undefined,
    logLevel: 'warning'
  });
}

async function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  await Promise.all([
    bundle('main.js', 'main.js', 'node'),
    bundle('preload.js', 'preload.js', 'node'),
    bundle('index.js', 'index.js', 'browser'),
    bundle('quick.js', 'quick.js', 'browser'),
    bundle('onboarding.js', 'onboarding.js', 'browser')
  ]);

  for (const file of ['index.html', 'quick.html', 'onboarding.html']) {
    fs.copyFileSync(path.join(source, file), path.join(output, file));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
