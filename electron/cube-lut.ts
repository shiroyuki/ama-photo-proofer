export const maxCubeBytes = 16 * 1024 * 1024;
const maxCubeSize = 65;

export interface CubeLut {
  size: number;
  min: number[];
  max: number[];
  values: Float32Array;
}

export function readCube(source: string): CubeLut {
  const lines = source.split(/\r\n?|\n/);
  const invalid = (line: number) => new Error(`Invalid .cube LUT on line ${line + 1}.`);
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let values = new Float32Array(0);
  let count = 0;
  for (const [index, line] of lines.entries()) {
    const entry = line.trim();
    if (/^TITLE\s+"[^"]*"\s*(?:#.*)?$/i.test(entry) && !count) continue;
    const text = entry.split('#', 1)[0].trim();
    if (!text) continue;
    const [key, ...args] = text.split(/\s+/);
    const directive = key.toUpperCase();
    if (directive.startsWith('LUT_1D_')) throw new Error('Choose a 3D .cube LUT without a 1D shaper.');
    if (directive === 'LUT_3D_SIZE') {
      const dimension = Number(args[0]);
      if (args.length !== 1 || size || !Number.isInteger(dimension) || dimension < 2 || dimension > maxCubeSize) {
        throw new Error(`Choose a 3D .cube LUT with 2 to ${maxCubeSize} points per axis.`);
      }
      size = dimension;
      values = new Float32Array(size ** 3 * 3);
    } else if (['DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_3D_INPUT_RANGE'].includes(directive)) {
      const range = args.map(Number);
      if (count || !range.every(Number.isFinite) || range.length !== (directive === 'LUT_3D_INPUT_RANGE' ? 2 : 3)) throw invalid(index);
      if (directive === 'DOMAIN_MIN') min = range;
      else if (directive === 'DOMAIN_MAX') max = range;
      else {
        min = [range[0], range[0], range[0]];
        max = [range[1], range[1], range[1]];
      }
    } else {
      const rgb = [key, ...args].map(Number);
      if (rgb.length !== 3 || !rgb.every(value => Number.isFinite(Math.fround(value))) || count >= values.length) throw invalid(index);
      values.set(rgb, count);
      count += 3;
    }
  }
  if (!size || count !== values.length) throw new Error('The .cube LUT does not contain a complete 3D color table.');
  if (min.some((value, channel) => max[channel] <= value || !Number.isFinite(max[channel] - value))) throw new Error('The .cube LUT has an invalid input range.');
  return { size, min, max, values };
}

export function cubeSampler({ size, min, max, values }: CubeLut) {
  // The image enters this stage as 8-bit sRGB. Map each input value to the
  // neighboring grid points once, then interpolate those points per pixel.
  const axes = [3, 3 * size, 3 * size * size].map((stride, channel) =>
    Array.from({ length: 256 }, (_, value) => {
      const position = Math.min(1, Math.max(0, (value / 255 - min[channel]) / (max[channel] - min[channel]))) * (size - 1);
      const cell = Math.min(size - 2, Math.floor(position));
      return { low: cell * stride, high: (cell + 1) * stride, fraction: position - cell };
    }),
  );
  const lerp = (a: number, b: number, amount: number) => a + (b - a) * amount;
  return (pixels: Buffer, offset: number, red: number, green: number, blue: number) => {
    // .cube data is ordered with red changing fastest, followed by green and blue.
    const r = axes[0][red], g = axes[1][green], b = axes[2][blue];
    for (let channel = 0; channel < 3; channel++) {
      const rg00 = r.low + g.low + channel, rg10 = r.high + g.low + channel;
      const rg01 = r.low + g.high + channel, rg11 = r.high + g.high + channel;
      const bg0 = lerp(values[rg00 + b.low], values[rg10 + b.low], r.fraction);
      const bg1 = lerp(values[rg01 + b.low], values[rg11 + b.low], r.fraction);
      const fg0 = lerp(values[rg00 + b.high], values[rg10 + b.high], r.fraction);
      const fg1 = lerp(values[rg01 + b.high], values[rg11 + b.high], r.fraction);
      const value = lerp(lerp(bg0, bg1, g.fraction), lerp(fg0, fg1, g.fraction), b.fraction);
      pixels[offset + channel] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
  };
}
