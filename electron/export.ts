import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportProgress, ExportResult } from '../shared/model';
export interface ExportAsset { path: string }
export class ExportService {
  private destination?: string;
  private cancelled = false;
  private job?: Promise<ExportResult>;
  constructor(private preferences: string, private pictures: string) {}
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
    this.destination = resolved;
    return resolved;
  }
  cancel() { this.cancelled = true; }
  async stop() { this.cancel(); await this.job; }
  async export(assets: ExportAsset[], progress: (value: ExportProgress) => void): Promise<ExportResult> {
    if (this.busy) throw new Error('An export is already running.');
    if (!assets.length) throw new Error('Select at least one capture to export.');
    this.cancelled = false;
    const work = async (): Promise<ExportResult> => {
      const destination = await this.getLocation();
      await mkdir(destination, { recursive: true });
      const result: ExportResult = { copied: 0, total: assets.length, cancelled: false, destination, failures: [] };
      for (const asset of assets) {
        if (this.cancelled) { result.cancelled = true; break; }
        const name = path.basename(asset.path);
        progress({ copied: result.copied, total: assets.length, current: name });
        try { await copyUnique(asset.path, destination); result.copied++; }
        catch (error) { result.failures.push({ name, message: error instanceof Error ? error.message : String(error) }); }
      }
      result.cancelled ||= this.cancelled;
      progress({ copied: result.copied, total: assets.length, current: '' });
      return result;
    };
    this.job = work();
    try { return await this.job; } finally { this.job = undefined; }
  }
}
export async function copyUnique(source: string, destination: string): Promise<string> {
  const extension = path.extname(source);
  const stem = path.basename(source, extension);
  for (let suffix = 0; ; suffix++) {
    const target = path.join(destination, `${stem}${suffix ? ` (${suffix})` : ''}${extension}`);
    try { await copyFile(source, target, constants.COPYFILE_EXCL); return target; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
