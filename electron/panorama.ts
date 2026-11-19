import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const stitch = `
import pathlib, sys
try:
    import cv2
    import numpy as np
except ImportError as error:
    print(error, file=sys.stderr)
    sys.exit(20)

frames = [cv2.imdecode(np.frombuffer(pathlib.Path(name).read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR) for name in sys.argv[2:]]
stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
status, image = stitcher.stitch(frames)
if status != cv2.Stitcher_OK:
    print("Could not align the selected photos. Choose frames with clear overlap from the same scene (OpenCV status %d)." % status, file=sys.stderr)
    sys.exit(21)
ok, result = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 95])
if not ok:
    sys.exit("The panorama could not be encoded.")
pathlib.Path(sys.argv[1]).write_bytes(result.tobytes())
`;

export async function exportPanorama(inputs: string[], destination: string, signal?: AbortSignal) {
  if (inputs.length < 2 || inputs.length > 12) throw new Error('Select 2 to 12 overlapping photos.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'photo-proofer-panorama-'));
  try {
    const jpgs: string[] = [];
    for (const [index, input] of inputs.entries()) {
      signal?.throwIfAborted();
      const jpg = path.join(temporary, `frame-${index}.jpg`);
      await sharp(input).autoOrient().resize(3000, 3000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 95 }).toFile(jpg);
      jpgs.push(jpg);
    }
    const output = path.join(temporary, 'stitched.jpg');
    const candidates = process.platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
      : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].map(command => ({ command, args: [] }));
    if (process.env.PHOTO_PROOFER_PYTHON) {
      candidates.unshift({ command: process.env.PHOTO_PROOFER_PYTHON, args: [] });
    }
    let finished = false;
    for (const { command, args } of candidates) {
      try {
        await run(command, [...args, '-I', '-c', stitch, output, ...jpgs], { timeout: 180_000, windowsHide: true, cwd: temporary, signal });
        finished = true;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
        if (failure.code === 'ENOENT' || String(failure.code) === '20' || /No (installed|suitable) Python|Python was not found/i.test(failure.stderr ?? '')) continue;
        throw new Error(failure.killed ? 'Panorama stitching timed out.' : failure.stderr?.trim() || failure.message);
      }
    }
    if (!finished) throw new Error('Panorama stitching requires Python 3 with opencv-python-headless installed. Set PHOTO_PROOFER_PYTHON to that interpreter if needed.');
    signal?.throwIfAborted();
    await mkdir(destination, { recursive: true });
    for (let copy = 0; ; copy++) {
      const file = path.join(destination, copy ? `Panorama (${copy}).JPG` : 'Panorama.JPG');
      try {
        await copyFile(output, file, constants.COPYFILE_EXCL);
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
