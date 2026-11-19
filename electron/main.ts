import { developRaw } from './raw-development';
import { exportPanorama } from './panorama';
import { defaultEdits, readEdits, type PhotoEdits, type VersionExportOptions } from '../shared/edits';
import { adjustedPhoto, exportVersions } from './edit-render';
import { nearDuplicate, thumbnailSignature } from './similar';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, access, rm, readFile, rename, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { maxCubeBytes, type CubeLut } from './cube-lut';
import sharp from 'sharp';
import { assets, authorize, cancelScan, exiftool, listSources, scan, getSessionCache, indexedFiles, grants } from './library';
import { ExportService } from './export';
import { planExport } from './export-plan';
import { OllamaTagger } from './ollama';
import { LibraryPreferences } from './library-settings';
import { EventSummaries } from './event-summaries';
import { groupEvents, pairPhotos } from '../shared/model';
import { PhotosExporter } from './photos';
import type { SimilarityResult, Source, ThemePreference } from '../shared/model';

// Keep existing app preferences across the product rename.
// An explicit Chromium profile (including desktop tests) takes precedence.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Ama Photo Proofer' : 'ama-photo-proofer'));
}
app.setName('Photo Proofer');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window: BrowserWindow | null;
let exporter: ExportService;
let tagger: OllamaTagger;
let eventSummaries: EventSummaries;
let modelQueueEpoch = 0;
let libraryPreferences: LibraryPreferences;
let activeScans = 0;
let renderedExport: Promise<unknown> | undefined;
let panoramaController: AbortController | undefined;

async function runRenderedExport<T>(work: () => Promise<T>) {
  const job = work();
  renderedExport = job;
  try { return await job; } finally { renderedExport = undefined; }
}
const photosExporter = new PhotosExporter();
let themePreference: ThemePreference = 'system';
let themeWrite: Promise<void> = Promise.resolve();
const pendingPreviews = new Map<string, Promise<string>>();
let activeConversions = 0;
const conversionQueue: (() => void)[] = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (activeConversions >= 3) await new Promise<void>(resolve => conversionQueue.push(resolve));
  activeConversions++;
  try { return await work(); } finally { activeConversions--; conversionQueue.shift()?.(); }
}
async function preview(id: string, thumbnail: boolean, edit?: { edits: PhotoEdits; lut?: CubeLut }): Promise<string> {
  const asset = assets.get(id);
  if (!asset) throw new Error('This file is no longer available.');
  const recipe = edit ? '-' + createHash('sha256').update(JSON.stringify(edit.edits)).digest('hex') : '';
  const key = `${id}-${thumbnail ? 'thumb' : 'full'}${recipe}`;
  const existing = pendingPreviews.get(key);
  if (existing) return existing;
  const task = limited(async () => {
    const cache = path.join(app.getPath('temp'), 'ama-photo-proofer', String(process.pid));
    await mkdir(cache, { recursive: true });
    const output = path.join(cache, `${key}.jpg`);
    try { await access(output); return output; } catch { /* Generate the preview. */ }
    if (edit) {
      const image = await adjustedPhoto(asset.path, edit.edits, 'thumbnail', asset.kind === 'raw', edit.lut);
      await writeFile(output, image);
      return output;
    }
    let input: string | Buffer = asset.path;
    if (asset.kind === 'raw') {
      let embedded: Buffer | undefined;
      for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const) {
        try {
          const result = await exiftool.extractBinaryTagToBuffer(tag, asset.path);
          if (result instanceof Buffer && result.length > 100) { embedded = result; break; }
        } catch { /* Cameras use different preview tags. */ }
      }
      if (!embedded) {
        const developed = await developRaw(asset.path, defaultEdits, thumbnail);
        if (thumbnail) developed.resize(640, 480, { fit: 'inside', withoutEnlargement: true });
        await developed.jpeg({ quality: thumbnail ? 82 : 95 }).toFile(output);
        return output;
      }
      input = embedded;
    }
    let pipeline = sharp(input);
    const embeddedOrientation = asset.kind === 'raw' ? (await pipeline.metadata()).orientation : undefined;
    if (asset.kind === 'raw' && !embeddedOrientation && asset.orientation) {
      switch (asset.orientation) {
        case 2: pipeline = pipeline.flop(); break;
        case 3: pipeline = pipeline.rotate(180); break;
        case 4: pipeline = pipeline.flip(); break;
        case 5: pipeline = pipeline.flip().rotate(90); break;
        case 6: pipeline = pipeline.rotate(90); break;
        case 7: pipeline = pipeline.flop().rotate(90); break;
        case 8: pipeline = pipeline.rotate(270); break;
      }
    } else pipeline = pipeline.rotate();
    if (thumbnail) pipeline.resize(640, 480, { fit: 'inside', withoutEnlargement: true });
    await writeFile(output, await pipeline.jpeg({ quality: thumbnail ? 82 : 95 }).toBuffer());
    return output;
  });
  pendingPreviews.set(key, task);
  try { return await task; } finally { pendingPreviews.delete(key); }
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 900, minHeight: 640,
    title: 'Photo Proofer', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f7f7f7', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 19, y: 21 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (process.argv.includes('--dev')) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(__dirname, '../../dist/index.html'));
  window.on('closed', () => { window = null; cancelScan(); tagger?.cancel(); });
}
app.whenReady().then(async () => {
  libraryPreferences = new LibraryPreferences(path.join(app.getPath('userData'), 'library-settings.json'));
  await libraryPreferences.initialize();
  const themeSettings = path.join(app.getPath('userData'), 'theme-settings.json');
  try {
    const saved = JSON.parse(await readFile(themeSettings, 'utf8'));
    if (['system', 'light', 'dark'].includes(saved.theme)) themePreference = saved.theme;
  } catch { /* Default to the system theme on first launch. */ }
  nativeTheme.themeSource = themePreference;
  nativeTheme.on('updated', () => window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f7f7f7'));
  app.setAboutPanelOptions({ applicationName: 'Photo Proofer', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Juti Noppornpitak', credits: 'Licensed under the Apache License, Version 2.0.', iconPath: path.join(__dirname, '../../dist/icon.png') });
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '../../dist/icon.png'));
  tagger = new OllamaTagger({
    directory: app.getPath('userData'),
    cache: {
      get: key => getSessionCache()?.getTags(key),
      set: (key, tags) => getSessionCache()?.setTags(key, tags),
      save: () => getSessionCache()?.save() ?? Promise.resolve(false),
    },
    asset: id => assets.get(id),
    onPreviewError: (id, error) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('session-warning', {
        sourcePath: getSessionCache()?.folder,
        message: `Could not use ${assets.get(id)?.path ?? 'a photo'} for the event description: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
    image: async (id, signal) => {
      signal.throwIfAborted();
      const asset = assets.get(id);
      if (!asset || asset.kind === 'video') throw new Error('This photo is no longer available.');
      const input = asset.kind === 'raw' ? await preview(id, false) : asset.path;
      signal.throwIfAborted();
      const image = await sharp(input).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      signal.throwIfAborted(); return image;
    },
  });
  await tagger.initialize();
  eventSummaries = new EventSummaries({
    cache: getSessionCache,
    events: () => groupEvents(pairPhotos([...indexedFiles.values()]), libraryPreferences.get().eventGapMinutes).map(event => ({
      id: event.id, name: event.start.slice(0, 19).replace('T', '_').replace(/:/g, '-'), start: event.start, end: event.end,
      keys: event.photos.flatMap(photo => photo.files.map(file => assets.get(file.id)!.key)),
      photos: event.photos.filter(photo => photo.primary.kind !== 'video').map(photo => ({ id: photo.primary.id, labels: tagger.tags([photo.primary.id])[photo.primary.id] ?? [] })),
    })),
    generate: (photos, signal) => tagger.summarizeEvent(photos, signal),
    notify: update => { if (!activeScans && window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('event-summary', { ...update, sourcePath: getSessionCache()?.folder }); },
  });
  exporter = new ExportService(path.join(app.getPath('userData'), 'export-settings.json'), app.getPath('pictures'),
    async file => { const { SourceFile: _source, Directory: _directory, ...metadata } = await exiftool.read(file); return metadata; },
    async (eventAssets, signal) => {
      if (!tagger.summaryPreferenceEnabled) return;
      return eventSummaries.forExport(eventAssets[0].event.name, signal);
    });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ label: 'About Photo Proofer', click: () => { window?.show(); window?.webContents.send('open-about'); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
  protocol.handle('media', async request => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.slice(1);
      const asset = assets.get(id);
      if (url.hostname !== 'asset' || !asset) return new Response('Unknown media', { status: 404 });
      const thumb = url.searchParams.get('size') === 'thumb';
      if (thumb && (asset.kind === 'jpeg' || asset.kind === 'raw')) {
        const cache = getSessionCache();
        const alternateId = url.searchParams.get('paired') ?? '';
        const alternate = assets.get(alternateId);
        const file = indexedFiles.get(id), paired = indexedFiles.get(alternateId);
        const sameCapture = file && paired && file.directory === paired.directory && file.stem.toLowerCase() === paired.stem.toLowerCase()
          && (asset.kind === 'jpeg' ? alternate?.kind === 'raw' : alternate?.kind === 'jpeg');
        const first = cache?.getVersions(asset.key)[0];
        const version = first ?? (sameCapture ? cache?.getVersions(alternate!.key)[0] : undefined);
        if (version && cache) {
          const { edits } = version;
          const lut = edits.lut && cache.getLut(edits.lut.id);
          const file = await preview(first ? id : alternateId, true, { edits, lut });
          return net.fetch(pathToFileURL(file).href);
        }
      }
      const needsPreview = asset.kind === 'raw' || (thumb && asset.kind !== 'video') || /\.(heic|heif|tif|tiff)$/i.test(asset.path);
      const file = needsPreview ? await preview(id, thumb) : asset.path;
      return net.fetch(pathToFileURL(file).href, { headers: request.headers });
    } catch {
      return new Response('Preview unavailable. Check that the card is connected and the format has a supported preview.', { status: 422 });
    }
  });
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted request');
  };
  const photoIds = (ids: unknown): string[] => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !assets.has(id))) throw new Error('Some photos are no longer available. Reopen the source and try again.');
    return [...new Set(ids as string[])];
  };
  const editablePhoto = (id: unknown) => {
    const [key] = photoIds([id]);
    const file = indexedFiles.get(key);
    const asset = assets.get(key);
    const cache = getSessionCache();
    if (activeScans || (!file || (file.kind !== 'jpeg' && file.kind !== 'raw')) || !asset || !cache) throw new Error('Open an indexed JPEG or RAW photo to make adjustments.');
    return { file, asset, cache };
  };
  ipcMain.handle('find-similar', async event => {
    trusted(event);
    if (activeScans) throw new Error('Finish indexing before finding similar photos.');
    const result: SimilarityResult = { groups: [], failures: [] };
    const events = groupEvents(pairPhotos([...indexedFiles.values()]), libraryPreferences.get().eventGapMinutes);
    for (const { photos } of events) {
      const recent: { ids: string[]; signature: Buffer; ratio: number }[] = [];
      for (const { primary } of photos) {
        if (primary.kind === 'video') continue;
        if (!indexedFiles.has(primary.id)) throw new Error('The opened folder changed.');
        try {
          const thumb = await preview(primary.id, true);
          const { width, height } = await sharp(thumb).metadata();
          const ratio = width / height;
          const signature = await thumbnailSignature(thumb);
          const group = recent.find(group => Math.abs(Math.log(group.ratio / ratio)) < 0.045 && nearDuplicate(group.signature, signature));
          if (group) {
            if (group.ids.length === 1) result.groups.push(group.ids);
            group.ids.push(primary.id);
            recent.splice(recent.indexOf(group), 1);
            recent.push(group);
          } else {
            recent.push({ ids: [primary.id], signature, ratio });
            if (recent.length > 32) recent.shift();
          }
        } catch (error) {
          result.failures.push({ name: primary.relativePath, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return result;
  });
  ipcMain.handle('get-edit-versions', (event, id: unknown) => {
    trusted(event);
    const { asset, cache } = editablePhoto(id);
    return cache.getVersions(asset.key);
  });
  ipcMain.handle('choose-edit-lut', async (event, id: unknown) => {
    trusted(event);
    const { cache } = editablePhoto(id);
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose a 3D LUT', properties: ['openFile'],
      filters: [{ name: '3D LUT', extensions: ['cube'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    if (editablePhoto(id).cache !== cache) throw new Error('The opened folder changed.');
    const file = result.filePaths[0];
    if (path.extname(file).toLowerCase() !== '.cube') throw new Error('Choose a 3D .cube LUT file.');
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxCubeBytes) throw new Error('Choose a .cube file of 16 MB or smaller.');
      const chunks: Buffer[] = [];
      for await (const chunk of handle.createReadStream({ end: maxCubeBytes, autoClose: false })) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length > maxCubeBytes) throw new Error('Choose a .cube file of 16 MB or smaller.');
      return { id: cache.importLut(data.toString('utf8')), name: path.basename(file) };
    } finally {
      await handle.close();
    }
  });
  ipcMain.handle('preview-edits', async (event, id: unknown, input: unknown) => {
    trusted(event);
    const { asset, cache } = editablePhoto(id);
    const edits = readEdits(input);
    const lut = edits.lut && cache.getLut(edits.lut.id);
    const image = await limited(() => adjustedPhoto(asset.path, edits, 'editor', asset.kind === 'raw', lut));
    return `data:image/jpeg;base64,${image.toString('base64')}`;
  });
  ipcMain.handle('save-edit-version', (event, id: unknown, input: unknown, version?: number) => {
    trusted(event);
    const { asset, cache } = editablePhoto(id);
    return cache.saveVersion(asset.key, readEdits(input), version);
  });
  ipcMain.handle('export-edit-versions', async (event, id: unknown, numbers: unknown, value: unknown) => {
    trusted(event);
    if (exporter.busy || photosExporter.busy || renderedExport) throw new Error('Wait for the current export to finish.');
    const { asset, cache, file } = editablePhoto(id);
    if (!Array.isArray(numbers) || !numbers.length || numbers.length > 100 || !numbers.every(Number.isInteger)) throw new Error('Choose one or more saved versions.');
    const versions = cache.getVersions(asset.key).filter(item => numbers.includes(item.number));
    if (versions.length !== new Set(numbers).size) throw new Error('An edit version is no longer available.');
    if (!value || typeof value !== 'object') throw new Error('Invalid version export options.');
    const options = value as VersionExportOptions;
    const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 500) : undefined;
    const validated = {
      watermark: text(options.watermark), caption: text(options.caption), name: text(options.name),
      automatic: options.automatic === true, locale: text(options.locale), timeZone: text(options.timeZone),
    };
    return runRenderedExport(async () => {
      const destination = await exporter.getLocation();
      const exif = validated.automatic ? { ...await exiftool.read(asset.path) } : {};
      return await limited(() => exportVersions(asset.path, file, versions, destination, validated, exif, id => cache.getLut(id)));
    });
  });
  ipcMain.handle('export-panorama', async (event, ids: unknown) => {
    trusted(event);
    if (activeScans || exporter.busy || photosExporter.busy || renderedExport) throw new Error('Wait for indexing or exporting to finish.');
    const selected = photoIds(ids);
    if (selected.length < 2 || selected.length > 12 || selected.some(id => assets.get(id)?.kind === 'video')) throw new Error('Select 2 to 12 overlapping photos.');
    const controller = new AbortController();
    panoramaController = controller;
    return runRenderedExport(async () => {
      try {
        const inputs: string[] = [];
        for (const id of selected) {
          controller.signal.throwIfAborted();
          const asset = assets.get(id)!;
          inputs.push(asset.kind === 'raw' ? await preview(id, false) : asset.path);
        }
        return await exportPanorama(inputs, await exporter.getLocation(), controller.signal);
      } finally {
        panoramaController = undefined;
      }
    });
  });
  ipcMain.handle('get-library-settings', event => { trusted(event); return libraryPreferences.get(); });
  ipcMain.handle('set-event-gap', async (event, minutes: unknown) => {
    trusted(event);
    if (activeScans || exporter.busy || photosExporter.busy || tagger.busy || eventSummaries.busy) throw new Error('Finish or stop indexing, background processing, and exports before changing the event gap.');
    if (typeof minutes !== 'number') throw new Error('Enter an event gap in minutes.');
    const gap = await libraryPreferences.setGap(minutes); modelQueueEpoch++; return gap;
  });
  ipcMain.handle('toggle-bookmark', async (event, folder: unknown) => {
    trusted(event);
    if (typeof folder !== 'string') throw new Error('Open a folder to bookmark it.');
    const existing = libraryPreferences.get().bookmarks.find(source => source.path === folder);
    if (existing) return libraryPreferences.toggleBookmark(existing);
    if (!grants.has(folder)) throw new Error('Open the folder before bookmarking it.');
    return libraryPreferences.toggleBookmark(await authorize(folder));
  });
  ipcMain.handle('open-bookmark', async (event, folder: unknown) => {
    trusted(event);
    if (typeof folder !== 'string' || !libraryPreferences.get().bookmarks.some(source => source.path === folder)) throw new Error('Choose a saved bookmark.');
    try { return await authorize(folder); }
    catch { throw new Error('This bookmarked folder is unavailable. Reconnect the card or choose another folder.'); }
  });
  ipcMain.handle('get-ollama-status' , event => { trusted(event); return tagger.status(); });
  ipcMain.handle('set-ollama-enabled', (event, enabled: unknown) => {
    trusted(event);
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable Ollama tagging.');
    if (!enabled) { modelQueueEpoch++; eventSummaries.stopQueued(); }
    return tagger.setEnabled(enabled);
  });
  ipcMain.handle('get-photo-reviews', (event, ids: unknown) => {
    trusted(event);
    return Object.fromEntries(photoIds(ids).flatMap(id => {
      const review = getSessionCache()?.getReview(assets.get(id)!.key);
      return review ? [[id, review]] : [];
    }));
  });
  ipcMain.handle('set-photo-reviews', async (event, ids: unknown, status: unknown) => {
    trusted(event);
    if (status !== null && status !== 'accepted' && status !== 'rejected') throw new Error('Invalid review decision.');
    const cache = getSessionCache();
    for (const id of photoIds(ids)) cache?.setReview(assets.get(id)!.key, status);
    return cache ? cache.save() : false;
  });
  ipcMain.handle('get-photo-tags', (event, ids: unknown) => { trusted(event); return tagger.tags(photoIds(ids)); });
  ipcMain.handle('get-event-summaries', event => { trusted(event); return eventSummaries.cached(); });
  ipcMain.handle('tag-photos', async (event, ids: unknown, jobId: unknown) => {
    trusted(event);
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(jobId)) throw new Error('Invalid tagging request.');
    const queueEpoch = modelQueueEpoch;
    const result = await tagger.tag(photoIds(ids), jobId, data => { if (!event.sender.isDestroyed()) event.sender.send('tag-progress', data); });
    const summarize = !result.cancelled && queueEpoch === modelQueueEpoch && (await tagger.summariesEnabled());
    if (queueEpoch !== modelQueueEpoch) result.cancelled = true;
    else if (summarize) { const summaries = await eventSummaries.run(); result.cancelled ||= summaries.cancelled; }
    return result;
  });
  ipcMain.handle('cancel-tagging', event => { trusted(event); modelQueueEpoch++; tagger.stopQueued(); eventSummaries.stopQueued(); });
  ipcMain.handle('get-theme', event => { trusted(event); return themePreference; });
  ipcMain.handle('set-theme', (event, preference: unknown) => {
    trusted(event);
    if (preference !== 'system' && preference !== 'light' && preference !== 'dark') throw new Error('Choose System, Light, or Dark.');
    themeWrite = themeWrite.catch(() => {}).then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(`${themeSettings}.tmp`, JSON.stringify({ theme: preference }));
      await rename(`${themeSettings}.tmp`, themeSettings);
      themePreference = preference;
      nativeTheme.themeSource = preference;
    });
    return themeWrite;
  });
  ipcMain.handle('list-sources', async event => { trusted(event); return listSources(); });
  ipcMain.handle('choose-folder', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window!, { title: 'Open a memory card or photo folder', properties: ['openDirectory'], buttonLabel: 'Open for review' });
    return result.canceled ? null : authorize(result.filePaths[0]);
  });
  const scanSource = async (event: Electron.IpcMainInvokeEvent, source: Source, refresh = false) => {
    trusted(event);
    if (exporter.busy || photosExporter.busy || renderedExport) throw new Error('Finish or cancel the export before reindexing.');
    if (refresh && (!source || source.path !== getSessionCache()?.folder)) throw new Error('Open this proofing session before reindexing it.');
    cancelScan(); activeScans++;
    try {
      modelQueueEpoch++; await tagger.stop(); await eventSummaries.stop();
      if (refresh) await authorize(source.path);
      await getSessionCache()?.save();
      await scan(source, data => { if (!event.sender.isDestroyed()) event.sender.send('scan-progress', data); }, message => { if (!event.sender.isDestroyed()) event.sender.send('session-warning', { sourcePath: source.path, message }); }, refresh);
    } finally { activeScans--; }
  };
  ipcMain.handle('scan', (event, source: Source) => scanSource(event, source));
  ipcMain.handle('reindex', (event, source: Source) => scanSource(event, source, true));
  ipcMain.handle('cancel-scan', event => { trusted(event); cancelScan(); });
  const exportPlan = (ids: unknown) => planExport([...indexedFiles.values()], photoIds(ids), id => {
    const asset = assets.get(id);
    return asset ? { path: asset.path, labels: tagger.tags([id])[id], review: getSessionCache()?.getReview(asset.key) } : undefined;
  }, libraryPreferences.get().eventGapMinutes);
  ipcMain.handle('get-export-capabilities', event => { trusted(event); return { photos: process.platform === 'darwin' }; });
  ipcMain.handle('export-to-photos', (event, ids: unknown) => {
    trusted(event);
    if (exporter.busy || renderedExport) throw new Error('Wait for the current folder export to finish.');
    return photosExporter.export(exportPlan(ids), data => { if (!event.sender.isDestroyed()) event.sender.send('export-progress', data); });
  });
  ipcMain.handle('get-export-location', event => { trusted(event); return exporter.getLocation(); });
  ipcMain.handle('choose-export-location', async event => {
    trusted(event);
    if (exporter.busy || photosExporter.busy) throw new Error('Wait for the current export to finish.');
    const result = await dialog.showOpenDialog(window!, { title: 'Choose export location', defaultPath: await exporter.getLocation(), properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
    return result.canceled ? null : exporter.setLocation(result.filePaths[0]);
  });
  ipcMain.handle('export-files', async (event, ids: unknown, mode: unknown = 'selection') => {
    trusted(event);
    if (photosExporter.busy || renderedExport) throw new Error('Wait for the current export to finish.');
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !assets.has(id))) throw new Error('Some selected files are no longer available. Reopen the card and try again.');
    if (typeof mode !== 'string' || !['selection', 'selection-by-event', 'accepted', 'event'].includes(mode)) throw new Error('Choose a valid export mode.');
    const originals = exportPlan(ids);
    return exporter.export(originals, data => { if (!event.sender.isDestroyed()) event.sender.send('export-progress', data); }, mode === 'selection' ? 'flat' : 'events', mode === 'accepted' || mode === 'selection-by-event');
  });
  ipcMain.handle('cancel-export', event => { trusted(event); exporter.cancel(); photosExporter.cancel(); });
  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let shuttingDown = false;
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true; modelQueueEpoch++;
  cancelScan();
  panoramaController?.abort();
  void Promise.allSettled([renderedExport, exiftool.end(), exporter?.stop(), photosExporter.stop(), themeWrite, libraryPreferences?.flush(), tagger?.stop(), eventSummaries?.stop()]).then(async () => {
    await getSessionCache()?.save();
    await Promise.allSettled(pendingPreviews.values());
    await rm(path.join(app.getPath('temp'), 'ama-photo-proofer', String(process.pid)), { recursive: true, force: true }).catch(() => {});
    app.quit();
  });
});
