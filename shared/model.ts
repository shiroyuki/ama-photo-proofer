import type { EditVersion, PhotoEdits, PhotoLut, VersionExportOptions } from './edits';
import type { ReviewStatus } from './selection';
export type ThemePreference = 'system' | 'light' | 'dark';
export type MediaKind = 'jpeg' | 'raw' | 'image' | 'video';
export interface MediaFile {
  id: string;
  name: string;
  relativePath: string;
  stem: string;
  directory: string;
  kind: MediaKind;
  extension: string;
  size: number;
  capturedAt: string;
  timestampSource: 'capture' | 'modified';
  camera?: string;
  lens?: string;
  iso?: string;
  aperture?: string;
  shutter?: string;
  width?: number;
  height?: number;
  duration?: number;
  warning?: string;
}
export interface Photo {
  id: string;
  files: MediaFile[];
  primary: MediaFile;
  raw?: MediaFile;
}
export interface PhotoEvent {
  id: string;
  photos: Photo[];
  start: string;
  end: string;
}
export const DEFAULT_EVENT_GAP_MINUTES = 30;
export function validEventGap(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10080; }
export interface LibrarySettings { eventGapMinutes: number; bookmarks: Source[] }
export interface Source { name: string; path: string }
export interface ScanProgress { scanned: number; total: number; files: MediaFile[]; done: boolean; source: Source; skipped: number }
export interface SessionWarning { sourcePath: string; message: string }
export interface EventSummaryUpdate { sourcePath?: string; id?: string; summary?: string; error?: string; completed?: number; total?: number; done?: boolean; cancelled?: boolean }
export interface SimilarityResult { groups: string[][]; failures: { name: string; message: string }[] }
export interface DesktopAPI {
  exportPanorama(ids: string[]): Promise<string>;
  findSimilar(): Promise<SimilarityResult>;
  getEditVersions(id: string): Promise<EditVersion[]>;
  chooseEditLut(id: string): Promise<PhotoLut | null>;
  previewEdits(id: string, edits: PhotoEdits): Promise<string>;
  saveEditVersion(id: string, edits: PhotoEdits, version?: number): Promise<EditVersion[]>;
  exportEditVersions(id: string, versions: number[], options: VersionExportOptions): Promise<ExportResult>;
  getLibrarySettings(): Promise<LibrarySettings>;
  setEventGap(minutes: number): Promise<number>;
  toggleBookmark(folder: string): Promise<Source[]>;
  openBookmark(folder: string): Promise<Source>;
  reindex(source: Source): Promise<void>;
  getEventSummaries(): Promise<Record<string, string>>;
  onEventSummary(callback: (update: EventSummaryUpdate) => void): () => void;
  onOpenAbout(callback: () => void): () => void;
  getPhotoReviews(ids: string[]): Promise<Record<string, ReviewStatus>>;
  setPhotoReviews(ids: string[], status: ReviewStatus | null): Promise<boolean>;
  onSessionWarning(callback: (warning: SessionWarning) => void): () => void;
  getOllamaStatus(): Promise<OllamaStatus>;
  setOllamaEnabled(enabled: boolean): Promise<OllamaStatus>;
  getPhotoTags(ids: string[]): Promise<Record<string, string[]>>;
  tagPhotos(ids: string[], jobId: string): Promise<TagResult>;
  cancelTagging(): Promise<void>;
  onTagProgress(callback: (progress: TagProgress) => void): () => void;
  getTheme(): Promise<ThemePreference>;
  setTheme(preference: ThemePreference): Promise<void>;
  chooseFolder(): Promise<Source | null>;
  listSources(): Promise<Source[]>;
  scan(source: Source): Promise<void>;
  cancelScan(): Promise<void>;
  getExportCapabilities(): Promise<{ photos: boolean }>;
  exportToPhotos(ids: string[]): Promise<ExportResult>;
  getExportLocation(): Promise<string>;
  chooseExportLocation(): Promise<string | null>;
  exportFiles(ids: string[], mode?: 'selection' | 'selection-by-event' | 'accepted' | 'event'): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void;
  onProgress(callback: (progress: ScanProgress) => void): () => void;
}
export const RAW_EXTENSIONS = new Set(['arw', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'pef', 'dng', 'srw', 'raw', 'rwl', '3fr', 'iiq', 'mos', 'mef', 'erf', 'kdc', 'dcr']);
export function mediaKind(extension: string): MediaKind | undefined {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (RAW_EXTENSIONS.has(ext)) return 'raw';
  if (['jpg', 'jpeg'].includes(ext)) return 'jpeg';
  if (['png', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', 'avi', 'mts', 'm2ts', 'webm', 'mkv'].includes(ext)) return 'video';
}
export function pairPhotos(files: MediaFile[]): Photo[] {
  const groups = new Map<string, MediaFile[]>();
  for (const file of files) {
    const key = file.kind === 'raw' || file.kind === 'jpeg'
      ? `${file.directory}/${file.stem.toLowerCase()}` : file.id;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, files]) => {
    files.sort((a, b) => a.name.localeCompare(b.name));
    const primary = files.find(f => f.kind === 'jpeg') ?? files[0];
    return { id: key, files, primary, raw: files.find(f => f.kind === 'raw') };
  }).sort((a, b) => Date.parse(a.primary.capturedAt) - Date.parse(b.primary.capturedAt) || a.primary.name.localeCompare(b.primary.name));
}
export function groupEvents(photos: Photo[], gapMinutes = DEFAULT_EVENT_GAP_MINUTES): PhotoEvent[] {
  if (!validEventGap(gapMinutes)) throw new Error('Invalid event gap.');
  const events: PhotoEvent[] = [];
  for (const photo of photos) {
    const last = events.at(-1);
    const taken = photo.primary.capturedAt;
    // Compare adjacent captures, not the event's start; midnight never splits an event.
    if (!last || Date.parse(taken) - Date.parse(last.end) > gapMinutes * 60 * 1000) {
      events.push({ id: photo.id, photos: [photo], start: taken, end: taken });
    } else {
      last.photos.push(photo);
      last.end = taken;
    }
  }
  return events;
}

export interface ExportProgress { copied: number; total: number; current: string }
export interface ExportResult { warnings?: string[]; target?: 'folder' | 'photos'; importedItems?: number; copied: number; total: number; cancelled: boolean; destination: string; failures: { name: string; message: string }[] }

export interface OllamaStatus {
  model: 'gemma4:e2b';
  enabled: boolean;
  available: boolean;
  reasons: string[];
  gpu?: string;
}
export interface TagProgress { jobId: string; id: string; tags?: string[]; error?: string; completed: number; total: number }
export interface TagResult { completed: number; total: number; cancelled: boolean; failures: number }
export function groupEventsByDate(events: PhotoEvent[]): { date: string; events: PhotoEvent[] }[] {
  const dates = new Map<string, PhotoEvent[]>();
  for (const event of events) {
    const date = event.start.slice(0, 10);
    const group = dates.get(date) ?? [];
    group.push(event); dates.set(date, group);
  }
  return [...dates].map(([date, events]) => ({ date, events }));
}
