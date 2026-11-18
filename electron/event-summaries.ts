import { createHash } from 'node:crypto';
import { summarySlug } from '../shared/summary';
import type { EventSummaryUpdate } from '../shared/model';
import type { SessionCache } from './session-cache';
export interface SummaryEvent {
  id: string; name: string; start: string; end: string; keys: string[];
  photos: { id: string; labels: string[] }[];
}
interface Options {
  events(): SummaryEvent[];
  cache(): SessionCache | undefined;
  generate(photos: SummaryEvent['photos'], signal: AbortSignal): Promise<string | undefined>;
  notify(update: EventSummaryUpdate): void;
}
interface Pending { promise: Promise<string | undefined>; controller: AbortController; waiters: number; settled: boolean }
export function eventFingerprint(event: SummaryEvent) {
  return createHash('sha256').update(JSON.stringify(['visual-summary-v2', event.start, event.end, [...event.keys].sort()])).digest('hex');
}
export class EventSummaries {
  private pending = new Map<string, Pending>();
  private job?: Promise<{ cancelled: boolean; failures: number }>;
  private controller?: AbortController;
  private stopRequested = false;
  constructor(private options: Options) {}
  get busy() { return Boolean(this.job) || this.pending.size > 0; }
  cached() {
    const cache = this.options.cache();
    return Object.fromEntries(this.options.events().filter(event => event.photos.length).flatMap(event => {
      const summary = cache?.getEventSummary(eventFingerprint(event));
      return summary ? [[event.id, summary]] : [];
    }));
  }
  async forExport(name: string, signal: AbortSignal) {
    const event = this.options.events().find(event => event.name === name);
    if (!event) throw new Error('This event is no longer indexed. Reopen the source.');
    return this.ensure(event, signal);
  }
  stopQueued() { this.stopRequested = true; }
  async stop() {
    this.stopQueued(); this.controller?.abort();
    const pending = [...this.pending.values()]; pending.forEach(task => task.controller.abort());
    await Promise.allSettled([this.job, ...pending.map(task => task.promise)]);
  }
  run() {
    if (this.job) return this.job;
    this.stopRequested = false; const controller = new AbortController(); this.controller = controller;
    const events = this.options.events().filter(event => event.photos.length), cache = this.options.cache();
    cache?.pruneEventSummaries(new Set(events.map(eventFingerprint)));
    const missing = events.filter(event => !cache?.getEventSummary(eventFingerprint(event)));
    const work = async () => {
      let completed = 0, failures = 0, cancelled = false;
      this.options.notify({ completed, total: missing.length, done: false });
      for (const event of missing) {
        if (controller.signal.aborted || this.stopRequested) { cancelled = true; break; }
        try {
          const summary = await this.ensure(event, controller.signal);
          if (!summary && (controller.signal.aborted || this.stopRequested)) { cancelled = true; break; }
        } catch (error) {
          if (controller.signal.aborted) { cancelled = true; break; }
          failures++;
          this.options.notify({ id: event.id, error: error instanceof Error ? error.message : String(error) });
        }
        completed++;
        this.options.notify({ completed, total: missing.length, done: false });
      }
      await cache?.save();
      this.options.notify({ completed, total: missing.length, done: true, cancelled });
      return { cancelled, failures };
    };
    this.job = work().finally(() => { this.job = undefined; this.controller = undefined; }); return this.job;
  }
  private async ensure(event: SummaryEvent, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!event.photos.length) return;
    const cache = this.options.cache(); if (!cache) throw new Error('Open a proofing session first.');
    const key = eventFingerprint(event), saved = cache.getEventSummary(key); if (saved) return saved;
    let task = this.pending.get(key);
    if (!task) {
      const created: Pending = { promise: Promise.resolve(undefined), controller: new AbortController(), waiters: 0, settled: false };
      this.pending.set(key, created);
      created.promise = (async () => {
        const generated = await this.options.generate(event.photos, created.controller.signal);
        created.controller.signal.throwIfAborted();
        if (generated === undefined) return;
        const summary = summarySlug(generated); if (!summary) throw new Error('Ollama returned no usable event summary.');
        cache.setEventSummary(key, summary); await cache.save();
        this.options.notify({ id: event.id, summary }); return summary;
      })().finally(() => { created.settled = true; this.pending.delete(key); });
      task = created;
    }
    const pending = task; pending.waiters++;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason ?? new Error('Summary cancelled.')); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        pending.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    } finally { pending.waiters--; if (!pending.waiters && !pending.settled) pending.controller.abort(); }
  }
}
