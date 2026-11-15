import type { MediaFile } from '../shared/model';
const times = ['2026-11-12T06:12:00', '2026-11-12T06:18:00', '2026-11-12T06:25:00', '2026-11-12T06:41:00', '2026-11-12T09:04:00', '2026-11-12T09:12:00', '2026-11-12T09:28:00', '2026-11-12T09:36:00', '2026-11-12T17:10:00', '2026-11-12T17:22:00', '2026-11-12T17:38:00', '2026-11-12T17:46:00'];
export const demoFiles: MediaFile[] = times.map((time, i) => ({
  id: `demo-${i}`, name: `DSC_${String(2041 + i).padStart(4, '0')}.JPG`, relativePath: `DCIM/100MSDCF/DSC_${2041 + i}.JPG`,
  stem: `DSC_${2041 + i}`, directory: '/demo/DCIM/100MSDCF', kind: 'jpeg', extension: 'jpg', size: 12400000 + i * 12030,
  capturedAt: time, timestampSource: 'capture', camera: 'Sony α7 IV', lens: 'FE 24–70mm F2.8 GM II', iso: String([100, 100, 200, 100][i % 4]),
  aperture: ['5.6', '8', '4', '2.8'][i % 4], shutter: ['1/250 s', '1/500 s', '1/125 s'][i % 3], width: 6000, height: 4000,
}));
export function demoUrl(id: string) { return `${import.meta.env.BASE_URL}demo/${Number(id.split('-')[1]) % 6 + 1}.jpg`; }
