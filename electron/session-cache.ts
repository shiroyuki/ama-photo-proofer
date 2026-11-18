import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaFile } from '../shared/model';
import type { ReviewStatus } from '../shared/selection';
import { summarySlug } from '../shared/summary';
import { normalizeTags } from '../shared/labels';
export const CACHE_NAME = 'photo-proofing.json';
export const CACHE_SCHEMA_VERSION = 1;
export type CachedMetadata = Pick<MediaFile, 'capturedAt' | 'timestampSource' | 'camera' | 'lens' | 'iso' | 'aperture' | 'shutter' | 'width' | 'height' | 'duration' | 'warning'> & { orientation?: number };
export interface CacheEntry { size: number; modifiedAt: number; metadata?: CachedMetadata; tags?: string[]; review?: ReviewStatus }
export interface CacheDocument { schemaVersion: number; files: Record<string, CacheEntry>; eventSummaries?: Record<string, string> }
function validPath(value: string) {
  return Boolean(value) && !path.isAbsolute(value) && !/^[a-zA-Z]:/.test(value) && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function metadata(value: unknown): CachedMetadata | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (typeof data.capturedAt !== 'string' || !Number.isFinite(Date.parse(data.capturedAt)) || !['capture', 'modified'].includes(String(data.timestampSource))) return;
  const result: CachedMetadata = { capturedAt: data.capturedAt, timestampSource: data.timestampSource as 'capture' | 'modified' };
  for (const key of ['camera', 'lens', 'iso', 'aperture', 'shutter', 'warning'] as const) if (typeof data[key] === 'string') result[key] = data[key].slice(0, 1000);
  for (const key of ['width', 'height', 'duration', 'orientation'] as const) if (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0) result[key] = data[key];
  return result;
}
export class SessionCache {
  private files: Record<string, CacheEntry> = Object.create(null);
  private eventSummaries: Record<string, string> = Object.create(null);
  private byKey = new Map<string, CacheEntry>();
  private revision = 0;
  private dirty = false;
  private readOnly = false;
  private saving: Promise<boolean> = Promise.resolve(true);
  private warnings = new Set<string>();
  private constructor(readonly folder: string, private warn: (message: string) => void) {}
  static async open(folder: string, warn: (message: string) => void = () => {}) {
    const cache = new SessionCache(folder, warn);
    let document: any;
    try { document = JSON.parse(await readFile(path.join(folder, CACHE_NAME), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cache.warning(`${CACHE_NAME} could not be read. Its cache will be rebuilt; previous labels and review decisions may be unavailable.`);
      cache.dirty = true; return cache;
    }
    if (typeof document?.schemaVersion === 'number' && document.schemaVersion > CACHE_SCHEMA_VERSION) {
      cache.readOnly = true;
      cache.warning(`${CACHE_NAME} uses a newer schema. The file is kept unchanged; this session's cache cannot be saved with this app version.`);
      return cache;
    }
    if (document?.schemaVersion !== CACHE_SCHEMA_VERSION || !document.files || typeof document.files !== 'object' || Array.isArray(document.files)) {
      cache.dirty = true;
      cache.warning(`${CACHE_NAME} uses an older or incompatible schema. Its cached metadata, labels, and review decisions were reset.`);
      return cache;
    }
    for (const [relative, raw] of Object.entries(document.files)) {
      const entry = raw as CacheEntry;
      if (!validPath(relative) || !entry || typeof entry !== 'object' || !Number.isFinite(entry.size) || entry.size < 0 || !Number.isFinite(entry.modifiedAt)) { cache.dirty = true; continue; }
      const value: CacheEntry = { size: entry.size, modifiedAt: entry.modifiedAt, metadata: metadata(entry.metadata) };
      const tags = normalizeTags(entry.tags); if (tags.length) value.tags = tags;
      if (entry.review === 'accepted' || entry.review === 'rejected') value.review = entry.review;
      cache.files[relative] = value; cache.byKey.set(cache.key(relative, value), value);
    }
    if (document.eventSummaries && typeof document.eventSummaries === 'object') for (const [key, value] of Object.entries(document.eventSummaries)) {
      const summary = summarySlug(value); if (/^[a-f0-9]{64}$/.test(key) && summary) cache.eventSummaries[key] = summary;
    }
    return cache;
  }
  clearIndexAndAI() {
    for (const entry of Object.values(this.files)) { delete entry.metadata; delete entry.tags; }
    this.eventSummaries = Object.create(null); this.changed();
  }
  getEventSummary(key: string) { return this.eventSummaries[key]; }
  setEventSummary(key: string, summary: string) { this.eventSummaries[key] = summary; this.changed(); }
  pruneEventSummaries(keys: Set<string>) { for (const key of Object.keys(this.eventSummaries)) if (!keys.has(key)) { delete this.eventSummaries[key]; this.changed(); } }
  private key(relative: string, entry: CacheEntry) { return `${relative}|${entry.size}|${entry.modifiedAt}`; }
  private warning(message: string) { if (!this.warnings.has(message)) { this.warnings.add(message); this.warn(message); } }
  fingerprint(relative: string, size: number, modifiedAt: number) { return `${relative}|${size}|${modifiedAt}`; }
  getMetadata(relative: string, size: number, modifiedAt: number) { return this.byKey.get(this.fingerprint(relative, size, modifiedAt))?.metadata; }
  setFile(relative: string, size: number, modifiedAt: number, data: CachedMetadata) {
    if (!validPath(relative)) throw new Error('Invalid cache path.');
    const previous = this.files[relative];
    const unchanged = previous?.size === size && previous?.modifiedAt === modifiedAt;
    if (previous) this.byKey.delete(this.key(relative, previous));
    const entry: CacheEntry = { ...(unchanged ? previous : {}), size, modifiedAt, metadata: data };
    this.files[relative] = entry; this.byKey.set(this.key(relative, entry), entry); this.changed();
  }
  prune(existing: Set<string>) {
    for (const relative of Object.keys(this.files)) if (!existing.has(relative)) this.remove(relative);
  }
  remove(relative: string) {
    const entry = this.files[relative];
    if (entry) { this.byKey.delete(this.key(relative, entry)); delete this.files[relative]; this.changed(); }
  }
  getTags(key: string) { return this.byKey.get(key)?.tags; }
  setTags(key: string, tags: string[]) { const entry = this.byKey.get(key); if (entry) { entry.tags = normalizeTags(tags); this.changed(); } }
  getReview(key: string) { return this.byKey.get(key)?.review; }
  setReview(key: string, review: ReviewStatus | null) {
    const entry = this.byKey.get(key);
    if (entry) { if (review) entry.review = review; else delete entry.review; this.changed(); }
  }
  private changed() { this.dirty = true; this.revision++; }
  save(): Promise<boolean> {
    const persist = async () => {
      if (this.readOnly) return false;
      if (!this.dirty) return true;
      const revision = this.revision;
      const document: CacheDocument = { schemaVersion: CACHE_SCHEMA_VERSION, files: this.files, eventSummaries: this.eventSummaries };
      const contents = JSON.stringify(document, null, 2) + '\n';
      const temporary = path.join(this.folder, `.photo-proofing-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, contents); await rename(temporary, path.join(this.folder, CACHE_NAME));
        if (revision === this.revision) this.dirty = false;
        return true;
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        this.warning(`${CACHE_NAME} could not be saved in this folder. You can keep reviewing, but session changes may be lost. Check the folder's write permissions.`);
        return false;
      }
    };
    this.saving = this.saving.then(persist, persist); return this.saving;
  }
}
