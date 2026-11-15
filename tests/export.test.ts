import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExportService } from '../electron/export';
let temp: string;
beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'ama-export-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
describe('original file export', () => {
  it('defaults to Pictures and remembers an explicitly chosen destination across instances', async () => {
    const preferences = path.join(temp, 'settings/export.json');
    const pictures = path.join(temp, 'Pictures'); const chosen = path.join(temp, 'Chosen'); await mkdir(chosen);
    const service = new ExportService(preferences, pictures);
    expect(await service.getLocation()).toBe(pictures); await service.setLocation(chosen);
    expect(await new ExportService(preferences, pictures).getLocation()).toBe(await realpath(chosen));
  });
  it('copies every original and preserves destination collisions and source bytes', async () => {
    const source = path.join(temp, 'card'); const target = path.join(temp, 'Pictures'); await mkdir(source); await mkdir(target);
    await writeFile(path.join(source, 'A.JPG'), 'jpeg'); await writeFile(path.join(source, 'A.DNG'), 'raw'); await writeFile(path.join(target, 'A.JPG'), 'existing');
    const service = new ExportService(path.join(temp, 'settings.json'), target);
    const result = await service.export(['A.JPG', 'A.DNG'].map(name => ({ path: path.join(source, name) })), () => {});
    expect(result.copied).toBe(2); expect(result.failures).toEqual([]);
    expect(await readFile(path.join(target, 'A.JPG'), 'utf8')).toBe('existing');
    expect(await readFile(path.join(target, 'A (1).JPG'), 'utf8')).toBe('jpeg');
    expect(await readFile(path.join(target, 'A.DNG'), 'utf8')).toBe('raw');
    expect(await readFile(path.join(source, 'A.JPG'), 'utf8')).toBe('jpeg');
  });
  it('reports missing source files while continuing with readable originals', async () => {
    const good = path.join(temp, 'good.JPG'); await writeFile(good, 'good');
    const service = new ExportService(path.join(temp, 'settings.json'), path.join(temp, 'Pictures'));
    const result = await service.export([{ path: path.join(temp, 'missing.JPG') }, { path: good }], () => {});
    expect(result.copied).toBe(1); expect(result.failures[0].name).toBe('missing.JPG');
  });
  it('cancels after the current file and rejects overlapping exports', async () => {
    const source = path.join(temp, 'A.JPG'); await writeFile(source, 'photo');
    const target = path.join(temp, 'Pictures'); const service = new ExportService(path.join(temp, 'settings.json'), target);
    const job = service.export([{ path: source }, { path: source }], () => service.cancel());
    await expect(service.export([{ path: source }], () => {})).rejects.toThrow('already running');
    expect((await job).cancelled).toBe(true); expect(await readdir(target)).toHaveLength(1);
  });
});
