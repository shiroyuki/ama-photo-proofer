import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, readdir, copyFile, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ExifTool } from 'exiftool-vendored';
import { previewDng, sensorDng } from './fixtures';

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
  await rm(path.join(fixture, 'photo-proofing.json'), { force: true });
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
  await expect(page.locator('.titlebar, footer, .details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toHaveCount(0);
  const info = page.getByRole('button', { name: 'Toggle photo details' });
  await expect(info).toHaveCount(0);
  await expect(page.locator('.photo-card img').first()).toHaveJSProperty('naturalWidth', 1000);
  await page.locator('.photo-card').first().click();
  await expect(page.locator('.detail-name h3')).toHaveText('DSC_2041.JPG');
  await expect(page.locator('.metadata')).toContainText('Sony α7 IV');
  await expect(info).toHaveAttribute('aria-pressed', 'true');
  expect(await info.evaluate(button => innerWidth - button.getBoundingClientRect().right)).toBeLessThanOrEqual(12);
  await info.press('Enter');
  await expect(page.locator('.details')).toHaveCount(0);
  await page.keyboard.press('i');
  await expect(page.locator('.details')).toBeVisible();
  await page.locator('.photo-card').first().click();
  await expect(page.locator('.details')).toHaveCount(0);
  await page.locator('.photo-card').first().dblclick();
  await expect(page.locator('.full-media img')).toBeVisible();
  await expect(page.locator('.viewer-toolbar, .viewer-bottom, .selection-summary')).toHaveCount(0);
  await expect(page.locator('.workspace-header')).not.toContainText('of 12 captures');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('h1')).toContainText('DSC_2042.JPG');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('h1')).toContainText('DSC_2041.JPG');
  await page.keyboard.press('Escape');
  await expect(page.locator('.photo-card')).toHaveCount(12);
  await page.getByRole('button', { name: 'Videos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching captures' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all captures' }).click();
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('2045');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('');
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
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('#indexing-progress')).toHaveCount(0);
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
  await expect(page.locator('.raw-note')).toContainText('Choose Edit RAW to develop the sensor data');
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
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
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
  await page.keyboard.press('a'); await expect(page.locator('.review-badge.accepted')).toHaveCount(5);
  await page.keyboard.press('d'); await expect(page.locator('.review-badge.rejected')).toHaveCount(5);
  await page.getByRole('button', { name: 'Clear status', exact: true }).click();
  await expect(page.locator('.review-badge')).toHaveCount(0);
  await cards.nth(0).click(); await page.keyboard.press('a');
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
  await page.keyboard.press('a'); await expect(page.locator('.review-badge.accepted')).toHaveCount(2);
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
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
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
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    const cards = page.locator('.photo-card');
    await cards.nth(0).click(); await page.keyboard.press('a');
    await cards.nth(2).click(); await page.keyboard.press('a');
    await cards.nth(0).click(); await cards.nth(1).click({ modifiers: ['Meta'] });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const pictures = await desktop.evaluate(({ app }) => app.getPath('pictures'));
    await expect(page.locator('.export-location strong')).toHaveText(pictures);
    await expect(page.locator('.export-modal')).toHaveCSS('background-color', 'rgb(38, 38, 38)');
    await expect(page.locator('.export-buttons')).toContainText('2 captures / 3 files');
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(page.locator('.export-location strong')).toContainText(path.basename(destination));
    await page.getByRole('button', { name: 'Export selection', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(hash(await readFile(path.join(destination, 'TEST_1.JPG')))).toBe(originalHash);
    expect(hash(await readFile(path.join(destination, 'TEST_1.DNG')))).toBe(hash(await readFile(path.join(fixture, 'TEST_1.DNG'))));
    expect(await readFile(path.join(destination, 'TEST_2.JPG'))).toEqual(await readFile(path.join(fixture, 'TEST_2.JPG')));
    const flatMetadata = JSON.parse(await readFile(path.join(destination, 'photo-proofing-export.json'), 'utf8'));
    expect(flatMetadata.files).toHaveLength(3);
    expect(flatMetadata.files.every((file: any) => file.event.name === '2026-11-12_23-45-00')).toBe(true);
    await page.getByLabel(/Accepted captures/).check();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(hash(await readFile(path.join(destination, '2026-11-12_23-45-00', 'TEST_1.JPG')))).toBe(originalHash);
    expect(await readFile(path.join(destination, '2026-11-13_09-00-00', 'TEST_3.JPG'))).toEqual(await readFile(path.join(fixture, 'TEST_3.JPG')));
    await page.screenshot({ path: 'test-results/export.png' });
    await page.getByRole('button', { name: 'Close export', exact: true }).click();
    await cards.nth(1).click();
    await cards.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Group selected captures into event folders' }).check();
    await page.getByRole('button', { name: 'Export selection', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    const firstEvent = path.join(destination, '2026-11-12_23-45-00 (1)');
    expect((await readdir(firstEvent)).sort()).toEqual(['TEST_2.JPG', 'photo-proofing-export.json']);
    const secondEvent = path.join(destination, '2026-11-13_09-00-00 (1)');
    expect((await readdir(secondEvent)).sort()).toEqual(['TEST_3.JPG', 'photo-proofing-export.json']);
    await page.getByRole('button', { name: 'Close export', exact: true }).click();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
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
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await expect(page.locator('.tab.selected')).toHaveCSS('background-color', 'rgb(48, 48, 48)');
  await expect(page.locator('.photo-card img').first()).toHaveCSS('filter', 'none');
  await expect(page.locator('.sidebar .copyright')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/dark-gallery.png' });
  await page.locator('.photo-card').first().dblclick();
  await expect(page.locator('.viewer')).toHaveCSS('background-color', 'rgb(18, 18, 18)');
  await page.screenshot({ path: 'test-results/dark-viewer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: false }).first().click();
  await expect(page.locator('.shortcuts-modal')).toHaveCSS('background-color', 'rgb(38, 38, 38)');
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
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.locator('.photo-card').first().click(); await page.keyboard.press('a');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const photos = page.getByRole('radio', { name: 'Photos (macOS)', exact: true });
  if (platform !== 'darwin') { await expect(photos).toHaveCount(0); return; }
  await expect(photos).toBeVisible();
  // Replace only the native boundary in this isolated app process; never import into the user's library.
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const native = load('./dist-electron/electron/photos.js');
    native.PhotosExporter.prototype.export = async function(assets: { path: string }[], progress: (value: { copied: number; total: number; current: string }) => void) {
      (globalThis as any).photosTestAssets = assets;
      (globalThis as any).photosTestPaths = assets.map(asset => asset.path);
      progress({ copied: assets.length, total: assets.length, current: '' });
      return { target: 'photos', copied: assets.length, total: assets.length, importedItems: 1, cancelled: false, destination: 'Photos', failures: [] };
    };
  });
  await desktop.evaluate(async ({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const library = load('./dist-electron/electron/library.js');
    for (const asset of library.assets.values()) if (asset.path.endsWith('TEST_1.JPG')) library.getSessionCache().setTags(asset.key, ['forest', 'landscape']);
    await library.getSessionCache().save();
  });
  await photos.check();
  await expect(page.locator('.photos-destination')).toContainText('macOS may ask for permission');
  await page.getByRole('button', { name: 'Export selection to Photos', exact: true }).click();
  await expect(page.locator('.export-result')).toContainText('Photos import complete.');
  const submitted = await desktop.evaluate(() => (globalThis as any).photosTestPaths as string[]);
  expect(submitted.map(file => path.basename(file)).sort()).toEqual(['TEST_1.DNG', 'TEST_1.JPG']);
  const payload = await desktop.evaluate(() => (globalThis as any).photosTestAssets as any[]);
  expect(payload.every(asset => asset.event.name === '2026-11-12_23-45-00' && asset.labels.join(',') === 'forest,landscape')).toBe(true);
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
  await toggle.click();
  await page.getByRole('button', { name: 'Turn off labelling', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.desktop!.getOllamaStatus().then(status => status.enabled))).toBe(false);
  await expect(toggle).not.toBeChecked();
  await desktop.close();
  desktop = await electron.launch({ executablePath: process.env.AMA_EXECUTABLE, args: [...(process.env.AMA_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'test' } });
  page = await desktop.firstWindow();
  await readyModel(); await openSettings();
  await expect(page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true })).not.toBeChecked();
});

test('indexed sessions confirm background labelling, report separate progress, and finish the active photo on deactivation', async () => {
  await page.evaluate(() => window.desktop!.setOllamaEnabled(false));
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const native = load('./dist-electron/electron/ollama.js');
    const originalTag = native.OllamaTagger.prototype.tag;
    const state: any = (globalThis as any).labellingTest = { calls: 0, signal: null, finish: null };
    native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
    native.OllamaTagger.prototype.tag = function(this: any, ...args: any[]) {
      const bytes = process.getBuiltinModule('buffer').Buffer;
      this.options.image = async () => bytes.from('test-preview');
      this.request = async (_url: string, init: RequestInit) => {
        state.calls++; state.signal = init.signal;
        return new Promise<Response>((resolve, reject) => {
          state.finish = () => resolve(Response.json({ response: '{"tags":["forest","landscape"]}' }));
          init.signal!.addEventListener('abort', () => reject(new Error('Session closed')), { once: true });
        });
      };
      return originalTag.apply(this, args);
    };
  });
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  const indexing = page.getByRole('progressbar', { name: 'Indexing progress', exact: true });
  await expect(indexing).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: 'Review progress', exact: true })).toBeVisible();
  await page.locator('.photo-card').first().click(); await openSettings();
  const toggle = page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true });
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(page.getByRole('alertdialog')).toContainText('3 unlabelled photos');
  expect(await desktop.evaluate(() => (globalThis as any).labellingTest.calls)).toBe(0);
  expect(await page.evaluate(() => window.desktop!.getOllamaStatus().then(status => status.enabled))).toBe(false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click(); await page.getByRole('button', { name: 'Enable and label', exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => (globalThis as any).labellingTest.calls)).toBe(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const labelling = page.getByRole('progressbar', { name: 'Labelling progress', exact: true });
  await expect(labelling).toHaveAttribute('value', '0'); await expect(labelling).toHaveAttribute('max', '3');
  await expect(indexing).toHaveCount(0); await expect(labelling).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Review progress', exact: true })).toBeVisible();
  const layout = await labelling.evaluate(element => {
    const bar = element.getBoundingClientRect(), text = element.nextElementSibling!.getBoundingClientRect();
    return Math.abs(bar.y + bar.height / 2 - text.y - text.height / 2);
  });
  expect(layout).toBeLessThan(3);
  await page.locator('.photo-card').nth(1).click();
  await expect(page.locator('.detail-name h3')).toHaveText('TEST_2.JPG');
  await page.screenshot({ path: 'test-results/background-labelling.png' });
  await openSettings(); await toggle.click();
  await expect(page.getByRole('alertdialog')).toContainText('The current photo will finish');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(toggle).toBeChecked();
  expect(await desktop.evaluate(() => (globalThis as any).labellingTest.signal.aborted)).toBe(false);
  await toggle.click(); await page.getByRole('button', { name: 'Turn off labelling', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.desktop!.getOllamaStatus().then(status => status.enabled))).toBe(false);
  expect(await desktop.evaluate(() => (globalThis as any).labellingTest.signal.aborted)).toBe(false);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.activity-panel')).toContainText('finishing current photo');
  await desktop.evaluate(() => (globalThis as any).labellingTest.finish());
  await expect(labelling).toHaveCount(0);
  await expect(page.locator('.activity-panel')).toContainText('1 of 3 photos · stopped');
  expect(await desktop.evaluate(() => (globalThis as any).labellingTest.calls)).toBe(1);
  await page.locator('.photo-card').first().click();
  await expect(page.locator('.tag-chip')).toHaveText(['forest', 'landscape']);
  const labels = page.getByRole('combobox', { name: 'Find a capture', exact: true });
  await labels.fill('fore'); await labels.press('Enter');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
});

test('an already enabled indexed session asks once before starting labelling', async () => {
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const native = load('./dist-electron/electron/ollama.js');
    native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
    native.OllamaTagger.prototype.tag = async () => { (globalThis as any).unexpectedLabelling = true; throw new Error('Unconfirmed tagging must not run'); };
  });
  await page.evaluate(() => window.desktop!.setOllamaEnabled(true));
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Label this proofing session?');
  expect(await desktop.evaluate(() => Boolean((globalThis as any).unexpectedLabelling))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.locator('.photo-card').first().dblclick();
  await expect(page.locator('.full-media img')).toBeVisible();
  await openSettings(); await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await desktop.evaluate(() => Boolean((globalThis as any).unexpectedLabelling))).toBe(false);
});

test('indexing shows discovery and numeric progress, then disappears when complete', async () => {
  await desktop.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const library = load('./dist-electron/electron/library.js');
    const scan = library.scan;
    library.scan = async (source: any, progress: (data: any) => void) => {
      progress({ source, total: 0, scanned: 0, files: [], done: false, skipped: 0 });
      await new Promise<void>(release => {
        (globalThis as any).discoverIndexFiles = async () => {
          let final: any;
          await scan(source, (data: any) => { if (data.done) final = data; else progress(data); });
          const split = Math.floor(final.files.length / 2);
          progress({ ...final, files: final.files.slice(0, split), scanned: split, done: false });
          (globalThis as any).finishIndexing = () => { progress({ ...final, files: final.files.slice(split) }); release(); };
        };
      });
    };
  });
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  const bar = page.getByRole('progressbar', { name: 'Indexing progress', exact: true });
  await expect(bar).toBeVisible();
  expect(await bar.getAttribute('value')).toBeNull();
  await expect(page.locator('.activity-panel')).toContainText('Finding photos and videos');
  await desktop.evaluate(async () => { await (globalThis as any).discoverIndexFiles(); });
  await expect(bar).toHaveAttribute('max', '4'); await expect(bar).toHaveAttribute('value', '2');
  await expect(page.locator('.activity-panel')).toContainText('2 of 4 files');
  await desktop.evaluate(() => (globalThis as any).finishIndexing());
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: 'Review progress', exact: true })).toHaveAttribute('aria-valuemax', '3');
  await expect(page.locator('.activity-panel')).not.toContainText('files · complete');
});


test('folder cache resets older schemas visibly, restores decisions and ignores missing targets', async () => {
  const cachePath = path.join(fixture, 'photo-proofing.json');
  await writeFile(cachePath, JSON.stringify({ schemaVersion: 0, files: {} }));
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('.cache-warning')).toContainText('reset');
  await page.locator('.photo-card').first().click(); await page.keyboard.press('a');
  await expect.poll(async () => JSON.parse(await readFile(cachePath, 'utf8')).files['TEST_1.JPG']?.review).toBe('accepted');
  const document = JSON.parse(await readFile(cachePath, 'utf8'));
  expect(document.schemaVersion).toBe(1);
  expect(document.files['TEST_1.DNG'].review).toBe('accepted');
  document.files['missing.JPG'] = document.files['TEST_1.JPG'];
  await writeFile(cachePath, JSON.stringify(document));
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
  await expect(page.locator('.cache-warning')).toHaveCount(0);
  expect(JSON.parse(await readFile(cachePath, 'utf8')).files['missing.JPG']).toBeUndefined();
});

test('light and dark palettes keep chrome neutral and state colors semantic', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  for (const theme of ['light', 'dark'] as const) {
    await chooseTheme(theme);
    await page.locator('.photo-card').first().click();
    // Plain click on an already selected card toggles it off.
    if (!await page.locator('.photo-card.is-selected').count()) await page.locator('.photo-card').first().click();
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(['--canvas', '--sidebar', '--surface', '--primary', '--selection-ring', '--accepted-text', '--rejected-text', '--warning-text'].map(key => {
        const element = document.createElement('span'); element.style.color = style.getPropertyValue(key); document.body.append(element);
        const rgb = getComputedStyle(element).color.match(/\d+/g)!.map(Number); element.remove(); return [key, rgb];
      }));
    });
    for (const key of ['--canvas', '--sidebar', '--surface', '--primary']) expect(new Set(colors[key]).size).toBe(1);
    const blue = colors['--selection-ring']; expect(blue[2]).toBeGreaterThan(blue[0]);
    const green = colors['--accepted-text']; expect(green[1]).toBeGreaterThan(green[0]);
    const red = colors['--rejected-text']; expect(red[0]).toBeGreaterThan(red[1]);
    const yellow = colors['--warning-text']; expect(yellow[1]).toBeGreaterThan(yellow[2]);
    await expect(page.locator('.brand-logo')).toHaveCSS('filter', 'grayscale(1)');
    await expect(page.locator('.photo-card img').first()).toHaveCSS('filter', 'none');
    await page.keyboard.press('a'); await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
    await page.keyboard.press('d'); await expect(page.locator('.review-badge.rejected')).toHaveCount(1);
  }
});

test('A and D keep repeated statuses, S clears mixed selections, and decisions persist', async () => {
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  const cards = page.locator('.photo-card');
  await expect(cards).toHaveCount(3); await cards.first().click();
  await expect(page.locator('.selection-check')).toHaveCount(0);
  await expect(cards.first()).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('a'); await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
  await page.keyboard.press('a'); await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
  await page.keyboard.press('d'); await expect(page.locator('.review-badge.rejected')).toHaveCount(1);
  await page.keyboard.press('d'); await expect(page.locator('.review-badge.rejected')).toHaveCount(1);
  await page.getByRole('button', { name: 'Accept', exact: false }).click();
  await page.getByRole('button', { name: 'Accept', exact: false }).click();
  await expect(page.locator('.review-badge.accepted')).toHaveCount(1);
  await page.keyboard.press('a'); await cards.nth(1).click(); await page.keyboard.press('d');
  await page.keyboard.press('Meta+a'); await expect(page.locator('.photo-card.is-selected')).toHaveCount(3);
  await page.keyboard.press('a');
  await expect(cards.nth(0).locator('.review-badge.accepted')).toHaveCount(1);
  await expect(page.locator('.review-badge.accepted')).toHaveCount(3);
  const cache = () => readFile(path.join(fixture, 'photo-proofing.json'), 'utf8').then(JSON.parse);
  await expect.poll(async () => Object.values((await cache()).files).filter((entry: any) => entry.review === 'accepted').length).toBe(4);
  await page.reload(); await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.review-badge.accepted')).toHaveCount(3);
  await cards.first().click(); await page.keyboard.press('d'); await page.keyboard.press('Meta+a');
  await page.keyboard.press('s'); await expect(page.locator('.review-badge')).toHaveCount(0);
  await expect.poll(async () => Object.values((await cache()).files).filter((entry: any) => entry.review).length).toBe(0);
});

test('About has offline software licenses, traps focus and opens from the native menu', async () => {
  await page.getByRole('button', { name: 'About Photo Proofer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'About Photo Proofer', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('© 2026 Juti Noppornpitak');
  await expect(dialog.locator('.about-version')).toContainText('Version');
  const licenseControl = dialog.getByText('Apache License 2.0', { exact: true });
  await expect(licenseControl).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Dependency licenses' })).toBeHidden();
  await licenseControl.click();
  await expect(dialog.getByRole('heading', { name: 'Dependency licenses' })).toBeVisible();
  await expect(dialog.locator('pre')).toContainText('TERMS AND CONDITIONS');
  await expect(dialog.getByRole('link')).toHaveCount(0);
  for (const [name, license] of [['electron', 'MIT'], ['sharp', 'Apache-2.0'], ['lucide', 'ISC'], ['ExifTool', 'Perl Artistic License'], ['systeminformation', 'MIT']]) {
    const credit = dialog.locator('.software-credit').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
    await expect(credit).toContainText(license);
  }
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'About Photo Proofer', exact: true })).toBeFocused();
  await desktop.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find(item => item.label === 'About Photo Proofer')!;
    item.click();
  });
  await expect(dialog).toBeVisible();
  await licenseControl.click();
  await page.screenshot({ path: 'test-results/about.png' });
  await page.getByRole('button', { name: 'Close About', exact: true }).focus();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.locator('pre')).toBeFocused();
  await page.getByRole('button', { name: 'Close About', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
});


test('review filters update live and combine with media and filename searches', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  const cards = page.locator('.photo-card'); const status = page.getByRole('combobox', { name: 'Filter by review status', exact: true });
  await cards.nth(0).click(); await page.keyboard.press('a');
  await cards.nth(1).click(); await page.keyboard.press('d');
  await status.selectOption('accepted'); await expect(cards).toHaveCount(1); await expect(cards.first()).toContainText('DSC_2041');
  await cards.first().click(); await page.keyboard.press('a'); await expect(cards).toHaveCount(1);
  await page.keyboard.press('s'); await expect(cards).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No matching captures' })).toBeVisible();
  await status.selectOption('rejected'); await expect(cards).toHaveCount(1);
  await cards.first().click(); await page.keyboard.press('d'); await expect(cards).toHaveCount(1);
  await page.keyboard.press('a'); await expect(cards).toHaveCount(0);
  await status.selectOption('accepted'); await expect(cards).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('2045'); await expect(cards).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill(''); await expect(cards).toHaveCount(1);
  await status.selectOption('unreviewed'); await expect(cards).toHaveCount(11);
  await page.getByRole('button', { name: 'Videos', exact: true }).click(); await expect(cards).toHaveCount(0);
  await page.getByRole('button', { name: 'Photos', exact: true }).click(); await expect(cards).toHaveCount(11);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(cards).toHaveCount(12);
  await expect(status).toHaveValue('all');
});

test('cached labels autocomplete with keyboard or mouse and combine with review filters', async () => {
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  const cachePath = path.join(fixture, 'photo-proofing.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache.files['TEST_1.JPG'].tags = ['forest', 'landscape']; cache.files['TEST_1.JPG'].review = 'accepted';
  cache.files['TEST_2.JPG'].tags = ['forest', 'portrait']; cache.files['TEST_2.JPG'].review = 'rejected';
  cache.files['TEST_3.JPG'].tags = ['city', 'landscape'];
  await writeFile(cachePath, JSON.stringify(cache));
  await page.reload(); await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find a capture', exact: true });
  const cards = page.locator('.photo-card');
  await input.fill('FOR'); await expect(page.getByRole('option', { name: 'forest 2', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'portrait 1', exact: true })).toHaveCount(0);
  await input.press('ArrowDown'); await expect(input).toHaveAttribute('aria-activedescendant', 'label-option-0');
  await input.press('Enter'); await expect(cards).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Remove label filter forest', exact: true })).toBeVisible();
  await input.fill('land'); await page.getByRole('option', { name: 'landscape 2', exact: true }).click();
  await expect(cards).toHaveCount(1); await expect(cards.first()).toContainText('TEST_1');
  await page.getByRole('combobox', { name: 'Filter by review status', exact: true }).selectOption('rejected');
  await expect(cards).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove label filter landscape', exact: true }).click();
  await expect(cards).toHaveCount(1); await expect(cards.first()).toContainText('TEST_2');
  await cards.first().click(); await page.keyboard.press('s'); await expect(cards).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(cards).toHaveCount(3);
  await input.fill('not-a-label'); await expect(page.getByText('Search filenames, cameras, lenses, or choose a label.', { exact: true })).toBeVisible();
  await input.press('Escape'); await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(cards).toHaveCount(0);
  await input.fill('city'); await input.press('Enter'); await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: 'Photos', exact: true }).click(); await expect(cards).toHaveCount(1);
  await page.screenshot({ path: 'test-results/label-filters.png' });
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await input.focus(); await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', 'label-option-3');
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.photo-card.is-selected')).toHaveCount(0);
});

test('viewer strip follows the current event while preserving sort and filters', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  await page.locator('.photo-card').nth(3).dblclick();
  const strip = page.locator('.filmstrip-item');
  await expect(strip).toHaveCount(4);
  await expect.poll(() => strip.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['DSC_2041.JPG', 'DSC_2042.JPG', 'DSC_2043.JPG', 'DSC_2044.JPG']);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('h1')).toContainText('DSC_2045.JPG');
  await expect.poll(() => strip.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['DSC_2045.JPG', 'DSC_2046.JPG', 'DSC_2047.JPG', 'DSC_2048.JPG']);
  await strip.last().click(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('h1')).toContainText('DSC_2049.JPG');
  await expect.poll(() => strip.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['DSC_2049.JPG', 'DSC_2050.JPG', 'DSC_2051.JPG', 'DSC_2052.JPG']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Oldest first/ }).click();
  await page.locator('.photo-card').first().dblclick();
  await expect.poll(() => strip.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['DSC_2052.JPG', 'DSC_2051.JPG', 'DSC_2050.JPG', 'DSC_2049.JPG']);
  await page.keyboard.press('Escape'); await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('2044');
  await page.locator('.photo-card').dblclick(); await expect(strip).toHaveCount(1);
  await expect(strip.locator('img')).toHaveAttribute('alt', 'DSC_2044.JPG');
});

test('strip badges and 50% rejection fade update everywhere, persist, and keep overnight events together', async () => {
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  const first = page.locator('.photo-card').first();
  await expect(page.locator('.photo-card')).toHaveCount(3); await first.click(); await page.keyboard.press('d');
  await expect(first.locator('img')).toHaveCSS('opacity', '0.5');
  await expect(first.locator('.review-badge')).toHaveCSS('opacity', '1');
  await expect(page.locator('.detail-preview img')).toHaveCSS('opacity', '0.5');
  await first.dblclick();
  const strip = page.locator('.filmstrip-item');
  await expect(strip).toHaveCount(2);
  await expect.poll(() => strip.locator('img').evaluateAll(images => images.map(image => image.getAttribute('alt')))).toEqual(['TEST_1.JPG', 'TEST_2.JPG']);
  await expect(page.locator('.full-media img')).toHaveCSS('opacity', '0.5');
  await expect(strip.first().locator('img')).toHaveCSS('opacity', '0.5');
  await expect(strip.last().locator('img')).toHaveCSS('opacity', '1');
  await expect(strip.first()).toHaveAccessibleName('Open TEST_1.JPG, rejected');
  await expect(strip.first().locator('.review-badge.rejected')).toHaveCSS('opacity', '1');
  await page.keyboard.press('a');
  await expect(strip.first().locator('.review-badge.accepted')).toBeVisible();
  await expect(page.locator('.full-media img')).toHaveCSS('opacity', '1');
  await expect(strip.first().locator('img')).toHaveCSS('opacity', '1');
  await page.keyboard.press('s'); await expect(strip.locator('.review-badge')).toHaveCount(0);
  await chooseTheme('dark'); await page.keyboard.press('d');
  await expect(page.locator('.full-media img')).toHaveCSS('opacity', '0.5');
  await page.keyboard.press('t');
  await expect(page.locator('h1')).toContainText('TEST_1.DNG');
  await expect(page.locator('.full-media img')).toHaveCSS('opacity', '0.5');
  await expect(page.locator('.detail-preview img')).toHaveCSS('opacity', '0.5');
  await expect(strip.first().locator('img')).toHaveCSS('opacity', '0.5');
  await expect(page.locator('.full-media img')).not.toHaveJSProperty('naturalWidth', 0);
  await expect(strip.first().locator('img')).not.toHaveJSProperty('naturalWidth', 0);
  await expect(page.locator('.detail-preview img')).not.toHaveJSProperty('naturalWidth', 0);
  await page.screenshot({ path: 'test-results/rejected-viewer.png' });
  await page.keyboard.press('ArrowRight'); await expect(strip).toHaveCount(2);
  await page.keyboard.press('ArrowRight'); await expect(strip).toHaveCount(1);
  await expect(strip.locator('img')).toHaveAttribute('alt', 'TEST_3.JPG');
  await page.reload(); await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(first.locator('img')).toHaveCSS('opacity', '0.5');
  await first.click(); await page.keyboard.press('s');
  await expect(first.locator('img')).toHaveCSS('opacity', '1');
  await expect(page.locator('.detail-preview img')).toHaveCSS('opacity', '1');
});


test('review progress segments use current position and explicit statuses without double counting', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  const bar = page.getByRole('progressbar', { name: 'Review progress', exact: true });
  const legend = page.locator('.review-progress-legend');
  const cards = page.locator('.photo-card');
  await expect(bar).toHaveAttribute('aria-valuenow', '0'); await expect(bar).toHaveAttribute('aria-valuemax', '12');
  await cards.nth(3).click();
  await expect(bar).toHaveAttribute('aria-valuenow', '4'); await expect(legend).toContainText('4 viewed');
  await page.keyboard.press('a'); await expect(legend).toContainText('1 accepted'); await expect(legend).toContainText('3 viewed');
  await expect(bar).toHaveAttribute('aria-valuenow', '4');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('d');
  await expect(legend).toContainText('1 rejected'); await expect(legend).toContainText('2 viewed');
  await page.keyboard.press('ArrowLeft');
  await expect(legend).toContainText('2 viewed'); await expect(bar).toHaveAttribute('aria-valuenow', '4');
  await page.keyboard.press('ArrowLeft');
  await expect(legend).toContainText('1 viewed'); await expect(bar).toHaveAttribute('aria-valuenow', '3');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('s');
  await expect(legend).toContainText('0 rejected'); await expect(legend).toContainText('3 viewed');
  await expect(bar).toHaveAttribute('aria-valuenow', '4');
  await cards.nth(3).dblclick(); await expect(bar).toHaveAttribute('aria-valuenow', '4');
  await page.keyboard.press('ArrowRight'); await expect(bar).toHaveAttribute('aria-valuenow', '5');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Filter by review status', exact: true }).selectOption('accepted');
  await expect(bar).toHaveAttribute('aria-valuenow', '1'); await expect(bar).toHaveAttribute('aria-valuemax', '1');
  await expect(legend).toContainText('0 viewed');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(bar).toHaveAttribute('aria-valuenow', '1'); await expect(bar).toHaveAttribute('aria-valuemax', '12');
  await cards.nth(3).click(); await page.keyboard.press('d'); await cards.nth(1).click(); await page.keyboard.press('a');
  for (const theme of ['light', 'dark'] as const) {
    await chooseTheme(theme);
    const colors = await page.evaluate(() => ['accepted', 'rejected', 'viewed'].map(name => getComputedStyle(document.querySelector(`.review-segment.review-${name}`)!).backgroundColor.match(/\d+/g)!.map(Number)));
    expect(colors[0][1]).toBeGreaterThan(colors[0][0]); expect(colors[1][0]).toBeGreaterThan(colors[1][1]); expect(colors[2][2]).toBeGreaterThan(colors[2][0]);
    const widths = await page.locator('.review-segment').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(widths.every(width => width > 0)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/review-progress.png' });
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('no-matching-photo');
  await expect(bar).toHaveAttribute('aria-valuenow', '0'); await expect(bar).toHaveAttribute('aria-valuetext', /0 of 0 reviewed/);
});

test('review bar previews and focuses the capture at its position in the current order', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  await page.locator('.photo-card').first().click(); await page.keyboard.press('a');
  await page.locator('.photo-card').nth(2).click(); await page.keyboard.press('d');
  const bar = page.getByRole('progressbar', { name: 'Review progress', exact: true });
  const preview = page.getByRole('tooltip');
  const point = async (fraction: number) => { const box = (await bar.boundingBox())!; return { x: box.x + box.width * fraction, y: box.y + box.height / 2 }; };
  const firstPoint = await point(2.5 / 12); await page.mouse.move(firstPoint.x, firstPoint.y);
  await expect(preview).toContainText('DSC_2043.JPG');
  await expect(preview.locator('img')).toHaveCSS('opacity', '0.5');
  await expect(preview.locator('.review-badge.rejected')).toBeVisible();
  await expect(preview.locator('img')).not.toHaveJSProperty('naturalWidth', 0);
  await expect(page.locator('.detail-name h3')).toHaveText('DSC_2043.JPG');
  const bounds = (await preview.boundingBox())!, barBounds = (await bar.boundingBox())!;
  expect(bounds.y).toBeGreaterThan(barBounds.y + barBounds.height);
  let target = await point(8.5 / 12); await page.mouse.move(target.x, target.y);
  await expect(preview).toContainText('DSC_2049.JPG');
  await expect(page.locator('.detail-name h3')).toHaveText('DSC_2043.JPG');
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('.photo-card.is-selected')).toContainText('DSC_2049');
  await expect(page.locator('.photo-card.is-selected')).toBeFocused();
  await expect(preview).toHaveCount(0);
  expect(await page.locator('.gallery-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.locator('.photo-card.is-selected').dblclick();
  target = await point(1.5 / 12); await page.mouse.click(target.x, target.y);
  await expect(page.locator('h1')).toContainText('DSC_2042.JPG');
  await expect(page.locator('.filmstrip-item')).toHaveCount(4);
  await bar.focus(); await page.keyboard.press('End');
  await expect(page.locator('h1')).toContainText('DSC_2052.JPG'); await expect(bar).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(page.locator('h1')).toContainText('DSC_2051.JPG');
  await page.keyboard.press('Home'); await expect(page.locator('h1')).toContainText('DSC_2041.JPG');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: /Oldest first/ }).click();
  target = await point(0.001); await page.mouse.move(target.x, target.y); await expect(preview).toContainText('DSC_2052.JPG');
  target = await point(0.999); await page.mouse.move(target.x, target.y); await expect(preview).toContainText('DSC_2041.JPG');
  await page.screenshot({ path: 'test-results/progress-hover.png' });
  await page.getByRole('combobox', { name: 'Filter by review status', exact: true }).selectOption('accepted');
  target = await point(0.9); await page.mouse.click(target.x, target.y);
  await expect(page.locator('.photo-card.is-selected')).toContainText('DSC_2041');
  await page.getByRole('combobox', { name: 'Find a capture', exact: true }).fill('missing-capture');
  await expect(bar).toHaveAttribute('aria-disabled', 'true');
  target = await point(0.5); await page.mouse.move(target.x, target.y); await expect(preview).toHaveCount(0);
});

test('one search field shares the review row and sidebar actions have even spacing', async () => {
  await page.getByRole('button', { name: /Explore a sample/ }).click();
  await expect(page.locator('input[type=search]')).toHaveCount(1);
  await expect(page.locator('#label-search')).toHaveCount(0);
  const search = page.getByRole('combobox', { name: 'Find a capture', exact: true });
  const status = page.getByRole('combobox', { name: 'Filter by review status', exact: true });
  for (const width of [1440, 1000, 900]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 700), width);
    const searchBox = (await search.boundingBox())!, statusBox = (await status.boundingBox())!;
    expect(Math.abs(searchBox.y + searchBox.height / 2 - statusBox.y - statusBox.height / 2)).toBeLessThan(3);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(width);
    const boxes = await page.locator('.sidebar-bottom>button').evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { y: rect.y, height: rect.height, bottom: rect.bottom }; }));
    expect(new Set(boxes.map(box => box.height)).size).toBe(1);
    expect(boxes[1].y - boxes[0].bottom).toBeCloseTo(boxes[2].y - boxes[1].bottom, 1);
    expect(700 - boxes.at(-1)!.bottom).toBeCloseTo(12, 0);
  }
  await expect(page.locator('.sidebar-bottom')).not.toContainText('©');
  await search.fill('2045'); await expect(page.locator('.photo-card')).toHaveCount(1);
  await search.fill(''); await page.getByRole('button', { name: 'About Photo Proofer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'About Photo Proofer' })).toContainText('© 2026 Juti Noppornpitak');
});

test('event export includes hidden event captures and JSON with EXIF, labels and review decisions', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'photo-event-export-'));
  try {
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    await page.locator('.photo-card').nth(0).click(); await page.keyboard.press('a');
    await page.locator('.photo-card').nth(1).click(); await page.keyboard.press('d');
    await desktop.evaluate(async ({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const library = load('./dist-electron/electron/library.js');
      for (const asset of library.assets.values()) if (asset.path.endsWith('TEST_1.JPG')) library.getSessionCache().setTags(asset.key, ['forest', 'landscape']);
      await library.getSessionCache().save();
    });
    await page.getByRole('combobox', { name: 'Filter by review status', exact: true }).selectOption('accepted');
    await expect(page.locator('.photo-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('radio', { name: /^Event/ }).check();
    const event = page.getByRole('combobox', { name: 'Event to export', exact: true });
    await event.selectOption({ index: 0 }); await expect(page.locator('.export-buttons')).toContainText('2 captures / 3 files');
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByRole('button', { name: 'Export event', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    const folder = path.join(destination, '2026-11-12_23-45-00');
    const document = JSON.parse(await readFile(path.join(folder, 'photo-proofing-export.json'), 'utf8'));
    expect(document.event).toMatchObject({ start: '2026-11-12T23:45:00', end: '2026-11-13T00:10:00' });
    expect(document.files).toHaveLength(3);
    const jpeg = document.files.find((file: any) => file.file === 'TEST_1.JPG');
    expect(jpeg).toMatchObject({ sourcePath: 'TEST_1.JPG', labels: ['forest', 'landscape'], review: 'accepted', exif: { Model: 'Test Camera', ISO: 200 } });
    expect(jpeg.exif.DateTimeOriginal).toBeTruthy();
    expect(document.files.find((file: any) => file.file === 'TEST_1.DNG').labels).toEqual(['forest', 'landscape']);
    expect(document.files.find((file: any) => file.file === 'TEST_2.JPG').review).toBe('rejected');
    expect(JSON.stringify(document)).not.toContain(fixture);
    expect(hash(await readFile(path.join(folder, 'TEST_1.JPG')))).toBe(originalHash);
    await event.selectOption({ index: 1 }); await page.getByRole('button', { name: 'Export event', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(JSON.parse(await readFile(path.join(destination, '2026-11-13_09-00-00', 'photo-proofing-export.json'), 'utf8')).files).toHaveLength(1);
    await page.screenshot({ path: 'test-results/event-export.png' });
  } finally { await rm(destination, { recursive: true, force: true }); }
});


test('accepted exports receive Ollama summaries while selected and Event naming stay unchanged', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'photo-summary-export-'));
  try {
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    await page.locator('.photo-card').first().click(); await page.keyboard.press('a');
    await page.locator('.photo-card').nth(2).click(); await page.keyboard.press('a');
    await desktop.evaluate(async ({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const native = load('./dist-electron/electron/ollama.js'); const library = load('./dist-electron/electron/library.js');
      const test: any = (globalThis as any).summaryTest = { calls: [], fail: false };
      for (const asset of library.assets.values()) {
        if (asset.path.endsWith('TEST_1.JPG')) library.getSessionCache().setTags(asset.key, ['forest', 'landscape']);
        if (asset.path.endsWith('TEST_2.JPG')) library.getSessionCache().setTags(asset.key, ['river', 'waterfall']);
        if (asset.path.endsWith('TEST_3.JPG')) library.getSessionCache().setTags(asset.key, ['city', 'street']);
      }
      await library.getSessionCache().save();
      native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
      const summarize = native.OllamaTagger.prototype.summarizeEvent;
      native.OllamaTagger.prototype.summarizeEvent = function(this: any, photos: any[], signal: AbortSignal) {
        this.request = async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)); test.calls.push({ photos, body });
          if (test.fail) throw new Error('model busy');
          return Response.json({ response: JSON.stringify({ summary: body.prompt.includes('forest') ? 'Forest & Lake Morning!' : 'City Walk!' }) });
        };
        return summarize.call(this, photos, signal);
      };
    });
    await page.evaluate(() => window.desktop!.setOllamaEnabled(true));
    await page.locator('.photo-card').first().click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByRole('button', { name: 'Export selection', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(await desktop.evaluate(() => (globalThis as any).summaryTest.calls.length)).toBe(0);
    expect(hash(await readFile(path.join(destination, 'TEST_1.JPG')))).toBe(originalHash);
    await page.getByLabel(/Accepted captures/).check();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    const firstFolder = 'forest-lake-morning';
    const secondFolder = 'city-walk';
    const manifest = JSON.parse(await readFile(path.join(destination, firstFolder, 'photo-proofing-export.json'), 'utf8'));
    expect(manifest).toMatchObject({ summary: 'forest-lake-morning', summarySource: 'ollama', folderName: firstFolder });
    expect(manifest.files).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(destination, secondFolder, 'photo-proofing-export.json'), 'utf8')).summary).toBe('city-walk');
    const calls = await desktop.evaluate(() => (globalThis as any).summaryTest.calls as any[]);
    expect(calls).toHaveLength(2); expect(calls[0].photos).toHaveLength(2); expect(calls[0].photos.some((photo: any) => photo.labels.includes('river'))).toBe(true); expect(calls[0].body.model).toBe('gemma4:e2b');
    expect((await readdir(destination, { withFileTypes: true })).filter(file => file.isDirectory()).every(file => /^[a-z0-9-]+$/.test(file.name))).toBe(true);
    await page.screenshot({ path: 'test-results/summary-export.png' });
    await page.getByRole('radio', { name: /^Event/ }).check();
    await page.getByRole('combobox', { name: 'Event to export', exact: true }).selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Export event', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(await desktop.evaluate(() => (globalThis as any).summaryTest.calls.length)).toBe(2);
    expect(await readFile(path.join(destination, '2026-11-12_23-45-00', 'TEST_1.JPG'))).toEqual(await readFile(path.join(fixture, 'TEST_1.JPG')));
    await page.getByLabel(/Accepted captures/).check(); await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(await desktop.evaluate(() => (globalThis as any).summaryTest.calls.length)).toBe(2);
    expect(JSON.parse(await readFile(path.join(destination, 'forest-lake-morning-2', 'photo-proofing-export.json'), 'utf8')).summary).toBe('forest-lake-morning');
    await expect(page.locator('.event-link .event-summary').first()).toHaveText('forest lake morning');
    await desktop.evaluate(({ app }) => {
      (globalThis as any).summaryTest.fail = true;
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      load('./dist-electron/electron/library.js').getSessionCache().pruneEventSummaries(new Set());
    });
    await page.getByLabel(/Accepted captures/).check(); await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toHaveClass(/is-warning/);
    await expect(page.locator('.export-result')).toContainText('fallback folder name');
    expect(JSON.parse(await readFile(path.join(destination, 'forest-landscape', 'photo-proofing-export.json'), 'utf8')).summarySource).toBe('labels-fallback');
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('background event summaries cover all photos, survive reload, and name different accepted selections consistently', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'photo-event-summary-cache-'));
  try {
    await page.evaluate(() => window.desktop!.setOllamaEnabled(false));
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    await page.locator('.photo-card').first().click(); await page.keyboard.press('a');
    await page.locator('.photo-card').nth(1).click(); await page.keyboard.press('d');
    await desktop.evaluate(({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const native = load('./dist-electron/electron/ollama.js');
      const test: any = (globalThis as any).eventSummaryTest = { tagging: 0, summaries: [] };
      native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
      native.OllamaTagger.prototype.tag = async function(this: any, ids: string[], jobId: string, progress: (data: any) => void) {
        test.tagging++;
        ids.forEach((id, index) => {
          const labels = [['forest'], ['river', 'waterfall'], ['city', 'park']][index];
          this.options.cache.set(this.options.asset(id).key, labels);
          progress({ jobId, id, tags: labels, completed: index + 1, total: ids.length });
        });
        await this.options.cache.save(); return { completed: ids.length, total: ids.length, cancelled: false, failures: 0 };
      };
      const summarize = native.OllamaTagger.prototype.summarizeEvent;
      native.OllamaTagger.prototype.summarizeEvent = function(this: any, photos: any[], signal: AbortSignal) {
        test.summaries.push(photos);
        this.request = async (_url: string, init: RequestInit) => {
          const prompt = JSON.parse(String(init.body)).prompt;
          return Response.json({ response: JSON.stringify({ summary: prompt.includes('river') ? 'forest-river-walk' : 'city-park' }) });
        };
        return summarize.call(this, photos, signal);
      };
    });
    await openSettings(); await page.getByRole('switch', { name: 'Tag photos with Ollama', exact: true }).click();
    await page.getByRole('button', { name: 'Enable and label', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.locator('.event-link .event-summary')).toHaveText(['forest river walk', 'city park']);
    await expect(page.locator('.event-heading .event-summary')).toHaveText(['forest river walk', 'city park']);
    await expect(page.getByRole('progressbar', { name: /^(Events|Labelling) progress$/ })).toHaveCount(0);
    const generated = await desktop.evaluate(() => (globalThis as any).eventSummaryTest.summaries as any[][]);
    expect(generated.map(photos => photos.length)).toEqual([2, 1]);
    expect(generated[0].some(photo => photo.labels.includes('river'))).toBe(true);
    const cache = JSON.parse(await readFile(path.join(fixture, 'photo-proofing.json'), 'utf8'));
    expect(Object.values(cache.eventSummaries).sort()).toEqual(['city-park', 'forest-river-walk']);
    await page.reload(); await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.event-link .event-summary')).toHaveText(['forest river walk', 'city park']);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await desktop.evaluate(() => (globalThis as any).eventSummaryTest.summaries.length)).toBe(2);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByLabel(/Accepted captures/).check();
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    expect(JSON.parse(await readFile(path.join(destination, 'forest-river-walk', 'photo-proofing-export.json'), 'utf8')).files).toHaveLength(2);
    await page.getByRole('button', { name: 'Close export', exact: true }).click();
    await page.locator('.photo-card').first().click(); await page.keyboard.press('s');
    await page.locator('.photo-card').nth(1).click(); await page.keyboard.press('a');
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByLabel(/Accepted captures/).check();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    const second = JSON.parse(await readFile(path.join(destination, 'forest-river-walk-2', 'photo-proofing-export.json'), 'utf8'));
    expect(second.files.map((file: any) => file.file)).toEqual(['TEST_2.JPG']); expect(second.summary).toBe('forest-river-walk');
    expect(await desktop.evaluate(() => (globalThis as any).eventSummaryTest.summaries.length)).toBe(2);
    await page.getByRole('button', { name: 'Close export', exact: true }).click();
    await page.screenshot({ path: 'test-results/event-summaries.png' });
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('event gap and bookmarks persist, regroup exports consistently, and handle a disconnected location', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'bookmarked-card-'));
  const offline = `${source}-disconnected`, destination = await mkdtemp(path.join(os.tmpdir(), 'custom-gap-export-'));
  let disconnected = false;
  try {
    for (const file of ['TEST_1.JPG', 'TEST_2.JPG', 'TEST_3.JPG']) await copyFile(path.join(fixture, file), path.join(source, file));
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, source);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3); await expect(page.locator('.event-section')).toHaveCount(2);
    await page.getByRole('button', { name: 'Bookmark this location', exact: true }).click();
    await expect(page.locator('.bookmark-row')).toHaveCount(1);
    await page.locator('.photo-card').first().click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('a');
    await openSettings(); const gap = page.getByRole('spinbutton', { name: 'Event gap in minutes', exact: true });
    await expect(gap).toHaveValue('30'); await gap.fill('0'); await page.getByRole('button', { name: 'Apply event gap', exact: true }).click();
    await expect(page.locator('.settings-error')).toContainText('whole-number');
    await gap.fill('10'); await page.getByRole('button', { name: 'Apply event gap', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.desktop!.getLibrarySettings().then(settings => settings.eventGapMinutes))).toBe(10);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await expect(page.locator('.event-section')).toHaveCount(3);
    await openSettings(); await gap.fill('600'); await page.getByRole('button', { name: 'Apply event gap', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.desktop!.getLibrarySettings().then(settings => settings.eventGapMinutes))).toBe(600);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.locator('.event-section')).toHaveCount(1); await expect(page.locator('.review-badge.accepted')).toHaveCount(3);
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByLabel(/Accepted captures/).check();
    await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click(); await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toContainText('Export complete.');
    const manifest = JSON.parse(await readFile(path.join(destination, '2026-11-12_23-45-00', 'photo-proofing-export.json'), 'utf8'));
    expect(manifest.files).toHaveLength(3); expect(manifest.event.end).toBe('2026-11-13T09:00:00');
    const settings = await page.evaluate(() => window.desktop!.getLibrarySettings()); expect(settings.bookmarks[0].path).toBe(await realpath(source));
    await desktop.close(); await rename(source, offline); disconnected = true;
    desktop = await electron.launch({ executablePath: process.env.AMA_EXECUTABLE, args: [...(process.env.AMA_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'test' } });
    page = await desktop.firstWindow(); await page.waitForLoadState('domcontentloaded');
    await desktop.evaluate(({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      load('./dist-electron/electron/ollama.js').OllamaTagger.prototype.status = async () => ({ model: 'gemma4:e2b', available: false, enabled: false, reasons: ['Ollama unavailable in tests.'] });
    });
    await expect(page.locator('.bookmark-row')).toHaveCount(1);
    await page.locator('[data-bookmark="0"]').click(); await expect(page.locator('.error-banner')).toContainText('bookmarked folder is unavailable');
    await expect(page.locator('.bookmark-row')).toHaveCount(1);
    await rename(offline, source); disconnected = false;
    await page.locator('[data-bookmark="0"]').click();
    await expect(page.locator('.photo-card')).toHaveCount(3); await expect(page.locator('.event-section')).toHaveCount(1);
    await expect(page.locator('.review-badge.accepted')).toHaveCount(3);
    await openSettings(); await expect(page.getByRole('spinbutton', { name: 'Event gap in minutes', exact: true })).toHaveValue('600'); await page.screenshot({ path: 'test-results/library-settings.png' });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: `Remove bookmark ${path.basename(source)}`, exact: true }).click();
    await expect(page.locator('.bookmark-row')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Bookmark this location', exact: true })).toBeVisible();
  } finally { if (disconnected) await rename(offline, source).catch(() => {}); await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); }
});

test('reindex refreshes metadata and reruns enabled AI while preserving accepted and rejected decisions', async () => {
  await desktop.evaluate(async ({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click(); await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.locator('.photo-card').first().click(); await page.keyboard.press('a'); await page.locator('.photo-card').nth(1).click(); await page.keyboard.press('d');
  await desktop.evaluate(async ({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`), library = load('./dist-electron/electron/library.js'), native = load('./dist-electron/electron/ollama.js');
    const cache = library.getSessionCache(); const fs = process.getBuiltinModule('fs');
    for (const asset of library.assets.values()) {
      cache.setTags(asset.key, ['old-label']);
      if (asset.path.endsWith('TEST_1.JPG')) {
        const info = fs.statSync(asset.path), previous = cache.getMetadata('TEST_1.JPG', info.size, info.mtimeMs);
        cache.setFile('TEST_1.JPG', info.size, info.mtimeMs, { ...previous, camera: 'Stale Camera' });
      }
    }
    cache.setEventSummary('a'.repeat(64), 'old-summary'); await cache.save();
    const test: any = (globalThis as any).reindexTest = { tags: 0, summaries: 0, clean: false };
    native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
    native.OllamaTagger.prototype.tag = async function(this: any, ids: string[], jobId: string, progress: (data: any) => void) {
      test.tags++;
      test.clean = ids.every(id => !this.options.cache.get(this.options.asset(id).key)) && !library.getSessionCache().getEventSummary('a'.repeat(64));
      ids.forEach((id, index) => { this.options.cache.set(this.options.asset(id).key, ['fresh-label']); progress({ jobId, id, tags: ['fresh-label'], completed: index + 1, total: ids.length }); });
      await this.options.cache.save(); return { completed: ids.length, total: ids.length, cancelled: false, failures: 0 };
    };
    native.OllamaTagger.prototype.summarizeEvent = async () => { test.summaries++; return `fresh-event-${test.summaries}`; };
  });
  await page.evaluate(() => window.desktop!.setOllamaEnabled(true));
  await page.getByRole('button', { name: 'Reindex & rerun AI', exact: true }).click();
  await expect(page.locator('.event-link .event-summary')).toHaveCount(2);
  await expect(page.locator('.review-badge.accepted')).toHaveCount(1); await expect(page.locator('.review-badge.rejected')).toHaveCount(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await desktop.evaluate(() => (globalThis as any).reindexTest)).toMatchObject({ tags: 1, summaries: 2, clean: true });
  const cache = JSON.parse(await readFile(path.join(fixture, 'photo-proofing.json'), 'utf8'));
  expect(cache.files['TEST_1.JPG'].metadata.camera).toBe('Test Camera'); expect(cache.files['TEST_1.JPG'].tags).toEqual(['fresh-label']);
  expect(cache.files['TEST_1.JPG'].review).toBe('accepted'); expect(cache.files['TEST_2.JPG'].review).toBe('rejected');
  await page.evaluate(() => window.desktop!.setOllamaEnabled(false));
  await page.getByRole('button', { name: 'Reindex & rerun AI', exact: true }).click();
  await expect(page.locator('#indexing-progress')).toHaveCount(0);
  await expect(page.locator('.event-link .event-summary')).toHaveCount(0);
  const disabled = JSON.parse(await readFile(path.join(fixture, 'photo-proofing.json'), 'utf8'));
  expect(disabled.files['TEST_1.JPG'].tags).toBeUndefined(); expect(disabled.files['TEST_1.JPG'].review).toBe('accepted');
  expect(await desktop.evaluate(() => (globalThis as any).reindexTest.tags)).toBe(1);
  expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
});

test('indexing and background AI errors show details without opening Settings and remain until dismissed', async () => {
  await desktop.evaluate(({ app, dialog }, folder) => {
    const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const library = load('./dist-electron/electron/library.js');
    const read = library.exiftool.read.bind(library.exiftool);
    library.exiftool.read = (file: string, ...args: any[]) => file.endsWith('TEST_2.JPG')
      ? Promise.reject(new Error('EXIF test failure <untrusted>')) : read(file, ...args);
    const native = load('./dist-electron/electron/ollama.js');
    native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
    native.OllamaTagger.prototype.tag = async (_ids: string[], jobId: string, progress: (data: any) => void) => {
      _ids.forEach((id, index) => progress({ jobId, id, completed: index + 1, total: _ids.length, error: 'Ollama test failure <script>bad()</script>' }));
      return { completed: _ids.length, total: _ids.length, cancelled: false, failures: _ids.length };
    };
    native.OllamaTagger.prototype.summarizeEvent = async () => { throw new Error('Event summary test failure'); };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, fixture);
  await page.evaluate(() => window.desktop!.setOllamaEnabled(false));
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await expect(page.locator('.cache-notices')).toContainText('TEST_2.JPG: Metadata unavailable: EXIF test failure <untrusted>');
  await page.evaluate(() => window.desktop!.setOllamaEnabled(true));
  await page.getByRole('button', { name: 'Reindex & rerun AI', exact: true }).click();
  const errors = page.locator('.error-banner');
  await expect(errors).toContainText('Could not label TEST_1.JPG. Ollama test failure <script>bad()</script>');
  await expect(errors).toContainText('Could not summarize event');
  await expect(errors).toContainText('Event summary test failure');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(errors.locator('script')).toHaveCount(0);
  await page.locator('.photo-card').first().dblclick();
  await expect(errors).toContainText('Ollama test failure');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(errors).toHaveCount(0);
  await expect(page.locator('.full-media')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: new Error('Unexpected asynchronous test failure'), promise: Promise.resolve() }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Unexpected renderer test failure' }));
  });
  await expect(errors).toContainText('Unexpected asynchronous test failure');
  await expect(errors).toContainText('Unexpected renderer test failure');
  await page.screenshot({ path: 'test-results/visible-errors.png' });
});

test('video-only events do not request summaries, prompt for AI work, or gain summary export names', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'photo-video-only-'));
  const destination = await mkdtemp(path.join(os.tmpdir(), 'photo-video-export-'));
  try {
    // Only indexing/export are exercised; playback is covered with a real clip above.
    await writeFile(path.join(source, 'CLIP.mp4'), Buffer.from('video-only indexing fixture'));
    await desktop.evaluate(({ app, dialog }, folder) => {
      const load = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const native = load('./dist-electron/electron/ollama.js');
      (globalThis as any).videoSummaryCalls = 0;
      native.OllamaTagger.prototype.status = async function(this: any) { return { model: 'gemma4:e2b', available: true, enabled: this.enabled, reasons: [] }; };
      native.OllamaTagger.prototype.summarizeEvent = async () => { (globalThis as any).videoSummaryCalls++; throw new Error('No photos should reach the model'); };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, source);
    await page.evaluate(() => window.desktop!.setOllamaEnabled(true));
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(1);
    await expect(page.locator('#indexing-progress')).toHaveCount(0);
    // Wait for the post-index cache/status load without relying on an arbitrary delay.
    await openSettings(); await page.getByRole('button', { name: 'Tag untagged photos', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('progressbar', { name: 'Events progress', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.locator('.photo-card').click(); await page.keyboard.press('a');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByLabel(/Accepted captures/).check();
    await page.getByRole('button', { name: 'Export accepted', exact: true }).click();
    await expect(page.locator('.export-result')).toBeVisible();
    const folders = await readdir(destination); expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    const metadata = JSON.parse(await readFile(path.join(destination, folders[0], 'photo-proofing-export.json'), 'utf8'));
    expect(metadata.summary).toBeUndefined(); expect(metadata.summarySource).toBeUndefined();
    expect(await desktop.evaluate(() => (globalThis as any).videoSummaryCalls)).toBe(0);
  } finally { await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); }
});

test('finds near-duplicates within an event and selects the group for review', async () => {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, fixture);
  await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Find similar photos' }).click();
  const similar = page.getByRole('dialog', { name: 'Similar photos' });
  await expect(similar.getByText('2 similar captures')).toBeVisible();
  await expect(similar.getByText('TEST_1.JPG', { exact: true })).toBeVisible();
  await expect(similar.getByText('TEST_2.JPG', { exact: true })).toBeVisible();
  await expect(similar.getByText('TEST_3.JPG', { exact: true })).toHaveCount(0);
  await similar.getByRole('button', { name: 'Select group for review' }).click();
  await expect(page.locator('.photo-card.is-selected')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Create panorama' })).toBeVisible();
});

test('fills the window, saves tone and LUT edits per version, and exports numbered copies', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'proof-edited-'));
  const toneValues = [['Highlights', '-24'], ['Shadows', '30'], ['Brightness', '7'], ['Blacks', '-18']];
  try {
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, fixture);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    await page.locator('.photo-card').first().dblclick();
    await page.getByRole('button', { name: 'Edit JPEG' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit JPEG' });
    expect(await editor.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [bounds.x, bounds.y, bounds.width / innerWidth, bounds.height / innerHeight];
    })).toEqual([0, 0, 1, 1]);
    await editor.getByRole('button', { name: 'Rotate right 90°' }).click();
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(editor.locator('.editor-status')).toContainText('Saved version 1');
    await editor.getByRole('button', { name: 'Rotate left 90°' }).click();
    await editor.getByLabel('Black and white').check();
    for (const [name, value] of toneValues) {
      await editor.getByRole('slider', { name, exact: true }).fill(value);
    }
    const lutFile = path.join(destination, 'Red.cube');
    await writeFile(lutFile, 'LUT_3D_SIZE 2\n' + '1 0 0\n'.repeat(8));
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, lutFile);
    await editor.getByRole('button', { name: 'Choose LUT' }).click();
    await expect(editor.locator('.editor-lut-name')).toHaveText('Red.cube');
    await editor.getByLabel('Crop aspect').selectOption('1:1');
    await expect(editor.locator('.editor-crop')).toBeVisible();
    await editor.getByRole('button', { name: 'Save as new version' }).click();
    await expect(editor.locator('.editor-status')).toContainText('Saved version 2');
    const cache = JSON.parse(await readFile(path.join(fixture, 'photo-proofing.json'), 'utf8'));
    expect(Object.keys(cache.luts)).toHaveLength(1);
    await rm(lutFile);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const firstVersionIsPortrait = (image: HTMLImageElement) => image.naturalWidth > 0 && image.naturalHeight > image.naturalWidth;
    const stripThumbnail = page.locator('.filmstrip-item.selected img');
    await expect.poll(() => stripThumbnail.evaluate(firstVersionIsPortrait)).toBe(true);
    await page.getByRole('button', { name: 'Reindex & rerun AI' }).click();
    await expect(page.locator('.photo-card')).toHaveCount(3);
    await expect.poll(() => page.locator('.photo-card').first().locator('img').evaluate(firstVersionIsPortrait)).toBe(true);
    await page.locator('.photo-card').first().dblclick();
    await page.getByRole('button', { name: 'Edit JPEG' }).click();
    await expect(editor.getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('2');
    await expect(editor.getByLabel('Black and white')).toBeChecked();
    for (const [name, value] of toneValues) await expect(editor.getByRole('slider', { name, exact: true })).toHaveValue(value);
    await expect(editor.locator('.editor-lut-name')).toHaveText('Red.cube');
    await editor.getByRole('combobox', { name: 'Version', exact: true }).selectOption('1');
    await expect(editor.getByLabel('Black and white')).not.toBeChecked();
    await expect(editor.getByRole('slider', { name: 'Highlights', exact: true })).toHaveValue('0');
    await expect(editor.locator('.editor-lut-name')).toHaveText('No LUT applied');
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, destination);
    await editor.getByRole('button', { name: 'Choose folder' }).click();
    await editor.getByLabel('Export all saved versions').check();
    await editor.getByLabel('Text watermark').fill('Photo Proofer');
    await editor.getByLabel('Bottom-right caption').selectOption('automatic');
    await editor.getByLabel('Name override').fill('Sample photographer');
    await editor.getByRole('button', { name: 'Export JPEG', exact: true }).click();
    await expect(editor.locator('.editor-status')).toContainText('Exported 2 of 2 JPEGs', { timeout: 25000 });
    const sharp = (await import('sharp')).default;
    const normal = await sharp(path.join(destination, 'TEST_1 (v1).JPG')).metadata();
    const graded = sharp(path.join(destination, 'TEST_1 (v2).JPG'));
    const cropped = await graded.metadata();
    expect(normal.width).not.toBe(normal.height);
    expect(Math.abs(cropped.width - cropped.height)).toBeLessThanOrEqual(1);
    const { channels } = await graded.stats();
    expect(channels[0].mean).toBeGreaterThan(channels[1].mean + 150);
    expect(hash(await readFile(path.join(fixture, 'TEST_1.JPG')))).toBe(originalHash);
    await page.screenshot({ path: 'test-results/jpeg-editor.png' });
    await editor.getByRole('button', { name: 'Rotate left 90°' }).click();
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(editor.locator('.editor-status')).toContainText('Saved version 1');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => stripThumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth > image.naturalHeight)).toBe(true);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('develops sensor data from a paired RAW and preserves portrait thumbnails and originals', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'proof-sensor-'));
  const destination = await mkdtemp(path.join(os.tmpdir(), 'proof-sensor-export-'));
  try {
    const bytes = sensorDng();
    const raw = path.join(source, 'SENSOR.DNG');
    await writeFile(raw, bytes);
    await copyFile(path.join(fixture, 'TEST_1.JPG'), path.join(source, 'SENSOR.JPG'));
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, source);
    await page.locator('.sidebar').getByRole('button', { name: 'Open a card or folder', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(1);
    await page.locator('.photo-card').click();
    await page.keyboard.press('t');
    const thumbnail = page.locator('.photo-card img');
    await expect(thumbnail).toHaveJSProperty('naturalWidth', 192);
    await expect(thumbnail).toHaveJSProperty('naturalHeight', 320);
    await expect(thumbnail).toHaveCSS('object-fit', 'contain');
    await page.getByRole('button', { name: 'Edit RAW', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit RAW', exact: true });
    await expect(editor.getByRole('combobox', { name: 'RAW white balance' })).toHaveValue('as-shot');
    await expect(editor.getByRole('img', { name: 'Adjustment preview' })).toHaveJSProperty('naturalWidth', 192);
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(editor.locator('.editor-status')).toContainText('Saved version 1');
    await editor.locator('input[name="exposure"]').evaluate((slider: HTMLInputElement) => {
      slider.value = '1';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await editor.getByRole('slider', { name: 'Brightness', exact: true }).fill('5');
    await editor.getByRole('button', { name: 'Save as new version' }).click();
    await expect(editor.locator('.editor-status')).toContainText('Saved version 2');
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, destination);
    await editor.getByRole('button', { name: 'Choose folder' }).click();
    await editor.getByLabel('Export all saved versions').check();
    await editor.getByRole('button', { name: 'Export JPEG', exact: true }).click();
    await expect(editor.locator('.editor-status')).toContainText('Exported 2 of 2 JPEGs');
    const sharp = (await import('sharp')).default;
    const first = sharp(path.join(destination, 'SENSOR (v1).JPG'));
    const second = sharp(path.join(destination, 'SENSOR (v2).JPG'));
    expect(await first.metadata()).toMatchObject({ width: 192, height: 320, format: 'jpeg' });
    expect((await second.stats()).channels[0].mean).toBeGreaterThan((await first.stats()).channels[0].mean + 10);
    expect(await readFile(raw)).toEqual(bytes);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.keyboard.press('t');
    await expect(page.locator('.photo-card img')).toHaveJSProperty('naturalWidth', 192);
    await page.getByRole('button', { name: 'Edit JPEG', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit JPEG' }).getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('');
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
