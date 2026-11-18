import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { PhotosExporter, photosBatches, photosPayload, IMPORT_PHOTOS_SCRIPT, type PhotosBatchResult } from '../electron/photos';
import { asset, event } from './export-fixture';
const originals = ['/card/A.JPG', '/card/A.DNG', '/card/B.MOV'].map(file => asset(file));
const result = (importedItems = 2, processedFiles = 3): PhotosBatchResult => ({ importedItems, processedFiles, failures: [] });
describe('Photos event and keyword export', () => {
  it('is macOS-only and does not call the native bridge elsewhere', async () => {
    const runner = vi.fn(async () => result());
    await expect(new PhotosExporter('linux', runner).export(originals, () => {})).rejects.toThrow('only on macOS'); expect(runner).not.toHaveBeenCalled();
  });
  it('keeps pairs and event albums together at batch boundaries', () => {
    expect(photosBatches(originals, 1).map(batch => batch.map(item => item.path))).toEqual([['/card/A.JPG', '/card/A.DNG'], ['/card/B.MOV']]);
    expect(photosBatches([originals[0], asset('/other/C.JPG', { event: { ...event, name: '2026-11-13_09-00-00' } })])).toHaveLength(2);
  });
  it('passes assets and labels as data and reports native item counts', async () => {
    const runner = vi.fn(async () => result()); const exporter = new PhotosExporter('darwin', runner);
    expect(await exporter.export([...originals, originals[0]], () => {})).toMatchObject({ copied: 3, importedItems: 2, failures: [] });
    expect(runner).toHaveBeenCalledWith(originals);
    expect(photosPayload(originals).captures).toHaveLength(2);
    expect(photosPayload(originals).captures[0]).toMatchObject({ paths: ['/card/A.JPG', '/card/A.DNG'], labels: ['landscape'] });
  });
  it('imports each capture into its event album and merges keywords onto every returned item', () => {
    let keywords = ['existing'];
    const item = { get keywords() { return () => keywords; }, set keywords(value: any) { keywords = value; } };
    const album = { id: 'event-album' }; const make = vi.fn(() => album), nativeImport = vi.fn(() => [item]);
    const context: any = { Application: () => ({ albums: { whose: () => () => [] }, make, import: nativeImport }), Path: (file: string) => file };
    vm.runInNewContext(IMPORT_PHOTOS_SCRIPT, context);
    const unusual = asset('/card/quoted " $() \\ file.JPG', { labels: ['landscape', 'existing'] });
    expect(JSON.parse(context.run([JSON.stringify(photosPayload([unusual]))]))).toMatchObject({ processedFiles: 1, importedItems: 1, failures: [] });
    expect(make).toHaveBeenCalledWith({ new: 'album', named: event.name });
    expect(nativeImport).toHaveBeenCalledWith([unusual.path], { into: album, skipCheckDuplicates: false });
    expect(keywords).toEqual(['existing', 'landscape']);
  });
  it('reports skipped duplicates and keyword failures without mislabelling unrelated media', () => {
    const context: any = { Application: () => ({ albums: { whose: () => () => [{}] }, import: () => [] }), Path: (file: string) => file };
    vm.runInNewContext(IMPORT_PHOTOS_SCRIPT, context);
    expect(JSON.parse(context.run([JSON.stringify(photosPayload(originals))])).failures[0].message).toContain('existing capture');
    context.Application = () => ({ albums: { whose: () => () => [{}] }, import: () => [{ keywords: () => { throw new Error('read only'); } }] });
    expect(JSON.parse(context.run([JSON.stringify(photosPayload(originals))])).failures[0].message).toContain('keywords');
  });
  it('cancels between batches and blocks overlapping imports', async () => {
    const runner = vi.fn(async () => result(40, 40)); const exporter = new PhotosExporter('darwin', runner);
    const job = exporter.export(Array.from({ length: 50 }, (_, index) => asset(`/card/${index}.JPG`)), progress => { if (progress.copied) exporter.cancel(); });
    await expect(exporter.export(originals, () => {})).rejects.toThrow('already running');
    expect(await job).toMatchObject({ copied: 40, cancelled: true }); expect(runner).toHaveBeenCalledTimes(1);
  });
  it('reports native and keyword failures while preserving confirmed import counts', async () => {
    const exporter = new PhotosExporter('darwin', async () => ({ ...result(), failures: [{ name: 'A.JPG', message: 'Keyword write failed' }] }));
    expect(await exporter.export(originals, () => {})).toMatchObject({ copied: 3, importedItems: 2, failures: [{ message: 'Keyword write failed' }] });
    await expect(exporter.export([], () => {})).rejects.toThrow('at least one');
    const failing = new PhotosExporter('darwin', async () => { throw new Error('permission denied'); });
    expect((await failing.export(originals, () => {})).failures[0].message).toContain('permission denied');
  });
});
