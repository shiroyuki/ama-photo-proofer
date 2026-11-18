import { expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

it('generates offline credits on a clean install before the Electron runtime exists', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'photo-proofer-credits-'));
  try {
    const electron = path.join(folder, 'node_modules/electron');
    await mkdir(electron, { recursive: true }); await mkdir(path.join(folder, 'scripts'));
    await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'credits-fixture', version: '1.0.0', dependencies: {} }));
    await writeFile(path.join(folder, 'LICENSE'), 'Application license');
    await writeFile(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.3.2', main: 'index.js', license: 'MIT' }));
    await writeFile(path.join(electron, 'LICENSE'), 'Electron package license');
    // Use the installed Electron entry point to exercise its real lazy-install path.
    const resolve = createRequire(path.resolve('package.json'));
    await copyFile(path.join(path.dirname(resolve.resolve('electron')), 'index.js'), path.join(electron, 'index.js'));
    await writeFile(path.join(electron, 'install.js'), `
      const fs = require('node:fs'), path = require('node:path');
      fs.mkdirSync(path.join(__dirname, 'dist'));
      fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron');
      fs.writeFileSync(path.join(__dirname, 'dist/electron'), 'fixture');
      fs.writeFileSync(path.join(__dirname, 'dist/LICENSE'), 'Electron runtime license');
      fs.writeFileSync(path.join(__dirname, 'dist/LICENSES.chromium.html'), '<html><head></head><body>Chromium license fixture</body></html>');
    `);
    await copyFile('scripts/licenses.cjs', path.join(folder, 'scripts/licenses.cjs'));
    const env = { ...process.env }; delete env.ELECTRON_OVERRIDE_DIST_PATH; delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
    for (let run = 0; run < 2; run++) execFileSync(process.execPath, ['scripts/licenses.cjs'], { cwd: folder, env });
    const credits = JSON.parse(await readFile(path.join(folder, 'public/licenses/software.json'), 'utf8'));
    expect(credits.appLicense).toBe('Application license');
    expect(credits.software.find((entry: { name: string }) => entry.name === 'electron').notices)
      .toEqual(expect.arrayContaining([{ name: 'LICENSE', text: 'Electron runtime license' }]));
    expect(await readFile(path.join(folder, 'public/licenses/chromium.html'), 'utf8')).toContain('Chromium license fixture');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
