import sharp from 'sharp';

export async function thumbnailSignature(file: string) {
  return sharp(file).resize(16, 16, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
}

export function nearDuplicate(a: Buffer, b: Buffer) {
  // Compare coarse color and edges. Ignore small differences caused by JPEG compression.
  let color = 0;
  let edges = 0;
  const luminance = (pixels: Buffer, i: number) => (pixels[i] * 3 + pixels[i + 1] * 6 + pixels[i + 2]) / 10;
  for (let offset = 0; offset < a.length; offset += 3) {
    color += Math.abs(a[offset] - b[offset]) + Math.abs(a[offset + 1] - b[offset + 1]) + Math.abs(a[offset + 2] - b[offset + 2]);
    if (offset % 48 === 45) continue;
    const edgeA = luminance(a, offset + 3) - luminance(a, offset);
    const edgeB = luminance(b, offset + 3) - luminance(b, offset);
    if (Math.max(Math.abs(edgeA), Math.abs(edgeB)) > 8 && Math.sign(edgeA) !== Math.sign(edgeB)) edges++;
  }
  return color / a.length <= 15 && edges <= 25;
}
