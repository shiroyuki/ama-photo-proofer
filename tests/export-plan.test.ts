import { describe, expect, it } from 'vitest';
import { planExport } from '../electron/export-plan';
import type { MediaFile } from '../shared/model';
import { asset } from './export-fixture';
function file(id: string, capturedAt: string, name = `${id}.JPG`): MediaFile {
  return { ...asset(`/card/${name}`).metadata, id, directory: '/card', capturedAt };
}
describe('session event export planning', () => {
  it('uses all indexed photos to keep sparse selections in their original overnight event', () => {
    const files = [file('one', '2026-11-12T23:45:00'), file('bridge', '2026-11-13T00:05:00'), file('three', '2026-11-13T00:25:00'), file('morning', '2026-11-13T09:00:00')];
    const result = planExport(files, ['one', 'three', 'morning'], id => ({ path: `/card/${id}.JPG` }));
    expect(result.map(item => item.event.name)).toEqual(['2026-11-12_23-45-00', '2026-11-12_23-45-00', '2026-11-13_09-00-00']);
    expect(result[0].event.end).toBe('2026-11-13T00:25:00');
  });
  it('keeps capture pairs together with shared labels and review status', () => {
    const files = [file('jpeg', '2026-11-12T12:00:00', 'A.JPG'), file('raw', '2026-11-12T12:00:00', 'A.DNG')];
    const result = planExport(files, ['raw'], id => ({ path: `/card/${id}`, labels: id === 'jpeg' ? ['landscape'] : [], review: id === 'jpeg' ? 'accepted' : undefined }));
    expect(result).toHaveLength(2); expect(result.every(item => item.review === 'accepted' && item.labels[0] === 'landscape')).toBe(true);
    expect(result[0].metadata).not.toHaveProperty('directory'); expect(result[0].metadata).not.toHaveProperty('id');
  });
  it('rejects unknown or disappeared assets', () => {
    const files = [file('one', '2026-11-12T12:00:00')];
    expect(() => planExport(files, ['other'], () => undefined)).toThrow('no longer available');
    expect(() => planExport(files, ['one'], () => undefined)).toThrow('no longer available');
  });
});

it('uses the configured event gap consistently when building export plans', () => {
  const files = [file('one', '2026-11-12T23:45:00'), file('two', '2026-11-13T00:10:00')];
  const lookup = (id: string) => ({ path: `/card/${id}.JPG` });
  expect(new Set(planExport(files, ['one', 'two'], lookup, 10).map(asset => asset.event.name)).size).toBe(2);
  expect(new Set(planExport(files, ['one', 'two'], lookup, 30).map(asset => asset.event.name)).size).toBe(1);
});
