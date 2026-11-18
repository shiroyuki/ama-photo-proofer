import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExportService, EXPORT_METADATA_NAME } from '../electron/export';
import { mkdirSync } from 'node:fs';
import { asset, event } from './export-fixture';
let temp: string;
beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'ama-export-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
const exif = async () => ({ Model: 'Test Camera', ISO: 200, DateTimeOriginal: '2026:11:12 23:45:00', GPSLatitude: 13.7 });
const service = (target = path.join(temp, 'Pictures')) => new ExportService(path.join(temp, 'settings/export.json'), target, exif);
describe('event export with metadata sidecars', () => {
  it('defaults to Pictures and remembers the destination across instances', async () => {
    const chosen = path.join(temp, 'Chosen'); await mkdir(chosen);
    expect(await service().getLocation()).toBe(path.join(temp, 'Pictures')); await service().setLocation(chosen);
    expect(await service().getLocation()).toBe(await realpath(chosen));
  });
  it('copies originals per event, writes full metadata and labels, and preserves previous exports', async () => {
    const source = path.join(temp, 'card'); const target = path.join(temp, 'Pictures'); await mkdir(source);
    await writeFile(path.join(source, 'A.JPG'), 'jpeg'); await writeFile(path.join(source, 'A.DNG'), 'raw');
    const originals = ['A.JPG', 'A.DNG'].map(name => asset(path.join(source, name)));
    const result = await service(target).export(originals, () => {});
    expect(result.copied).toBe(2); expect(result.failures).toEqual([]);
    const folder = path.join(target, event.name);
    expect(await readFile(path.join(folder, 'A.JPG'), 'utf8')).toBe('jpeg'); expect(await readFile(path.join(folder, 'A.DNG'), 'utf8')).toBe('raw');
    const document = JSON.parse(await readFile(path.join(folder, EXPORT_METADATA_NAME), 'utf8'));
    expect(document).toMatchObject({ schemaVersion: 1, event, files: [{ file: 'A.JPG', labels: ['landscape'], review: 'accepted', exif: await exif() }, { file: 'A.DNG', labels: ['landscape'] }] });
    await service(target).export(originals, () => {});
    expect(await readFile(path.join(target, `${event.name} (1)`, 'A.JPG'), 'utf8')).toBe('jpeg');
    expect(await readFile(path.join(folder, EXPORT_METADATA_NAME), 'utf8')).toBe(JSON.stringify(document, null, 2) + '\n');
    expect(await readFile(path.join(source, 'A.JPG'), 'utf8')).toBe('jpeg');
  });
  it('renames both JPEG and RAW consistently when captures have the same basename', async () => {
    const one = path.join(temp, 'one'), two = path.join(temp, 'two'); await mkdir(one); await mkdir(two);
    await writeFile(path.join(one, 'A.JPG'), 'first'); await writeFile(path.join(two, 'A.JPG'), 'second'); await writeFile(path.join(two, 'A.DNG'), 'raw');
    const result = await service().export([asset(path.join(one, 'A.JPG')), asset(path.join(two, 'A.JPG')), asset(path.join(two, 'A.DNG'))], () => {});
    expect(result.failures).toEqual([]);
    const folder = path.join(temp, 'Pictures', event.name);
    expect(await readFile(path.join(folder, 'A (1).JPG'), 'utf8')).toBe('second'); expect(await readFile(path.join(folder, 'A (1).DNG'), 'utf8')).toBe('raw');
    expect(JSON.parse(await readFile(path.join(folder, EXPORT_METADATA_NAME), 'utf8')).files.map((file: any) => file.file)).toEqual(['A.JPG', 'A (1).JPG', 'A (1).DNG']);
  });
  it('reports missing originals and EXIF errors while retaining readable originals and explicit metadata errors', async () => {
    const good = path.join(temp, 'good.JPG'); await writeFile(good, 'good');
    const exporter = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'), async () => { throw new Error('bad metadata'); });
    const result = await exporter.export([asset(path.join(temp, 'missing.JPG')), asset(good)], () => {});
    expect(result.copied).toBe(1); expect(result.failures).toHaveLength(2);
    const document = JSON.parse(await readFile(path.join(temp, 'Pictures', event.name, EXPORT_METADATA_NAME), 'utf8'));
    expect(document.files).toHaveLength(1); expect(document.files[0].exifError).toContain('bad metadata');
  });
  it('stops after the current file, records partial output and rejects overlapping exports', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo'); const exporter = service();
    const other = path.join(temp, 'B.JPG'); await writeFile(other, 'second');
    const job = exporter.export([asset(source), asset(other)], () => exporter.cancel());
    await expect(exporter.export([asset(source)], () => {})).rejects.toThrow('already running');
    const result = await job; expect(result.cancelled).toBe(true); expect(result.copied).toBe(1);
    const folder = path.join(temp, 'Pictures', event.name);
    expect(await readdir(folder)).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(folder, EXPORT_METADATA_NAME), 'utf8'))).toMatchObject({ cancelled: true, files: [{ file: 'A.JPG' }] });
  });
  it('reports metadata sidecar write failures while retaining copied originals', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo'); let blocked = false;
    const result = await service().export([asset(source)], progress => {
      if (!blocked && progress.current) { mkdirSync(path.join(temp, 'Pictures', event.name, `.${EXPORT_METADATA_NAME}.tmp`)); blocked = true; }
    });
    expect(result.copied).toBe(1); expect(result.failures[0].message).toContain('Metadata JSON could not be saved');
  });
  it('exports a selection flat with collision-safe pairs and JSON while accepted layout remains per event', async () => {
    const source = path.join(temp, 'card'), target = path.join(temp, 'Pictures'); await mkdir(source); await mkdir(target);
    for (const file of ['A.JPG', 'A.DNG', 'B.JPG']) await writeFile(path.join(source, file), file);
    await writeFile(path.join(target, 'A.JPG'), 'existing original');
    await writeFile(path.join(target, EXPORT_METADATA_NAME), 'existing metadata');
    const nextEvent = { name: '2026-11-13_09-00-00', start: '2026-11-13T09:00:00', end: '2026-11-13T09:00:00' };
    const assets = [asset(path.join(source, 'A.JPG')), asset(path.join(source, 'A.DNG')), asset(path.join(source, 'B.JPG'), { event: nextEvent })];
    const exported = await service(target).export(assets, () => {}, 'flat');
    expect(exported.failures).toEqual([]); expect(exported.copied).toBe(3);
    expect(await readFile(path.join(target, 'A.JPG'), 'utf8')).toBe('existing original');
    expect(await readFile(path.join(target, 'A (1).JPG'), 'utf8')).toBe('A.JPG');
    expect(await readFile(path.join(target, 'A (1).DNG'), 'utf8')).toBe('A.DNG');
    expect(await readFile(path.join(target, EXPORT_METADATA_NAME), 'utf8')).toBe('existing metadata');
    const manifest = JSON.parse(await readFile(path.join(target, 'photo-proofing-export (1).json'), 'utf8'));
    expect(manifest.files.map((file: any) => file.event.name)).toEqual([event.name, event.name, nextEvent.name]);
    expect((await readdir(target, { withFileTypes: true })).some(file => file.isDirectory())).toBe(false);
    await service(target).export(assets, () => {}, 'flat');
    expect(await readFile(path.join(target, 'A (2).DNG'), 'utf8')).toBe('A.DNG');
    expect(JSON.parse(await readFile(path.join(target, 'photo-proofing-export (2).json'), 'utf8')).files).toHaveLength(3);
    await service(target).export(assets, () => {}, 'events');
    expect(await readFile(path.join(target, event.name, 'A.JPG'), 'utf8')).toBe('A.JPG');
    expect(await readFile(path.join(target, nextEvent.name, 'B.JPG'), 'utf8')).toBe('B.JPG');
  });
  it('adds one sanitized summary per accepted event and keeps repeated folder names hyphen-only', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo');
    const summarize = vi.fn(async () => 'Mountain Lake Sunrise!');
    const exporter = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'), exif, summarize);
    expect((await exporter.export([asset(source)], () => {}, 'events', true)).failures).toEqual([]);
    const folderName = 'mountain-lake-sunrise';
    const document = JSON.parse(await readFile(path.join(temp, 'Pictures', folderName, EXPORT_METADATA_NAME), 'utf8'));
    expect(document).toMatchObject({ summary: 'mountain-lake-sunrise', summarySource: 'ollama', folderName });
    await exporter.export([asset(source)], () => {}, 'events', true);
    expect(await readFile(path.join(temp, 'Pictures', `${folderName}-2`, 'A.JPG'), 'utf8')).toBe('photo');
    expect(summarize).toHaveBeenCalledTimes(2);
  });
  it('leaves selected and explicit event exports alone and respects disabled integration', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo'); const summarize = vi.fn(async () => undefined);
    const exporter = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'), exif, summarize);
    await exporter.export([asset(source)], () => {}, 'flat'); await exporter.export([asset(source)], () => {}, 'events');
    expect(summarize).not.toHaveBeenCalled();
    await exporter.export([asset(source)], () => {}, 'events', true);
    expect(await readFile(path.join(temp, 'Pictures', `${event.name} (1)`, 'A.JPG'), 'utf8')).toBe('photo');
  });
  it('falls back without losing originals if a summary fails and records a visible warning', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo');
    const exporter = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'), exif, async () => { throw new Error('model busy'); });
    const result = await exporter.export([asset(source)], () => {}, 'events', true);
    expect(result.copied).toBe(1); expect(result.failures).toEqual([]); expect(result.warnings?.[0]).toContain('fallback');
    const document = JSON.parse(await readFile(path.join(temp, 'Pictures', 'landscape', EXPORT_METADATA_NAME), 'utf8'));
    expect(document).toMatchObject({ summary: 'landscape', summarySource: 'labels-fallback' }); expect(document.summaryWarning).toContain('model busy');
  });
  it('cancels a pending summary before creating a folder or copying files', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo');
    let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
    const exporter = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'), exif, (_assets, signal) => {
      begin(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
    });
    const job = exporter.export([asset(source)], () => {}, 'events', true); await started; exporter.cancel();
    expect(await job).toMatchObject({ copied: 0, cancelled: true, failures: [] }); expect(await readdir(path.join(temp, 'Pictures'))).toEqual([]);
  });
});
