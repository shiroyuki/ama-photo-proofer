import type { Photo } from '../shared/model';

export async function openPanorama(photos: Photo[]) {
  const api = window.desktop;
  if (!api || document.querySelector('.panorama-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'similar-dialog panorama-dialog';
  dialog.setAttribute('aria-labelledby', 'panorama-title');
  dialog.innerHTML = `<header><h2 id="panorama-title">Create panorama</h2><button type="button" class="button" data-pano="close">Close</button></header>
    <p>Stitch ${photos.length} overlapping photos into one JPEG.</p>
    <p class="editor-destination"></p><div class="editor-row"><button type="button" class="button" data-pano="folder">Choose folder</button><button type="button" class="button primary" data-pano="stitch">Stitch and export</button></div>
    <p class="editor-status" role="status"></p><p class="editor-error" role="alert"></p>`;
  const opener = document.activeElement as HTMLElement | null;
  const location = dialog.querySelector<HTMLElement>('.editor-destination')!;
  const status = dialog.querySelector<HTMLElement>('.editor-status')!;
  const error = dialog.querySelector<HTMLElement>('.editor-error')!;
  const buttons = [...dialog.querySelectorAll('button')];
  let busy = false;
  const setBusy = (value: boolean) => {
    busy = value;
    for (const button of buttons) button.disabled = value;
  };
  const describe = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });
  dialog.onclick = async event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-pano]')?.dataset.pano;
    if (!action || busy) return;
    if (action === 'close') { dialog.close(); return; }
    setBusy(true);
    error.textContent = '';
    try {
      if (action === 'folder') {
        const folder = await api.chooseExportLocation();
        if (folder) location.textContent = folder;
      } else {
        status.textContent = 'Stitching photos…';
        const file = await api.exportPanorama(photos.map(photo => photo.primary.id));
        status.textContent = `Saved ${file}`;
      }
    } catch (failure) {
      status.textContent = '';
      error.textContent = describe(failure);
    } finally { setBusy(false); }
  };
  document.body.append(dialog);
  dialog.showModal();
  try { location.textContent = await api.getExportLocation(); }
  catch (failure) { error.textContent = describe(failure); }
}
