import { groupEvents, pairPhotos, type MediaFile } from '../shared/model';
import type { ReviewStatus } from '../shared/selection';
import { normalizeTags } from '../shared/labels';
export interface ExportEvent { name: string; start: string; end: string }
export interface ExportAsset {
  path: string; sourcePath: string; captureId: string; event: ExportEvent;
  metadata: Omit<MediaFile, 'id' | 'directory'>; labels: string[]; review?: ReviewStatus;
}
export function planExport(files: MediaFile[], ids: string[], lookup: (id: string) => { path: string; labels?: string[]; review?: ReviewStatus } | undefined, gapMinutes = 30): ExportAsset[] {
  const selected = new Set(ids);
  const result: ExportAsset[] = [];
  for (const event of groupEvents(pairPhotos(files), gapMinutes)) {
    const name = event.start.slice(0, 19).replace('T', '_').replace(/:/g, '-');
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name)) throw new Error('Invalid event timestamp. Reindex the source before exporting.');
    for (const capture of event.photos) {
      if (!capture.files.some(file => selected.has(file.id))) continue;
      const assets = capture.files.map(file => lookup(file.id));
      if (assets.some(asset => !asset)) throw new Error('A capture is no longer available. Reopen the source before exporting.');
      const labels = normalizeTags(assets.flatMap(asset => asset?.labels ?? []));
      const review = lookup(capture.primary.id)?.review ?? assets.find(asset => asset?.review)?.review;
      // Selecting a capture includes both members of its JPEG/RAW pair.
      for (const file of capture.files) {
        const asset = lookup(file.id)!;
        const { id: _id, directory: _directory, ...metadata } = file;
        result.push({ path: asset.path, sourcePath: file.relativePath, captureId: capture.id, event: { name, start: event.start, end: event.end }, metadata, labels: [...labels], review });
      }
    }
  }
  if (!result.length || ids.some(id => !files.some(file => file.id === id))) throw new Error('Some photos are no longer available. Reopen the source before exporting.');
  return result;
}
export function captureGroups(assets: ExportAsset[]): ExportAsset[][] {
  const groups = new Map<string, ExportAsset[]>();
  for (const asset of assets) {
    const key = `${asset.event.name}\0${asset.captureId}`;
    const group = groups.get(key) ?? []; if (!group.some(item => item.path === asset.path)) group.push(asset); groups.set(key, group);
  }
  return [...groups.values()];
}
