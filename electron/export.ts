import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { summarySlug } from '../shared/summary';
import type { ExportProgress, ExportResult } from '../shared/model';
import { captureGroups, type ExportAsset, type ExportEvent } from './export-plan';
export type { ExportAsset } from './export-plan';
export const EXPORT_METADATA_NAME = 'photo-proofing-export.json';
export class ExportService {
  private destination?: string;
  private cancelled = false;
  private job?: Promise<ExportResult>;
  private summaryController?: AbortController;
  constructor(private preferences: string, private pictures: string, private readExif: (file: string) => Promise<Record<string, unknown>>, private summarize?: (assets: ExportAsset[], signal: AbortSignal) => Promise<string | undefined>) {}
  get busy() { return Boolean(this.job); }
  async getLocation(): Promise<string> {
    if (!this.destination) {
      try {
        const saved = JSON.parse(await readFile(this.preferences, 'utf8'));
        if (typeof saved.destination === 'string' && path.isAbsolute(saved.destination)) this.destination = saved.destination;
      } catch { /* First launch or invalid settings: use Pictures. */ }
    }
    return this.destination ?? this.pictures;
  }
  async setLocation(folder: string): Promise<string> {
    if (this.busy) throw new Error('Wait for the current export to finish.');
    const resolved = await realpath(folder);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Choose a destination folder.');
    await mkdir(path.dirname(this.preferences), { recursive: true });
    const temporary = `${this.preferences}.tmp`;
    await writeFile(temporary, JSON.stringify({ destination: resolved }));
    await rename(temporary, this.preferences);
    this.destination = resolved; return resolved;
  }
  cancel() { this.cancelled = true; this.summaryController?.abort(); }
  async stop() { this.cancel(); await this.job; }
  async export(assets: ExportAsset[], progress: (value: ExportProgress) => void, layout: 'events' | 'flat' = 'events', summarizeAccepted = false): Promise<ExportResult> {
    if (this.busy) throw new Error('An export is already running.');
    if (!assets.length) throw new Error('Select at least one capture to export.');
    this.cancelled = false;
    const work = async (): Promise<ExportResult> => {
      const destination = await this.getLocation(); await mkdir(destination, { recursive: true });
      const originals = [...new Map(assets.map(asset => [asset.path, asset])).values()];
      const result: ExportResult = { copied: 0, total: originals.length, cancelled: false, destination, failures: [] };
      const events = new Map<string, { folder: string; event?: ExportEvent; summary?: string; summarySource?: 'ollama' | 'labels-fallback'; summaryWarning?: string; files: Record<string, unknown>[] }>();
      for (const capture of captureGroups(originals)) {
        if (this.cancelled) { result.cancelled = true; break; }
        const event = capture[0].event;
        const key = layout === 'events' ? event.name : 'flat';
        let output = events.get(key);
        try {
          if (!output) {
            let summary: string | undefined, summarySource: 'ollama' | 'labels-fallback' | undefined, summaryWarning: string | undefined;
            if (layout === 'events' && summarizeAccepted && this.summarize) {
              const eventAssets = originals.filter(asset => asset.event.name === event.name);
              this.summaryController = new AbortController();
              progress({ copied: result.copied, total: result.total, current: `Summarizing ${event.name}…` });
              try {
                const generated = await this.summarize(eventAssets, this.summaryController.signal);
                if (generated !== undefined) {
                  summary = summarySlug(generated);
                  if (!summary) throw new Error('Ollama returned an empty summary.');
                  summarySource = 'ollama';
                }
              } catch (error) {
                if (this.cancelled) { result.cancelled = true; break; }
                summary = summarySlug(captureGroups(eventAssets).flatMap(group => group[0].labels).slice(0, 5).join('-')) ?? 'accepted-photos';
                summarySource = 'labels-fallback';
                summaryWarning = `Ollama summary unavailable; a fallback folder name was used. ${error instanceof Error ? error.message : String(error)}`;
                (result.warnings ??= []).push(`${event.name}: ${summaryWarning}`);
              } finally { this.summaryController = undefined; }
            }
            if (this.cancelled) { result.cancelled = true; break; }
            const folderName = summary ?? event.name;
            output = { folder: layout === 'events' ? await uniqueDirectory(destination, folderName, Boolean(summary)) : destination, event: layout === 'events' ? event : undefined, summary, summarySource, summaryWarning, files: [] };
            events.set(key, output);
          }
          const suffix = await captureSuffix(capture, output.folder);
          for (const asset of capture) {
            if (this.cancelled) { result.cancelled = true; break; }
            const name = exportedName(asset.path, suffix);
            progress({ copied: result.copied, total: result.total, current: `${path.basename(output.folder)}/${name}` });
            try {
              let exif: Record<string, unknown> = {}, exifError: string | undefined;
              try { exif = await this.readExif(asset.path); }
              catch (error) { exifError = `EXIF metadata could not be read: ${error instanceof Error ? error.message : String(error)}`; }
              await copyFile(asset.path, path.join(output.folder, name), constants.COPYFILE_EXCL);
              result.copied++;
              output.files.push({ file: name, event: asset.event, sourcePath: asset.sourcePath, metadata: asset.metadata, labels: asset.labels, review: asset.review ?? null, exif, ...(exifError ? { exifError } : {}) });
              if (exifError) result.failures.push({ name, message: exifError });
            } catch (error) { result.failures.push({ name, message: error instanceof Error ? error.message : String(error) }); }
          }
        } catch (error) { result.failures.push({ name: event.name, message: error instanceof Error ? error.message : String(error) }); }
      }
      result.cancelled ||= this.cancelled;
      for (const output of events.values()) {
        const temporary = path.join(output.folder, `.${EXPORT_METADATA_NAME}.tmp`);
        try {
          const contents = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), event: output.event, summary: output.summary, summarySource: output.summarySource, summaryWarning: output.summaryWarning, folderName: path.basename(output.folder), cancelled: result.cancelled, files: output.files, failures: result.failures }, null, 2) + '\n';
          if (layout === 'flat') await writeUniqueMetadata(output.folder, contents);
          else {
            await writeFile(temporary, contents, { flag: 'wx' });
            await rename(temporary, path.join(output.folder, EXPORT_METADATA_NAME));
          }
        } catch (error) { result.failures.push({ name: `${path.basename(output.folder)}/${EXPORT_METADATA_NAME}`, message: `Metadata JSON could not be saved: ${error instanceof Error ? error.message : String(error)}` }); }
      }
      progress({ copied: result.copied, total: result.total, current: '' }); return result;
    };
    this.job = work(); try { return await this.job; } finally { this.job = undefined; }
  }
}
async function uniqueDirectory(destination: string, name: string, summarized = false): Promise<string> {
  if (!(summarized ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/).test(name)) throw new Error('Invalid event folder name.');
  for (let suffix = 0; ; suffix++) {
    const folder = path.join(destination, `${name}${suffix ? summarized ? `-${suffix + 1}` : ` (${suffix})` : ''}`);
    try { await mkdir(folder); return folder; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
function exportedName(source: string, suffix: number) {
  const extension = path.extname(source), stem = path.basename(source, extension);
  return `${stem}${suffix ? ` (${suffix})` : ''}${extension}`;
}
async function captureSuffix(capture: ExportAsset[], folder: string) {
  for (let suffix = 0; ; suffix++) {
    let collision = false;
    for (const asset of capture) {
      try { await lstat(path.join(folder, exportedName(asset.path, suffix))); collision = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!collision) return suffix;
  }
}

async function writeUniqueMetadata(folder: string, contents: string) {
  for (let suffix = 0; ; suffix++) {
    const file = path.join(folder, exportedName(EXPORT_METADATA_NAME, suffix));
    try { await writeFile(file, contents, { flag: 'wx' }); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
