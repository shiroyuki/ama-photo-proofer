import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LibraryPreferences } from '../electron/library-settings';
let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(os.tmpdir(), 'library-settings-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
it('persists custom event gaps and bookmarks across instances', async () => {
  const file = path.join(folder, 'settings.json'), preferences = new LibraryPreferences(file); await preferences.initialize();
  expect(preferences.get()).toEqual({ eventGapMinutes: 30, bookmarks: [] });
  await preferences.setGap(60); await preferences.toggleBookmark({ name: 'Card', path: path.join(folder, 'card') });
  const restored = new LibraryPreferences(file); await restored.initialize();
  expect(restored.get()).toEqual({ eventGapMinutes: 60, bookmarks: [{ name: 'Card', path: path.join(folder, 'card') }] });
});
it('serializes concurrent preference changes and allows removing an unavailable bookmark', async () => {
  const preferences = new LibraryPreferences(path.join(folder, 'settings.json')); await preferences.initialize();
  const bookmark = { name: 'Disconnected', path: path.join(folder, 'unmounted') };
  await Promise.all([preferences.setGap(10), preferences.toggleBookmark(bookmark)]);
  expect(preferences.get().eventGapMinutes).toBe(10); expect(preferences.get().bookmarks).toHaveLength(1);
  await preferences.toggleBookmark(bookmark); expect(preferences.get().bookmarks).toHaveLength(0);
});
it('ignores malformed settings and rejects out-of-range gaps without changing preferences', async () => {
  const file = path.join(folder, 'settings.json'); await writeFile(file, JSON.stringify({ eventGapMinutes: -2, bookmarks: [{ name: 'bad', path: '../relative' }] }));
  const preferences = new LibraryPreferences(file); await preferences.initialize(); expect(preferences.get()).toEqual({ eventGapMinutes: 30, bookmarks: [] });
  for (const gap of [0, -1, 1.5, 10081, NaN]) expect(() => preferences.setGap(gap)).toThrow('whole-number');
});
