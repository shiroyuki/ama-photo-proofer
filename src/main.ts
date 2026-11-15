import './style.css';
import { themePreference, setThemePreference } from './theme';
import { icon } from './icons';
import { pairPhotos, groupEvents, groupEventsByDate, type MediaFile, type Photo, type PhotoEvent, type Source } from '../shared/model';
import { demoFiles, demoUrl } from './demo';
import { clickSelection, type ReviewStatus } from '../shared/selection';
import { installMarquee } from './marquee';
import type { ExportResult, OllamaStatus } from '../shared/model';

const root = document.querySelector<HTMLDivElement>('#app')!;
const state = {
  files: [] as MediaFile[], source: null as Source | null, sources: [] as Source[],
  selectedIds: new Set<string>(), anchorId: '', selectedId: '', eventId: '', filter: 'all', search: '', full: false, raw: false,
  info: true, loading: false, scanned: 0, total: 0, skipped: 0, demo: false,
  size: 240, reverse: false, zoom: false, help: false, error: '',
  exportOpen: false, exportMode: 'selection' as 'selection' | 'accepted', exportLocation: '',
  exportBusy: false, exportCopied: 0, exportTotal: 0, exportCurrent: '', exportResult: null as ExportResult | null,
  exportError: '', choosingLocation: false, exportTarget: 'folder' as 'folder' | 'photos', photosAvailable: false,
  settingsOpen: false, settingsChecking: false, settingsBusy: false, settingsError: '', ollama: null as OllamaStatus | null,
  tagging: false, tagJobId: '', tagCompleted: 0, tagTotal: 0, tagSummary: '',
};
let allPhotos: Photo[] = [];
let events: PhotoEvent[] = [];
let visible: Photo[] = [];
let photoById = new Map<string, Photo>();
let tagEpoch = 0;
const tags = new Map<string, string[]>();
const tagErrors = new Map<string, string>();
let reviews: Record<string, ReviewStatus> = {};
try {
  const saved: unknown = JSON.parse(localStorage.getItem('ama-reviews-v1') ?? '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    reviews = Object.fromEntries(Object.entries(saved).filter(([, value]) => value === 'accepted' || value === 'rejected'));
  }
} catch { /* First launch or unavailable storage. */ }
const reviewKey = (photo: Photo) => `${photo.primary.directory}/${photo.primary.kind === 'jpeg' || photo.primary.kind === 'raw' ? photo.primary.stem.toLowerCase() : photo.primary.name}|${photo.primary.capturedAt.slice(0, 19)}`;
const reviewStatus = (photo: Photo) => reviews[reviewKey(photo)];
const acceptedPhotos = () => allPhotos.filter(photo => reviewStatus(photo) === 'accepted');
const selectedPhotos = () => allPhotos.filter(photo => state.selectedIds.has(photo.id));
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const selected = () => photoById.get(state.selectedId);
const currentFile = (photo: Photo) => state.raw && state.selectedId === photo.id && photo.raw ? photo.raw : photo.primary;
const url = (file: MediaFile, thumb = false) => file.id.startsWith('demo-') ? demoUrl(file.id) : `media://asset/${file.id}${thumb ? '?size=thumb' : ''}`;
// Keep the camera's local date/time even when its EXIF includes a timezone.
const localDate = (date: string) => new Date(date.slice(0, 19));
const day = (date: string, short = false) => localDate(date).toLocaleDateString('en-US', { month: short ? 'short' : 'long', day: 'numeric', ...(short ? {} : { year: 'numeric' }) });
const time = (date: string) => localDate(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const eventDate = (event: PhotoEvent) => event.start.slice(0, 10) === event.end.slice(0, 10) ? day(event.start) : `${day(event.start, true)} – ${day(event.end, true)}`;
const eventName = (event: PhotoEvent) => {
  if (event.start.slice(0, 10) !== event.end.slice(0, 10)) return 'Overnight';
  const hour = localDate(event.start).getHours();
  return hour < 5 ? 'Late night' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 21 ? 'Evening' : 'Night';
};
const sizeLabel = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;
const btn = (name: Parameters<typeof icon>[0], label: string, action: string, active = false) => `<button class="icon-button ${active ? 'active' : ''}" data-action="${action}" title="${label}" aria-label="${label}"${action === 'info' ? ` aria-pressed="${active}"` : ''}>${icon(name)}</button>`;
function compute() {
  allPhotos = pairPhotos(state.files);
  photoById = new Map(allPhotos.map(photo => [photo.id, photo]));
  events = groupEvents(allPhotos);
  const event = events.find(e => e.id === state.eventId);
  visible = (event ? event.photos : allPhotos).filter(p => {
    const file = p.primary;
    return (state.filter === 'all' || (state.filter === 'video' ? file.kind === 'video' : file.kind !== 'video')) &&
      (!state.search || p.files.some(f => `${f.name} ${f.camera ?? ''} ${f.lens ?? ''} ${(tags.get(p.id) ?? []).join(' ')}`.toLowerCase().includes(state.search.toLowerCase())));
  });
  if (state.reverse) visible.reverse();
  const visibleIds = new Set(visible.map(photo => photo.id));
  state.selectedIds = new Set([...state.selectedIds].filter(id => visibleIds.has(id)));
  if (!visibleIds.has(state.selectedId)) state.selectedId = [...state.selectedIds].at(-1) ?? '';
}
function sidebar() {
  return `<aside class="sidebar"><div class="sidebar-content"><div class="brand"><img class="brand-logo" src="${import.meta.env.BASE_URL}logo.svg" alt=""><span class="brand-name">Photo Proofer</span></div>
  <div class="side-section"><div class="section-label">Workspace</div><button class="side-link ${!state.eventId ? 'selected' : ''}" data-action="all">${icon('LayoutGrid')}<span>All captures</span><span class="count">${allPhotos.length || '—'}</span></button></div>
  <div class="side-section"><div class="section-label">Sources<button class="small-icon" data-action="refresh-sources" aria-label="Refresh memory cards" title="Refresh memory cards">${icon('RefreshCw', 13)}</button></div>
  ${state.source ? `<div class="source-item">${icon(state.demo ? 'Folder' : 'HardDrive', 20)}<div><strong>${escape(state.source.name)}</strong><span>${state.demo ? 'Sample collection' : 'Opened for review'}</span></div><span class="source-dot"></span></div>` : `<div class="no-source">No card opened</div>`}
  ${state.sources.filter(s => s.path !== state.source?.path).map((s, index) => `<button class="side-link" data-source="${index}">${icon('HardDrive')}<span>${escape(s.name)}</span></button>`).join('')}
  <button class="source-open" data-action="open">${icon('FolderOpen', 16)}Open a card or folder</button></div>
  <div class="side-section events-nav"><div class="section-label">Events <span>${events.length || ''}</span></div><div class="events-list">
  ${events.length ? groupEventsByDate(events).map(group => `<section class="event-date-group"><h3>${group.date}</h3>${group.events.map(event => `<button class="event-link ${state.eventId === event.id ? 'selected' : ''}" data-event="${escape(event.id)}"><span class="event-marker">${icon(localDate(event.start).getHours() < 17 ? 'Sun' : 'Moon', 15)}</span><span><strong>${time(event.start)} – ${time(event.end)}</strong>${event.start.slice(0, 10) !== event.end.slice(0, 10) ? `<small>to ${event.end.slice(0, 10)}</small>` : ''}</span><span class="count">${event.photos.length}</span></button>`).join('')}</section>`).join('') : `<p class="side-hint">Your shoots, organized by date and time. A gap over 30 minutes starts a new event.</p>`}</div></div>
  </div><div class="sidebar-bottom"><button class="settings-button" data-action="settings">${icon('Settings2', 17)}Settings</button><button class="help-button" data-action="help">${icon('Keyboard', 17)}Keyboard shortcuts<span>?</span></button><small class="copyright">© 2026 Juti Noppornpitak</small></div></aside>`;
}
function toolbar() {
  const event = events.find(e => e.id === state.eventId);
  return `<div class="titlebar"><span>${state.full ? 'Photo viewer' : 'Memory card workspace'}</span><span class="local-status"><span></span>Local workspace</span></div>
  <header class="page-header"><div>${state.full ? `<button class="back-button" data-action="back">${icon('ArrowLeft', 16)}All thumbnails</button>` : `<div class="breadcrumb">Library ${icon('ChevronRight', 12)} ${escape(state.source?.name ?? 'Getting started')}</div>`}<h1>${state.full ? escape(selected() ? currentFile(selected()!).name : '') : event ? `${event.start.slice(0, 10)} ${time(event.start)}` : 'All captures'}${state.demo ? '<span class="demo-tag">Demo</span>' : ''}</h1><p>${state.full ? `${Math.max(0, visible.findIndex(p => p.id === state.selectedId) + 1)} of ${visible.length} captures` : allPhotos.length ? `${allPhotos.length} captures${state.files.length !== allPhotos.length ? ` from ${state.files.length} files` : ''} in ${events.length} events` : 'A little space to see what you captured.'}</p></div>
  <div class="header-actions">${state.loading ? `<button class="button" data-action="cancel">${icon('X', 15)}Stop scan</button>` : ''}${btn('Info', 'Toggle photo details', 'info', state.info)}<button class="button primary" data-action="open" ${state.exportBusy ? 'disabled' : ''}>${icon('FolderOpen', 16)}Open folder</button>${allPhotos.length ? `<button class="button" data-action="export" ${state.demo ? 'disabled title="Export is available for your own files"' : state.loading ? 'disabled title="Finish scanning before exporting"' : ''}>${icon('ArrowUpRight', 16)}Export</button>` : ''}</div></header>
  ${!state.full && allPhotos.length ? `<div class="toolbar"><div class="tabs" role="group" aria-label="Media type">${[['all', 'All media'], ['photo', 'Photos'], ['video', 'Videos']].map(([value, label]) => `<button class="tab ${state.filter === value ? 'selected' : ''}" data-filter="${value}" aria-pressed="${state.filter === value}">${value === 'video' ? icon('Film', 14) : value === 'photo' ? icon('Image', 14) : ''}${label}</button>`).join('')}</div>
  <div class="view-tools"><label class="search">${icon('Search', 15)}<input id="search" type="search" placeholder="Find a capture…" value="${escape(state.search)}" aria-label="Search filenames, cameras and lenses"></label><button class="sort-button" data-action="sort" title="Reverse capture order">${state.reverse ? 'Newest first' : 'Oldest first'}${icon('ChevronDown', 14)}</button><div class="size-control">${icon('Grid2X2', 15)}<input id="thumbnail-size" type="range" min="160" max="360" value="${state.size}" aria-label="Thumbnail size"></div></div></div>` : ''}`;
}
function mediaMarkup(file: MediaFile, thumb: boolean) {
  if (file.kind === 'video') return `<video class="media-image ${thumb ? 'video-thumbnail' : ''}" src="${url(file)}" ${thumb ? 'preload="metadata" muted' : 'controls preload="metadata"'} aria-label="${escape(file.name)}"></video>${thumb ? `<span class="video-badge">${icon('Play', 12)}${file.duration ? `${Math.floor(file.duration / 60)}:${String(Math.floor(file.duration % 60)).padStart(2, '0')}` : 'Video'}</span>` : ''}`;
  return `<img class="media-image" src="${url(file, thumb)}" alt="${escape(file.name)}" ${thumb ? 'loading="lazy"' : ''} draggable="false">`;
}
function card(photo: Photo) {
  const file = currentFile(photo);
  return `<button class="photo-card ${state.selectedIds.has(photo.id) ? 'is-selected' : ''}" data-photo="${escape(photo.id)}" aria-label="${escape(file.name)}, ${time(file.capturedAt)}. Double-click to open." aria-pressed="${state.selectedIds.has(photo.id)}"><div class="thumbnail">${mediaMarkup(file, true)}<span class="review-indicator">${reviewBadge(photo)}</span><span class="selection-check">${icon('Check', 12)}</span>${photo.raw && photo.primary.kind === 'jpeg' ? `<span class="format-badge">JPEG + RAW</span>` : file.kind === 'raw' ? `<span class="format-badge">RAW</span>` : ''}</div><div class="photo-caption"><strong>${escape(file.stem)}</strong><span>${time(file.capturedAt)}</span></div><div class="photo-meta"><span>${escape(file.camera ?? (file.kind === 'video' ? 'Video' : 'Photo'))}</span><span>${file.kind === 'video' ? file.extension.toUpperCase() : file.aperture ? `ƒ/${escape(file.aperture)}` : file.extension.toUpperCase()}</span></div></button>`;
}
function empty() {
  return `<div class="welcome"><div class="welcome-visual"><div class="frame-back"></div><div class="frame-front"><img class="welcome-logo" src="${import.meta.env.BASE_URL}logo.svg" alt=""><span>A fresh perspective.</span></div><div class="card-chip">${icon('HardDrive', 25)}</div></div><h2>Your next shoot starts here.</h2><p>Open a memory card or photo folder.<br>We’ll bring your captures together, one event at a time.</p><button class="button primary large" data-action="open">${icon('FolderOpen', 18)}Open a card or folder</button><button class="demo-button" data-action="demo">Explore a sample collection ${icon('ArrowUpRight', 14)}</button><div class="welcome-features"><span>${icon('Image', 16)}JPEG + RAW, together</span><span>${icon('Clock3', 16)}Events organized for you</span><span>${icon('Film', 16)}Video in the same view</span></div></div>`;
}
function gallery() {
  if (!allPhotos.length) return state.loading ? `<div class="empty-results">${icon('LoaderCircle', 32)}<h2>Reading your card…</h2><p>Looking for photos and videos. Originals stay untouched.</p></div>` : state.source ? `<div class="empty-results">${icon('FolderOpen', 40)}<h2>No captures found</h2><p>Choose a folder containing photos, RAW files, or videos.</p><button class="button primary" data-action="open">Open another folder</button></div>` : empty();
  if (!visible.length) return `<div class="empty-results">${icon('Search', 34)}<h2>No matching captures</h2><p>Try another search or media type.</p><button class="button" data-action="reset-filters">Show all captures</button></div>`;
  const ids = new Set(visible.map(p => p.id));
  const shownEvents = (state.reverse ? [...events].reverse() : events).filter(e => e.photos.some(p => ids.has(p.id)));
  return groupEventsByDate(shownEvents).map(group => `<section class="capture-date"><h2>${group.date}</h2>${group.events.map(event => `<section class="event-section"><div class="event-heading"><div><h3>${time(event.start)} – ${time(event.end)}</h3><span class="event-subtitle">${eventName(event)}${event.start.slice(0, 10) !== event.end.slice(0, 10) ? ` to ${event.end.slice(0, 10)}` : ''}</span></div><span class="event-total">${event.photos.filter(p => ids.has(p.id)).length} captures</span></div><div class="photo-grid" style="--thumb-size:${state.size}px">${(state.reverse ? [...event.photos].reverse() : event.photos).filter(p => ids.has(p.id)).map(card).join('')}</div></section>`).join('')}</section>`).join('');
}
function details() {
  const photo = selected();
  if (!photo) return `<aside class="details"><div class="details-title"><h2>Photo details</h2>${btn('X', 'Hide photo details', 'info')}</div><div class="details-empty">${icon('Camera', 34)}<p>A closer look at your capture.</p><span>Select a photo to see its camera settings and file details.</span></div><div class="details-tip">${icon('Info', 16)}<p>JPEG and RAW files with the same name appear as one capture.</p></div></aside>`;
  const file = currentFile(photo);
  const metadata = [['Camera', file.camera], ['Lens', file.lens], ['Taken', `${day(file.capturedAt)}<br>${time(file.capturedAt)}:${file.capturedAt.slice(17, 19)}`]];
  return `<aside class="details"><div class="details-title"><h2>${file.kind === 'video' ? 'Video' : 'Photo'} details</h2>${btn('X', 'Hide photo details', 'info')}</div><div class="detail-preview">${mediaMarkup(file, true)}</div><div class="detail-name"><h3>${escape(file.name)}</h3>${reviewStatus(photo) ? `<span class="detail-review ${reviewStatus(photo)}">${reviewStatus(photo) === 'accepted' ? 'Accepted' : 'Rejected'}</span>` : ''}<span>${sizeLabel(file.size)}${file.width && file.height ? ` <span class="dot-separator"></span> ${file.width} × ${file.height}` : ''}</span></div>
  ${photo.raw && photo.primary.kind === 'jpeg' ? `<div class="version-toggle" role="group" aria-label="File version"><button data-action="jpeg" class="${!state.raw ? 'selected' : ''}" aria-pressed="${!state.raw}">JPEG</button><button data-action="raw" class="${state.raw ? 'selected' : ''}" aria-pressed="${state.raw}">RAW</button><kbd>T</kbd></div>` : ''}
  ${file.kind === 'raw' ? '<div class="raw-note">Showing the camera’s embedded RAW preview.</div>' : ''}
  <div class="exposure-grid"><div><span>ISO</span><strong>${escape(file.iso ?? '—')}</strong></div><div><span>Aperture</span><strong>${file.aperture ? `ƒ/${escape(file.aperture)}` : '—'}</strong></div><div><span>Shutter</span><strong>${escape(file.shutter ?? '—')}</strong></div></div><dl class="metadata">${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${label === 'Taken' ? value : escape(value ?? 'Unavailable')}</dd></div>`).join('')}<div><dt>Format</dt><dd>${file.extension.toUpperCase()}${photo.files.length > 1 ? ` <span class="paired-label">${photo.files.length} paired files</span>` : ''}</dd></div><div><dt>Location</dt><dd class="file-path">${escape(file.relativePath)}</dd></div></dl>
  ${photoTags(photo)}${file.timestampSource === 'modified' ? '<p class="metadata-warning">Capture time unavailable. Grouped using the file’s modified time.</p>' : ''}${file.warning ? `<p class="metadata-warning">${escape(file.warning)}</p>` : ''}<div class="details-tip">${icon('Info', 16)}<p>Double-click a thumbnail to open the viewer. Use <kbd>←</kbd> / <kbd>→</kbd> to browse. Mark your selection with <kbd>S</kbd> to accept or <kbd>D</kbd> to reject.</p></div></aside>`;
}
function viewer() {
  const photo = selected();
  if (!photo) { state.full = false; return gallery(); }
  const file = currentFile(photo);
  const index = visible.findIndex(p => p.id === photo.id);
  return `<div class="viewer"><div class="viewer-toolbar"><div class="viewer-format">${file.extension.toUpperCase()}${reviewStatus(photo) ? `<span class="detail-review ${reviewStatus(photo)}">${reviewStatus(photo) === 'accepted' ? 'Accepted' : 'Rejected'}</span>` : ''}${file.kind === 'raw' ? '<span>Embedded preview</span>' : ''}</div><div class="viewer-tools">${photo.raw && photo.primary.kind === 'jpeg' ? `<button class="button compact" data-action="toggle-raw">${state.raw ? 'View JPEG' : 'View RAW'}<kbd>T</kbd></button>` : ''}${file.kind !== 'video' ? btn(state.zoom ? 'ZoomOut' : 'ZoomIn', state.zoom ? 'Fit to window' : 'Zoom photo', 'zoom', state.zoom) : ''}</div></div><div class="viewer-stage ${state.zoom ? 'zoomed' : ''}"><button class="viewer-nav previous" data-action="previous" aria-label="Previous capture" ${index <= 0 ? 'disabled' : ''}>${icon('ChevronLeft', 25)}</button><div class="full-media">${mediaMarkup(file, false)}</div><button class="viewer-nav next" data-action="next" aria-label="Next capture" ${index >= visible.length - 1 ? 'disabled' : ''}>${icon('ChevronRight', 25)}</button></div><div class="viewer-bottom"><span>${icon(file.kind === 'video' ? 'Film' : 'Camera', 15)}${escape(file.camera ?? file.extension.toUpperCase())}</span><span>${file.kind === 'video' ? 'Space to play / pause • ⌘ / Alt + ← / → to seek 5 seconds' : `${file.iso ? `ISO ${escape(file.iso)}` : ''}${file.aperture ? `　ƒ/${escape(file.aperture)}` : ''}${file.shutter ? `　${escape(file.shutter)}` : ''}`}</span><span>${time(file.capturedAt)}</span></div><div class="filmstrip">${visible.map(p => `<button class="filmstrip-item ${p.id === photo.id ? 'selected' : ''}" data-photo="${escape(p.id)}" aria-label="Open ${escape(p.primary.name)}">${mediaMarkup(currentFile(p), true)}</button>`).join('')}</div></div>`;
}
function help() {
  return `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="shortcut-title" class="shortcuts-modal"><div class="modal-title"><h2 id="shortcut-title">Make yourself at home.</h2>${btn('X', 'Close keyboard shortcuts', 'help')}</div><p>A few keys for a smoother review.</p><dl class="shortcut-list">${[['Next capture', '<kbd>→</kbd>'], ['Previous capture', '<kbd>←</kbd>'], ['Open selected photo', '<kbd>Enter</kbd>'], ['Back to thumbnails', '<kbd>Esc</kbd>'], ['Switch JPEG / RAW', '<kbd>T</kbd>'], ['Play / pause video', '<kbd>Space</kbd>'], ['Seek video 5 seconds', '<kbd>⌘ / Alt</kbd><kbd>← / →</kbd>'], ['Accept selection', '<kbd>S</kbd>'], ['Reject selection', '<kbd>D</kbd>'], ['Select all visible captures', '<kbd>⌘ / Ctrl</kbd><kbd>A</kbd>'], ['Show / hide details', '<kbd>I</kbd>'], ['Keyboard shortcuts', '<kbd>?</kbd>']].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl></section></div>`;
}
function exportPhotos() { return state.exportMode === 'accepted' ? acceptedPhotos() : selectedPhotos(); }
function exportDialog() {
  const photos = exportPhotos();
  const fileCount = photos.reduce((count, photo) => count + photo.files.length, 0);
  const result = state.exportResult;
  const toPhotos = state.exportTarget === 'photos';
  return `<div class="modal-backdrop export-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="export-title" class="export-modal"><div class="modal-title"><h2 id="export-title">Export originals</h2><button class="icon-button" data-action="close-export" aria-label="Close export" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}>${icon('X', 18)}</button></div><p>${toPhotos ? 'Import your captures into Photos on this Mac.' : 'Copy your captures to a folder on disk.'}</p>
  <fieldset class="export-options" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}><legend>Captures to export</legend><label><input type="radio" name="export-mode" value="selection" ${state.exportMode === 'selection' ? 'checked' : ''}>Selected captures<span>${state.selectedIds.size}</span></label><label><input type="radio" name="export-mode" value="accepted" ${state.exportMode === 'accepted' ? 'checked' : ''}>Accepted captures<span>${acceptedPhotos().length}</span></label></fieldset>
  ${state.photosAvailable ? `<fieldset class="export-targets" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}><legend>Destination</legend><label><input type="radio" name="export-target" value="folder" ${!toPhotos ? 'checked' : ''}>Folder</label><label><input type="radio" name="export-target" value="photos" ${toPhotos ? 'checked' : ''}>Photos (macOS)</label></fieldset>` : ''}
  ${!toPhotos ? `<div class="export-location"><span>Destination</span><div><strong title="${escape(state.exportLocation)}">${escape(state.exportLocation || 'Loading location…')}</strong><button class="button compact" data-action="choose-export-location" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}>${state.choosingLocation ? 'Choosing…' : 'Choose folder'}</button></div><small>This location is remembered for your next export.</small></div>` : `<div class="photos-destination">${icon('Image', 22)}<div><strong>Photos</strong><span>Imports into the current Photos library. macOS may ask for permission to control Photos.</span></div></div>`}
  <p class="export-note">${toPhotos ? 'JPEG + RAW pairs include both original files. Photos manages supported formats and duplicate checking. Keep the card connected until the import finishes.' : 'JPEG + RAW pairs include both original files. Existing files are kept; duplicate names receive a number.'}</p>
  ${state.exportBusy ? `<div class="export-progress" role="status"><progress value="${state.exportCopied}" max="${state.exportTotal || 1}"></progress><span>${state.exportCopied} of ${state.exportTotal} files ${toPhotos ? 'processed by Photos' : 'copied'}</span><small>${escape(state.exportCurrent)}</small></div>` : ''}
  ${result ? `<div class="export-result" role="status"><strong>${result.cancelled ? 'Export stopped.' : result.failures.length ? 'Export finished with errors.' : result.target === 'photos' ? 'Photos import complete.' : 'Export complete.'}</strong><span>${result.target === 'photos' ? `${result.copied} of ${result.total} original files processed by Photos. ${result.importedItems ?? 0} ${result.importedItems === 1 ? 'item' : 'items'} imported; duplicates may be skipped.` : `${result.copied} of ${result.total} files copied to ${escape(result.destination)}.`}</span>${result.failures.length ? `<ul>${result.failures.slice(0, 5).map(f => `<li>${escape(f.name)}: ${escape(f.message)}</li>`).join('')}</ul>${result.failures.length > 5 ? `<span>And ${result.failures.length - 5} more failures.</span>` : ''}` : ''}</div>` : ''}
  ${state.exportError ? `<p role="alert" class="export-error">${escape(state.exportError)}</p>` : ''}
  <div class="export-buttons">${state.exportBusy ? `<button class="button" data-action="cancel-export">Stop after current ${toPhotos ? 'batch' : 'file'}</button>` : `<span>${photos.length} ${photos.length === 1 ? 'capture' : 'captures'} / ${fileCount} ${fileCount === 1 ? 'file' : 'files'}</span><button class="button primary" data-action="start-export" ${!photos.length || (!toPhotos && !state.exportLocation) || state.choosingLocation ? 'disabled' : ''}>Export ${state.exportMode === 'accepted' ? 'accepted' : 'selection'}${toPhotos ? ' to Photos' : ''}</button>`}</div></section></div>`;
}
function refreshExportDialog() {
  const previousAction = (document.activeElement as HTMLElement | null)?.dataset.action;
  const previousRadio = ['export-mode', 'export-target'].includes((document.activeElement as HTMLInputElement | null)?.name ?? '') ? (document.activeElement as HTMLInputElement).value : '';
  const backdrop = root.querySelector('.export-backdrop');
  if (backdrop) backdrop.outerHTML = exportDialog();
  if (previousAction) root.querySelector<HTMLButtonElement>(`.export-modal [data-action="${previousAction}"]`)?.focus();
  else if (previousRadio) root.querySelector<HTMLInputElement>(`.export-modal input[value="${previousRadio}"]`)?.focus();
}
async function openExport() {
  if (state.demo || state.loading || !window.desktop) return;
  state.exportMode = state.selectedIds.size ? 'selection' : 'accepted'; state.exportTarget = 'folder'; state.exportResult = null; state.exportError = ''; state.exportOpen = true;
  render(); root.querySelector<HTMLButtonElement>('.export-modal [data-action="close-export"]')?.focus();
  try { const [location, capabilities] = await Promise.all([window.desktop.getExportLocation(), window.desktop.getExportCapabilities()]); state.exportLocation = location; state.photosAvailable = capabilities.photos; }
  catch { state.exportError = 'Unable to load the export location. Choose a folder to continue.'; }
  refreshExportDialog();
}
async function chooseExportLocation() {
  if (!window.desktop || state.exportBusy || state.choosingLocation) return;
  state.choosingLocation = true; state.exportError = ''; refreshExportDialog();
  try { const location = await window.desktop.chooseExportLocation(); if (location) state.exportLocation = location; }
  catch (error) { state.exportError = `Unable to remember this folder. ${String(error)}`; }
  finally { state.choosingLocation = false; refreshExportDialog(); }
}
async function startExport() {
  if (!window.desktop || state.exportBusy || state.choosingLocation) return;
  const ids = exportPhotos().flatMap(photo => photo.files.map(file => file.id));
  if (!ids.length) return;
  state.exportBusy = true; state.exportCopied = 0; state.exportTotal = ids.length; state.exportCurrent = ''; state.exportResult = null; state.exportError = ''; refreshExportDialog();
  try { state.exportResult = state.exportTarget === 'photos' ? await window.desktop.exportToPhotos(ids) : await window.desktop.exportFiles(ids); }
  catch (error) { state.exportError = `Export could not finish. ${String(error)}`; }
  finally { state.exportBusy = false; state.exportCurrent = ''; render(); }
}
function settingsDialog() {
  const status = state.ollama;
  return `<div class="modal-backdrop settings-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="settings-title" class="settings-modal"><div class="modal-title"><h2 id="settings-title">Settings</h2>${btn('X', 'Close settings', 'close-settings')}</div><section class="settings-section"><h3>Appearance</h3><label class="settings-row"><span>Theme<small>System follows your computer’s appearance.</small></span><select data-theme-switcher aria-label="Theme">${['system', 'light', 'dark'].map(value => `<option value="${value}" ${themePreference() === value ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label></section>
  <section class="settings-section"><h3>Photo tagging</h3><label class="settings-row"><span>Tag photos with Ollama<small>Uses the local ${status?.model ?? 'gemma4:e2b'} model. Defaults on when ready on macOS; off elsewhere.</small></span><input type="checkbox" role="switch" aria-label="Tag photos with Ollama" data-ollama-enabled ${status?.enabled ? 'checked' : ''} ${state.settingsChecking || state.settingsBusy || !status?.available ? 'disabled' : ''}></label>
  <p class="settings-note">When enabled, opened photo collections are tagged in the background. Resized previews are sent to Ollama on this computer. Originals stay untouched. Videos are skipped.</p>
  ${state.settingsChecking ? `<p class="settings-status" role="status">${icon('LoaderCircle', 15)}Checking availability…</p>` : status ? status.available ? `<p class="settings-status ready">${icon('Check', 15)}Ready${status.gpu ? ` · ${escape(status.gpu)}` : ''}</p>` : `<div class="settings-warning" role="alert">${icon('Info', 17)}<ul>${status.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></div>` : '<p class="settings-note">Open the desktop app to check Ollama and GPU availability.</p>'}
  <div class="settings-tag-actions"><button class="button compact" data-action="check-ollama" ${state.settingsChecking || state.settingsBusy ? 'disabled' : ''}>${icon('RefreshCw', 14)}Check again</button>${state.tagging ? '<button class="button compact" data-action="stop-tagging">Stop tagging</button>' : `<button class="button compact" data-action="retry-tagging" ${!status?.enabled || state.demo || !allPhotos.length || state.loading ? 'disabled' : ''}>Tag untagged photos</button>`}</div>
  ${state.tagging ? `<p role="status" class="settings-note">Tagging ${state.tagCompleted} of ${state.tagTotal} photos. You can close Settings while this runs.</p>` : ''}
  ${state.settingsError ? `<p role="alert" class="settings-error">${escape(state.settingsError)}</p>` : ''}</section><div class="settings-legal">© 2026 Juti Noppornpitak<small>Apache License 2.0</small></div></section></div>`;
}
let settingsPoll: ReturnType<typeof setInterval> | undefined;
function refreshSettings() {
  if (!state.settingsOpen) return;
  const previous = document.activeElement as HTMLElement | null;
  const action = previous?.dataset.action;
  const wasSwitch = previous?.matches('[data-ollama-enabled]');
  const wasTheme = previous?.matches('[data-theme-switcher]');
  const backdrop = root.querySelector('.settings-backdrop');
  if (backdrop) backdrop.outerHTML = settingsDialog();
  if (action) root.querySelector<HTMLButtonElement>(`.settings-modal [data-action="${action}"]`)?.focus();
  else if (wasSwitch) root.querySelector<HTMLInputElement>('.settings-modal [data-ollama-enabled]')?.focus();
  else if (wasTheme) root.querySelector<HTMLSelectElement>('.settings-modal [data-theme-switcher]')?.focus();
}
async function openSettings() {
  if (state.settingsOpen) return;
  state.settingsOpen = true;
  root.insertAdjacentHTML('beforeend', settingsDialog());
  root.querySelector<HTMLButtonElement>('.settings-modal [data-action="close-settings"]')?.focus();
  clearInterval(settingsPoll);
  settingsPoll = setInterval(() => { if (!state.settingsChecking && !state.settingsBusy) void checkOllama(); }, 15000);
  await checkOllama();
}
function closeSettings() {
  state.settingsOpen = false; clearInterval(settingsPoll); settingsPoll = undefined;
  root.querySelector('.settings-backdrop')?.remove();
  root.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
}
async function checkOllama() {
  if (!window.desktop || state.settingsChecking || state.settingsBusy) return;
  state.settingsChecking = true; state.settingsError = ''; refreshSettings();
  try {
    const wasEnabled = state.ollama?.enabled ?? false;
    state.ollama = await window.desktop.getOllamaStatus();
    if (state.ollama.enabled && !wasEnabled) void queueTagging();
  }
  catch { state.ollama = { model: 'gemma4:e2b', enabled: false, available: false, reasons: ['Ollama availability could not be checked. Try again.'] }; }
  finally { state.settingsChecking = false; refreshSettings(); }
}
async function toggleOllama(enabled: boolean) {
  if (!window.desktop || state.settingsBusy) return;
  state.settingsBusy = true; state.settingsError = ''; refreshSettings();
  try {
    state.ollama = await window.desktop.setOllamaEnabled(enabled);
    if (state.ollama.enabled) void queueTagging();
  } catch (error) { state.settingsError = String(error); }
  finally { state.settingsBusy = false; refreshSettings(); }
}
function photoTags(photo: Photo) {
  if (photo.primary.kind === 'video') return '';
  const values = tags.get(photo.id) ?? [];
  const error = tagErrors.get(photo.id);
  return `<section class="photo-tags"><h4>Tags${values.length ? '<span>Ollama</span>' : ''}</h4>${values.length ? `<div class="tag-list">${values.map(tag => `<span class="tag-chip">${escape(tag)}</span>`).join('')}</div>` : `<p>${error ? escape(error) : state.tagging ? 'Waiting for photo tags…' : 'No tags yet.'}</p>`}</section>`;
}
function updateTagUI() {
  const current = selected(); const panel = root.querySelector('.photo-tags');
  if (current && panel) panel.outerHTML = photoTags(current);
  const footer = root.querySelector('.library-status');
  if (footer) footer.innerHTML = state.tagging ? `<span class="spinner"></span> Tagging ${state.tagCompleted} of ${state.tagTotal} photos` : escape(state.tagSummary || `${visible.length} captures`);
}
async function loadTags() {
  if (!window.desktop || state.demo || state.loading) return;
  compute(); const epoch = tagEpoch;
  const photos = allPhotos.filter(photo => photo.primary.kind !== 'video');
  try {
    const [saved, status] = await Promise.all([window.desktop.getPhotoTags(photos.map(photo => photo.primary.id)), window.desktop.getOllamaStatus()]);
    if (epoch !== tagEpoch) return;
    state.ollama = status;
    for (const photo of photos) if (saved[photo.primary.id]) tags.set(photo.id, saved[photo.primary.id]);
    updateTagUI(); refreshSettings();
    if (status.enabled) await queueTagging();
  } catch { if (epoch === tagEpoch) { state.settingsError = 'Photo tags could not be loaded. Reopen the source or check Settings.'; refreshSettings(); } }
}
async function queueTagging() {
  if (!window.desktop || state.tagging || state.demo || state.loading || !state.ollama?.enabled) return;
  const photos = allPhotos.filter(photo => photo.primary.kind !== 'video' && !tags.has(photo.id));
  if (!photos.length) return;
  const epoch = tagEpoch; const jobId = crypto.randomUUID();
  state.tagJobId = jobId; state.tagging = true; state.tagCompleted = 0; state.tagTotal = photos.length; state.tagSummary = ''; state.settingsError = '';
  refreshSettings(); updateTagUI();
  try {
    const result = await window.desktop.tagPhotos(photos.map(photo => photo.primary.id), jobId);
    if (epoch !== tagEpoch || state.tagJobId !== jobId) return;
    state.tagSummary = result.cancelled ? 'Photo tagging stopped' : result.failures ? `${result.failures} photos could not be tagged` : `${result.completed} photos tagged`;
    if (result.failures) { state.ollama = await window.desktop.getOllamaStatus(); }
    if (result.failures) state.settingsError = 'Some photos could not be tagged. Select a photo to see its error, then retry after checking Ollama.';
  } catch (error) {
    if (epoch !== tagEpoch || state.tagJobId !== jobId) return;
    state.settingsError = String(error); state.tagSummary = 'Photo tagging could not finish';
    try {
    const wasEnabled = state.ollama?.enabled ?? false;
    state.ollama = await window.desktop.getOllamaStatus();
    if (state.ollama.enabled && !wasEnabled) void queueTagging();
  } catch { /* Keep the original error. */ }
  } finally {
    if (epoch === tagEpoch && state.tagJobId === jobId) {
      state.tagging = false; updateTagUI(); refreshSettings();
      if (state.search && !state.full) scheduleScanRender();
    }
  }
}

function render() {
  const galleryScroll = root.querySelector('.gallery-scroll')?.scrollTop ?? 0;
  const eventsScroll = root.querySelector('.events-list')?.scrollTop ?? 0;
  const detailsScroll = root.querySelector('.details')?.scrollTop ?? 0;
  const previousMedia = root.querySelector<HTMLVideoElement | HTMLImageElement>('.full-media .media-image');
  const focusedSearch = document.activeElement?.id === 'search';
  compute();
  root.innerHTML = `<div class="app-shell ${state.info ? '' : 'no-details'}">${sidebar()}<main>${toolbar()}${state.error ? `<div role="alert" class="error-banner">${icon('Info', 16)}<span>${escape(state.error)}</span><button class="small-icon" data-action="dismiss-error" aria-label="Dismiss error">${icon('X', 16)}</button></div>` : ''}<div class="selection-toolbar">${selectionToolbar()}</div><div class="workspace"><div class="gallery-scroll ${state.full ? 'viewer-container' : ''}">${state.full ? viewer() : gallery()}</div>${state.info ? details() : ''}</div><footer><span class="library-status" role="status">${state.tagging ? `<span class="spinner"></span> Tagging ${state.tagCompleted} of ${state.tagTotal} photos` : state.tagSummary || (state.loading ? `<span class="spinner"></span> Reading ${state.scanned} of ${state.total || '…'} files` : `${state.source ? `${visible.length} captures${state.skipped ? ` • ${state.skipped} unreadable files or folders` : ''}` : 'Ready when you are'}`)}</span><span>${state.demo ? 'Sample photos • illustrative metadata' : state.loading ? 'You can start reviewing while we read.' : 'Read-only review'}<span class="footer-divider"></span>${state.full ? '<kbd>Esc</kbd> Thumbnails' : 'Double-click to open'}<span class="footer-divider"></span><button data-action="help"><kbd>?</kbd> Shortcuts</button></span></footer></main></div>${state.help ? help() : ''}${state.exportOpen ? exportDialog() : ''}${state.settingsOpen ? settingsDialog() : ''}`;
  const nextMedia = root.querySelector<HTMLVideoElement | HTMLImageElement>('.full-media .media-image');
  if (previousMedia && nextMedia && previousMedia.getAttribute('src') === nextMedia.getAttribute('src')) nextMedia.replaceWith(previousMedia);
  const galleryElement = root.querySelector('.gallery-scroll');
  if (galleryElement) galleryElement.scrollTop = galleryScroll;
  const eventList = root.querySelector('.events-list');
  if (eventList) eventList.scrollTop = eventsScroll;
  const detailsElement = root.querySelector('.details');
  if (detailsElement) detailsElement.scrollTop = detailsScroll;
  if (focusedSearch) root.querySelector<HTMLInputElement>('#search')?.focus();
  bindMediaErrors();
  if (state.full) root.querySelector('.filmstrip-item.selected')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (state.help) root.querySelector<HTMLButtonElement>('.shortcuts-modal button')?.focus();
}
const boundMedia = new WeakSet<Element>();
function bindMediaErrors() {
  root.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video').forEach(media => {
    if (boundMedia.has(media)) return;
    boundMedia.add(media);
    media.addEventListener('error', () => {
      const container = media.parentElement!;
      if (container.querySelector('.media-error')) return;
      const full = container.classList.contains('full-media');
      const message = media.tagName === 'VIDEO' ? 'Video cannot play. Its codec may be unsupported, or the card is disconnected.' : 'Preview unavailable. Check the card connection or try the paired JPEG.';
      media.hidden = true;
      const fallback = document.createElement('div');
      fallback.className = 'media-error';
      fallback.innerHTML = `${icon(media.tagName === 'VIDEO' ? 'Film' : 'Image', full ? 36 : 24)}<span>${full ? message : 'Preview unavailable'}</span>${full ? '<button class="button" data-action="retry">Retry preview</button>' : ''}`;
      container.append(fallback);
    });
  });
}
async function loadSource(source: Source) {
  if (state.exportBusy) { state.error = 'Finish or cancel the export before opening another source.'; render(); return; }
  tagEpoch++; tags.clear(); tagErrors.clear(); state.tagJobId = ''; state.tagging = false; state.tagSummary = '';
  clearSelection();
  state.files = []; state.source = source; state.demo = false; state.selectedId = ''; state.eventId = ''; state.full = false;
  state.raw = false; state.loading = true; state.error = ''; state.scanned = 0; state.total = 0; state.skipped = 0; state.search = ''; state.filter = 'all';
  render();
  try { await window.desktop!.scan(source); } catch (error) { state.loading = false; state.error = `Unable to read this source. ${String(error)}`; render(); }
}
async function openFolder() {
  if (state.exportBusy) return;
  if (!window.desktop) { state.error = 'Folder access is available in the desktop app. Run npm start, or explore the sample collection here.'; render(); return; }
  try { const source = await window.desktop.chooseFolder(); if (source) await loadSource(source); }
  catch { state.error = 'Unable to open the folder. Check that the card is connected and try again.'; render(); }
}
function clearSelection() {
  state.selectedIds.clear(); state.selectedId = ''; state.anchorId = ''; state.raw = false;
}
function setSingle(id: string) {
  if (state.selectedId !== id) { state.raw = false; state.zoom = false; }
  state.selectedId = id; state.selectedIds = new Set([id]); state.anchorId = id;
}
function navigate(offset: number) {
  const index = visible.findIndex(p => p.id === state.selectedId);
  const next = visible[Math.max(0, Math.min(visible.length - 1, index + offset))];
  if (next) { setSingle(next.id); if (state.full) render(); else updateSelectionUI(); root.querySelector<HTMLElement>('.photo-card.is-selected')?.scrollIntoView({ block: 'nearest' }); }
}
function selectPhoto(id: string, open: boolean, event?: MouseEvent) {
  if (open) { setSingle(id); state.full = true; render(); return; }
  const result = clickSelection(visible.map(p => p.id), state.selectedIds, state.anchorId, id, { shift: event?.shiftKey, additive: event?.ctrlKey || event?.metaKey });
  state.selectedIds = result.ids; state.anchorId = result.anchor;
  state.selectedId = result.ids.has(id) ? id : [...result.ids].at(-1) ?? '';
  state.raw = false; state.zoom = false; updateSelectionUI();
}
function reviewBadge(photo: Photo) {
  const status = reviewStatus(photo);
  return status ? `<span class="review-badge ${status}" title="${status === 'accepted' ? 'Accepted' : 'Rejected'}" aria-label="${status === 'accepted' ? 'Accepted' : 'Rejected'}">${icon(status === 'accepted' ? 'Check' : 'X', 12)}</span>` : '';
}
function selectionToolbar() {
  if (!allPhotos.length) return '';
  const count = state.selectedIds.size;
  return `<span class="selection-summary">${count ? `${count} selected` : 'Click to select. Shift for a range. Cmd / Ctrl to add.'}</span><div class="selection-actions"><button data-action="accept" class="review-action accept" ${!count ? 'disabled' : ''}>${icon('Check', 14)}Accept<kbd>S</kbd></button><button data-action="reject" class="review-action reject" ${!count ? 'disabled' : ''}>${icon('X', 14)}Reject<kbd>D</kbd></button>${count ? '<button data-action="clear-review" class="review-action">Clear status</button><button data-action="clear-selection" class="review-action" aria-label="Deselect all captures">Deselect</button>' : ''}<span class="accepted-count">${acceptedPhotos().length} accepted</span></div>`;
}
function updateSelectionUI() {
  root.querySelectorAll<HTMLElement>('.photo-card').forEach(card => {
    const isSelected = state.selectedIds.has(card.dataset.photo!);
    card.classList.toggle('is-selected', isSelected); card.setAttribute('aria-pressed', String(isSelected));
    const photo = photoById.get(card.dataset.photo!);
    const image = card.querySelector<HTMLImageElement>('.thumbnail img.media-image');
    if (photo && image) { const file = currentFile(photo); if (image.getAttribute('src') !== url(file, true)) { image.src = url(file, true); image.alt = file.name; } }
    const indicator = card.querySelector('.review-indicator');
    if (photo && indicator) indicator.innerHTML = reviewBadge(photo);
  });
  const toolbar = root.querySelector('.selection-toolbar');
  if (toolbar) toolbar.innerHTML = selectionToolbar();
  const panel = root.querySelector('.details');
  if (panel) { const scroll = panel.scrollTop; panel.outerHTML = details(); const replacement = root.querySelector('.details'); if (replacement) replacement.scrollTop = scroll; }
  bindMediaErrors();
}
function markSelection(status?: ReviewStatus) {
  if (!state.selectedIds.size) return;
  const previous = { ...reviews };
  for (const photo of selectedPhotos()) { if (status) reviews[reviewKey(photo)] = status; else delete reviews[reviewKey(photo)]; }
  try { localStorage.setItem('ama-reviews-v1', JSON.stringify(reviews)); }
  catch { reviews = previous; state.error = 'Review decisions could not be saved. Free some local storage and try again.'; render(); return; }
  if (state.full) render(); else updateSelectionUI();
}
const actions: Record<string, () => void | Promise<void>> = {
  open: openFolder,
  all: () => { clearSelection(); state.eventId = ''; state.full = false; render(); },
  back: () => { state.full = false; state.zoom = false; render(); },
  info: () => { state.info = !state.info; render(); },
  help: () => { state.help = !state.help; render(); },
  settings: openSettings,
  'close-settings': closeSettings,
  'check-ollama': checkOllama,
  'retry-tagging': () => queueTagging(),
  'stop-tagging': async () => { await window.desktop?.cancelTagging(); },
  'dismiss-error': () => { state.error = ''; render(); },
  'refresh-sources': async () => { if (window.desktop) { state.sources = await window.desktop.listSources(); render(); } },
  cancel: async () => { await window.desktop?.cancelScan(); state.loading = false; render(); },
  demo: async () => { if (state.exportBusy) return; await window.desktop?.cancelScan(); await window.desktop?.cancelTagging(); tagEpoch++; tags.clear(); tagErrors.clear(); state.tagJobId = ''; state.tagging = false; state.tagSummary = ''; clearSelection(); Object.assign(state, { files: demoFiles, source: { name: 'A day in the mountains', path: '/demo' }, demo: true, loading: false, eventId: '', full: false, search: '', filter: 'all', error: '' }); render(); },
  'reset-filters': () => { clearSelection(); state.search = ''; state.filter = 'all'; render(); },
  jpeg: () => { state.raw = false; render(); }, raw: () => { state.raw = true; render(); },
  'toggle-raw': () => { const photo = selected(); if (photo?.raw && photo.primary.kind === 'jpeg') { state.raw = !state.raw; render(); } },
  sort: () => { state.reverse = !state.reverse; render(); }, zoom: () => { state.zoom = !state.zoom; render(); },
  previous: () => navigate(-1), next: () => navigate(1), retry: () => render(),
  accept: () => markSelection('accepted'), reject: () => markSelection('rejected'), 'clear-review': () => markSelection(),
  'clear-selection': () => { if (state.full) state.full = false; clearSelection(); render(); },
  export: openExport,
  'close-export': () => { if (!state.exportBusy && !state.choosingLocation) { state.exportOpen = false; render(); } },
  'choose-export-location': chooseExportLocation,
  'start-export': startExport,
  'cancel-export': async () => { await window.desktop?.cancelExport(); },
};
const marquee = installMarquee(root, {
  enabled: () => !state.full && !state.help && !state.exportOpen && !state.settingsOpen,
  selection: () => state.selectedIds,
  update: ids => {
    if (ids.size === state.selectedIds.size && [...ids].every(id => state.selectedIds.has(id))) return;
    state.selectedIds = ids; state.selectedId = [...ids].at(-1) ?? ''; state.anchorId = [...ids][0] ?? ''; state.raw = false;
    updateSelectionUI();
  },
});
root.addEventListener('click', event => {
  if (marquee.consumeClick()) { event.preventDefault(); return; }
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action) { void actions[action]?.(); return; }
  const photo = target.closest<HTMLElement>('[data-photo]');
  if (photo) { selectPhoto(photo.dataset.photo!, state.full, event); return; }
  const eventButton = target.closest<HTMLElement>('[data-event]');
  if (eventButton) { clearSelection(); state.eventId = eventButton.dataset.event!; state.full = false; render(); return; }
  const filter = target.closest<HTMLElement>('[data-filter]');
  if (filter) { clearSelection(); state.filter = filter.dataset.filter!; render(); return; }
  const source = target.closest<HTMLElement>('[data-source]');
  if (source) { const filtered = state.sources.filter(s => s.path !== state.source?.path); void loadSource(filtered[Number(source.dataset.source)]); return; }
  if (!state.full && target.closest('.gallery-scroll') && !event.shiftKey && !event.ctrlKey && !event.metaKey) { clearSelection(); updateSelectionUI(); }
});
// macOS delivers Control-click as a context-menu gesture instead of a click.
root.addEventListener('contextmenu', event => {
  const photo = (event.target as HTMLElement).closest<HTMLElement>('.photo-card');
  if (photo && event.ctrlKey && !state.full) { event.preventDefault(); selectPhoto(photo.dataset.photo!, false, event); }
});
root.addEventListener('dblclick', event => {
  const photo = (event.target as HTMLElement).closest<HTMLElement>('.photo-card');
  if (photo && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); selectPhoto(photo.dataset.photo!, true); }
});
root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'search') {
    const cursor = input.selectionStart;
    state.search = input.value; render();
    const replacement = root.querySelector<HTMLInputElement>('#search'); replacement?.focus();
    if (cursor !== null) { try { replacement?.setSelectionRange(cursor, cursor); } catch { /* Search inputs may not expose a selection. */ } }
  }
  if (input.id === 'thumbnail-size') {
    state.size = Number(input.value);
    root.querySelectorAll<HTMLElement>('.photo-grid').forEach(grid => grid.style.setProperty('--thumb-size', `${state.size}px`));
  }
});
document.addEventListener('keydown', event => {
  if (state.settingsOpen) {
    if (event.key === 'Escape') { event.preventDefault(); closeSettings(); return; }
    if (event.key === 'Tab') {
      const controls = [...root.querySelectorAll<HTMLElement>('.settings-modal button:not(:disabled), .settings-modal input:not(:disabled), .settings-modal select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if ((event.target as HTMLElement).matches('input:not([type=radio]), textarea, select')) return;
  if (state.exportOpen && event.key === 'Tab') {
    const controls = [...root.querySelectorAll<HTMLElement>('.export-modal button:not(:disabled), .export-modal input:not(:disabled)')].filter(element => !element.closest('fieldset:disabled'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (state.help) {
    if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); state.help = false; render(); }
    if (event.key === 'Tab') { event.preventDefault(); root.querySelector<HTMLButtonElement>('.shortcuts-modal button')?.focus(); }
    return;
  }
  const video = root.querySelector<HTMLVideoElement>('.full-media video');
  if (state.exportOpen) { if (event.key === 'Escape') { event.preventDefault(); void actions['close-export'](); } return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault(); state.selectedIds = new Set(visible.map(photo => photo.id)); state.selectedId ||= visible[0]?.id ?? ''; state.anchorId ||= state.selectedId;
    if (state.full) render(); else updateSelectionUI(); return;
  }
  if ((event.metaKey || event.altKey) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    if (state.full && video && video.readyState >= 1) {
      const target = video.currentTime + (event.key === 'ArrowRight' ? 5 : -5);
      video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : Infinity, target));
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigate(event.key === 'ArrowRight' ? 1 : -1); return; }
  if (state.full && video && event.key === ' ') {
    event.preventDefault();
    if (video.paused) void video.play().catch(() => { state.error = 'This video cannot play. Its codec may be unsupported.'; render(); }); else video.pause();
    return;
  }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); markSelection('accepted'); }
  if (event.key.toLowerCase() === 'd') { event.preventDefault(); markSelection('rejected'); }
  if (event.key.toLowerCase() === 't') { event.preventDefault(); void actions['toggle-raw'](); }
  if (event.key.toLowerCase() === 'i') { event.preventDefault(); void actions.info(); }
  if (event.key === '?') { event.preventDefault(); void actions.help(); }
  if (event.key === 'Escape' && state.full) void actions.back();
  if (event.key === 'Enter' && selected()) { event.preventDefault(); setSingle(state.selectedId); state.full = true; render(); }
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.matches('[data-theme-switcher]')) {
    void setThemePreference(input.value).catch(() => { state.error = 'The theme preference could not be saved. Try again.'; render(); });
  }
  if (input.matches('[data-ollama-enabled]')) void toggleOllama(input.checked);
  if (input.name === 'export-target' && !state.exportBusy && (input.value !== 'photos' || state.photosAvailable)) { state.exportTarget = input.value as 'folder' | 'photos'; state.exportResult = null; state.exportError = ''; refreshExportDialog(); }
  if (input.name === 'export-mode' && !state.exportBusy) { state.exportMode = input.value as 'selection' | 'accepted'; state.exportResult = null; refreshExportDialog(); }
});
window.desktop?.onTagProgress(progress => {
  if (progress.jobId !== state.tagJobId) return;
  state.tagCompleted = progress.completed; state.tagTotal = progress.total;
  const photo = allPhotos.find(photo => photo.primary.id === progress.id);
  if (photo) {
    if (progress.tags) { tags.set(photo.id, progress.tags); tagErrors.delete(photo.id); }
    else if (progress.error) tagErrors.set(photo.id, progress.error);
    else tagErrors.delete(photo.id);
  }
  updateTagUI();
});
window.desktop?.onExportProgress(progress => {
  state.exportCopied = progress.copied; state.exportTotal = progress.total; state.exportCurrent = progress.current;
  if (state.exportOpen) refreshExportDialog();
});
let progressRender: ReturnType<typeof setTimeout> | undefined;
function scheduleScanRender() {
  progressRender = undefined;
  if (marquee.active) { progressRender = setTimeout(scheduleScanRender, 180); return; }
  render();
}
window.desktop?.onProgress(progress => {
  if (state.demo || state.source?.path !== progress.source.path) return;
  state.files.push(...progress.files); state.scanned = progress.scanned; state.total = progress.total;
  state.loading = !progress.done; state.skipped = progress.skipped;
  if (progress.done) { clearTimeout(progressRender); progressRender = undefined; scheduleScanRender(); void loadTags(); }
  else if (!progressRender) progressRender = setTimeout(scheduleScanRender, 180);
});
render();
if (window.desktop) void window.desktop.listSources().then(sources => { state.sources = sources; render(); }).catch(() => {});
