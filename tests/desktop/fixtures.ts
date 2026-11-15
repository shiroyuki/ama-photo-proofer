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
