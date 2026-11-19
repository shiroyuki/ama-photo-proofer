import { defaultEdits, type EditVersion, type PhotoEdits } from '../shared/edits';
import type { MediaFile } from '../shared/model';

const toneSliders = [
  ['exposure', 'Exposure', -2, 2, 0.05],
  ['highlights', 'Highlights', -100, 100, 1],
  ['shadows', 'Shadows', -100, 100, 1],
  ['brightness', 'Brightness', -100, 100, 1],
  ['blacks', 'Blacks', -100, 100, 1],
  ['contrast', 'Contrast', -100, 100, 1],
] as const;
const colorSliders = [
  ['saturation', 'Saturation', -100, 100, 1],
  ['warmth', 'White balance warmth', -100, 100, 1],
] as const;
const rotationSlider = ['rotation', 'Rotation / leveling', -360, 360, 0.1] as const;
const sliders = [...toneSliders, ...colorSliders, rotationSlider];
const sliderMarkup = ([key, label, min, max, step]: typeof sliders[number]) =>
  `<label><span>${label} <span class="editor-slider-value" data-value="${key}" aria-hidden="true"></span></span><input name="${key}" type="range" min="${min}" max="${max}" step="${step}" value="0"></label>`;
const message = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export async function openEditor(photo: MediaFile, onThumbnailChange: () => void) {
  const api = window.desktop;
  if (!api || document.querySelector('.photo-editor')) return;
  const isRaw = photo.kind === 'raw';
  const rawDefaults = { whiteBalance: 'as-shot' as const, recoverHighlights: true };
  const dialog = document.createElement('dialog');
  dialog.className = 'photo-editor';
  dialog.classList.toggle('editor-mac', navigator.platform.startsWith('Mac'));
  dialog.setAttribute('aria-labelledby', 'editor-title');
  dialog.innerHTML = `
    <header>
      <div class="editor-title"><h2 id="editor-title">Edit ${isRaw ? 'RAW' : 'JPEG'}</h2><p class="editor-filename"></p></div>
      <fieldset class="editor-version-actions" aria-label="Edit versions">
        <label>Version<select name="version"></select></label>
        <button type="button" class="button primary" data-editor="save">Save version</button>
        <button type="button" class="button" data-editor="copy">Save as new version</button>
        <button type="button" class="button" data-editor="close">Close</button>
      </fieldset>
    </header>
    <div class="editor-body">
      <div class="editor-stage"><div class="editor-image"><img alt="Adjustment preview" draggable="false"><div class="editor-crop" hidden><div></div></div></div></div>
      <div class="editor-controls">
        <fieldset>
          <legend>Tone</legend>
          ${toneSliders.map(sliderMarkup).join('')}
          ${isRaw ? '<label class="editor-check"><input type="checkbox" name="recover-highlights" checked>Blend clipped RAW highlights</label>' : ''}
        </fieldset>
        <fieldset>
          <legend>Color</legend>
          ${isRaw ? '<label>RAW white balance<select name="raw-balance"><option value="as-shot">As shot</option><option value="daylight">Daylight</option></select></label>' : ''}
          ${colorSliders.map(sliderMarkup).join('')}
          <label class="editor-check"><input type="checkbox" name="monochrome">Black and white</label>
          <div class="editor-lut"><span class="editor-lut-name"></span>
            <div class="editor-row"><button type="button" class="button compact" data-editor="lut">Choose LUT…</button><button type="button" class="button compact" data-editor="remove-lut" hidden>Remove LUT</button></div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Crop and rotate</legend>
          ${sliderMarkup(rotationSlider)}
          <div class="editor-row"><button type="button" class="button compact" data-editor="rotate-left">Rotate left 90°</button><button type="button" class="button compact" data-editor="rotate-right">Rotate right 90°</button></div>
          <label>Crop aspect<select name="aspect"><option value="">Original</option><option value="1:1">1:1</option><option value="2:3">2:3</option><option value="3:4">3:4</option><option value="16:9">16:9</option><option value="2.39:1">2.39:1 widescreen</option><option value="custom">Custom ratio</option><option value="saved" hidden>Saved crop</option></select></label>
          <div class="editor-row" id="custom-crop" hidden><label>Ratio width<input name="ratio-width" type="number" min="1" max="10000" value="4"></label><label>Ratio height<input name="ratio-height" type="number" min="1" max="10000" value="3"></label></div>
          <label>Crop size<input name="crop-size" type="range" min="10" max="100" value="100" disabled></label>
          <label class="editor-check"><input type="checkbox" name="guides" checked>Rule-of-thirds guides</label>
          <p class="editor-hint">Drag the crop box or use its arrow keys to position it.</p>
        </fieldset>
        <fieldset>
          <legend>Export JPEG versions</legend>
          <label class="editor-check"><input type="checkbox" name="all-versions">Export all saved versions</label>
          <label>Text watermark<input name="watermark" maxlength="500" placeholder="Optional"></label>
          <label>Bottom-right caption<select name="caption-mode"><option value="">None</option><option value="automatic">Automatic from EXIF</option><option value="manual">Manual</option></select></label>
          <label id="caption-name" hidden>Name override<input name="caption-name" maxlength="500" placeholder="Use EXIF name"></label>
          <label id="caption-text" hidden>Caption text<textarea name="caption-text" rows="3" maxlength="500"></textarea></label>
          <div class="editor-row"><button type="button" class="button" data-editor="folder">Choose folder</button><button type="button" class="button primary" data-editor="export">Export JPEG</button></div>
          <p class="editor-destination"></p>
        </fieldset>
      </div>
    </div>
    <p class="editor-status" role="status"></p><p class="editor-error" role="alert" hidden></p>`;
  document.body.append(dialog);
  const opener = document.activeElement as HTMLElement | null;
  const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(name: string) => dialog.querySelector<T>(`[name="${name}"]`)!;
  const status = dialog.querySelector<HTMLElement>('.editor-status')!;
  const error = dialog.querySelector<HTMLElement>('.editor-error')!;
  const image = dialog.querySelector<HTMLImageElement>('img')!;
  const frame = dialog.querySelector<HTMLElement>('.editor-crop')!;
  const controls = [...dialog.querySelectorAll<HTMLFieldSetElement>('fieldset')];
  const close = dialog.querySelector<HTMLButtonElement>('[data-editor="close"]')!;
  const destination = dialog.querySelector<HTMLElement>('.editor-destination')!;
  const lutName = dialog.querySelector<HTMLElement>('.editor-lut-name')!;
  const removeLut = dialog.querySelector<HTMLButtonElement>('[data-editor="remove-lut"]')!;
  dialog.querySelector('.editor-filename')!.textContent = photo.name;

  let versions: EditVersion[] = [];
  let version: number | undefined;
  let edits: PhotoEdits = { ...defaultEdits };
  let dirty = false;
  let thumbnailChanged = false;
  let busy = false;
  let previewRevision = 0;
  let previewPending = false;
  let previewFailed = false;
  let cropNeedsReflow = false;
  let pendingPreview: ReturnType<typeof setTimeout>;
  let previewInFlight: Promise<string> | undefined;
  let cropCenter = { x: 0.5, y: 0.5 };
  let savedAspect: number | undefined;

  function setError(value: unknown) {
    error.textContent = value ? message(value) : '';
    error.hidden = !value;
  }
  function refreshControls() {
    for (const fieldset of controls) fieldset.disabled = busy;
    close.disabled = busy;
    dialog.querySelector<HTMLButtonElement>('[data-editor="save"]')!.disabled = previewPending || previewFailed || Boolean(version && !dirty);
    dialog.querySelector<HTMLButtonElement>('[data-editor="copy"]')!.disabled = previewPending || previewFailed || !version;
    dialog.querySelector<HTMLButtonElement>('[data-editor="export"]')!.disabled = !versions.length || (!input('all-versions').checked && (!version || dirty));
  }
  function refreshVersions() {
    const select = input<HTMLSelectElement>('version');
    select.replaceChildren(new Option('New version', ''), ...versions.map(item => new Option(`Version ${item.number}`, String(item.number))));
    select.value = version ? String(version) : '';
    refreshControls();
  }
  function refreshLut() {
    lutName.textContent = edits.lut?.name ?? 'No LUT applied';
    removeLut.hidden = !edits.lut;
  }
  function drawCrop() {
    frame.hidden = !edits.crop;
    if (!edits.crop) return;
    const { x, y, width, height } = edits.crop;
    Object.assign(frame.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` });
    frame.classList.toggle('guides', input('guides').checked);
  }
  function resizeCrop() {
    const aspect = input<HTMLSelectElement>('aspect').value;
    dialog.querySelector<HTMLElement>('#custom-crop')!.hidden = aspect !== 'custom';
    input('crop-size').disabled = !aspect;
    if (!aspect) {
      delete edits.crop;
      drawCrop();
      return;
    }
    if (!image.naturalWidth) return;
    const [w, h] = aspect === 'custom' ? [input('ratio-width').valueAsNumber, input('ratio-height').valueAsNumber] : aspect.split(':').map(Number);
    const ratio = aspect === 'saved' ? savedAspect ?? 1 : w / h;
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) throw new Error('Use a crop ratio between 1:10 and 10:1.');
    const normalized = ratio * image.naturalHeight / image.naturalWidth;
    const size = input('crop-size').valueAsNumber / 100;
    const width = Math.min(1, normalized) * size;
    const height = Math.min(1, 1 / normalized) * size;
    edits.crop = {
      x: Math.max(0, Math.min(1 - width, cropCenter.x - width / 2)),
      y: Math.max(0, Math.min(1 - height, cropCenter.y - height / 2)),
      width, height,
    };
    drawCrop();
  }
  function requestPreview(recalculateCrop = false) {
    const revision = ++previewRevision;
    cropNeedsReflow ||= recalculateCrop;
    previewPending = true;
    if (previewFailed) setError('');
    previewFailed = false;
    refreshControls();
    clearTimeout(pendingPreview);
    pendingPreview = setTimeout(async () => {
      try {
        await previewInFlight?.catch(() => {});
        if (!dialog.isConnected || previewRevision !== revision) return;
        const work = api!.previewEdits(photo.id, { ...edits, crop: undefined });
        previewInFlight = work;
        const source = await work.finally(() => { if (previewInFlight === work) previewInFlight = undefined; });
        if (!dialog.isConnected || previewRevision !== revision) return;
        const decoded = new Image();
        decoded.src = source;
        await decoded.decode();
        if (!dialog.isConnected || previewRevision !== revision) return;
        image.style.setProperty('--preview-ratio', String(decoded.naturalWidth / decoded.naturalHeight));
        image.src = source;
        await image.decode();
        if (!dialog.isConnected || previewRevision !== revision) return;
        if (edits.crop && !savedAspect) savedAspect = edits.crop.width * image.naturalWidth / (edits.crop.height * image.naturalHeight);
        if (cropNeedsReflow) resizeCrop();
        else drawCrop();
        cropNeedsReflow = false;
      } catch (error) {
        if (previewRevision === revision) { previewFailed = true; setError(error); }
      }
      finally {
        if (previewRevision === revision) {
          previewPending = false;
          refreshControls();
        }
      }
    }, 100);
  }
  function syncSliders() {
    for (const [key] of sliders) {
      input(key).value = String(edits[key]);
      dialog.querySelector(`[data-value="${key}"]`)!.textContent = String(edits[key]);
    }
  }
  function selectVersion(number?: number) {
    version = number;
    edits = structuredClone(versions.find(item => item.number === version)?.edits ?? defaultEdits);
    dirty = false;
    savedAspect = undefined;
    cropNeedsReflow = false;
    cropCenter = edits.crop ? { x: edits.crop.x + edits.crop.width / 2, y: edits.crop.y + edits.crop.height / 2 } : { x: 0.5, y: 0.5 };
    syncSliders();
    refreshLut();
    input('monochrome').checked = edits.monochrome;
    if (isRaw) {
      edits.raw ??= { ...rawDefaults };
      input('raw-balance').value = edits.raw.whiteBalance;
      input('recover-highlights').checked = edits.raw.recoverHighlights;
    }
    input('aspect').value = edits.crop ? 'saved' : '';
    input<HTMLSelectElement>('aspect').options[6].hidden = !edits.crop;
    input('crop-size').value = String(edits.crop ? Math.round(Math.max(edits.crop.width, edits.crop.height) * 100) : 100);
    input('crop-size').disabled = !edits.crop;
    dialog.querySelector<HTMLElement>('#custom-crop')!.hidden = true;
    refreshVersions();
    requestPreview();
  }
  function changeCrop() {
    try { resizeCrop(); dirty = true; refreshControls(); setError(''); }
    catch (error) { setError(error); }
  }
  dialog.addEventListener('input', event => {
    const target = event.target as HTMLInputElement;
    const key = sliders.find(([key]) => key === target.name)?.[0];
    if (key || target.name === 'monochrome') {
      if (key) edits[key] = target.valueAsNumber;
      else edits.monochrome = target.checked;
      dirty = true;
      syncSliders();
      refreshControls();
      requestPreview(key === 'rotation');
    }
    if (['ratio-width', 'ratio-height', 'crop-size'].includes(target.name)) changeCrop();
  });
  dialog.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    if (isRaw && (target.name === 'raw-balance' || target.name === 'recover-highlights')) {
      edits.raw = {
        whiteBalance: input('raw-balance').value === 'daylight' ? 'daylight' : 'as-shot',
        recoverHighlights: input('recover-highlights').checked,
      };
      dirty = true;
      requestPreview();
    }
    if (target.name === 'version') {
      if (dirty && !window.confirm('Discard unsaved adjustments?')) { refreshVersions(); return; }
      setError('');
      selectVersion(Number(target.value) || undefined);
    }
    if (target.name === 'aspect') { input('crop-size').value = '100'; changeCrop(); }
    if (target.name === 'guides') drawCrop();
    if (target.name === 'all-versions') refreshControls();
    if (target.name === 'caption-mode') {
      dialog.querySelector<HTMLElement>('#caption-name')!.hidden = target.value !== 'automatic';
      dialog.querySelector<HTMLElement>('#caption-text')!.hidden = target.value !== 'manual';
    }
  });
  frame.tabIndex = 0;
  frame.setAttribute('aria-label', 'Crop position. Use arrow keys to move.');
  let dragStart: { x: number; y: number; centerX: number; centerY: number } | undefined;
  frame.addEventListener('pointerdown', event => {
    if (busy || !edits.crop) return;
    frame.setPointerCapture(event.pointerId);
    dragStart = { x: event.clientX, y: event.clientY, centerX: edits.crop.x + edits.crop.width / 2, centerY: edits.crop.y + edits.crop.height / 2 };
  });
  frame.addEventListener('pointermove', event => {
    if (!dragStart || !frame.hasPointerCapture(event.pointerId)) return;
    const bounds = image.getBoundingClientRect();
    cropCenter = { x: dragStart.centerX + (event.clientX - dragStart.x) / bounds.width, y: dragStart.centerY + (event.clientY - dragStart.y) / bounds.height };
    changeCrop();
  });
  frame.addEventListener('lostpointercapture', () => { dragStart = undefined; });
  frame.addEventListener('keydown', event => {
    if (busy || !edits.crop || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const { x, y, width, height } = edits.crop;
    const step = event.shiftKey ? 0.05 : 0.01;
    cropCenter = { x: x + width / 2 + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: y + height / 2 + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) };
    changeCrop();
  });
  function tryClose() {
    if (!busy && (!dirty || window.confirm('Discard unsaved adjustments?'))) dialog.close();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); tryClose(); });
  dialog.addEventListener('close', () => {
    clearTimeout(pendingPreview);
    dialog.remove();
    if (thumbnailChanged) onThumbnailChange();
    else opener?.focus();
  });
  dialog.addEventListener('click', async event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-editor]')?.dataset.editor;
    if (!action || busy) return;
    if (action === 'close') { tryClose(); return; }
    if (action === 'remove-lut') {
      delete edits.lut;
      dirty = true;
      refreshLut();
      requestPreview();
      dialog.querySelector<HTMLButtonElement>('[data-editor="lut"]')!.focus();
      return;
    }
    if (action === 'rotate-left' || action === 'rotate-right') {
      edits.rotation = (edits.rotation + (action === 'rotate-right' ? 90 : -90)) % 360;
      dirty = true; syncSliders(); refreshControls(); requestPreview(true);
      return;
    }
    busy = true;
    setError('');
    refreshControls();
    try {
      if (action === 'save' || action === 'copy') {
        const current = action === 'save' ? version : undefined;
        versions = await api.saveEditVersion(photo.id, edits, current);
        version = current ?? versions.at(-1)?.number;
        thumbnailChanged ||= version === versions[0]?.number;
        dirty = false;
        refreshVersions();
        status.textContent = `Saved version ${version}.`;
      } else if (action === 'lut') {
        const lut = await api.chooseEditLut(photo.id);
        if (!lut) return;
        edits.lut = lut;
        dirty = true;
        refreshLut();
        requestPreview();
      } else if (action === 'folder') {
        const folder = await api.chooseExportLocation();
        if (folder) destination.textContent = folder;
      } else if (action === 'export') {
        status.textContent = 'Rendering JPEGs…';
        const mode = input('caption-mode').value;
        const result = await api.exportEditVersions(photo.id, input('all-versions').checked ? versions.map(item => item.number) : [version!], {
          automatic: mode === 'automatic',
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          name: input('caption-name').value,
          caption: mode === 'manual' ? input('caption-text').value : undefined,
          watermark: input('watermark').value,
        });
        status.textContent = `Exported ${result.copied} of ${result.total} JPEGs to ${result.destination}.`;
        if (result.failures.length) setError(result.failures.map(item => `${item.name}: ${item.message}`).join('\n'));
      }
    } catch (error) { status.textContent = ''; setError(error); }
    finally { busy = false; refreshControls(); }
  });
  dialog.showModal();
  busy = true;
  refreshControls();
  try {
    [versions, destination.textContent] = await Promise.all([api.getEditVersions(photo.id), api.getExportLocation()]);
    selectVersion(versions.at(-1)?.number);
  } catch (error) { setError(error); }
  finally { busy = false; refreshControls(); }
}
