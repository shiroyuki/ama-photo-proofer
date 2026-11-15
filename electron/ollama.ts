import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { graphics } from 'systeminformation';
import type { MediaKind, OllamaStatus, TagProgress, TagResult } from '../shared/model';
const MODEL = 'gemma4:e2b' as const;
const HOST = 'http://127.0.0.1:11434';
export interface GPU { model: string; vendor: string; vram: number | null; vramDynamic: boolean; memoryTotal?: number }
export function dedicatedGPU(controllers: GPU[]): GPU | undefined {
  return controllers.find(gpu => {
    const memory = gpu.memoryTotal ?? gpu.vram;
    if (gpu.vramDynamic !== false || !memory || memory <= 0) return false;
    const name = `${gpu.vendor} ${gpu.model}`;
    if (/integrated|tegra|jetson|virtual|microsoft|vmware|virtio|iris|\buhd\b/i.test(name)) return false;
    // Positive identification: unknown or shared-memory adapters remain disabled.
    return /nvidia/i.test(name) || /radeon\s+(?:rx\s*\d|pro\s+[wv]|vii\b|r[579]\s+\d{3})/i.test(name) || /arc\s+[ab]\d{3}\b/i.test(name);
  });
}
export interface TagAsset { key: string; kind: MediaKind }
interface Options {
  directory: string;
  platform?: string;
  detectGPU?: () => Promise<GPU[]>;
  fetch?: typeof fetch;
  asset(id: string): TagAsset | undefined;
  image(id: string, signal: AbortSignal): Promise<Buffer>;
}
export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(tag => tag.length > 0 && tag.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\s-]*$/u.test(tag)))].slice(0, 12);
}
export class OllamaTagger {
  private enabled = false;
  private cache: Record<string, string[]> = {};
  private controller?: AbortController;
  private job?: Promise<TagResult>;
  private settingsWrite: Promise<void> = Promise.resolve();
  private readonly request: typeof fetch;
  constructor(private options: Options) {
    this.request = options.fetch ?? fetch;
    this.enabled = (options.platform ?? process.platform) === 'darwin';
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(path.join(this.options.directory, 'ollama-settings.json'), 'utf8'));
      if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled;
    } catch { /* Default on for a ready macOS model; off on other platforms. */ }
    try {
      const stored = JSON.parse(await readFile(path.join(this.options.directory, 'photo-tags.json'), 'utf8'));
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) this.cache = Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, cleanTags(value)]));
    } catch { /* No cached tags yet. */ }
  }
  private async json(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await this.request(`${HOST}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    return response.json();
  }
  async status(): Promise<OllamaStatus> {
    const result: OllamaStatus = { model: MODEL, enabled: false, available: false, reasons: [] };
    const isMac = (this.options.platform ?? process.platform) === 'darwin';
    const [gpu, server] = await Promise.allSettled([
      isMac ? Promise.resolve([] as GPU[]) : Promise.race([
        (this.options.detectGPU ?? (async () => (await graphics()).controllers))(),
        new Promise<GPU[]>((_, reject) => { const timer = setTimeout(() => reject(new Error('GPU detection timed out.')), 5000); timer.unref(); }),
      ]),
      this.json('/api/tags'),
    ]);
    const dedicated = gpu.status === 'fulfilled' ? dedicatedGPU(gpu.value) : undefined;
    if (dedicated) result.gpu = dedicated.model;
    else if (!isMac) result.reasons.push('A dedicated GPU with its own video memory could not be confirmed. Integrated, shared-memory, and unknown GPUs are disabled.');
    if (server.status === 'rejected') result.reasons.push('Ollama is not available at 127.0.0.1:11434. Start Ollama and check again.');
    else if (!Array.isArray(server.value?.models) || !server.value.models.some((model: any) => model?.name === MODEL || model?.model === MODEL)) {
      result.reasons.push(`The ${MODEL} model is not installed. Run ollama pull ${MODEL}, then check again.`);
    } else {
      try {
        const model = await this.json('/api/show', { model: MODEL });
        if (model?.remote_host || model?.remote_model) result.reasons.push('Use a locally installed gemma4:e2b model. Cloud-backed models are disabled.');
        if (!Array.isArray(model?.capabilities) || !model.capabilities.includes('vision')) result.reasons.push(`${MODEL} does not report image support. Update Ollama and the model, then check again.`);
      } catch { result.reasons.push(`Ollama could not load information about ${MODEL}. Check Ollama and try again.`); }
    }
    result.available = result.reasons.length === 0;
    result.enabled = this.enabled && result.available;
    if (!result.available) this.cancel();
    return result;
  }
  async setEnabled(value: boolean): Promise<OllamaStatus> {
    if (!value) { this.enabled = false; this.cancel(); }
    const status = await this.status();
    if (value && !status.available) throw new Error(status.reasons.join(' '));
    const write = this.settingsWrite.catch(() => {}).then(() => this.write('ollama-settings.json', { enabled: value }));
    this.settingsWrite = write;
    await write; this.enabled = value;
    return { ...status, enabled: value && status.available };
  }
  tags(ids: string[]): Record<string, string[]> {
    return Object.fromEntries(ids.flatMap(id => {
      const asset = this.options.asset(id); const tags = asset && this.cache[asset.key];
      return tags?.length ? [[id, tags]] : [];
    }));
  }
  cancel() { this.controller?.abort(); }
  async stop() { this.cancel(); await this.job?.catch(() => {}); await this.settingsWrite.catch(() => {}); }
  async tag(ids: string[], jobId: string, progress: (value: TagProgress) => void): Promise<TagResult> {
    if (this.job) throw new Error('Photo tagging is already running.');
    if (!this.enabled) throw new Error('Enable Ollama tagging in Settings first.');
    const assets = [...new Set(ids)].map(id => {
      const asset = this.options.asset(id);
      if (!asset) throw new Error('A photo is no longer available. Reopen the source and try again.');
      return { id, asset };
    }).filter(({ asset }) => asset.kind !== 'video');
    const controller = new AbortController(); this.controller = controller;
    const work = async () => {
      const status = await this.status();
      if (controller.signal.aborted && !this.enabled) return { completed: 0, total: assets.length, cancelled: true, failures: 0 };
      if (!status.available || !this.enabled) throw new Error(status.reasons.join(' ') || 'Ollama tagging is disabled.');
      const result: TagResult = { completed: 0, total: assets.length, cancelled: false, failures: 0 };
      let changed = false;
      try {
        for (const { id, asset } of assets) {
          if (controller.signal.aborted || !this.enabled) { result.cancelled = true; break; }
          progress({ jobId, id, completed: result.completed, total: result.total });
          try {
            let tags = this.cache[asset.key];
            if (!tags?.length) {
              const image = await this.options.image(id, controller.signal);
              controller.signal.throwIfAborted();
              const data = await this.json('/api/generate', {
                model: MODEL, stream: false, think: false,
                prompt: 'Tag this photograph with 3 to 8 short, factual, lowercase keywords describing visible subjects, setting, colors, and activities. Do not identify people or infer sensitive personal traits. Return only the requested JSON.',
                images: [image.toString('base64')],
                format: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 12 } }, required: ['tags'], additionalProperties: false },
                options: { temperature: 0.1, num_predict: 256, ...((this.options.platform ?? process.platform) === 'darwin' ? {} : { num_gpu: 99 }) }, keep_alive: '2m',
              }, controller.signal);
              if (typeof data.response !== 'string') throw new Error('Ollama returned no tags.');
              tags = cleanTags(JSON.parse(data.response).tags);
              if (!tags.length) throw new Error('Ollama returned no usable tags.');
              controller.signal.throwIfAborted();
              this.cache[asset.key] = tags; changed = true;
            }
            result.completed++; progress({ jobId, id, tags, completed: result.completed, total: result.total });
          } catch (error) {
            if (controller.signal.aborted || !this.enabled) { result.cancelled = true; break; }
            result.completed++; result.failures++;
            progress({ jobId, id, error: error instanceof Error ? error.message : String(error), completed: result.completed, total: result.total });
            if (error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.message.startsWith('Ollama returned HTTP')))) break;
          }
        }
      } finally { if (changed) await this.write('photo-tags.json', this.cache); }
      return result;
    };
    this.job = work();
    try { return await this.job; } finally { this.job = undefined; this.controller = undefined; }
  }
  private async write(name: string, value: unknown) {
    await mkdir(this.options.directory, { recursive: true });
    const target = path.join(this.options.directory, name);
    await writeFile(`${target}.tmp`, JSON.stringify(value)); await rename(`${target}.tmp`, target);
  }
}
