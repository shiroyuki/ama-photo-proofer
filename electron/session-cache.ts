import { readEdits, type EditVersion, type PhotoEdits } from '../shared/edits';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MediaFile } from '../shared/model';
import type { ReviewStatus } from '../shared/selection';
import { summarySlug } from '../shared/summary';
import { normalizeTags } from '../shared/labels';
import { maxCubeBytes, readCube, type CubeLut } from './cube-lut';
export const CACHE_NAME = 'photo-proofing.json';
export const CACHE_SCHEMA_VERSION = 1;
export type CachedMetadata = Pick<MediaFile, 'capturedAt' | 'timestampSource' | 'camera' | 'lens' | 'iso' | 'aperture' | 'shutter' | 'width' | 'height' | 'duration' | 'warning'> & { orientation?: number };
export interface CacheEntry { size: number; modifiedAt: number; metadata?: CachedMetadata; tags?: string[]; review?: ReviewStatus; versions?: EditVersion[] }
export interface CacheDocument { schemaVersion: number; files: Record<string, CacheEntry>; eventSummaries?: Record<string, string>; luts?: Record<string, string> }
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
  private luts = new Map<string, { source: string; cube?: CubeLut }>();
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
      if (Array.isArray(entry.versions)) {
        const versions = new Map<number, EditVersion>();
        for (const item of entry.versions.slice(0, 100)) {
          if (!Number.isInteger(item?.number) || item.number < 1 || item.number > 100) continue;
          try { versions.set(item.number, { number: item.number, edits: readEdits(item.edits) }); } catch { /* Ignore invalid recipes. */ }
        }
        if (versions.size) value.versions = [...versions.values()].sort((a, b) => a.number - b.number);
      }
      cache.files[relative] = value; cache.byKey.set(cache.key(relative, value), value);
    }
    if (document.eventSummaries && typeof document.eventSummaries === 'object') for (const [key, value] of Object.entries(document.eventSummaries)) {
      const summary = summarySlug(value); if (/^[a-f0-9]{64}$/.test(key) && summary) cache.eventSummaries[key] = summary;
    }
    for (const id of cache.savedLutIds()) {
      const source: unknown = document.luts?.[id];
      if (typeof source === 'string' && Buffer.byteLength(source) <= maxCubeBytes) cache.luts.set(id, { source });
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
  getVersions(key: string) { return this.byKey.get(key)?.versions ?? []; }
  importLut(source: string) {
    const id = createHash('sha256').update(source).digest('hex');
    const existing = this.luts.get(id);
    if (!existing?.cube) this.luts.set(id, { source, cube: readCube(source) });
    return id;
  }
  getLut(id: string) {
    const entry = this.luts.get(id);
    if (!entry) throw new Error('This version’s LUT is missing. Choose the LUT again or remove it.');
    return entry.cube ??= readCube(entry.source);
  }
  private savedLutIds() {
    const ids = new Set<string>();
    for (const entry of Object.values(this.files)) {
      for (const { edits } of entry.versions ?? []) if (edits.lut) ids.add(edits.lut.id);
    }
    return ids;
  }
  async saveVersion(key: string, edits: PhotoEdits, number?: number) {
    const entry = this.byKey.get(key);
    if (!entry || this.readOnly) throw new Error('This folder cannot save edit versions.');
    if (edits.lut) this.getLut(edits.lut.id);
    const versions = entry.versions ?? [];
    if (number !== undefined && !versions.some(item => item.number === number)) throw new Error('This version is no longer available.');
    const next = number ?? ((versions.at(-1)?.number ?? 0) + 1);
    if (next > 100) throw new Error('This photo already has 100 edit versions.');
    const updated = [...versions.filter(item => item.number !== next), { number: next, edits }].sort((a, b) => a.number - b.number);
    entry.versions = updated;
    this.changed();
    if (await this.save()) return updated;
    if (entry.versions === updated) {
      entry.versions = versions;
      this.changed();
    }
    throw new Error('The adjustments could not be saved to the source folder.');
  }
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
      for (const id of this.savedLutIds()) {
        const entry = this.luts.get(id);
        if (entry) (document.luts ??= {})[id] = entry.source;
      }
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
