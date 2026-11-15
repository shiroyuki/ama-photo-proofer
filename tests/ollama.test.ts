import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cleanTags, dedicatedGPU, OllamaTagger, type GPU, type TagAsset } from '../electron/ollama';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'photo-tagger-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const discrete: GPU = { vendor: 'NVIDIA', model: 'GeForce RTX 4070', vram: 12288, vramDynamic: false };
function service(overrides: { platform?: string; gpus?: GPU[]; fetch?: typeof fetch } = {}) {
  const assets = new Map<string, TagAsset>([['jpg', { key: '/card/A.JPG|1024|1', kind: 'jpeg' }], ['raw', { key: '/card/B.DNG|1024|1', kind: 'raw' }], ['video', { key: '/card/C.MP4|1024|1', kind: 'video' }]]);
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
  const image = vi.fn(async () => Buffer.from('resized-preview'));
  const detectGPU = vi.fn(async () => overrides.gpus ?? [discrete]);
  const tagger = new OllamaTagger({ directory, platform: overrides.platform ?? 'linux', detectGPU,
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
    const { tagger, image, calls } = service(); await tagger.initialize();
    expect((await tagger.status()).enabled).toBe(false);
    await expect(tagger.tag(['jpg'], 'off', () => {})).rejects.toThrow('Enable Ollama');
    expect(image).not.toHaveBeenCalled(); expect(calls.some(call => call.endpoint === '/api/generate')).toBe(false);
  });
  it('defaults on for a ready local macOS model without requiring dedicated GPU memory', async () => {
    const { tagger, detectGPU, image, calls } = service({ platform: 'darwin', gpus: [] }); await tagger.initialize();
    expect(await tagger.status()).toMatchObject({ available: true, enabled: true, reasons: [] });
    expect(detectGPU).not.toHaveBeenCalled();
    expect((await tagger.tag(['jpg'], 'mac-default', () => {})).completed).toBe(1);
    expect(image).toHaveBeenCalledTimes(1);
    expect(calls.find(call => call.endpoint === '/api/generate')?.body.options).not.toHaveProperty('num_gpu');
  });
  it('remembers an explicit macOS opt-out and allows it to be re-enabled', async () => {
    const { tagger } = service({ platform: 'darwin' }); await tagger.initialize();
    await tagger.setEnabled(false);
    const restored = service({ platform: 'darwin' }); await restored.tagger.initialize();
    expect((await restored.tagger.status()).enabled).toBe(false);
    await expect(restored.tagger.tag(['jpg'], 'off', () => {})).rejects.toThrow('Enable Ollama');
    expect(restored.image).not.toHaveBeenCalled();
    expect((await restored.tagger.setEnabled(true)).enabled).toBe(true);
  });
  it('keeps macOS disabled when Ollama or the model is unavailable, and enables when it becomes ready', async () => {
    let ready = false;
    const request: typeof fetch = vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: ready ? [{ name: 'gemma4:e2b' }] : [] }) : Response.json({ capabilities: ['vision'] }));
    const { tagger, detectGPU, image } = service({ platform: 'darwin', fetch: request }); await tagger.initialize();
    expect(await tagger.status()).toMatchObject({ available: false, enabled: false });
    await expect(tagger.tag(['jpg'], 'missing', () => {})).rejects.toThrow('not installed');
    expect(image).not.toHaveBeenCalled(); expect(detectGPU).not.toHaveBeenCalled();
    ready = true; expect(await tagger.status()).toMatchObject({ available: true, enabled: true });
    const offline = service({ platform: 'darwin', fetch: vi.fn(async () => { throw new Error('offline'); }) });
    await offline.tagger.initialize(); expect((await offline.tagger.status()).enabled).toBe(false);
    expect((await offline.tagger.status()).reasons.join()).toContain('not available');
  });
  it('blocks integrated-only machines and unreachable Ollama with clear reasons', async () => {
    const { tagger, image } = service({ gpus: [{ vendor: 'Intel', model: 'Iris Xe', vram: 128, vramDynamic: true }], fetch: vi.fn(async () => { throw new Error('offline'); }) });
    await tagger.initialize(); const status = await tagger.status();
    expect(status.available).toBe(false); expect(status.reasons.join()).toContain('dedicated GPU'); expect(status.reasons.join()).toContain('not available');
    await expect(tagger.setEnabled(true)).rejects.toThrow(); expect(image).not.toHaveBeenCalled();
  });
  it('requires the exact installed model and vision capability', async () => {
    const missing = service({ fetch: vi.fn(async () => Response.json({ models: [{ name: 'other-model' }] })) });
    expect((await missing.tagger.status()).reasons.join()).toContain('ollama pull gemma4:e2b');
    const nonVision = service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : Response.json({ capabilities: ['completion'] })) });
    expect((await nonVision.tagger.status()).reasons.join()).toContain('image support');
    const remote = service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : Response.json({ capabilities: ['vision'], remote_host: 'https://example.com' })) });
    expect((await remote.tagger.status()).available).toBe(false);
  });
  it('sends preview bytes only after opt-in, skips videos, cleans tags and persists the cache', async () => {
    const { tagger, image, calls, assets } = service(); await tagger.initialize();
    expect((await tagger.setEnabled(true)).enabled).toBe(true);
    const progress = vi.fn(); const result = await tagger.tag(['jpg', 'jpg', 'raw', 'video'], 'photos', progress);
    expect(result).toEqual({ completed: 2, total: 2, cancelled: false, failures: 0 });
    expect(image).toHaveBeenCalledTimes(2);
    const generations = calls.filter(call => call.endpoint === '/api/generate'); expect(generations).toHaveLength(2);
    expect(generations[0].body).toMatchObject({ model: 'gemma4:e2b', images: [Buffer.from('resized-preview').toString('base64')], stream: false, think: false });
    expect(tagger.tags(['jpg', 'raw', 'video'])).toEqual({ jpg: ['mountains', 'lake'], raw: ['mountains', 'lake'] });
    await tagger.tag(['jpg'], 'cached', () => {}); expect(image).toHaveBeenCalledTimes(2);
    const restored = service(); await restored.tagger.initialize(); expect(restored.tagger.tags(['jpg']).jpg).toEqual(['mountains', 'lake']);
    assets.set('jpg', { key: '/card/A.JPG|2048|2', kind: 'jpeg' }); expect(tagger.tags(['jpg'])).toEqual({});
    expect(JSON.parse(await readFile(path.join(directory, 'ollama-settings.json'), 'utf8')).enabled).toBe(true);
  });
  it('aborts in-flight inference when disabled and rejects overlapping jobs', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const request: typeof fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:e2b' }] });
      if (String(input).endsWith('/api/show')) return Response.json({ capabilities: ['vision'] });
      began(); return new Promise<Response>((_, reject) => { init!.signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); });
    });
    const { tagger } = service({ fetch: request }); await tagger.initialize(); await tagger.setEnabled(true);
    const job = tagger.tag(['jpg', 'raw'], 'cancel', () => {}); await started;
    await expect(tagger.tag(['raw'], 'overlap', () => {})).rejects.toThrow('already running');
    await tagger.setEnabled(false); expect((await job).cancelled).toBe(true); expect(tagger.tags(['jpg'])).toEqual({});
  });
  it('reports malformed model output and refuses unknown photo identifiers', async () => {
    const { tagger } = service({ fetch: vi.fn(async input => String(input).endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e2b' }] }) : String(input).endsWith('/api/show') ? Response.json({ capabilities: ['vision'] }) : Response.json({ response: 'not json' })) });
    await tagger.initialize(); await tagger.setEnabled(true);
    expect((await tagger.tag(['jpg'], 'invalid', () => {})).failures).toBe(1);
    await expect(tagger.tag(['arbitrary-path'], 'unknown', () => {})).rejects.toThrow('no longer available');
  });
});
it('normalizes and bounds model-generated tag text', () => {
  expect(cleanTags([' Red  fox ', 'red fox', '', '<img>', 'x'.repeat(41), null, '山'])).toEqual(['red fox', '山']);
  expect(cleanTags('landscape')).toEqual([]);
});
