import { app, BrowserWindow, dialog, ipcMain, net, protocol, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, access, rm, readFile, rename } from 'node:fs/promises';
import sharp from 'sharp';
import { assets, authorize, cancelScan, exiftool, listSources, scan } from './library';
import { ExportService } from './export';
import { OllamaTagger } from './ollama';
import { PhotosExporter } from './photos';
import type { Source, ThemePreference } from '../shared/model';

// Keep existing review decisions and export preferences across the product rename.
// An explicit Chromium profile (including desktop tests) takes precedence.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Ama Photo Proofer' : 'ama-photo-proofer'));
}
app.setName('Photo Proofer');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window: BrowserWindow | null;
let exporter: ExportService;
let tagger: OllamaTagger;
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
async function preview(id: string, thumbnail: boolean): Promise<string> {
  const asset = assets.get(id);
  if (!asset) throw new Error('This file is no longer available.');
  const key = `${id}-${thumbnail ? 'thumb' : 'full'}`;
  const existing = pendingPreviews.get(key);
  if (existing) return existing;
  const task = limited(async () => {
    const cache = path.join(app.getPath('temp'), 'ama-photo-proofer', String(process.pid));
    await mkdir(cache, { recursive: true });
    const output = path.join(cache, `${key}.jpg`);
    try { await access(output); return output; } catch { /* Generate the preview. */ }
    let input: string | Buffer = asset.path;
    if (asset.kind === 'raw') {
      let embedded: Buffer | undefined;
      for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const) {
        try {
          const result = await exiftool.extractBinaryTagToBuffer(tag, asset.path);
          if (result instanceof Buffer && result.length > 100) { embedded = result; break; }
        } catch { /* Cameras use different preview tags. */ }
      }
      if (!embedded) throw new Error('This RAW file has no supported embedded preview.');
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
    title: 'Photo Proofer', backgroundColor: nativeTheme.shouldUseDarkColors ? '#171c1f' : '#f5f7f8', titleBarStyle: 'hiddenInset',
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
  const themeSettings = path.join(app.getPath('userData'), 'theme-settings.json');
  try {
    const saved = JSON.parse(await readFile(themeSettings, 'utf8'));
    if (['system', 'light', 'dark'].includes(saved.theme)) themePreference = saved.theme;
  } catch { /* Default to the system theme on first launch. */ }
  nativeTheme.themeSource = themePreference;
  nativeTheme.on('updated', () => window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#171c1f' : '#f5f7f8'));
  app.setAboutPanelOptions({ applicationName: 'Photo Proofer', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Juti Noppornpitak', credits: 'Licensed under the Apache License, Version 2.0.', iconPath: path.join(__dirname, '../../dist/icon.png') });
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '../../dist/icon.png'));
  tagger = new OllamaTagger({
    directory: app.getPath('userData'),
    asset: id => assets.get(id),
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
  exporter = new ExportService(path.join(app.getPath('userData'), 'export-settings.json'), app.getPath('pictures'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
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
  ipcMain.handle('get-ollama-status', event => { trusted(event); return tagger.status(); });
  ipcMain.handle('set-ollama-enabled', (event, enabled: unknown) => {
    trusted(event);
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable Ollama tagging.');
    return tagger.setEnabled(enabled);
  });
  ipcMain.handle('get-photo-tags', (event, ids: unknown) => { trusted(event); return tagger.tags(photoIds(ids)); });
  ipcMain.handle('tag-photos', (event, ids: unknown, jobId: unknown) => {
    trusted(event);
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(jobId)) throw new Error('Invalid tagging request.');
    return tagger.tag(photoIds(ids), jobId, data => { if (!event.sender.isDestroyed()) event.sender.send('tag-progress', data); });
  });
  ipcMain.handle('cancel-tagging', event => { trusted(event); return tagger.stop(); });
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
  ipcMain.handle('scan', async (event, source: Source) => {
    trusted(event);
    await tagger.stop();
    await scan(source, data => { if (!event.sender.isDestroyed()) event.sender.send('scan-progress', data); });
  });
  ipcMain.handle('cancel-scan', event => { trusted(event); cancelScan(); });
  ipcMain.handle('get-export-capabilities', event => { trusted(event); return { photos: process.platform === 'darwin' }; });
  ipcMain.handle('export-to-photos', (event, ids: unknown) => {
    trusted(event);
    if (exporter.busy) throw new Error('Wait for the current folder export to finish.');
    return photosExporter.export(photoIds(ids).map(id => ({ path: assets.get(id)!.path })), data => { if (!event.sender.isDestroyed()) event.sender.send('export-progress', data); });
  });
  ipcMain.handle('get-export-location', event => { trusted(event); return exporter.getLocation(); });
  ipcMain.handle('choose-export-location', async event => {
    trusted(event);
    if (exporter.busy || photosExporter.busy) throw new Error('Wait for the current export to finish.');
    const result = await dialog.showOpenDialog(window!, { title: 'Choose export location', defaultPath: await exporter.getLocation(), properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
    return result.canceled ? null : exporter.setLocation(result.filePaths[0]);
  });
  ipcMain.handle('export-files', async (event, ids: unknown) => {
    trusted(event);
    if (photosExporter.busy) throw new Error('Wait for the current Photos import to finish.');
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !assets.has(id))) throw new Error('Some selected files are no longer available. Reopen the card and try again.');
    const originals = [...new Set(ids as string[])].map(id => ({ path: assets.get(id)!.path }));
    return exporter.export(originals, data => { if (!event.sender.isDestroyed()) event.sender.send('export-progress', data); });
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
  shuttingDown = true;
  cancelScan();
  void Promise.allSettled([exiftool.end(), exporter?.stop(), photosExporter.stop(), themeWrite, tagger?.stop()]).then(async () => {
    await Promise.allSettled(pendingPreviews.values());
    await rm(path.join(app.getPath('temp'), 'ama-photo-proofer', String(process.pid)), { recursive: true, force: true }).catch(() => {});
    app.quit();
  });
});
