import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionCache, type CachedMetadata } from './session-cache';
import { ExifTool } from 'exiftool-vendored';
import { mediaKind, type MediaFile, type Source, type ScanProgress } from '../shared/model';
export const exiftool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 20000 });
export const assets = new Map<string, { path: string; kind: MediaFile['kind']; orientation?: number; key: string }>();
export const indexedFiles = new Map<string, MediaFile>();
export const grants = new Set<string>();
let generation = 0;
let sessionCache: SessionCache | undefined;
export const getSessionCache = () => sessionCache;
export function cancelScan() { generation++; }
export async function authorize(folder: string): Promise<Source> {
  const resolved = await realpath(folder);
  if (!(await stat(resolved)).isDirectory()) throw new Error('Choose a folder.');
  grants.add(resolved);
  return { name: path.basename(resolved) || resolved, path: resolved };
}
export async function listSources(): Promise<Source[]> {
  const roots = process.platform === 'darwin' ? ['/Volumes'] : process.platform === 'win32'
    ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`)
    : ['/media', `/run/media/${process.env.USER ?? ''}`];
  const sources: Source[] = [];
  for (const root of roots) {
    try {
      const folders = process.platform === 'win32' ? [root] : (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => path.join(root, d.name));
      for (const folder of folders) sources.push(await authorize(folder));
    } catch { /* A missing mount point is normal. */ }
  }
  return sources;
}
function captureDate(value: unknown): string | undefined {
  const text = typeof value === 'object' && value !== null && 'toISOString' in value
    ? (value as { toISOString(): string }).toISOString() : typeof value === 'string' ? value : '';
  if (!text) return undefined;
  const normalized = text.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  return Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}
const field = (value: unknown) => value === undefined || value === null || value === '' ? undefined : String(value);
export async function scan(source: Source, progress: (data: ScanProgress) => void, warn: (message: string) => void = () => {}, refresh = false) {
  if (!source || typeof source.path !== 'string' || !grants.has(source.path)) throw new Error('Choose a folder or mounted card first.');
  const current = ++generation;
  assets.clear(); indexedFiles.clear();
  const paths: string[] = [];
  let skipped = 0;
  const walk = async (folder: string) => {
    if (generation !== current) return;
    try {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const full = path.join(folder, item.name);
        if (item.isDirectory()) await walk(full);
        else if (item.isFile() && mediaKind(path.extname(item.name))) paths.push(full);
      }
    } catch (error) { skipped++; if (generation === current) warn(`Could not read folder ${folder}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  progress({ source, total: 0, scanned: 0, files: [], done: false, skipped });
  const cache = await SessionCache.open(source.path, warn);
  if (generation !== current) return;
  if (refresh) cache.clearIndexAndAI();
  sessionCache = cache;
  await walk(source.path);
  if (generation !== current) return;
  const relativePath = (file: string) => path.relative(source.path, file).split(path.sep).join('/');
  cache.prune(new Set(paths.map(relativePath)));
  let scanned = 0;
  progress({ source, total: paths.length, scanned, files: [], done: false, skipped });
  // Bounded batches prevent thousands of EXIF tasks from queueing on a large card.
  for (let start = 0; start < paths.length; start += 8) {
    if (generation !== current) return;
    const files = (await Promise.all(paths.slice(start, start + 8).map(async full => {
      try {
        const info = await stat(full);
        const relative = relativePath(full);
        const extension = path.extname(full).slice(1).toLowerCase();
        const kind = mediaKind(extension)!;
        const cached = cache.getMetadata(relative, info.size, info.mtimeMs);
        if (cached) {
          const id = randomUUID();
          if (generation !== current) return null;
          if (cached.warning) warn(`${relative}: ${cached.warning}`);
          assets.set(id, { path: full, kind, orientation: cached.orientation, key: cache.fingerprint(relative, info.size, info.mtimeMs) });
          return { ...cached, id, name: path.basename(full), relativePath: relative, stem: path.basename(full, path.extname(full)), directory: path.dirname(full), kind, extension, size: info.size } satisfies MediaFile;
        }
        let tags: Record<string, unknown> = {};
        let warning: string | undefined;
        try { tags = await exiftool.read(full); } catch (error) {
          warning = `Metadata unavailable: ${error instanceof Error ? error.message : String(error)}`;
          if (generation === current) warn(`${path.relative(source.path, full)}: ${warning}`);
        }
        const capturedAt = captureDate(tags.DateTimeOriginal) ?? captureDate(tags.CreateDate) ?? captureDate(tags.MediaCreateDate);
        const id = randomUUID();
        if (generation !== current) return null;
        assets.set(id, { path: full, kind, orientation: Number(tags.Orientation) || undefined, key: cache.fingerprint(relative, info.size, info.mtimeMs) });
        const exposureText = String(tags.ExposureTime ?? '');
        const fraction = exposureText.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
        const exposure = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(tags.ExposureTime);
        const file: MediaFile = {
          id, name: path.basename(full), relativePath: relative,
          stem: path.basename(full, path.extname(full)), directory: path.dirname(full), kind, extension,
          size: info.size, capturedAt: capturedAt ?? info.mtime.toISOString(),
          timestampSource: capturedAt ? 'capture' : 'modified', camera: field(tags.Model),
          lens: field(tags.LensModel ?? tags.LensID ?? tags.Lens), iso: field(tags.ISO),
          aperture: field(tags.FNumber), shutter: exposure > 0 ? exposure < 1 ? `1/${Math.round(1 / exposure)} s` : `${exposure} s` : field(tags.ShutterSpeed),
          width: Number(tags.ImageWidth) || undefined, height: Number(tags.ImageHeight) || undefined,
          duration: typeof tags.Duration === 'number' ? tags.Duration : undefined, warning,
        };
        const { id: _id, name: _name, relativePath: _relative, stem: _stem, directory: _directory, kind: _kind, extension: _extension, size: _size, ...data } = file;
        cache.setFile(relative, info.size, info.mtimeMs, { ...data, orientation: Number(tags.Orientation) || undefined } satisfies CachedMetadata);
        return file;
      } catch (error) {
        if (generation !== current) return null;
        cache.remove(relativePath(full)); skipped++;
        warn(`Could not read ${relativePath(full)}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }))).filter((file): file is NonNullable<typeof file> => file !== null);
    if (generation !== current) return;
    for (const file of files) indexedFiles.set(file.id, file);
    scanned += Math.min(8, paths.length - start);
    await cache.save();
    if (generation !== current) return;
    progress({ source, total: paths.length, scanned, files, done: scanned === paths.length, skipped });
  }
  if (!paths.length && generation === current) { await cache.save(); progress({ source, total: 0, scanned: 0, files: [], done: true, skipped }); }
}
