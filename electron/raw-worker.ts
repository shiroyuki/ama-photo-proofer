import { readFile, stat } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { LibRaw } from '@colorhythm/libraw-wasm';
import type { RawRequest } from './raw-development';

async function develop({ file, exposure, warmth, whiteBalance, recoverHighlights, preview }: RawRequest) {
  if ((await stat(file)).size > 256 * 1024 * 1024) throw new Error('This RAW file exceeds the 256 MB editing limit.');
  const binary = await readFile(require.resolve('@colorhythm/libraw-wasm/libraw.wasm'));
  await LibRaw.initialize(Uint8Array.from(binary).buffer);
  const raw = new LibRaw();
  await raw.waitUntilReady();
  try {
    const bytes = await readFile(file);
    const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    raw.open(input);
    const pixels = raw.getRawWidth() * raw.getRawHeight();
    if (pixels <= 0 || pixels > 120_000_000) throw new Error('The RAW sensor dimensions are outside the supported range.');
    raw.setOutputBps(16);
    raw.setOutputColor(1);
    // Match the sRGB transfer curve as well as its primaries.
    raw.setGamma(0, 1 / 2.4);
    raw.setGamma(1, 12.92);
    raw.setNoAutoBright(1);
    raw.setBright(2 ** exposure);
    raw.setHighlight(recoverHighlights ? 2 : 0);
    if (preview && pixels > 4_000_000) raw.setHalfSize(1);
    const daylight = [0, 1, 2, 3].map(channel => raw.getPreMul(channel));
    const camera = [0, 1, 2, 3].map(channel => raw.getCamMul(channel));
    const valid = (values: number[]) => values.slice(0, 3).every(value => Number.isFinite(value) && value > 0);
    const asShot = whiteBalance === 'as-shot' && valid(camera);
    if (!warmth && asShot) raw.setUseCameraWb(1);
    else {
      const values = asShot ? camera : valid(daylight) ? daylight : [1, 1, 1, 1];
      const adjustment = warmth / 100;
      const scale = [2 ** adjustment, 1, 2 ** -adjustment, 1];
      for (let channel = 0; channel < 4; channel++) {
        const multiplier = (values[channel] > 0 ? values[channel] : values[1]) * scale[channel];
        raw.setUserMul(channel, multiplier);
      }
    }
    raw.unpack();
    raw.dcrawProcess();
    const image = raw.dcrawMakeMemImage();
    if (image.type_ !== 'LIBRAW_IMAGE_BITMAP' || image.bits !== 16 || ![1, 3].includes(image.colors)
      || image.data.byteLength !== image.width * image.height * image.colors * 2) throw new Error('The decoder returned an unsupported pixel layout.');
    parentPort!.postMessage({ width: image.width, height: image.height, channels: image.colors, data: image.data.buffer }, [image.data.buffer]);
  } finally {
    raw.dispose();
  }
}

void develop(workerData).catch(error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }));
