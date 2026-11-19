import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cubeSampler, readCube } from '../electron/cube-lut';
import { exportVersions, toneCurve } from '../electron/edit-render';
import { defaultEdits, readEdits } from '../shared/edits';
import { asset } from './export-fixture';

it('reads existing recipes with neutral tone sliders and validates new values', () => {
  const { highlights, shadows, brightness, blacks, ...oldRecipe } = defaultEdits;
  expect(readEdits(oldRecipe)).toEqual(defaultEdits);
  expect(readEdits({ ...oldRecipe, blacks: -42 }).blacks).toBe(-42);
  expect(() => readEdits({ ...oldRecipe, highlights: 101 })).toThrow('supported range');
  expect(() => readEdits({ ...oldRecipe, lut: { id: '../file.cube', name: 'Look' } })).toThrow('LUT reference');
});

it('targets the different tonal regions without changing neutral edits', () => {
  const neutral = toneCurve(defaultEdits);
  expect([...neutral]).toEqual(Array.from({ length: 256 }, (_, value) => value));
  const highlights = toneCurve({ ...defaultEdits, highlights: -50 });
  const shadows = toneCurve({ ...defaultEdits, shadows: 50 });
  const brightness = toneCurve({ ...defaultEdits, brightness: 50 });
  const blacks = toneCurve({ ...defaultEdits, blacks: 50 });
  expect([highlights[64], highlights[220] < 220]).toEqual([64, true]);
  expect([shadows[64] > 64, shadows[220]]).toEqual([true, 220]);
  expect([brightness[64] > 64, brightness[220] > 220]).toEqual([true, true]);
  expect([blacks[0] > 0, blacks[64]]).toEqual([true, 64]);
});

it('interpolates red-fastest .cube colors and applies the declared input range', () => {
  const rows = ['0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1'].join('\n');
  const pixel = Buffer.alloc(3);
  cubeSampler(readCube(`TITLE "Swap # red and blue"\nLUT_3D_SIZE 2\n${rows}`))(pixel, 0, 40, 140, 220);
  expect([...pixel]).toEqual([220, 140, 40]);
  cubeSampler(readCube(`LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 0.5\n${rows}`))(pixel, 0, 40, 140, 220);
  expect([...pixel]).toEqual([255, 255, 80]);
  expect(() => readCube('LUT_3D_SIZE 2\n0 0 0')).toThrow('complete 3D color table');
  expect(() => readCube('LUT_1D_SIZE 3')).toThrow('3D .cube LUT');
});

it('exports an opaque white caption behind and between the text', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'proof-caption-'));
  try {
    const source = path.join(folder, 'Photo.JPG');
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#403020' } }).jpeg().toFile(source);
    const { metadata } = asset(source);
    const photo = { ...metadata, id: 'photo', size: 1, directory: folder };
    const result = await exportVersions(source, photo, [{ number: 1, edits: defaultEdits }], folder, {
      caption: 'A long line of caption text\nI',
    }, {}, () => { throw new Error('Unexpected LUT'); });
    expect(result.failures).toEqual([]);
    const { data, info } = await sharp(path.join(folder, 'Photo (v1).JPG')).raw().toBuffer({ resolveWithObject: true });
    const rgb = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    // At this size 1 rem is 16 px. Both points are inside the box, with
    // one in its bottom padding and one in the empty part of the short line.
    expect(rgb(1156, 776)).toEqual([255, 255, 255]);
    expect(rgb(1156, 762)).toEqual([255, 255, 255]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
