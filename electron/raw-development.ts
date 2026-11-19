import path from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import type { PhotoEdits } from '../shared/edits';

export interface RawRequest {
  file: string;
  exposure: number;
  warmth: number;
  whiteBalance: 'as-shot' | 'daylight';
  recoverHighlights: boolean;
  preview: boolean;
}

interface RawImage { width: number; height: number; channels: 1 | 3; data: ArrayBuffer }

let queue: Promise<unknown> = Promise.resolve();

export function developRaw(file: string, edits: PhotoEdits, preview: boolean) {
  const request: RawRequest = {
    file, exposure: edits.exposure, warmth: edits.warmth, preview,
    whiteBalance: edits.raw?.whiteBalance ?? 'as-shot',
    recoverHighlights: edits.raw?.recoverHighlights ?? true,
  };
  // Demosaic one image at a time to bound peak memory on large files.
  const job = queue.then(() => decode(request));
  queue = job.catch(() => {});
  return job.then(({ width, height, channels, data }) =>
    sharp(new Uint16Array(data), { raw: { width, height, channels } }));
}

function decode(workerData: RawRequest): Promise<RawImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'raw-worker.js'), { workerData });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('RAW development timed out.'));
    }, 90_000);
    worker.once('message', (result: RawImage | { error: string }) => {
      if ('error' in result) reject(new Error(`Could not develop this RAW file. ${result.error}`));
      else resolve(result);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`RAW development stopped before returning an image (code ${code}).`));
    });
  });
}
