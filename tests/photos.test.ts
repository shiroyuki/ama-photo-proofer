import { describe, expect, it, vi } from 'vitest';
import { PhotosExporter, photosBatches, IMPORT_PHOTOS_SCRIPT } from '../electron/photos';
const originals = [{ path: '/card/A.JPG' }, { path: '/card/A.DNG' }, { path: '/card/B.MOV' }];
describe('Photos export', () => {
  it('is macOS-only and never calls the native bridge on other platforms', async () => {
    const runner = vi.fn(async () => 0); const exporter = new PhotosExporter('linux', runner);
    await expect(exporter.export(originals, () => {})).rejects.toThrow('only on macOS'); expect(runner).not.toHaveBeenCalled();
  });
  it('keeps JPEG/RAW pairs together even at a batch boundary', () => {
    expect(photosBatches(originals, 1).map(batch => batch.map(item => item.path))).toEqual([['/card/A.JPG', '/card/A.DNG'], ['/card/B.MOV']]);
  });
  it('passes all originals as data, deduplicates requests and reports native media-item counts', async () => {
    const runner = vi.fn(async () => 2); const exporter = new PhotosExporter('darwin', runner); const progress = vi.fn();
    const result = await exporter.export([...originals, originals[0]], progress);
    expect(runner).toHaveBeenCalledWith(originals.map(asset => asset.path));
    expect(result).toMatchObject({ target: 'photos', copied: 3, total: 3, importedItems: 2, cancelled: false, failures: [] });
    expect(IMPORT_PHOTOS_SCRIPT).toContain('skip check duplicates false');
    expect(IMPORT_PHOTOS_SCRIPT).toContain('POSIX file (contents of originalPath)');
    const unusual = '/card/quoted " photo \' with $ signs.JPG';
    await exporter.export([{ path: unusual }], () => {}); expect(runner).toHaveBeenLastCalledWith([unusual]);
  });
  it('stops between batches without interrupting an import already submitted to Photos', async () => {
    const runner = vi.fn(async () => 40); const exporter = new PhotosExporter('darwin', runner);
    const assets = Array.from({ length: 50 }, (_, index) => ({ path: `/card/${index}.JPG` }));
    const result = await exporter.export(assets, progress => { if (progress.copied) exporter.cancel(); });
    expect(runner).toHaveBeenCalledTimes(1); expect(result.copied).toBe(40); expect(result.cancelled).toBe(true);
  });
  it('reports permission/native failures and does not repeatedly retry Photos', async () => {
    const runner = vi.fn(async () => { throw new Error('Photos permission denied'); }); const exporter = new PhotosExporter('darwin', runner);
    const result = await exporter.export(originals, () => {});
    expect(result.copied).toBe(0); expect(result.failures[0].message).toContain('permission denied'); expect(runner).toHaveBeenCalledTimes(1);
  });
  it('blocks concurrent imports and empty selections', async () => {
    let finish!: (count: number) => void;
    const exporter = new PhotosExporter('darwin', () => new Promise(resolve => { finish = resolve; }));
    await expect(exporter.export([], () => {})).rejects.toThrow('at least one');
    const job = exporter.export(originals, () => {});
    await expect(exporter.export(originals, () => {})).rejects.toThrow('already running');
    finish(2); await job; expect(exporter.busy).toBe(false);
  });
});
