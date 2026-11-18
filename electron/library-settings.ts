import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EVENT_GAP_MINUTES, validEventGap, type LibrarySettings, type Source } from '../shared/model';
export class LibraryPreferences {
  private settings: LibrarySettings = { eventGapMinutes: DEFAULT_EVENT_GAP_MINUTES, bookmarks: [] };
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (validEventGap(saved.eventGapMinutes)) this.settings.eventGapMinutes = saved.eventGapMinutes;
      if (Array.isArray(saved.bookmarks)) {
        const paths = new Set<string>();
        this.settings.bookmarks = saved.bookmarks.filter((value: unknown): value is Source => {
          if (!value || typeof value !== 'object') return false;
          const source = value as Source;
          if (typeof source.path !== 'string' || !path.isAbsolute(source.path) || typeof source.name !== 'string' || paths.has(source.path)) return false;
          paths.add(source.path); return true;
        }).map((source: Source) => ({ path: source.path, name: source.name }));
      }
    } catch { /* Use defaults if no valid preferences exist. */ }
  }
  async flush() { await this.writing; }
  get() { return { eventGapMinutes: this.settings.eventGapMinutes, bookmarks: this.settings.bookmarks.map(source => ({ ...source })) }; }
  setGap(minutes: number) {
    if (!validEventGap(minutes)) throw new Error('Choose a whole-number event gap from 1 to 10080 minutes.');
    return this.update(settings => ({ ...settings, eventGapMinutes: minutes })).then(settings => settings.eventGapMinutes);
  }
  toggleBookmark(source: Source) {
    return this.update(settings => ({ ...settings, bookmarks: settings.bookmarks.some(item => item.path === source.path)
      ? settings.bookmarks.filter(item => item.path !== source.path) : [...settings.bookmarks, { ...source }] })).then(settings => settings.bookmarks);
  }
  private update(change: (settings: LibrarySettings) => LibrarySettings) {
    const write = this.writing.catch(() => {}).then(async () => {
      const next = change(this.get());
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n'); await rename(temporary, this.file);
      this.settings = next; return this.get();
    });
    this.writing = write; return write;
  }
}
