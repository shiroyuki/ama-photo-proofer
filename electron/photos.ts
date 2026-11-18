import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ExportProgress, ExportResult } from '../shared/model';
import { captureGroups, type ExportAsset } from './export-plan';
const exec = promisify(execFile);
// Data is a single JSON argv value; paths, album names and labels never become script source.
export const IMPORT_PHOTOS_SCRIPT = `function run(argv) {
  var data = JSON.parse(argv[0]);
  var photos = Application('com.apple.Photos');
  var matches = photos.albums.whose({name: data.event.name})();
  var album = matches.length ? matches[0] : photos.make({new: 'album', named: data.event.name});
  var result = {importedItems: 0, processedFiles: 0, failures: []};
  for (var g = 0; g < data.captures.length; g++) {
    var capture = data.captures[g];
    try {
      var items = photos.import(capture.paths.map(function(file) { return Path(file); }), {into: album, skipCheckDuplicates: false});
      result.importedItems += items.length;
      result.processedFiles += capture.paths.length;
      if (!items.length && capture.labels.length) result.failures.push({name: capture.name, message: 'Photos skipped an existing capture. Its labels could not be applied safely; existing keywords were kept.'});
      for (var i = 0; i < items.length; i++) {
        if (!capture.labels.length) continue;
        try {
          var merged = (items[i].keywords() || []).slice();
          capture.labels.forEach(function(label) { if (merged.indexOf(label) < 0) merged.push(label); });
          items[i].keywords = merged;
        } catch (error) { result.failures.push({name: capture.name, message: 'Imported, but labels could not be saved as Photos keywords: ' + String(error)}); }
      }
    } catch (error) { result.failures.push({name: capture.name, message: 'Photos could not confirm this import. Check Photos before retrying: ' + String(error)}); break; }
  }
  return JSON.stringify(result);
}`;
export interface PhotosBatchResult { importedItems: number; processedFiles: number; failures: { name: string; message: string }[] }
export type PhotosRunner = (assets: ExportAsset[]) => Promise<PhotosBatchResult>;
export function photosPayload(assets: ExportAsset[]) {
  return { event: assets[0].event, captures: captureGroups(assets).map(group => ({ name: path.basename(group[0].path), paths: group.map(asset => asset.path), labels: [...new Set(group.flatMap(asset => asset.labels))] })) };
}
export const importPhotos: PhotosRunner = async assets => {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', IMPORT_PHOTOS_SCRIPT, '--', JSON.stringify(photosPayload(assets))], { timeout: 300000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim()) as PhotosBatchResult;
    if (!Number.isSafeInteger(result.importedItems) || result.importedItems < 0 || !Number.isSafeInteger(result.processedFiles) || result.processedFiles < 0 || result.processedFiles > assets.length || !Array.isArray(result.failures) || result.failures.some(failure => typeof failure?.name !== 'string' || typeof failure?.message !== 'string')) throw new Error('Photos did not return a valid result. Check Photos before retrying.');
    return result;
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    if (detail.includes('-1743')) throw new Error('Photos permission was denied. Allow Photo Proofer to control Photos in System Settings > Privacy & Security > Automation, then retry.');
    throw new Error(`Photos could not confirm the import. Some files may already have been imported; check Photos before retrying. ${detail}`);
  }
};
export function photosBatches(assets: ExportAsset[], limit = 40): ExportAsset[][] {
  const batches: ExportAsset[][] = []; let batch: ExportAsset[] = [];
  for (const group of captureGroups(assets)) {
    if (batch.length && (batch.length + group.length > limit || batch[0].event.name !== group[0].event.name)) { batches.push(batch); batch = []; }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch); return batches;
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
        progress({ copied: result.copied, total: result.total, current: `${batch[0].event.name}: ${batch.length} original files` });
        try {
          const imported = await this.runner(batch);
          result.importedItems! += imported.importedItems; result.copied += imported.processedFiles; result.failures.push(...imported.failures);
          progress({ copied: result.copied, total: result.total, current: '' });
          if (imported.failures.length) break;
        } catch (error) { result.failures.push({ name: batch.map(asset => path.basename(asset.path)).join(', '), message: error instanceof Error ? error.message : String(error) }); break; }
      }
      result.cancelled ||= this.cancelled; return result;
    };
    this.job = work(); try { return await this.job; } finally { this.job = undefined; }
  }
}
