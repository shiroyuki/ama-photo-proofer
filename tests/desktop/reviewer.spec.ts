import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ExifTool } from 'exiftool-vendored';
import { previewDng } from './fixtures';

let desktop: ElectronApplication;
let page: Page;
let fixture: string;
let originalHash: string;
let profile: string;
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
test.beforeAll(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'ama-test-'));
  const source = await readFile(path.resolve('public/demo/1.jpg'));
  const tool = new ExifTool({ maxProcs: 1 });
  try {
    for (const [index, time] of ['2026:11:12 23:45:00', '2026:11:13 00:10:00', '2026:11:13 09:00:00'].entries()) {
      const file = path.join(fixture, `TEST_${index + 1}.JPG`);
      await writeFile(file, source);
      await tool.write(file, { DateTimeOriginal: time, Model: 'Test Camera', LensModel: '24-70mm F2.8', ISO: 200, FNumber: 2.8, ExposureTime: 1 / 250 }, ['-overwrite_original']);
    }
  } finally { await tool.end(); }
  await writeFile(path.join(fixture, 'TEST_1.DNG'), previewDng(source));
  originalHash = hash(await readFile(path.join(fixture, 'TEST_1.JPG')));
});
test.afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });
test.beforeEach(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), 'ama-profile-'));
  desktop = await electron.launch({ executablePath: process.env.AMA_EXECUTABLE, args: [...(process.env.AMA_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'test' } });
  page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Keep UI tests independent of the user's local Ollama models; real policy/API paths have unit mocks.
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    load('./dist-electron/electron/ollama.js').OllamaTagger.prototype.status = async () => ({ model: 'gemma4:e2b', available: false, enabled: false, reasons: ['Ollama is not available at 127.0.0.1:11434. Start Ollama and check again.'] });
  });
  await expect(page).toHaveTitle('Photo Proofer');
  await expect(page.locator('.brand')).toHaveText('Photo Proofer');
  expect(await desktop.evaluate(({ app }) => app.getName())).toBe('Photo Proofer');
});
test.afterEach(async () => { await desktop?.close(); await rm(profile, { recursive: true, force: true }); });

async function openSettings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}
async function chooseTheme(value: 'system' | 'light' | 'dark') {
  await openSettings();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(value);
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', value);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

test('sample collection: thumbnail selection, viewer, navigation, filters and help', async () => {
  await expect(page.getByRole('heading', { name: 'Your next shoot starts here.' })).toBeVisible();
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(12);
  await expect(page.locator('.event-section')).toHaveCount(3);
  await expect(page.locator('.event-date-group')).toHaveCount(1);
  await expect(page.locator('.event-date-group>h3')).toHaveText('2026-11-12');
  await expect(page.locator('.event-link strong')).toHaveText(['06:12 – 06:41', '09:04 – 09:36', '17:10 – 17:46']);
  await expect(page.locator('.capture-date')).toHaveCount(1);
  await expect(page.locator('.photo-card img').first()).toHaveJSProperty('naturalWidth', 1000);
  await page.locator('.photo-card').first().click();
  await expect(page.locator('.detail-name h3')).toHaveText('DSC_2041.JPG');
  await expect(page.locator('.metadata')).toContainText('Sony α7 IV');
  await page.locator('.photo-card').first().dblclick();
  await expect(page.locator('.full-media img')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('h1')).toContainText('DSC_2042.JPG');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('h1')).toContainText('DSC_2041.JPG');
  await page.keyboard.press('Escape');
  await expect(page.locator('.photo-card')).toHaveCount(12);
  await page.getByRole('button', { name: 'Videos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching captures' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all captures' }).click();
  await page.getByRole('searchbox').fill('2045');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.keyboard.press('Tab');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/gallery.png' });
});

test('real folder: metadata, overnight events, media protocol and originals preserved', async () => {
  await desktop.evaluate(async ({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  }, fixture);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('footer')).toContainText('Read-only review');
  await expect(page.locator('.event-section')).toHaveCount(2);
  await expect(page.locator('.event-section').first()).toContainText('Overnight');
  await page.locator('.photo-card').first().click();
  await expect(page.locator('.metadata')).toContainText('Test Camera');
  await expect(page.locator('.metadata')).toContainText('24-70mm F2.8');
  await expect(page.locator('.exposure-grid')).toContainText('200');
  await expect(page.locator('.exposure-grid')).toContainText('2.8');
  await expect(page.locator('.exposure-grid')).toContainText('1/250 s');
  await expect(page.locator('.photo-card img').first()).toHaveJSProperty('complete', true);
  await expect(page.locator('.photo-card img').first()).not.toHaveJSProperty('naturalWidth', 0);
  await expect(page.locator('.format-badge').first()).toHaveText('JPEG + RAW');
  await page.keyboard.press('Enter');
  await expect(page.locator('.full-media img')).not.toHaveJSProperty('naturalWidth', 0);
  await page.keyboard.press('t');
  await expect(page.locator('h1')).toContainText('TEST_1.DNG');
  await expect(page.locator('.full-media img')).not.toHaveJSProperty('naturalWidth', 0);
  await expect(page.locator('.media-error')).toHaveCount(0);
  await expect(page.locator('.raw-note')).toContainText('embedded RAW preview');
  await page.keyboard.press('t');
  await expect(page.locator('h1')).toContainText('TEST_1.JPG');
  expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
  await page.screenshot({ path: 'test-results/viewer.png' });
});

test('video keyboard controls play, pause and seek five seconds', async () => {
  const videoFolder = await mkdtemp(path.join(os.tmpdir(), 'ama-video-'));
  try {
    // Create our own short VP8 clip, without a network or external codec dependency.
    const data = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d')!;
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
      let frame = 0;
      const timer = setInterval(() => { context.fillStyle = `hsl(${frame++ * 3} 35% 45%)`; context.fillRect(0, 0, 320, 180); }, 100);
      recorder.start();
      await new Promise(resolve => setTimeout(resolve, 11500)); recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await (await finished).arrayBuffer()));
    });
    await writeFile(path.join(videoFolder, 'CLIP.webm'), Buffer.from(data));
    await writeFile(path.join(videoFolder, 'BEFORE.JPG'), await readFile(path.join(fixture, 'TEST_1.JPG')));
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, videoFolder);
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(2);
    await page.locator('.photo-card').filter({ has: page.locator('video') }).dblclick();
    const video = page.locator('.full-media video');
    await expect(video).toHaveJSProperty('readyState', 4);
    await page.keyboard.press('Space');
    await expect(video).toHaveJSProperty('paused', false);
    await chooseTheme('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(video).toHaveJSProperty('paused', false);
    await page.keyboard.press('Space');
    await expect(video).toHaveJSProperty('paused', true);
    await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1; });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1, 0);
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(6, 0);
    await page.keyboard.press('Meta+ArrowLeft');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1, 0);
    await page.keyboard.press('Meta+ArrowLeft');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(0);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('h1')).toHaveText('BEFORE.JPG');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('h1')).toHaveText('CLIP.webm');
  } finally { await rm(videoFolder, { recursive: true, force: true }); }
});

test('multiple selection, click deselection, review shortcuts and persisted decisions', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  const cards = page.locator('.photo-card');
  const selected = page.locator('.photo-card.is-selected');
  await cards.nth(0).click(); await expect(selected).toHaveCount(1);
  await cards.nth(0).click(); await expect(selected).toHaveCount(0);
  await cards.nth(0).click(); await cards.nth(2).click({ modifiers: ['Meta'] });
  await expect(selected).toHaveCount(2);
  await cards.nth(0).click({ modifiers: ['Control'] }); await expect(selected).toHaveCount(1);
  await cards.nth(4).click({ modifiers: ['Shift'] }); await expect(selected).toHaveCount(5);
  await page.keyboard.press('s'); await expect(page.locator('.review-badge.accepted')).toHaveCount(5);
  await page.keyboard.press('d'); await expect(page.locator('.review-badge.rejected')).toHaveCount(5);
  await page.getByRole('button', { name: 'Clear status', exact: true }).click();
  await expect(page.locator('.review-badge')).toHaveCount(0);
  await cards.nth(0).click(); await page.keyboard.press('s');
  await page.reload(); await page.getByRole('button', { name: /Explore a sample/ }).click();
  await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
  await page.keyboard.press('ArrowRight'); await expect(selected).toHaveCount(1);
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.detail-name h3')).toHaveText('DSC_2042.JPG');
});

test('drag selection replaces a selection and Cmd-drag adds to it', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  const cards = page.locator('.photo-card');
  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  await page.mouse.move(first.x - 8, first.y - 8); await page.mouse.down();
  await page.mouse.move(second.x + second.width + 3, second.y + second.height + 3, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.photo-card.is-selected')).toHaveCount(2);
  await page.keyboard.press('s'); await expect(page.locator('.review-badge.accepted')).toHaveCount(2);
  const third = (await cards.nth(2).boundingBox())!;
  await page.keyboard.down('Meta');
  await page.mouse.move(third.x - 5, third.y - 5); await page.mouse.down();
  await page.mouse.move(third.x + third.width + 3, third.y + third.height + 3, { steps: 10 });
  await page.mouse.up(); await page.keyboard.up('Meta');
  await expect(page.locator('.photo-card.is-selected')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/multi-selection.png' });
});

test('ISO event labels and independently scrolling events keep bottom navigation accessible', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ama-events-'));
  const tool = new ExifTool({ maxProcs: 2 });
  try {
    const image = await readFile(path.join(fixture, 'TEST_1.JPG'));
    for (let index = 0; index < 25; index++) {
      const file = path.join(folder, `EVENT_${index}.JPG`); await writeFile(file, image);
      await tool.write(file, { DateTimeOriginal: `2026:11:${String(index + 1).padStart(2, '0')} 09:00:00` }, ['-overwrite_original']);
    }
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.locator('.event-link')).toHaveCount(25);
    await expect(page.locator('.event-date-group>h3').first()).toHaveText('2026-11-01');
    await expect(page.locator('.event-link strong').first()).toHaveText('09:00 – 09:00');
    await expect(page.locator('.event-marker svg').first()).toBeVisible();
    const list = page.locator('.events-list');
    const bounds = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
    expect(bounds.content).toBeGreaterThan(bounds.height);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
    const bottom = page.locator('.sidebar-bottom');
    const before = (await bottom.boundingBox())!;
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect((await bottom.boundingBox())!.y).toBeCloseTo(before.y, 0);
    expect(before.y + before.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) + 1);
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: false }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  } finally { await tool.end(); await rm(folder, { recursive: true, force: true }); }
});

test('exports selected pairs or accepted captures, remembers the folder and keeps originals', async () => {
  await chooseTheme('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const destination = await mkdtemp(path.join(os.tmpdir(), 'ama-destination-'));
  try {
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    const cards = page.locator('.photo-card');
    await cards.nth(0).click(); await page.keyboard.press('s');
    await cards.nth(2).click(); await page.keyboard.press('s');
    await cards.nth(0).click(); await cards.nth(1).click({ modifiers: ['Meta'] });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const pictures = await desktop.evaluate(({ app }) => app.getPath('pictures'));
    await expect(page.locator('.export-location strong')).toHaveText(pictures);
    await expect(page.locator('.export-modal')).toHaveCSS('background-color', 'rgb(35, 45, 50)');
    await expect(page.locator('.export-buttons')).toContainText('2 captures / 3 files');
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(page.locator('.export-location strong')).toContainText(path.basename(destination));
    await page.getByRole('button', { name: 'Export selection', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(hash(await readFile(path.join(destination, 'TEST_1.JPG')))).toBe(originalHash);
    expect(hash(await readFile(path.join(destination, 'TEST_1.DNG')))).toBe(hash(await readFile(path.join(fixture, 'TEST_1.DNG'))));
    expect(await readFile(path.join(destination, 'TEST_2.JPG'))).toEqual(await readFile(path.join(fixture, 'TEST_2.JPG')));
    await page.getByLabel(/Accepted captures/).check();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(hash(await readFile(path.join(destination, 'TEST_1 (1).JPG')))).toBe(originalHash);
    expect(await readFile(path.join(destination, 'TEST_3.JPG'))).toEqual(await readFile(path.join(fixture, 'TEST_3.JPG')));
    await page.screenshot({ path: 'test-results/export.png' });
    await page.getByRole('button', { name: 'Close export', exact: true }).click();
    await page.reload();
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.locator('.review-badge.accepted')).toHaveCount(2);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.locator('.export-location strong')).toContainText(path.basename(destination));
    expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
    const invalidExport = await page.evaluate(async () => { try { await window.desktop!.exportFiles(['not-authorized']); return ''; } catch (error) { return String(error); } });
    expect(invalidExport).toContain('no longer available');
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('themes follow the system by default, override live and persist across launches', async () => {
  await openSettings();
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  const html = page.locator('html');
  await expect(theme).toHaveValue('system');
  expect(await desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await theme.selectOption('light');
  await expect.poll(() => desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  await page.locator('.photo-card').first().click();
  await openSettings();
  await theme.selectOption('dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.photo-card.is-selected')).toHaveCount(1);
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(28, 35, 39)');
  await expect(page.locator('.tab.selected')).toHaveCSS('background-color', 'rgb(41, 52, 58)');
  await expect(page.locator('.photo-card img').first()).toHaveCSS('filter', 'none');
  await expect(page.locator('.copyright')).toHaveText('© 2026 Juti Noppornpitak');
  await page.screenshot({ path: 'test-results/dark-gallery.png' });
  await page.locator('.photo-card').first().dblclick();
  await expect(page.locator('.viewer')).toHaveCSS('background-color', 'rgb(16, 21, 24)');
  await page.screenshot({ path: 'test-results/dark-viewer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: false }).first().click();
  await expect(page.locator('.shortcuts-modal')).toHaveCSS('background-color', 'rgb(35, 45, 50)');
  await page.screenshot({ path: 'test-results/dark-shortcuts.png' });
  await desktop.close();
  desktop = await electron.launch({ executablePath: process.env.AMA_EXECUTABLE, args: [...(process.env.AMA_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'test' } });
  page = await desktop.firstWindow();
  await openSettings();
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('system');
  await expect.poll(() => desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Settings owns appearance and locks unavailable Ollama tagging off with a warning', async () => {
  await expect(page.locator('.local-note')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveCount(0);
  await openSettings();
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('system');
  const toggle = page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true });
  await expect(toggle).not.toBeChecked();
  const status = await page.evaluate(() => window.desktop!.getOllamaStatus());
  if (!status.available) {
    await expect(toggle).toBeDisabled();
    await expect(page.locator('.settings-warning')).toBeVisible();
  }
  if (await desktop.evaluate(() => process.platform) === 'darwin') {
    await expect(page.locator('.settings-warning')).toContainText('Ollama is not available');
    const bypass = await page.evaluate(async () => { try { await window.desktop!.setOllamaEnabled(true); return ''; } catch (error) { return String(error); } });
    expect(bypass).toContain('Ollama is not available');
    const generate = await page.evaluate(async () => { try { await window.desktop!.tagPhotos([], 'disabled-test'); return ''; } catch (error) { return String(error); } });
    expect(generate).toContain('Ollama is not available');
  }
  await page.screenshot({ path: 'test-results/settings.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('Photos is a macOS-only destination and submits selected or accepted originals through the native bridge', async () => {
  const platform = await desktop.evaluate(() => process.platform);
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.locator('.photo-card').first().click(); await page.keyboard.press('s');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const photos = page.getByRole('radio', { name: 'Photos (macOS)', exact: true });
  if (platform !== 'darwin') { await expect(photos).toHaveCount(0); return; }
  await expect(photos).toBeVisible();
  // Replace only the native boundary in this isolated app process; never import into the user's library.
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const native = load('./dist-electron/electron/photos.js');
    native.PhotosExporter.prototype.export = async function(assets: { path: string }[], progress: (value: { copied: number; total: number; current: string }) => void) {
      (globalThis as any).photosTestPaths = assets.map(asset => asset.path);
      progress({ copied: assets.length, total: assets.length, current: '' });
      return { target: 'photos', copied: assets.length, total: assets.length, importedItems: 1, cancelled: false, destination: 'Photos', failures: [] };
    };
  });
  await photos.check();
  await expect(page.locator('.photos-destination')).toContainText('macOS may ask for permission');
  await page.getByRole('button', { name: 'Export selection to Photos', exact: true }).click();
  await expect(page.locator('.export-result')).toContainText('Photos import complete.');
  const submitted = await desktop.evaluate(() => (globalThis as any).photosTestPaths as string[]);
  expect(submitted.map(file => path.basename(file)).sort()).toEqual(['TEST_1.DNG', 'TEST_1.JPG']);
  await page.getByLabel(/Accepted captures/).check();
  await page.getByRole('button', { name: 'Export accepted to Photos', exact: true }).click();
  await expect(page.locator('.export-result')).toContainText('2 of 2 original files processed by Photos');
  expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
  await page.screenshot({ path: 'test-results/photos-export.png' });
});

test('macOS defaults a ready model on and preserves an explicit opt-out after restart', async () => {
  test.skip(await desktop.evaluate(() => process.platform) !== 'darwin', 'macOS default policy');
  const readyModel = async () => desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    load('./dist-electron/electron/ollama.js').OllamaTagger.prototype.status = async function(this: { enabled: boolean }) {
      return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] };
    };
  });
  await readyModel(); await openSettings();
  const toggle = page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true });
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => page.evaluate(() => window.desktop!.getOllamaStatus().then(status => status.enabled))).toBe(false);
  await expect(toggle).not.toBeChecked();
  await desktop.close();
  desktop = await electron.launch({ executablePath: process.env.AMA_EXECUTABLE, args: [...(process.env.AMA_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'test' } });
  page = await desktop.firstWindow();
  await readyModel(); await openSettings();
  await expect(page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true })).not.toBeChecked();
});
