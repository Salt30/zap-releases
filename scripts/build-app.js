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
    bundle('onboarding.js', 'onboarding.js', 'browser'),
    bundle('zap-pin.js', 'zap-pin.js', 'browser')
  ]);

  for (const file of ['index.html', 'quick.html', 'onboarding.html', 'native.css', 'zap.css', 'zap-pin.html']) {
    fs.copyFileSync(path.join(source, file), path.join(output, file));
  }
  fs.copyFileSync(path.join(source, 'windows-host.ps1'), path.join(output, 'windows-host.ps1'));
  fs.copyFileSync(path.join(root, 'assets', 'brand', 'zap', 'logo', 'zap-icon.svg'), path.join(output, 'zap-icon.svg'));
  fs.copyFileSync(path.join(root, 'assets', 'brand', 'zap', 'logo', 'zap-wordmark-dark.svg'), path.join(output, 'zap-wordmark-dark.svg'));
  fs.copyFileSync(path.join(root, 'assets', 'brand', 'zap', 'logo', 'zap-wordmark-light.svg'), path.join(output, 'zap-wordmark-light.svg'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
