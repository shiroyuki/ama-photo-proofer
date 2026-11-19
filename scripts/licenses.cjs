// Generate offline About credits from the actual dependencies installed for this platform.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const app = require(path.join(root, 'package.json'));
const entries = [];
const visited = new Set();
function resolvePackage(name, parent) {
  const resolver = createRequire(path.join(parent, 'package.json'));
  for (const base of resolver.resolve.paths(name) || []) {
    const file = path.join(base, name, 'package.json');
    if (fs.existsSync(file)) return path.dirname(fs.realpathSync(file));
  }
}
function licenseFiles(folder) {
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(item => item.isFile() && /^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(item.name))
    .map(item => ({ name: item.name, text: fs.readFileSync(path.join(folder, item.name), 'utf8') }));
}
function visit(name, parent, optional = false) {
  const folder = resolvePackage(name, parent);
  if (!folder) { if (optional) return; throw new Error(`Missing license dependency: ${name}`); }
  if (visited.has(folder)) return;
  visited.add(folder);
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || pkg.licenses?.map(item => item.type).join(' OR ') || 'See included license notices';
  const notices = licenseFiles(folder);
  entries.push({ name: pkg.name, version: pkg.version, license, notices });
  if (pkg.name === '@colorhythm/libraw-wasm') {
    entries.push({ name: 'LibRaw', version: 'Bundled with ' + pkg.version, license: 'CDDL-1.0 OR LGPL-2.1-only', notices: licenseFiles(path.join(folder, 'LibRaw')) });
  }
  if (pkg.name === 'electron') return; // Its npm installer is not part of the running application.
  if (pkg.name.startsWith('exiftool-vendored.')) {
    entries.push({ name: 'ExifTool', version: pkg.version, license: 'Perl Artistic License OR GNU GPL (same terms as Perl)', notices: fs.existsSync(path.join(folder, 'bin', 'LICENSE')) ? licenseFiles(path.join(folder, 'bin')) : notices });
  }
  if (pkg.name.startsWith('@img/sharp-libvips-')) {
    const readme = fs.readFileSync(path.join(folder, 'README.md'), 'utf8');
    notices.push({ name: 'Bundled native library licenses', text: readme });
    const versions = JSON.parse(fs.readFileSync(path.join(folder, 'versions.json'), 'utf8'));
    const aliases = { libarchive: 'archive', libexif: 'exif', libffi: 'ffi', libheif: 'heif', libimagequant: 'imagequant', libpng: 'png', librsvg: 'rsvg', libtiff: 'tiff', libultrahdr: 'uhdr', libvips: 'vips', libwebp: 'webp', libxml2: 'xml2' };
    for (const line of readme.split('\n')) {
      const row = line.match(/^\|\s*([\w-]+)\s*\|\s*(.+?)\s*\|$/);
      if (!row) continue;
      const version = versions[aliases[row[1]] || row[1]];
      if (version) entries.push({ name: row[1], version, license: row[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), notices: [] });
    }
  }
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies || {}));
  for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, folder, optionalNames.has(dependency));
  for (const dependency of optionalNames) if (!pkg.dependencies?.[dependency]) visit(dependency, folder, true);
}
for (const name of Object.keys(app.dependencies)) visit(name, root);
visit('electron', root);
const electron = resolvePackage('electron', root);
// Electron 45 installs its runtime lazily. A clean npm ci has no dist directory
// until its entry point resolves (and, if needed, downloads) the executable.
require(electron);
const electronDist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electron, 'dist');
const electronEntry = entries.find(entry => entry.name === 'electron');
electronEntry.notices.push(...licenseFiles(electronDist).filter(notice => !notice.name.endsWith('.html')));
const output = path.join(root, 'public', 'licenses');
fs.mkdirSync(output, { recursive: true });
const chromium = fs.readFileSync(path.join(electronDist, 'LICENSES.chromium.html'), 'utf8')
  .replace(/<link[^>]+chrome:[^>]*>/g, '')
  .replace('</head>', '<style>body{font:13px system-ui,sans-serif;line-height:1.6;margin:16px;background:#fff;color:#252525}a{color:#175bcc}.product{border-top:1px solid #dedede;padding:16px 0}.title{font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px ui-monospace,monospace}.show,.show-all,#print-link{display:none}</style></head>');
fs.writeFileSync(path.join(output, 'chromium.html'), chromium);
if (fs.existsSync(path.join(root, 'public/fonts/Inter-LICENSE.txt'))) entries.push({ name: 'Inter', version: '4.1', license: 'OFL-1.1', notices: [
  { name: 'Inter-LICENSE.txt', text: fs.readFileSync(path.join(root, 'public/fonts/Inter-LICENSE.txt'), 'utf8') },
] });
const manifest = {
  version: app.version,
  appLicense: fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'),
  software: entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
};
fs.writeFileSync(path.join(output, 'software.json'), JSON.stringify(manifest));
console.log(`Generated offline credits for ${entries.length} software components.`);
