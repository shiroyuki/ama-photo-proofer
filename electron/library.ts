import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExifTool } from 'exiftool-vendored';
import { mediaKind, type MediaFile, type Source, type ScanProgress } from '../shared/model';
export const exiftool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 20000 });
export const assets = new Map<string, { path: string; kind: MediaFile['kind']; orientation?: number; key: string }>();
export const grants = new Set<string>();
let generation = 0;
export function cancelScan() { generation++; }
export async function authorize(folder: string): Promise<Source> {
  const resolved = await realpath(folder);
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
export async function scan(source: Source, progress: (data: ScanProgress) => void) {
  if (!source || typeof source.path !== 'string' || !grants.has(source.path)) throw new Error('Choose a folder or mounted card first.');
  const current = ++generation;
  assets.clear();
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
    } catch { skipped++; }
  };
  progress({ source, total: 0, scanned: 0, files: [], done: false, skipped });
  await walk(source.path);
  let scanned = 0;
  progress({ source, total: paths.length, scanned, files: [], done: false, skipped });
  // Bounded batches prevent thousands of EXIF tasks from queueing on a large card.
  for (let start = 0; start < paths.length; start += 8) {
    if (generation !== current) return;
    const files = (await Promise.all(paths.slice(start, start + 8).map(async full => {
      try {
        const info = await stat(full);
        let tags: Record<string, unknown> = {};
        let warning: string | undefined;
        try { tags = await exiftool.read(full); } catch { warning = 'Metadata unavailable'; }
        const extension = path.extname(full).slice(1).toLowerCase();
        const kind = mediaKind(extension)!;
        const capturedAt = captureDate(tags.DateTimeOriginal) ?? captureDate(tags.CreateDate) ?? captureDate(tags.MediaCreateDate);
        const id = randomUUID();
        if (generation !== current) return null;
        assets.set(id, { path: full, kind, orientation: Number(tags.Orientation) || undefined, key: `${full}|${info.size}|${info.mtimeMs}` });
        const exposureText = String(tags.ExposureTime ?? '');
        const fraction = exposureText.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
        const exposure = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(tags.ExposureTime);
        return {
          id, name: path.basename(full), relativePath: path.relative(source.path, full),
          stem: path.basename(full, path.extname(full)), directory: path.dirname(full), kind, extension,
          size: info.size, capturedAt: capturedAt ?? info.mtime.toISOString(),
          timestampSource: capturedAt ? 'capture' : 'modified', camera: field(tags.Model),
          lens: field(tags.LensModel ?? tags.LensID ?? tags.Lens), iso: field(tags.ISO),
          aperture: field(tags.FNumber), shutter: exposure > 0 ? exposure < 1 ? `1/${Math.round(1 / exposure)} s` : `${exposure} s` : field(tags.ShutterSpeed),
          width: Number(tags.ImageWidth) || undefined, height: Number(tags.ImageHeight) || undefined,
          duration: typeof tags.Duration === 'number' ? tags.Duration : undefined, warning,
        } satisfies MediaFile;
      } catch { skipped++; return null; }
    }))).filter((file): file is NonNullable<typeof file> => file !== null);
    if (generation !== current) return;
    scanned += Math.min(8, paths.length - start);
    progress({ source, total: paths.length, scanned, files, done: scanned === paths.length, skipped });
  }
  if (!paths.length && generation === current) progress({ source, total: 0, scanned: 0, files: [], done: true, skipped });
}
