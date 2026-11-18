import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventSummaries, eventFingerprint, type SummaryEvent } from '../electron/event-summaries';
import { SessionCache } from '../electron/session-cache';
let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(os.tmpdir(), 'event-summaries-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
const event = (): SummaryEvent => ({ id: 'event', name: '2026-11-12_23-45-00', start: '2026-11-12T23:45:00', end: '2026-11-13T00:10:00', keys: ['A.JPG|1|1', 'B.JPG|1|1'], photos: [{ id: 'A', labels: ['forest'] }, { id: 'B', labels: ['river'] }] });
it('generates from the full event once and restores the same summary with fresh runtime IDs', async () => {
  const cache = await SessionCache.open(folder), context = event(); const generate = vi.fn(async () => 'Forest and River');
  const service = new EventSummaries({ events: () => [context], cache: () => cache, generate, notify: vi.fn() });
  await service.run(); expect(generate).toHaveBeenCalledWith(context.photos, expect.any(AbortSignal));
  context.photos[0].labels = ['new label'];
  expect(await service.forExport(context.name, new AbortController().signal)).toBe('forest-and-river'); expect(generate).toHaveBeenCalledTimes(1);
  const restored = await SessionCache.open(folder); context.id = 'new-session-id';
  expect(new EventSummaries({ events: () => [context], cache: () => restored, generate, notify: vi.fn() }).cached()).toEqual({ 'new-session-id': 'forest-and-river' });
});
it('invalidates summaries when the event photos change and prunes obsolete records', async () => {
  const cache = await SessionCache.open(folder), context = event(); const generate = vi.fn(async () => 'forest');
  const service = new EventSummaries({ events: () => [context], cache: () => cache, generate, notify: vi.fn() });
  await service.run(); const previous = eventFingerprint(context); context.keys.push('C.JPG|2|2');
  expect(service.cached()).toEqual({}); await service.run(); expect(generate).toHaveBeenCalledTimes(2); expect(cache.getEventSummary(previous)).toBeUndefined();
});
it('shares an in-flight summary between background work and export; cancelling export keeps the background job', async () => {
  const cache = await SessionCache.open(folder), context = event(); let finish!: (value: string) => void;
  const generate = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const service = new EventSummaries({ events: () => [context], cache: () => cache, generate, notify: vi.fn() });
  const background = service.run(), controller = new AbortController(); const exported = service.forExport(context.name, controller.signal);
  controller.abort(); await expect(exported).rejects.toThrow(); finish('forest-river'); await background;
  expect(generate).toHaveBeenCalledTimes(1); expect(service.cached()).toEqual({ event: 'forest-river' });
});
it('stops only unstarted summaries and preserves the current result', async () => {
  const cache = await SessionCache.open(folder), first = event(), second = { ...event(), id: 'second', name: '2026-11-13_09-00-00', start: '2026-11-13T09:00:00', keys: ['C.JPG|1|1'] };
  let finish!: (value: string) => void; const generate = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const service = new EventSummaries({ events: () => [first, second], cache: () => cache, generate, notify: vi.fn() });
  const job = service.run(); service.stopQueued(); finish('forest');
  expect(await job).toMatchObject({ cancelled: true }); expect(service.cached()).toEqual({ event: 'forest' }); expect(generate).toHaveBeenCalledTimes(1);
});
it('aborts pending summaries when the source closes and does not cache an unfinished result', async () => {
  const cache = await SessionCache.open(folder), context = event();
  const generate = vi.fn((_photos, signal: AbortSignal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })));
  const service = new EventSummaries({ events: () => [context], cache: () => cache, generate, notify: vi.fn() });
  const job = service.run(); await service.stop(); expect(await job).toMatchObject({ cancelled: true }); expect(service.cached()).toEqual({});
});

it('skips video-only events, ignores cached summaries for them, and continues to events with photos', async () => {
  const cache = await SessionCache.open(folder), empty = { ...event(), id: 'video', name: 'video-event', keys: ['CLIP.MP4|1|1'], photos: [] }, context = event();
  cache.setEventSummary(eventFingerprint(empty), 'old-video-summary');
  const generate = vi.fn(async () => 'forest-river'), notify = vi.fn();
  const service = new EventSummaries({ events: () => [empty, context], cache: () => cache, generate, notify });
  expect(service.cached()).toEqual({});
  expect(await service.forExport(empty.name, new AbortController().signal)).toBeUndefined();
  expect(await service.run()).toEqual({ cancelled: false, failures: 0 });
  expect(generate).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledWith(context.photos, expect.any(AbortSignal));
  expect(service.cached()).toEqual({ event: 'forest-river' });
  expect(cache.getEventSummary(eventFingerprint(empty))).toBeUndefined();
  expect(notify).toHaveBeenCalledWith({ completed: 1, total: 1, done: true, cancelled: false });
});
it('does not stop the remaining queue when a generator has no description for an event', async () => {
  const cache = await SessionCache.open(folder), first = event(), second = { ...event(), id: 'second', keys: ['C.JPG|1|1'] };
  const generate = vi.fn<(_photos: SummaryEvent['photos'], signal: AbortSignal) => Promise<string | undefined>>()
    .mockResolvedValueOnce(undefined).mockResolvedValueOnce('forest');
  const service = new EventSummaries({ events: () => [first, second], cache: () => cache, generate, notify: vi.fn() });
  expect(await service.run()).toEqual({ cancelled: false, failures: 0 });
  expect(generate).toHaveBeenCalledTimes(2); expect(service.cached()).toEqual({ second: 'forest' });
});
