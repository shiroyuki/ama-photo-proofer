import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CACHE_NAME, SessionCache } from '../electron/session-cache';
let folder: string;
const metadata = { capturedAt: '2026-11-12T23:45:00', timestampSource: 'capture' as const, camera: 'Test Camera' };
beforeEach(async () => { folder = await mkdtemp(path.join(os.tmpdir(), 'proofing-cache-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
it('persists metadata, labels and decisions using portable relative paths', async () => {
  const cache = await SessionCache.open(folder);
  cache.setFile('DCIM/A.JPG', 100, 123, metadata);
  const key = cache.fingerprint('DCIM/A.JPG', 100, 123);
  cache.setTags(key, ['Lake', 'lake']); cache.setReview(key, 'accepted');
  expect(await cache.save()).toBe(true);
  const restored = await SessionCache.open(folder);
  expect(restored.getMetadata('DCIM/A.JPG', 100, 123)).toEqual(metadata);
  expect(restored.getTags(key)).toEqual(['lake']); expect(restored.getReview(key)).toBe('accepted');
  expect(restored.getMetadata('DCIM/A.JPG', 101, 123)).toBeUndefined();
  restored.setFile('DCIM/A.JPG', 101, 124, metadata);
  expect(restored.getTags(key)).toBeUndefined(); expect(restored.getReview(restored.fingerprint('DCIM/A.JPG', 101, 124))).toBeUndefined();
  expect(await readFile(path.join(folder, CACHE_NAME), 'utf8')).not.toContain(folder);
});
it('prunes missing files and keeps only records for existing targets', async () => {
  const cache = await SessionCache.open(folder);
  cache.setFile('A.JPG', 1, 1, metadata); cache.setFile('gone.JPG', 1, 1, metadata);
  cache.prune(new Set(['A.JPG'])); await cache.save();
  expect(Object.keys(JSON.parse(await readFile(path.join(folder, CACHE_NAME), 'utf8')).files)).toEqual(['A.JPG']);
});
it('resets old schemas with a warning and writes the current schema', async () => {
  await writeFile(path.join(folder, CACHE_NAME), JSON.stringify({ schemaVersion: 0, files: { 'old.JPG': {} } }));
  const warn = vi.fn(); const cache = await SessionCache.open(folder, warn);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('reset'));
  cache.setFile('new.JPG', 1, 1, metadata); await cache.save();
  expect(JSON.parse(await readFile(path.join(folder, CACHE_NAME), 'utf8'))).toMatchObject({ schemaVersion: 1, files: { 'new.JPG': { metadata } } });
});
it('preserves newer schemas and warns instead of overwriting them', async () => {
  const contents = '{"schemaVersion":999,"files":{}}'; await writeFile(path.join(folder, CACHE_NAME), contents);
  const warn = vi.fn(); const cache = await SessionCache.open(folder, warn);
  cache.setFile('A.JPG', 1, 1, metadata); expect(await cache.save()).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('newer schema'));
  expect(await readFile(path.join(folder, CACHE_NAME), 'utf8')).toBe(contents);
});
it('rebuilds malformed JSON and ignores unsafe cache paths', async () => {
  await writeFile(path.join(folder, CACHE_NAME), '{broken');
  const warn = vi.fn(); const broken = await SessionCache.open(folder, warn); await broken.save(); expect(warn).toHaveBeenCalled();
  await writeFile(path.join(folder, CACHE_NAME), JSON.stringify({ schemaVersion: 1, files: { '../outside.JPG': { size: 1, modifiedAt: 1, metadata }, 'A.JPG': { size: 1, modifiedAt: 1, metadata } } }));
  const cache = await SessionCache.open(folder); await cache.save();
  expect(Object.keys(JSON.parse(await readFile(path.join(folder, CACHE_NAME), 'utf8')).files)).toEqual(['A.JPG']);
});
it('serializes overlapping saves without dropping subsequent decisions', async () => {
  const cache = await SessionCache.open(folder); cache.setFile('A.JPG', 1, 1, metadata);
  const first = cache.save(); cache.setReview(cache.fingerprint('A.JPG', 1, 1), 'rejected');
  await Promise.all([first, cache.save()]);
  expect((await SessionCache.open(folder)).getReview(cache.fingerprint('A.JPG', 1, 1))).toBe('rejected');
});
it('warns and retains in-memory decisions if the card disconnects', async () => {
  const warn = vi.fn(); const cache = await SessionCache.open(folder, warn);
  cache.setFile('A.JPG', 1, 1, metadata); cache.setReview(cache.fingerprint('A.JPG', 1, 1), 'accepted');
  await rm(folder, { recursive: true }); expect(await cache.save()).toBe(false);
  expect(cache.getReview(cache.fingerprint('A.JPG', 1, 1))).toBe('accepted');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
});

it('preserves existing reviews and metadata when adding optional event-summary records to schema 1', async () => {
  const contents = { schemaVersion: 1, files: { 'A.JPG': { size: 1, modifiedAt: 1, metadata, review: 'accepted' } } };
  await writeFile(path.join(folder, CACHE_NAME), JSON.stringify(contents)); const warn = vi.fn();
  const cache = await SessionCache.open(folder, warn); cache.setEventSummary('a'.repeat(64), 'forest-river'); await cache.save();
  const restored = await SessionCache.open(folder, warn);
  expect(restored.getReview(restored.fingerprint('A.JPG', 1, 1))).toBe('accepted');
  expect(restored.getMetadata('A.JPG', 1, 1)).toEqual(metadata); expect(restored.getEventSummary('a'.repeat(64))).toBe('forest-river'); expect(warn).not.toHaveBeenCalled();
});

it('clears cached indexing and AI output for reindexing while preserving review decisions', async () => {
  const cache = await SessionCache.open(folder); cache.setFile('A.JPG', 1, 1, metadata);
  const key = cache.fingerprint('A.JPG', 1, 1); cache.setReview(key, 'accepted'); cache.setTags(key, ['forest']); cache.setEventSummary('b'.repeat(64), 'forest-walk');
  cache.clearIndexAndAI(); await cache.save();
  const restored = await SessionCache.open(folder);
  expect(restored.getMetadata('A.JPG', 1, 1)).toBeUndefined(); expect(restored.getTags(key)).toBeUndefined(); expect(restored.getEventSummary('b'.repeat(64))).toBeUndefined();
  expect(restored.getReview(key)).toBe('accepted'); restored.setFile('A.JPG', 1, 1, metadata); expect(restored.getReview(key)).toBe('accepted');
});
