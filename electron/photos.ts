import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mediaKind, type ExportProgress, type ExportResult } from '../shared/model';
import type { ExportAsset } from './export';
const exec = promisify(execFile);
export const IMPORT_PHOTOS_SCRIPT = `on run argv
  set originalFiles to {}
  repeat with originalPath in argv
    set end of originalFiles to POSIX file (contents of originalPath)
  end repeat
  tell application id "com.apple.Photos"
    set importedItems to import originalFiles skip check duplicates false
    return count of importedItems
  end tell
end run`;
export type PhotosRunner = (paths: string[]) => Promise<number>;
export const importPhotos: PhotosRunner = async paths => {
  try {
    // Filenames are argv data, never interpolated into AppleScript or a shell.
    const { stdout } = await exec('/usr/bin/osascript', ['-e', IMPORT_PHOTOS_SCRIPT, '--', ...paths], { timeout: 300000, maxBuffer: 1024 * 1024 });
    const count = /^\d+$/.test(stdout.trim()) ? Number(stdout.trim()) : NaN;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Photos did not return a valid import count. Check Photos before retrying.');
    return count;
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    if (detail.includes('-1743')) throw new Error('Photos permission was denied. Allow Photo Proofer to control Photos in System Settings > Privacy & Security > Automation, then retry.');
    throw new Error(`Photos could not confirm the import. Some files may already have been imported; check Photos before retrying. ${detail}`);
  }
};
export function photosBatches(assets: ExportAsset[], limit = 40): ExportAsset[][] {
  const groups = new Map<string, ExportAsset[]>();
  for (const asset of assets) {
    const extension = path.extname(asset.path);
    const kind = mediaKind(extension);
    const key = kind === 'raw' || kind === 'jpeg' ? path.join(path.dirname(asset.path), path.basename(asset.path, extension).toLowerCase()) : asset.path;
    const group = groups.get(key) ?? []; group.push(asset); groups.set(key, group);
  }
  const batches: ExportAsset[][] = []; let batch: ExportAsset[] = [];
  for (const group of groups.values()) {
    if (batch.length && batch.length + group.length > limit) { batches.push(batch); batch = []; }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export class PhotosExporter {
  private cancelled = false;
  private job?: Promise<ExportResult>;
  constructor(private platform = process.platform as string, private runner: PhotosRunner = importPhotos) {}
  get busy() { return Boolean(this.job); }
  cancel() { this.cancelled = true; }
  async stop() { this.cancel(); await this.job; }
  async export(assets: ExportAsset[], progress: (value: ExportProgress) => void): Promise<ExportResult> {
    if (this.platform !== 'darwin') throw new Error('Export to Photos is available only on macOS.');
    if (this.busy) throw new Error('A Photos import is already running.');
    if (!assets.length) throw new Error('Select at least one capture to export.');
    this.cancelled = false;
    const originals = [...new Map(assets.map(asset => [asset.path, asset])).values()];
    const work = async (): Promise<ExportResult> => {
      const result: ExportResult = { target: 'photos', copied: 0, total: originals.length, importedItems: 0, cancelled: false, destination: 'Photos', failures: [] };
      for (const batch of photosBatches(originals)) {
        if (this.cancelled) { result.cancelled = true; break; }
        progress({ copied: result.copied, total: result.total, current: `Photos: ${batch.length} original files` });
        try {
          result.importedItems! += await this.runner(batch.map(asset => asset.path));
          result.copied += batch.length;
          progress({ copied: result.copied, total: result.total, current: '' });
        } catch (error) {
          result.failures.push({ name: batch.map(asset => path.basename(asset.path)).join(', '), message: error instanceof Error ? error.message : String(error) });
          break; // Avoid repeated permission prompts or retrying an uncertain native import.
        }
      }
      result.cancelled ||= this.cancelled;
      return result;
    };
    this.job = work();
    try { return await this.job; } finally { this.job = undefined; }
  }
}
