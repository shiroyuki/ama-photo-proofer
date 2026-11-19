/** Synthetic DNG container with a JPEG preview; no camera sensor data. */
export function previewDng(jpeg: Buffer): Buffer {
  const string = (value: string) => Buffer.from(`${value}\0`);
  const tags: [number, number, number, number | Buffer][] = [
    [254, 4, 1, 1], [256, 4, 1, 1000], [257, 4, 1, 667],
    [258, 3, 3, Buffer.from([8, 0, 8, 0, 8, 0])], [259, 3, 1, 6], [262, 3, 1, 2],
    [271, 2, 5, string('Test')], [272, 2, 12, string('Test Camera')],
    [306, 2, 20, string('2026:11:12 23:45:00')],
    [513, 4, 1, 0], [514, 4, 1, jpeg.length],
    [50706, 1, 4, Buffer.from([1, 4, 0, 0])],
    [50708, 2, 12, string('Test Camera')],
  ];
  const header = Buffer.alloc(8 + 2 + tags.length * 12 + 4);
  header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags.length, 8);
  const extras: Buffer[] = [];
  let offset = header.length;
  let jpegPointer = 0;
  tags.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    header.writeUInt16LE(tag, at); header.writeUInt16LE(type, at + 2); header.writeUInt32LE(count, at + 4);
    if (tag === 513) jpegPointer = at + 8;
    if (typeof value === 'number') header.writeUInt32LE(value, at + 8);
    else if (value.length <= 4) value.copy(header, at + 8);
    else { header.writeUInt32LE(offset, at + 8); extras.push(value); offset += value.length; }
  });
  header.writeUInt32LE(offset, jpegPointer);
  return Buffer.concat([header, ...extras, jpeg]);
}

/** Compact uncompressed Bayer DNG containing sensor data and no JPEG thumbnail. */
export function sensorDng(width = 192, height = 320) {
  const short = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
    return buffer;
  };
  const rational = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => {
      buffer.writeInt32LE(Math.round(value * 10000), index * 8);
      buffer.writeInt32LE(10000, index * 8 + 4);
    });
    return buffer;
  };
  const tags: [number, number, number, number | Buffer][] = [
    [254, 4, 1, 0], [256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, 16],
    [259, 3, 1, 1], [262, 3, 1, 32803], [271, 2, 8, Buffer.from('Fixture\0')],
    [272, 2, 12, Buffer.from('Bayer Test\0\0')], [273, 4, 1, 0], [274, 3, 1, 1],
    [277, 3, 1, 1], [278, 4, 1, height], [279, 4, 1, width * height * 2], [284, 3, 1, 1],
    [33421, 3, 2, short(2, 2)], [33422, 1, 4, Buffer.from([0, 1, 1, 2])],
    [50706, 1, 4, Buffer.from([1, 4, 0, 0])], [50707, 1, 4, Buffer.from([1, 1, 0, 0])],
    [50708, 2, 12, Buffer.from('Bayer Test\0\0')], [50714, 3, 1, 512], [50717, 4, 1, 16383],
    [50721, 10, 9, rational(0.65, -0.14, -0.05, -0.3, 1.12, 0.2, -0.04, 0.16, 0.52)],
    [50728, 5, 3, rational(0.5, 1, 0.66)], [50778, 3, 1, 21],
  ];
  const header = Buffer.alloc(14 + tags.length * 12);
  header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags.length, 8);
  const extras: Buffer[] = [];
  let pointer = header.length;
  let strip = 0;
  tags.forEach(([tag, type, count, value], index) => {
    const start = 10 + index * 12;
    header.writeUInt16LE(tag, start); header.writeUInt16LE(type, start + 2); header.writeUInt32LE(count, start + 4);
    if (tag === 273) strip = start + 8;
    if (typeof value === 'number') header.writeUInt32LE(value, start + 8);
    else if (value.length <= 4) value.copy(header, start + 8);
    else { header.writeUInt32LE(pointer, start + 8); extras.push(value); pointer += value.length; }
  });
  header.writeUInt32LE(pointer, strip);
  const pixels = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const signal = 3000 + x * 10 + y * 5;
    const multiplier = y % 2 === 0 && x % 2 === 0 ? 0.5 : y % 2 === 1 && x % 2 === 1 ? 0.66 : 1;
    pixels.writeUInt16LE(512 + Math.round(signal * multiplier), 2 * (y * width + x));
  }
  return Buffer.concat([header, ...extras, pixels]);
}
