import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanTags, dedicatedGPU, OllamaTagger, type GPU, type TagAsset } from '../electron/ollama';
import { SessionCache } from '../electron/session-cache';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'photo-tagger-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const discrete: GPU = { vendor: 'NVIDIA', model: 'GeForce RTX 4070', vram: 12288, vramDynamic: false };
async function service(overrides: { platform?: string; gpus?: GPU[]; fetch?: typeof fetch } = {}) {
  const cache = await SessionCache.open(directory);
  for (const file of ['A.JPG', 'B.DNG', 'C.MP4']) cache.setFile(file, 1024, 1, { capturedAt: '2026-11-12T12:00:00', timestampSource: 'capture' });
  const assets = new Map<string, TagAsset>([['jpg', { key: 'A.JPG|1024|1', kind: 'jpeg' }], ['raw', { key: 'B.DNG|1024|1', kind: 'raw' }], ['video', { key: 'C.MP4|1024|1', kind: 'video' }]]);
  const calls: { endpoint: string; body?: any }[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ endpoint, body });
    expect(new URL(String(input)).origin).toBe('http://127.0.0.1:11434');
    expect(init?.redirect).toBe('error');
    if (endpoint === '/api/tags') return Response.json({ models: [{ name: 'gemma4:e2b' }] });
    if (endpoint === '/api/show') return Response.json({ capabilities: ['completion', 'vision'] });
    return Response.json({ response: JSON.stringify({ tags: [' Mountains ', 'mountains', 'lake', '<script>', 9] }) });
  });
  const image = vi.fn(async (_id: string, _signal: AbortSignal) => Buffer.from('resized-preview'));
  const detectGPU = vi.fn(async () => overrides.gpus ?? [discrete]);
  const tagger = new OllamaTagger({ directory, platform: overrides.platform ?? 'linux', detectGPU,
    cache: { get: key => cache.getTags(key), set: (key, tags) => cache.setTags(key, tags), save: () => cache.save() },
    fetch: overrides.fetch ?? request as typeof fetch, asset: id => assets.get(id), image });
  return { tagger, request, calls, image, assets, detectGPU };
}
describe('dedicated GPU policy', () => {
  it('accepts confirmed discrete NVIDIA, AMD and Intel adapters but rejects shared or unknown memory', () => {
    expect(dedicatedGPU([discrete])?.model).toBe(discrete.model);
    expect(dedicatedGPU([{ vendor: 'AMD', model: 'Radeon RX 6800', vram: 16384, vramDynamic: false }])).toBeTruthy();
    expect(dedicatedGPU([{ vendor: 'Intel', model: 'Arc A770', vram: 16384, vramDynamic: false }])).toBeTruthy();
    for (const gpu of [
      { vendor: 'Intel', model: 'UHD Graphics', vram: 128, vramDynamic: false },
      { vendor: 'AMD', model: 'Radeon Graphics', vram: 512, vramDynamic: false },
      { ...discrete, vramDynamic: true }, { ...discrete, vram: null },
      { vendor: 'NVIDIA', model: 'Tegra', vram: 4096, vramDynamic: false },
      { vendor: 'Unknown', model: 'Adapter', vram: 4096, vramDynamic: false },
    ]) expect(dedicatedGPU([gpu])).toBeUndefined();
  });
});
describe('Ollama tagging gates and image API', () => {
  it('is off by default and never reads a preview or generates tags while disabled', async () => {
    const { tagger, image, calls } = await service(); await tagger.initialize();
    expect((await tagger.status()).enabled).toBe(false);
    await expect(tagger.tag(['jpg'], 'off', () => {})).rejects.toThrow('Enable Ollama');
    expect(image).not.toHaveBeenCalled(); expect(calls.some(call => call.endpoint === '/api/generate')).toBe(false);
  });
  it('defaults on for a ready local macOS model without requiring dedicated GPU memory', async () => {
    const { tagger, detectGPU, image, calls } = await service({ platform: 'darwin', gpus: [] }); await tagger.initialize();
    expect(await tagger.status()).toMatchObject({ available: true, enabled: true, reasons: [] });
    expect(detectGPU).not.toHaveBeenCalled();
    expect((await tagger.tag(['jpg'], 'mac-default', () => {})).completed).toBe(1);
    expect(image).toHaveBeenCalledTimes(1);
    expect(calls.find(call => call.endpoint === '/api/generate')?.body.options).not.toHaveProperty('num_gpu');
  });
  it('remembers an explicit macOS opt-out and allows it to be re-enabled', async () => {
    const { tagger } = await service({ platform: 'darwin' }); await tagger.initialize();
    await tagger.setEnabled(false);
    const restored = await service({ platform: 'darwin' }); await restored.tagger.initialize();
    expect((await restored.tagger.status()).enabled).toBe(false);
    await expect(restored.tagger.tag(['jpg'], 'off', () => {})).rejects.toThrow('Enable Ollama');
    expect(restored.image).not.toHaveBeenCalled();
    expect((await restored.tagger.setEnabled(true)).enabled).toBe(true);
  });
  it('keeps macOS disabled when Ollama or the model is unavailable, and enables when it becomes ready', async () => {
    let ready = false;
    const request: typeof fetch = vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: ready ? [{ name: 'gemma4:e2b' }] : [] }) : Response.json({ capabilities: ['vision'] }));
    const { tagger, detectGPU, image } = await service({ platform: 'darwin', fetch: request }); await tagger.initialize();
    expect(await tagger.status()).toMatchObject({ available: false, enabled: false });
    await expect(tagger.tag(['jpg'], 'missing', () => {})).rejects.toThrow('not installed');
    expect(image).not.toHaveBeenCalled(); expect(detectGPU).not.toHaveBeenCalled();
    ready = true; expect(await tagger.status()).toMatchObject({ available: true, enabled: true });
    const offline = await service({ platform: 'darwin', fetch: vi.fn(async () => { throw new Error('offline'); }) });
    await offline.tagger.initialize(); expect((await offline.tagger.status()).enabled).toBe(false);
    expect((await offline.tagger.status()).reasons.join()).toContain('not available');
  });
  it('blocks integrated-only machines and unreachable Ollama with clear reasons', async () => {
    const { tagger, image } = await service({ gpus: [{ vendor: 'Intel', model: 'Iris Xe', vram: 128, vramDynamic: true }], fetch: vi.fn(async () => { throw new Error('offline'); }) });
    await tagger.initialize(); const status = await tagger.status();
    expect(status.available).toBe(false); expect(status.reasons.join()).toContain('dedicated GPU'); expect(status.reasons.join()).toContain('not available');
    await expect(tagger.setEnabled(true)).rejects.toThrow(); expect(image).not.toHaveBeenCalled();
  });
  it('requires the exact installed model and vision capability', async () => {
    const missing = await service({ fetch: vi.fn(async () => Response.json({ models: [{ name: 'other-model' }] })) });
    expect((await missing.tagger.status()).reasons.join()).toContain('ollama pull gemma4:e2b');
    const nonVision = await service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : Response.json({ capabilities: ['completion'] })) });
    expect((await nonVision.tagger.status()).reasons.join()).toContain('image support');
    const remote = await service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : Response.json({ capabilities: ['vision'], remote_host: 'https://example.com' })) });
    expect((await remote.tagger.status()).available).toBe(false);
  });
  it('sends preview bytes only after opt-in, skips videos, cleans tags and persists the cache', async () => {
    const { tagger, image, calls, assets } = await service(); await tagger.initialize();
    expect((await tagger.setEnabled(true)).enabled).toBe(true);
    const progress = vi.fn(); const result = await tagger.tag(['jpg', 'jpg', 'raw', 'video'], 'photos', progress);
    expect(result).toEqual({ completed: 2, total: 2, cancelled: false, failures: 0 });
    expect(image).toHaveBeenCalledTimes(2);
    const generations = calls.filter(call => call.endpoint === '/api/generate'); expect(generations).toHaveLength(2);
    expect(generations[0].body).toMatchObject({ model: 'gemma4:e2b', images: [Buffer.from('resized-preview').toString('base64')], stream: false, think: false });
    expect(tagger.tags(['jpg', 'raw', 'video'])).toEqual({ jpg: ['mountains', 'lake'], raw: ['mountains', 'lake'] });
    await tagger.tag(['jpg'], 'cached', () => {}); expect(image).toHaveBeenCalledTimes(2);
    const restored = await service(); await restored.tagger.initialize(); expect(restored.tagger.tags(['jpg']).jpg).toEqual(['mountains', 'lake']);
    assets.set('jpg', { key: '/card/A.JPG|2048|2', kind: 'jpeg' }); expect(tagger.tags(['jpg'])).toEqual({});
    expect(JSON.parse(await readFile(path.join(directory, 'ollama-settings.json'), 'utf8')).enabled).toBe(true);
  });
  it('deactivates queued work while allowing the current photo to finish and retain its labels', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    let finish!: () => void; let activeSignal: AbortSignal | undefined;
    const request: typeof fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:e2b' }] });
      if (String(input).endsWith('/api/show')) return Response.json({ capabilities: ['vision'] });
      activeSignal = init?.signal ?? undefined; began();
      return new Promise<Response>(resolve => { finish = () => resolve(Response.json({ response: '{"tags":["forest"]}' })); });
    });
    const { tagger, image } = await service({ fetch: request }); await tagger.initialize(); await tagger.setEnabled(true);
    const progress = vi.fn(); const job = tagger.tag(['jpg', 'raw'], 'graceful', progress); await started;
    await expect(tagger.tag(['raw'], 'overlap', () => {})).rejects.toThrow('already running');
    await tagger.setEnabled(false);
    expect(activeSignal?.aborted).toBe(false); expect(image).toHaveBeenCalledTimes(1);
    finish(); expect(await job).toMatchObject({ cancelled: true, completed: 1, total: 2 });
    expect(tagger.tags(['jpg', 'raw'])).toEqual({ jpg: ['forest'] });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ id: 'jpg', tags: ['forest'], completed: 1 }));
    const restored = await service(); await restored.tagger.initialize(); expect(restored.tagger.tags(['jpg']).jpg).toEqual(['forest']);
    expect((await restored.tagger.status()).enabled).toBe(false);
  });
  it('stops queued jobs without disabling the preference, and can resume in a new batch', async () => {
    const { tagger, image } = await service(); await tagger.initialize(); await tagger.setEnabled(true);
    const first = await tagger.tag(['jpg', 'raw'], 'stop-queue', progress => { if (progress.tags) tagger.stopQueued(); });
    expect(first).toMatchObject({ cancelled: true, completed: 1, total: 2 });
    expect(image).toHaveBeenCalledTimes(1); expect((await tagger.status()).enabled).toBe(true);
    expect((await tagger.tag(['raw'], 'resume', () => {})).completed).toBe(1);
    expect(tagger.tags(['jpg', 'raw']).raw).toEqual(['mountains', 'lake']);
  });
  it('still aborts an in-flight request when the session closes or changes', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const request: typeof fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:e2b' }] });
      if (String(input).endsWith('/api/show')) return Response.json({ capabilities: ['vision'] });
      began(); return new Promise<Response>((_, reject) => { init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); });
    });
    const { tagger } = await service({ fetch: request }); await tagger.initialize(); await tagger.setEnabled(true);
    const job = tagger.tag(['jpg'], 'close', () => {}); await started;
    await tagger.stop(); expect((await job).cancelled).toBe(true); expect(tagger.tags(['jpg'])).toEqual({});
  });
  it('reports malformed model output and refuses unknown photo identifiers', async () => {
    const { tagger } = await service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : String(input).endsWith('/api/show') ? Response.json({ capabilities: ['vision'] }) : Response.json({ response: 'not json' })) });
    await tagger.initialize(); await tagger.setEnabled(true);
    expect((await tagger.tag(['jpg'], 'invalid', () => {})).failures).toBe(1);
    await expect(tagger.tag(['arbitrary-path'], 'unknown', () => {})).rejects.toThrow('no longer available');
  });
});
it('normalizes and bounds model-generated tag text', () => {
  expect(cleanTags([' Red  fox ', 'red fox', '', '<img>', 'x'.repeat(41), null, '山'])).toEqual(['red fox', '山']);
  expect(cleanTags('landscape')).toEqual([]);
});

describe('accepted event folder summaries', () => {
  const photos = [{ id: 'jpg', labels: ['landscape', 'lake'] }, { id: 'raw', labels: ['lake'] }];
  function requests(response = 'Mountain Lake Sunrise!') {
    return vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:e2b' }] });
      if (String(input).endsWith('/api/show')) return Response.json({ capabilities: ['vision'] });
      return Response.json({ response: JSON.stringify({ summary: response }) });
    }) as ReturnType<typeof vi.fn> & typeof fetch;
  }
  it('does not access previews or Ollama when integration is off', async () => {
    const { tagger, request, image } = await service(); await tagger.initialize();
    expect(await tagger.summarizeEvent(photos, new AbortController().signal)).toBeUndefined();
    expect(request).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
  });
  it('uses photographs as primary evidence even when every photo has labels', async () => {
    const request = requests(); const { tagger, image } = await service({ fetch: request }); await tagger.initialize(); await tagger.setEnabled(true);
    expect(await tagger.summarizeEvent(photos, new AbortController().signal)).toBe('mountain-lake-sunrise');
    expect(image.mock.calls.map(call => call[0])).toEqual(['jpg', 'raw']);
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(String(calls.find(([url]) => url.endsWith('/api/generate'))![1].body));
    expect(body).toMatchObject({ model: 'gemma4:e2b', stream: false, format: { required: ['summary'] } });
    expect(body.prompt).toContain('["lake",2]'); expect(body.prompt).toContain('photographs as the primary evidence');
    expect(body.images).toEqual([Buffer.from('resized-preview').toString('base64'), Buffer.from('resized-preview').toString('base64')]);
  });
  it('does not call the model or read previews for an event without photos', async () => {
    const { tagger, image, request } = await service({ platform: 'darwin' }); await tagger.initialize();
    expect(await tagger.summarizeEvent([], new AbortController().signal)).toBeUndefined();
    expect(image).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('samples at most three resized previews when labels are absent', async () => {
    const { tagger, image } = await service({ platform: 'darwin', fetch: requests() }); await tagger.initialize();
    await tagger.summarizeEvent(Array.from({ length: 5 }, (_, index) => ({ id: `photo-${index}`, labels: [] })), new AbortController().signal);
    expect(image.mock.calls.map(call => call[0])).toEqual(['photo-0', 'photo-2', 'photo-4']);
  });
  it('uses readable photos when another preview fails, and skips inference if none can be read', async () => {
    const request = requests(), { tagger, image } = await service({ platform: 'darwin', fetch: request }); await tagger.initialize();
    image.mockRejectedValueOnce(new Error('Card disconnected'));
    expect(await tagger.summarizeEvent(photos, new AbortController().signal)).toBe('mountain-lake-sunrise');
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls.find(([url]) => url.endsWith('/api/generate'))![1].body)).images).toHaveLength(1);
    request.mockClear(); image.mockRejectedValue(new Error('Card disconnected'));
    expect(await tagger.summarizeEvent(photos, new AbortController().signal)).toBeUndefined();
    expect(request.mock.calls.some(call => String(call[0]).endsWith('/api/generate'))).toBe(false);
  });
  it('does not infer when Ollama is unavailable and rejects unusable output when ready', async () => {
    const offline = await service({ platform: 'darwin', fetch: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await offline.tagger.summarizeEvent(photos, new AbortController().signal)).toBeUndefined(); expect(offline.image).not.toHaveBeenCalled();
    const ready = await service({ platform: 'darwin', fetch: requests('... / !!!') });
    await expect(ready.tagger.summarizeEvent(photos, new AbortController().signal)).rejects.toThrow('usable event summary');
  });
  it('aborts a summary request when its export is cancelled', async () => {
    let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
    const normal = requests();
    const request: typeof fetch = vi.fn(async (input, init) => {
      if (!String(input).endsWith('/api/generate')) return normal(input, init);
      begin(); return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    });
    const { tagger } = await service({ platform: 'darwin', fetch: request }); const controller = new AbortController();
    const job = tagger.summarizeEvent(photos, controller.signal); await started; controller.abort();
    await expect(job).rejects.toThrow('Stopped');
  });
});

it('marks a stopped final photo as cancelled so a following summary queue cannot start', async () => {
  const { tagger } = await service(); await tagger.initialize(); await tagger.setEnabled(true);
  const result = await tagger.tag(['jpg'], 'stop-last-photo', progress => { if (progress.tags) tagger.stopQueued(); });
  expect(result).toMatchObject({ completed: 1, total: 1, cancelled: true });
});
