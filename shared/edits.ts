export interface Crop { x: number; y: number; width: number; height: number }
export interface PhotoLut { id: string; name: string }
export interface PhotoEdits {
  exposure: number;
  highlights: number;
  shadows: number;
  brightness: number;
  blacks: number;
  contrast: number;
  saturation: number;
  warmth: number;
  rotation: number;
  monochrome: boolean;
  crop?: Crop;
  lut?: PhotoLut;
  raw?: { whiteBalance: 'as-shot' | 'daylight'; recoverHighlights: boolean };
}
export interface EditVersion { number: number; edits: PhotoEdits }
export interface VersionExportOptions { watermark?: string; caption?: string; automatic?: boolean; name?: string; locale?: string; timeZone?: string }
export const defaultEdits: PhotoEdits = {
  exposure: 0, highlights: 0, shadows: 0, brightness: 0, blacks: 0,
  contrast: 0, saturation: 0, warmth: 0, rotation: 0, monochrome: false,
};

export function readEdits(input: unknown): PhotoEdits {
  if (!input || typeof input !== 'object') throw new Error('Invalid photo adjustments.');
  const value = input as PhotoEdits;
  const number = (value: number, min: number, max: number) => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('An adjustment is outside its supported range.');
    return value;
  };
  const tone = (value: number | undefined) => number(value === undefined ? 0 : value, -100, 100);
  const edits: PhotoEdits = {
    exposure: number(value.exposure, -2, 2),
    highlights: tone(value.highlights),
    shadows: tone(value.shadows),
    brightness: tone(value.brightness),
    blacks: tone(value.blacks),
    contrast: number(value.contrast, -100, 100),
    saturation: number(value.saturation, -100, 100),
    warmth: number(value.warmth, -100, 100),
    rotation: number(value.rotation, -360, 360),
    monochrome: value.monochrome === true,
  };
  if (value.crop) {
    const { x, y, width, height } = value.crop;
    edits.crop = { x: number(x, 0, 1), y: number(y, 0, 1), width: number(width, 0.005, 1 - x + 1e-9), height: number(height, 0.005, 1 - y + 1e-9) };
  }
  if (value.raw) {
    if (!['as-shot', 'daylight'].includes(value.raw.whiteBalance) || typeof value.raw.recoverHighlights !== 'boolean') throw new Error('Invalid RAW development settings.');
    edits.raw = { whiteBalance: value.raw.whiteBalance, recoverHighlights: value.raw.recoverHighlights };
  }
  if (value.lut !== undefined) {
    const lut = value.lut;
    if (!lut || typeof lut.id !== 'string' || !/^[a-f0-9]{64}$/.test(lut.id) || typeof lut.name !== 'string' || !lut.name.trim() || lut.name.length > 512) throw new Error('Invalid LUT reference.');
    edits.lut = { id: lut.id, name: lut.name };
  }
  return edits;
}
