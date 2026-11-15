import { describe, expect, it } from 'vitest';
import { groupEvents, groupEventsByDate, pairPhotos, mediaKind, type MediaFile } from '../shared/model';
function file(name: string, capturedAt: string, directory = '/card/DCIM/100'): MediaFile {
  const extension = name.split('.').at(-1)!;
  return { id: `${directory}/${name}`, name, extension, relativePath: name, stem: name.replace(/\.[^.]+$/, ''), directory, kind: mediaKind(extension)!, size: 1024, capturedAt, timestampSource: 'capture' };
}
describe('capture pairing', () => {
  it('prefers JPEG regardless of scan order and retains the RAW alternative', () => {
    const photos = pairPhotos([file('DSC001.ARW', '2026-11-12T09:00:00'), file('DSC001.JPG', '2026-11-12T09:00:00')]);
    expect(photos).toHaveLength(1); expect(photos[0].primary.kind).toBe('jpeg'); expect(photos[0].raw?.kind).toBe('raw');
  });
  it('keeps capture identity stable when a paired JPEG arrives during scanning', () => {
    const raw = file('DSC001.ARW', '2026-11-12T09:00:00');
    const jpeg = file('DSC001.JPG', '2026-11-12T09:00:00');
    expect(pairPhotos([raw])[0].id).toBe(pairPhotos([raw, jpeg])[0].id);
  });
  it('never pairs matching stems in different directories or pairs a video with a photo', () => {
    expect(pairPhotos([file('A.JPG', '2026-11-12T09:00:00', '/1'), file('A.NEF', '2026-11-12T09:00:00', '/2'), file('A.MOV', '2026-11-12T09:00:00', '/1')])).toHaveLength(3);
  });
  it('handles extension and basename casing', () => {
    expect(pairPhotos([file('dsc001.jpg', '2026-11-12T09:00:00'), file('DSC001.CR3', '2026-11-12T09:00:00')])).toHaveLength(1);
  });
});
describe('event grouping', () => {
  it('sorts captures and splits only gaps strictly greater than 30 minutes', () => {
    const photos = pairPhotos([file('C.JPG', '2026-11-12T10:00:01'), file('A.JPG', '2026-11-12T09:00:00'), file('B.JPG', '2026-11-12T09:30:00')]);
    expect(groupEvents(photos).map(e => e.photos.length)).toEqual([2, 1]);
  });
  it('merges continuous captures overnight using each adjacent gap', () => {
    const photos = pairPhotos(['23:20:00', '23:45:00'].map((t, i) => file(`${i}.JPG`, `2026-11-12T${t}`)).concat(['00:10:00', '00:35:00', '01:05:00'].map((t, i) => file(`${i + 2}.JPG`, `2026-11-13T${t}`))));
    expect(groupEvents(photos)).toHaveLength(1); expect(groupEvents(photos)[0].photos).toHaveLength(5);
  });
  it('splits overnight when the capture gap exceeds 30 minutes', () => {
    expect(groupEvents(pairPhotos([file('A.JPG', '2026-11-12T23:45:00'), file('B.JPG', '2026-11-13T00:15:01')]))).toHaveLength(2);
  });
  it('handles empty libraries and RAW-only photos', () => {
    expect(groupEvents([])).toEqual([]); expect(pairPhotos([file('A.RAF', '2026-11-12T09:00:00')])[0].primary.kind).toBe('raw');
  });
});

it('groups continuous events by their starting date and then chronological time', () => {
  const events = groupEvents(pairPhotos([file('A.JPG', '2026-11-12T08:00:00'), file('B.JPG', '2026-11-12T10:00:00'), file('C.JPG', '2026-11-12T23:45:00'), file('D.JPG', '2026-11-13T00:10:00'), file('E.JPG', '2026-11-13T09:00:00')]));
  const days = groupEventsByDate(events);
  expect(days.map(day => day.date)).toEqual(['2026-11-12', '2026-11-13']);
  expect(days[0].events.map(event => event.start.slice(11, 16))).toEqual(['08:00', '10:00', '23:45']);
  expect(days[0].events[2].photos).toHaveLength(2);
  expect(days[0].events[2].end).toBe('2026-11-13T00:10:00');
});
