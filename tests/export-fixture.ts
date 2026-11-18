import path from 'node:path';
import { mediaKind } from '../shared/model';
import type { ExportAsset, ExportEvent } from '../electron/export-plan';
export const event: ExportEvent = { name: '2026-11-12_23-45-00', start: '2026-11-12T23:45:00', end: '2026-11-13T00:10:00' };
export function asset(file: string, override: Partial<ExportAsset> = {}): ExportAsset {
  const extension = path.extname(file).slice(1), kind = mediaKind(extension) ?? 'image', stem = path.basename(file, path.extname(file));
  return { path: file, sourcePath: path.basename(file), captureId: kind === 'jpeg' || kind === 'raw' ? `${path.dirname(file)}/${stem.toLowerCase()}` : file, event, labels: ['landscape'], review: 'accepted', metadata: { name: path.basename(file), relativePath: path.basename(file), stem, extension, kind, size: 4, capturedAt: event.start, timestampSource: 'capture' }, ...override };
}
