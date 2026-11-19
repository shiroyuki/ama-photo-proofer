import { developRaw } from './raw-development';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { cubeSampler, type CubeLut } from './cube-lut';
import { setImmediate as yieldToMain } from 'node:timers/promises';
import type { EditVersion, PhotoEdits, VersionExportOptions } from '../shared/edits';
import type { ExportResult, MediaFile } from '../shared/model';

const fontfile = path.join(__dirname, '../../dist/fonts/Inter-Regular.ttf').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const escapeMarkup = (text: string) => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

export function toneCurve({ highlights, shadows, brightness, blacks }: PhotoEdits) {
  const smooth = (x: number) => x * x * (3 - 2 * x);
  return Uint8Array.from({ length: 256 }, (_, index) => {
    const value = index / 255;
    const highlightWeight = smooth(Math.max(0, (value - 0.5) * 2));
    const shadowPosition = Math.min(1, value / 0.55);
    const shadowWeight = 4 * shadowPosition * (1 - shadowPosition);
    const blackWeight = 1 - smooth(Math.min(1, value / 0.25));
    const adjusted = value + brightness * 0.0025 + blacks * 0.0015 * blackWeight
      + shadows * 0.0015 * shadowWeight + highlights * 0.0025 * highlightWeight;
    return Math.round(Math.max(0, Math.min(1, adjusted)) * 255);
  });
}

export async function adjustedPhoto(file: string, edits: PhotoEdits, mode: 'export' | 'editor' | 'thumbnail', raw = false, lut?: CubeLut) {
  const image = raw ? await developRaw(file, edits, mode !== 'export') : sharp(file).autoOrient();
  image.toColourspace('srgb');
  if (mode === 'editor') image.resize(1000, 800, { fit: 'inside', withoutEnlargement: true });
  if (mode === 'thumbnail') image.resize(640, 640, { fit: 'inside', withoutEnlargement: true });
  const rotation = ((edits.rotation % 360) + 360) % 360;
  if (rotation) image.rotate(rotation);
  const contrast = 1 + edits.contrast / 100;
  const exposure = raw ? 1 : 2 ** edits.exposure;
  const warmth = raw ? 0 : edits.warmth * 0.002;
  const offset = (raw ? 32768 : 128) * (1 - contrast);
  image.linear([1 + warmth, 1, 1 - warmth].map(channel => channel * contrast * exposure), [offset, offset, offset]);
  image.modulate({ saturation: edits.monochrome ? 0 : 1 + edits.saturation / 100 });
  const grade = Boolean(edits.highlights || edits.shadows || edits.brightness || edits.blacks || lut);
  if (!grade && (mode === 'editor' || (mode === 'thumbnail' && !edits.crop))) return image.jpeg({ quality: 88 }).toBuffer();

  // Resolve rotation before mapping the normalized crop rectangle to output pixels.
  if (grade) image.removeAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  if (grade) {
    const tone = toneCurve(edits);
    const sample = lut && cubeSampler(lut);
    // Yield between chunks to keep the desktop responsive during full-size exports.
    const chunk = 256 * 1024 * info.channels;
    for (let start = 0; start < data.length; start += chunk) {
      const end = Math.min(data.length, start + chunk);
      if (sample) {
        for (let i = start; i < end; i += info.channels) sample(data, i, tone[data[i]], tone[data[i + 1]], tone[data[i + 2]]);
      } else {
        for (let i = start; i < end; i++) data[i] = tone[data[i]];
      }
      if (end < data.length) await yieldToMain();
    }
  }
  const rendered = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  if (edits.crop && mode !== 'editor') {
    const left = Math.min(info.width - 1, Math.floor(edits.crop.x * info.width));
    const top = Math.min(info.height - 1, Math.floor(edits.crop.y * info.height));
    rendered.extract({ left, top, width: Math.max(1, Math.min(info.width - left, Math.round(edits.crop.width * info.width))), height: Math.max(1, Math.min(info.height - top, Math.round(edits.crop.height * info.height))) });
  }
  return mode === 'export' ? rendered.png().toBuffer() : rendered.jpeg({ quality: 88 }).toBuffer();
}

export function automaticCaption(photo: MediaFile, exif: Record<string, unknown>, options: VersionExportOptions = {}) {
  const name = options.name?.trim() || [exif.Artist, exif.Creator, exif.OwnerName].find(value => typeof value === 'string' && value.trim()) || photo.stem;
  const exposure = [photo.iso && `ISO ${photo.iso}`, photo.aperture && `ƒ/${photo.aperture}`, photo.shutter].filter(Boolean).join(' · ');
  let date = photo.capturedAt;
  const offset = typeof exif.OffsetTimeOriginal === 'string' && /^[+-]\d{2}:\d{2}$/.test(exif.OffsetTimeOriginal) ? exif.OffsetTimeOriginal : '';
  const knownZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(date) || offset;
  if (offset && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date)) date += offset;
  const when = new Intl.DateTimeFormat(options.locale, { dateStyle: 'medium', timeStyle: knownZone ? 'long' : 'medium', timeZone: knownZone ? options.timeZone : 'UTC' }).format(new Date(knownZone ? date : date + 'Z'));
  const timestamp = photo.timestampSource === 'capture' ? when + (knownZone ? '' : ' (timezone unknown)') : 'Capture time unavailable';
  return `${name}\n${exposure || 'Exposure settings unavailable'}\n${timestamp}`;
}

async function overlay(text: string, width: number, height: number, caption: boolean) {
  // A 16 px em at 1200 px output width, scaled down for small exports.
  const rem = Math.max(1, Math.round(Math.min(width / 75, height / 12)));
  if (width < 5 || height < 5) throw new Error('The crop is too small to add export text.');
  const label = await sharp({ text: {
    text: `<span foreground="${caption ? '#000000' : '#ffffff'}">${escapeMarkup(text)}</span>`,
    font: `Inter ${rem}`, fontfile, rgba: true, width: Math.min(width - 4 * rem, Math.round(width * (caption ? 0.78 : 0.55))), align: 'left', wrap: 'word-char',
  } }).png().toBuffer({ resolveWithObject: true });
  if (label.info.height + 4 * rem > height) throw new Error('The export text is too long for this crop.');
  const box = sharp(label.data);
  if (caption) box.flatten({ background: '#ffffff' });
  const input = await box.extend({ top: rem, bottom: rem, left: rem, right: rem, background: caption ? '#ffffff' : '#00000099' }).png().toBuffer();
  return { input, left: caption ? width - label.info.width - 3 * rem : rem, top: caption ? height - label.info.height - 3 * rem : rem };
}

export async function exportVersions(file: string, photo: MediaFile, versions: EditVersion[], destination: string, options: VersionExportOptions, exif: Record<string, unknown>, getLut: (id: string) => CubeLut) {
  await mkdir(destination, { recursive: true });
  const result: ExportResult = { copied: 0, total: versions.length, cancelled: false, destination, failures: [] };
  const caption = options.automatic ? automaticCaption(photo, exif, options) : options.caption?.trim();
  for (const version of versions) {
    const stem = `${photo.stem} (v${version.number})`;
    const extension = photo.kind === 'raw' ? '.JPG' : path.extname(file);
    try {
      const lut = version.edits.lut && getLut(version.edits.lut.id);
      const adjusted = await adjustedPhoto(file, version.edits, 'export', photo.kind === 'raw', lut);
      const image = sharp(adjusted);
      const { width, height } = await image.metadata();
      const layers = [];
      if (options.watermark?.trim()) layers.push(await overlay(options.watermark.trim(), width, height, false));
      if (caption) layers.push(await overlay(caption, width, height, true));
      if (layers.length) image.composite(layers);
      const jpeg = await image.jpeg({ quality: 95 }).toBuffer();
      for (let copy = 0; ; copy++) {
        const name = `${stem}${copy ? ` (${copy})` : ''}${extension}`;
        try {
          await writeFile(path.join(destination, name), jpeg, { flag: 'wx' });
          result.copied++;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } catch (error) {
      result.failures.push({ name: stem + extension, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
