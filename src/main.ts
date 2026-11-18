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
  eventGapMinutes: 30, gapDraft: '30', bookmarks: [] as Source[], bookmarkBusy: false, libraryReady: false,
  files: [] as MediaFile[], source: null as Source | null, sources: [] as Source[],
  selectedIds: new Set<string>(), anchorId: '', selectedId: '', eventId: '', filter: 'all', search: '', reviewFilter: 'all', labelFilters: [] as string[], labelOpen: false, labelActive: -1, full: false, raw: false,
  info: true, loading: false, scanned: 0, total: 0, skipped: 0, demo: false,
  cacheWarnings: [] as string[], runtimeErrors: [] as string[], size: 240, reverse: false, zoom: false, help: false, about: false, error: '',
  exportOpen: false, exportMode: 'selection' as 'selection' | 'accepted' | 'event', exportEventId: '', exportLocation: '',
  exportBusy: false, exportCopied: 0, exportTotal: 0, exportCurrent: '', exportResult: null as ExportResult | null,
  exportError: '', choosingLocation: false, exportTarget: 'folder' as 'folder' | 'photos', photosAvailable: false,
  settingsOpen: false, settingsChecking: false, settingsBusy: false, settingsError: '', ollama: null as OllamaStatus | null,
  tagConfirmation: null as TagAction | null, tagConfirmationEpoch: 0, tagApprovedEpoch: -1, tagDeclinedEpoch: -1, tagDeferred: false, tagStopping: false,
  summaryActive: false, summaryCompleted: 0, summaryTotal: 0, summaryCancelled: false, tagging: false, tagJobId: '', tagCompleted: 0, tagTotal: 0, tagSummary: '',
};
let allPhotos: Photo[] = [];
let events: PhotoEvent[] = [];
let visible: Photo[] = [];
let photoById = new Map<string, Photo>();
let tagEpoch = 0;
const tags = new Map<string, string[]>();
const tagErrors = new Map<string, string>();
const eventSummaries = new Map<string, string>();
const eventSummaryErrors = new Map<string, string>();
function resetEventSummaries() { eventSummaries.clear(); eventSummaryErrors.clear(); state.summaryActive = false; state.summaryCompleted = 0; state.summaryTotal = 0; state.summaryCancelled = false; }
function pendingSummaryEvents() { return events.filter(event => event.photos.some(photo => photo.primary.kind !== 'video') && !eventSummaries.has(event.id)); }
function eventSummaryMarkup(event: PhotoEvent) { const summary = eventSummaries.get(event.id); return summary ? `<small class="event-summary" title="${escape(summary)}">${escape(summary.replace(/-/g, ' '))}</small>` : ''; }
function updateEventSummaryUI() {
  const sidebarNodes = new Map([...root.querySelectorAll<HTMLElement>('[data-event]')].map(element => [element.dataset.event, element]));
  const galleryNodes = new Map([...root.querySelectorAll<HTMLElement>('[data-event-section]')].map(element => [element.dataset.eventSection, element]));
  for (const event of events) {
    const sidebar = sidebarNodes.get(event.id)?.querySelector('strong')?.parentElement;
    const gallery = galleryNodes.get(event.id)?.querySelector('.event-heading>div');
    for (const parent of [sidebar, gallery]) if (parent) { parent.querySelector('.event-summary')?.remove(); parent.insertAdjacentHTML('beforeend', eventSummaryMarkup(event)); }
  }
  updateActivityUI();
}
const reviewEdits = new Map<string, ReviewStatus | null>();
let reviews: Record<string, ReviewStatus> = {};
try {
  const saved: unknown = JSON.parse(localStorage.getItem('photo-proofer-demo-reviews') ?? '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    reviews = Object.fromEntries(Object.entries(saved).filter(([, value]) => value === 'accepted' || value === 'rejected'));
  }
} catch { /* First launch or unavailable storage. */ }
const reviewKey = (photo: Photo) => `${photo.primary.directory}/${photo.primary.kind === 'jpeg' || photo.primary.kind === 'raw' ? photo.primary.stem.toLowerCase() : photo.primary.name}|${photo.primary.capturedAt.slice(0, 19)}`;
const reviewStatus = (photo: Photo) => reviews[reviewKey(photo)];
const acceptedPhotos = () => allPhotos.filter(photo => reviewStatus(photo) === 'accepted');
const selectedPhotos = () => allPhotos.filter(photo => state.selectedIds.has(photo.id));
const errorMessage = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function errorNotices() {
  const messages = [...new Set([state.error, ...state.runtimeErrors].filter(Boolean))];
  return messages.length ? `<div role="alert" class="error-banner">${icon('Info', 16)}<div class="error-messages">${messages.map(message => `<p>${escape(message)}</p>`).join('')}</div><button class="small-icon" data-action="dismiss-error" aria-label="Dismiss error">${icon('X', 16)}</button></div>` : '';
}
function reportError(context: string, error: unknown) {
  const message = `${context} ${errorMessage(error)}`.trim();
  if (!state.runtimeErrors.includes(message)) state.runtimeErrors.push(message);
  const notices = root.querySelector('.error-notices');
  if (notices) notices.innerHTML = errorNotices();
}
window.addEventListener('unhandledrejection', event => { reportError('The operation could not finish.', event.reason); });
window.addEventListener('error', event => { if (event.message) reportError('An unexpected error occurred.', event.error ?? event.message); });
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
  events = groupEvents(allPhotos, state.eventGapMinutes);
  const event = events.find(e => e.id === state.eventId);
  visible = (event ? event.photos : allPhotos).filter(p => {
    const file = p.primary;
    return (state.filter === 'all' || (state.filter === 'video' ? file.kind === 'video' : file.kind !== 'video')) &&
      (state.reviewFilter === 'all' || (state.reviewFilter === 'unreviewed' ? !reviewStatus(p) : reviewStatus(p) === state.reviewFilter)) &&
      state.labelFilters.every(label => (tags.get(p.id) ?? []).includes(label)) &&
      (!state.search || p.files.some(f => `${f.name} ${f.camera ?? ''} ${f.lens ?? ''} ${(tags.get(p.id) ?? []).join(' ')}`.toLowerCase().includes(state.search.toLowerCase())));
  });
  if (state.reverse) visible.reverse();
  const visibleIds = new Set(visible.map(photo => photo.id));
  state.selectedIds = new Set([...state.selectedIds].filter(id => visibleIds.has(id)));
  if (!visibleIds.has(state.selectedId)) state.selectedId = [...state.selectedIds].at(-1) ?? '';
  if (state.full && !state.selectedId) state.full = false;
}
function sidebar() {
  return `<aside class="sidebar"><div class="sidebar-content"><div class="brand"><img class="brand-logo" src="${import.meta.env.BASE_URL}logo.svg" alt=""><span class="brand-name">Photo Proofer</span></div>
  <div class="side-section"><div class="section-label">Workspace</div><button class="side-link ${!state.eventId ? 'selected' : ''}" data-action="all">${icon('LayoutGrid')}<span>All captures</span><span class="count">${allPhotos.length || '—'}</span></button></div>
  <div class="side-section"><div class="section-label">Sources<button class="small-icon" data-action="refresh-sources" aria-label="Refresh memory cards" title="Refresh memory cards">${icon('RefreshCw', 13)}</button></div>
  ${state.source ? `<div class="source-item">${icon(state.demo ? 'Folder' : 'HardDrive', 20)}<div><strong>${escape(state.source.name)}</strong><span>${state.demo ? 'Sample collection' : 'Opened for review'}</span></div><span class="source-dot"></span>${!state.demo ? `<button class="small-icon bookmark-button ${state.bookmarks.some(source => source.path === state.source!.path) ? 'active' : ''}" data-action="bookmark" aria-label="${state.bookmarks.some(source => source.path === state.source!.path) ? 'Remove bookmark for this location' : 'Bookmark this location'}" aria-pressed="${state.bookmarks.some(source => source.path === state.source!.path)}" ${state.bookmarkBusy ? 'disabled' : ''}>${icon('Bookmark', 16)}</button>` : ''}</div>` : `<div class="no-source">No card opened</div>`}
  ${state.sources.filter(s => s.path !== state.source?.path).map((s, index) => `<button class="side-link" data-source="${index}">${icon('HardDrive')}<span>${escape(s.name)}</span></button>`).join('')}
  <button class="source-open" data-action="open">${icon('FolderOpen', 16)}Open a card or folder</button>${state.source && !state.demo ? `<button class="source-open" data-action="reindex" ${state.loading || state.exportBusy ? 'disabled' : ''}>${icon('RefreshCw', 16)}Reindex &amp; rerun AI</button>` : ''}</div>
  ${state.bookmarks.length ? `<div class="side-section bookmarks-nav"><div class="section-label">Bookmarks</div>${state.bookmarks.map((source, index) => `<div class="bookmark-row"><button class="side-link" data-bookmark="${index}" title="${escape(source.path)}">${icon('Bookmark', 16)}<span>${escape(source.name)}</span></button><button class="small-icon" data-remove-bookmark="${index}" aria-label="Remove bookmark ${escape(source.name)}" ${state.bookmarkBusy ? 'disabled' : ''}>${icon('X', 13)}</button></div>`).join('')}</div>` : ''}
  <div class="side-section events-nav"><div class="section-label">Events <span>${events.length || ''}</span></div><div class="events-list">
  ${events.length ? groupEventsByDate(events).map(group => `<section class="event-date-group"><h3>${group.date}</h3>${group.events.map(event => `<button class="event-link ${state.eventId === event.id ? 'selected' : ''}" data-event="${escape(event.id)}"><span class="event-marker">${icon(localDate(event.start).getHours() < 17 ? 'Sun' : 'Moon', 15)}</span><span><strong>${time(event.start)} – ${time(event.end)}</strong>${event.start.slice(0, 10) !== event.end.slice(0, 10) ? `<small>to ${event.end.slice(0, 10)}</small>` : ''}${eventSummaryMarkup(event)}</span><span class="count">${event.photos.length}</span></button>`).join('')}</section>`).join('') : `<p class="side-hint">Your shoots, organized by date and time. A gap over ${state.eventGapMinutes} minutes starts a new event.</p>`}</div></div>
  </div><div class="sidebar-bottom"><button class="settings-button" data-action="settings">${icon('Settings2', 17)}Settings</button><button class="help-button" data-action="help">${icon('Keyboard', 17)}Keyboard shortcuts<span>?</span></button><button class="help-button" data-action="about">${icon('Info', 17)}About Photo Proofer</button></div></aside>`;
}
function toolbar() {
  const event = events.find(e => e.id === state.eventId);
  return `<div class="titlebar"><span>${state.full ? 'Photo viewer' : 'Memory card workspace'}</span><span class="local-status"><span></span>Local workspace</span></div>
  <header class="page-header"><div>${state.full ? `<button class="back-button" data-action="back">${icon('ArrowLeft', 16)}All thumbnails</button>` : `<div class="breadcrumb">Library ${icon('ChevronRight', 12)} ${escape(state.source?.name ?? 'Getting started')}</div>`}<h1>${state.full ? escape(selected() ? currentFile(selected()!).name : '') : event ? `${event.start.slice(0, 10)} ${time(event.start)}` : 'All captures'}${state.demo ? '<span class="demo-tag">Demo</span>' : ''}</h1><p>${state.full ? `${Math.max(0, visible.findIndex(p => p.id === state.selectedId) + 1)} of ${visible.length} captures` : allPhotos.length ? `${allPhotos.length} captures${state.files.length !== allPhotos.length ? ` from ${state.files.length} files` : ''} in ${events.length} events` : 'A little space to see what you captured.'}</p></div>
  <div class="header-actions">${state.loading ? `<button class="button" data-action="cancel">${icon('X', 15)}Stop scan</button>` : ''}${btn('Info', 'Toggle photo details', 'info', state.info)}<button class="button primary" data-action="open" ${state.exportBusy ? 'disabled' : ''}>${icon('FolderOpen', 16)}Open folder</button>${allPhotos.length ? `<button class="button" data-action="export" ${state.demo ? 'disabled title="Export is available for your own files"' : state.loading ? 'disabled title="Finish scanning before exporting"' : ''}>${icon('ArrowUpRight', 16)}Export</button>` : ''}</div></header>
  ${!state.full && allPhotos.length ? `<div class="toolbar"><div class="tabs" role="group" aria-label="Media type">${[['all', 'All media'], ['photo', 'Photos'], ['video', 'Videos']].map(([value, label]) => `<button class="tab ${state.filter === value ? 'selected' : ''}" data-filter="${value}" aria-pressed="${state.filter === value}">${value === 'video' ? icon('Film', 14) : value === 'photo' ? icon('Image', 14) : ''}${label}</button>`).join('')}</div>
  <div class="view-tools">${captureSearch()}<button class="sort-button" data-action="sort" title="Reverse capture order">${state.reverse ? 'Newest first' : 'Oldest first'}${icon('ChevronDown', 14)}</button><div class="size-control">${icon('Grid2X2', 15)}<input id="thumbnail-size" type="range" min="160" max="360" value="${state.size}" aria-label="Thumbnail size"></div></div></div>${captureFilters()}` : ''}`;
}
function labelSuggestions() {
  const counts = new Map<string, number>();
  for (const photo of allPhotos) for (const label of new Set(tags.get(photo.id) ?? [])) counts.set(label, (counts.get(label) ?? 0) + 1);
  const query = state.search.trim().toLowerCase();
  return [...counts].filter(([label]) => !state.labelFilters.includes(label) && label.toLowerCase().includes(query)).sort(([a], [b]) => a.localeCompare(b)).slice(0, 50);
}
function labelOptions() {
  const suggestions = labelSuggestions();
  return suggestions.length ? suggestions.map(([label, count], index) => `<button type="button" role="option" tabindex="-1" id="label-option-${index}" data-label="${escape(label)}" aria-selected="${state.labelActive === index}"><span>${escape(label)}</span><small>${count}</small></button>`).join('') : '<p class="label-empty" role="status">Search filenames, cameras, lenses, or choose a label.</p>';
}
function captureSearch() {
  return `<div class="capture-search-controls"><label class="review-filter">Review status<select id="review-filter" aria-label="Filter by review status" class="${state.reviewFilter !== 'all' ? 'is-filtered' : ''}">${[['all', 'All statuses'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['unreviewed', 'Unreviewed']].map(([value, name]) => `<option value="${value}" ${state.reviewFilter === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label><div class="capture-search"><label class="search">${icon('Search', 15)}<input id="search" type="search" role="combobox" aria-label="Find a capture" placeholder="Find a capture…" aria-autocomplete="list" aria-expanded="${state.labelOpen}" aria-controls="label-options" ${state.labelActive >= 0 ? `aria-activedescendant="label-option-${state.labelActive}"` : ''} autocomplete="off" value="${escape(state.search)}"></label><div id="label-options" role="listbox" aria-label="Label suggestions" ${state.labelOpen ? '' : 'hidden'}>${labelOptions()}</div></div></div>`;
}
function captureFilters() {
  if (!state.labelFilters.length && state.reviewFilter === 'all' && !state.search && state.filter === 'all') return '';
  return `<div class="capture-filters">${state.labelFilters.length ? `<div class="label-filter-chips" aria-label="Selected label filters">${state.labelFilters.map(label => `<button class="label-filter-chip" data-remove-label="${escape(label)}" aria-label="Remove label filter ${escape(label)}">${escape(label)}${icon('X', 12)}</button>`).join('')}<small>Match all selected labels</small></div>` : ''}<span class="filter-result-count" role="status">${visible.length} of ${allPhotos.length} captures</span>${state.reviewFilter !== 'all' || state.labelFilters.length || state.search || state.filter !== 'all' ? '<button class="clear-filters" data-action="reset-filters">Clear filters</button>' : ''}</div>`;
}
function refreshLabelSuggestions() {
  const input = root.querySelector<HTMLInputElement>('#search');
  const list = root.querySelector<HTMLElement>('#label-options');
  if (!input || !list) return;
  if (state.labelActive >= labelSuggestions().length) state.labelActive = -1;
  input.setAttribute('aria-expanded', String(state.labelOpen));
  if (state.labelActive >= 0) input.setAttribute('aria-activedescendant', `label-option-${state.labelActive}`); else input.removeAttribute('aria-activedescendant');
  list.hidden = !state.labelOpen; list.innerHTML = labelOptions();
  if (state.labelActive >= 0) list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
function addLabelFilter(label: string) {
  if (!labelSuggestions().some(([value]) => value === label)) return;
  state.labelFilters.push(label); state.search = ''; state.labelActive = -1; state.labelOpen = false;
  render(); root.querySelector<HTMLInputElement>('#search')?.focus();
  state.labelOpen = false; refreshLabelSuggestions();
}
function mediaMarkup(file: MediaFile, thumb: boolean) {
  if (file.kind === 'video') return `<video class="media-image ${thumb ? 'video-thumbnail' : ''}" src="${url(file)}" ${thumb ? 'preload="metadata" muted' : 'controls preload="metadata"'} aria-label="${escape(file.name)}"></video>${thumb ? `<span class="video-badge">${icon('Play', 12)}${file.duration ? `${Math.floor(file.duration / 60)}:${String(Math.floor(file.duration % 60)).padStart(2, '0')}` : 'Video'}</span>` : ''}`;
  return `<img class="media-image" src="${url(file, thumb)}" alt="${escape(file.name)}" ${thumb ? 'loading="lazy"' : ''} draggable="false">`;
}
function card(photo: Photo) {
  const file = currentFile(photo);
  return `<button class="photo-card ${state.selectedIds.has(photo.id) ? 'is-selected' : ''} ${reviewStatus(photo) === 'rejected' ? 'is-rejected' : ''}" data-photo="${escape(photo.id)}" aria-label="${escape(file.name)}, ${time(file.capturedAt)}. Double-click to open." aria-pressed="${state.selectedIds.has(photo.id)}"><div class="thumbnail">${mediaMarkup(file, true)}<span class="review-indicator">${reviewBadge(photo)}</span>${photo.raw && photo.primary.kind === 'jpeg' ? `<span class="format-badge">JPEG + RAW</span>` : file.kind === 'raw' ? `<span class="format-badge">RAW</span>` : ''}</div><div class="photo-caption"><strong>${escape(file.stem)}</strong><span>${time(file.capturedAt)}</span></div><div class="photo-meta"><span>${escape(file.camera ?? (file.kind === 'video' ? 'Video' : 'Photo'))}</span><span>${file.kind === 'video' ? file.extension.toUpperCase() : file.aperture ? `ƒ/${escape(file.aperture)}` : file.extension.toUpperCase()}</span></div></button>`;
}
function empty() {
  return `<div class="welcome"><div class="welcome-visual"><div class="frame-back"></div><div class="frame-front"><img class="welcome-logo" src="${import.meta.env.BASE_URL}logo.svg" alt=""><span>A fresh perspective.</span></div><div class="card-chip">${icon('HardDrive', 25)}</div></div><h2>Your next shoot starts here.</h2><p>Open a memory card or photo folder.<br>We’ll bring your captures together, one event at a time.</p><button class="button primary large" data-action="open">${icon('FolderOpen', 18)}Open a card or folder</button><button class="demo-button" data-action="demo">Explore a sample collection ${icon('ArrowUpRight', 14)}</button><div class="welcome-features"><span>${icon('Image', 16)}JPEG + RAW, together</span><span>${icon('Clock3', 16)}Events organized for you</span><span>${icon('Film', 16)}Video in the same view</span></div></div>`;
}
function gallery() {
  if (!allPhotos.length) return state.loading ? `<div class="empty-results">${icon('LoaderCircle', 32)}<h2>Reading your card…</h2><p>Looking for photos and videos. Originals stay untouched.</p></div>` : state.source ? `<div class="empty-results">${icon('FolderOpen', 40)}<h2>No captures found</h2><p>Choose a folder containing photos, RAW files, or videos.</p><button class="button primary" data-action="open">Open another folder</button></div>` : empty();
  if (!visible.length) return `<div class="empty-results">${icon('Search', 34)}<h2>No matching captures</h2><p>Try another search, review status, label, or media type.</p><button class="button" data-action="reset-filters">Show all captures</button></div>`;
  const ids = new Set(visible.map(p => p.id));
  const shownEvents = (state.reverse ? [...events].reverse() : events).filter(e => e.photos.some(p => ids.has(p.id)));
  return groupEventsByDate(shownEvents).map(group => `<section class="capture-date"><h2>${group.date}</h2>${group.events.map(event => `<section class="event-section" data-event-section="${escape(event.id)}"><div class="event-heading"><div><h3>${time(event.start)} – ${time(event.end)}</h3><span class="event-subtitle">${eventName(event)}${event.start.slice(0, 10) !== event.end.slice(0, 10) ? ` to ${event.end.slice(0, 10)}` : ''}</span>${eventSummaryMarkup(event)}</div><span class="event-total">${event.photos.filter(p => ids.has(p.id)).length} captures</span></div><div class="photo-grid" style="--thumb-size:${state.size}px">${(state.reverse ? [...event.photos].reverse() : event.photos).filter(p => ids.has(p.id)).map(card).join('')}</div></section>`).join('')}</section>`).join('');
}
function details() {
  const photo = selected();
  if (!photo) return `<aside class="details"><div class="details-title"><h2>Photo details</h2>${btn('X', 'Hide photo details', 'info')}</div><div class="details-empty">${icon('Camera', 34)}<p>A closer look at your capture.</p><span>Select a photo to see its camera settings and file details.</span></div><div class="details-tip">${icon('Info', 16)}<p>JPEG and RAW files with the same name appear as one capture.</p></div></aside>`;
  const file = currentFile(photo);
  const metadata = [['Camera', file.camera], ['Lens', file.lens], ['Taken', `${day(file.capturedAt)}<br>${time(file.capturedAt)}:${file.capturedAt.slice(17, 19)}`]];
  return `<aside class="details"><div class="details-title"><h2>${file.kind === 'video' ? 'Video' : 'Photo'} details</h2>${btn('X', 'Hide photo details', 'info')}</div><div class="detail-preview ${reviewStatus(photo) === 'rejected' ? 'is-rejected' : ''}">${mediaMarkup(file, true)}</div><div class="detail-name"><h3>${escape(file.name)}</h3>${reviewStatus(photo) ? `<span class="detail-review ${reviewStatus(photo)}">${reviewStatus(photo) === 'accepted' ? 'Accepted' : 'Rejected'}</span>` : ''}<span>${sizeLabel(file.size)}${file.width && file.height ? ` <span class="dot-separator"></span> ${file.width} × ${file.height}` : ''}</span></div>
  ${photo.raw && photo.primary.kind === 'jpeg' ? `<div class="version-toggle" role="group" aria-label="File version"><button data-action="jpeg" class="${!state.raw ? 'selected' : ''}" aria-pressed="${!state.raw}">JPEG</button><button data-action="raw" class="${state.raw ? 'selected' : ''}" aria-pressed="${state.raw}">RAW</button><kbd>T</kbd></div>` : ''}
  ${file.kind === 'raw' ? '<div class="raw-note">Showing the camera’s embedded RAW preview.</div>' : ''}
  <div class="exposure-grid"><div><span>ISO</span><strong>${escape(file.iso ?? '—')}</strong></div><div><span>Aperture</span><strong>${file.aperture ? `ƒ/${escape(file.aperture)}` : '—'}</strong></div><div><span>Shutter</span><strong>${escape(file.shutter ?? '—')}</strong></div></div><dl class="metadata">${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${label === 'Taken' ? value : escape(value ?? 'Unavailable')}</dd></div>`).join('')}<div><dt>Format</dt><dd>${file.extension.toUpperCase()}${photo.files.length > 1 ? ` <span class="paired-label">${photo.files.length} paired files</span>` : ''}</dd></div><div><dt>Location</dt><dd class="file-path">${escape(file.relativePath)}</dd></div></dl>
  ${photoTags(photo)}${file.timestampSource === 'modified' ? '<p class="metadata-warning">Capture time unavailable. Grouped using the file’s modified time.</p>' : ''}${file.warning ? `<p class="metadata-warning">${escape(file.warning)}</p>` : ''}<div class="details-tip">${icon('Info', 16)}<p>Double-click a thumbnail to open the viewer. Use <kbd>←</kbd> / <kbd>→</kbd> to browse. Mark your selection with <kbd>A</kbd> to accept, <kbd>D</kbd> to reject, or <kbd>S</kbd> to clear status.</p></div></aside>`;
}
function viewer() {
  const photo = selected();
  if (!photo) { state.full = false; return gallery(); }
  const file = currentFile(photo);
  const index = visible.findIndex(p => p.id === photo.id);
  const eventPhotoIds = new Set(events.find(event => event.photos.some(item => item.id === photo.id))?.photos.map(item => item.id) ?? [photo.id]);
  const stripPhotos = visible.filter(item => eventPhotoIds.has(item.id));
  return `<div class="viewer"><div class="viewer-toolbar"><div class="viewer-format">${file.extension.toUpperCase()}${reviewStatus(photo) ? `<span class="detail-review ${reviewStatus(photo)}">${reviewStatus(photo) === 'accepted' ? 'Accepted' : 'Rejected'}</span>` : ''}${file.kind === 'raw' ? '<span>Embedded preview</span>' : ''}</div><div class="viewer-tools">${photo.raw && photo.primary.kind === 'jpeg' ? `<button class="button compact" data-action="toggle-raw">${state.raw ? 'View JPEG' : 'View RAW'}<kbd>T</kbd></button>` : ''}${file.kind !== 'video' ? btn(state.zoom ? 'ZoomOut' : 'ZoomIn', state.zoom ? 'Fit to window' : 'Zoom photo', 'zoom', state.zoom) : ''}</div></div><div class="viewer-stage ${state.zoom ? 'zoomed' : ''}"><button class="viewer-nav previous" data-action="previous" aria-label="Previous capture" ${index <= 0 ? 'disabled' : ''}>${icon('ChevronLeft', 25)}</button><div class="full-media ${reviewStatus(photo) === 'rejected' ? 'is-rejected' : ''}">${mediaMarkup(file, false)}</div><button class="viewer-nav next" data-action="next" aria-label="Next capture" ${index >= visible.length - 1 ? 'disabled' : ''}>${icon('ChevronRight', 25)}</button></div><div class="viewer-bottom"><span>${icon(file.kind === 'video' ? 'Film' : 'Camera', 15)}${escape(file.camera ?? file.extension.toUpperCase())}</span><span>${file.kind === 'video' ? 'Space to play / pause • ⌘ / Alt + ← / → to seek 5 seconds' : `${file.iso ? `ISO ${escape(file.iso)}` : ''}${file.aperture ? `　ƒ/${escape(file.aperture)}` : ''}${file.shutter ? `　${escape(file.shutter)}` : ''}`}</span><span>${time(file.capturedAt)}</span></div><div class="filmstrip" role="group" aria-label="Photos in this event">${stripPhotos.map(p => `<button class="filmstrip-item ${p.id === photo.id ? 'selected' : ''} ${reviewStatus(p) === 'rejected' ? 'is-rejected' : ''}" data-photo="${escape(p.id)}" aria-label="Open ${escape(p.primary.name)}${reviewStatus(p) ? `, ${reviewStatus(p)}` : ''}" aria-pressed="${p.id === photo.id}">${mediaMarkup(currentFile(p), true)}${reviewBadge(p)}</button>`).join('')}</div></div>`;
}
function help() {
  return `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="shortcut-title" class="shortcuts-modal"><div class="modal-title"><h2 id="shortcut-title">Make yourself at home.</h2>${btn('X', 'Close keyboard shortcuts', 'help')}</div><p>A few keys for a smoother review.</p><dl class="shortcut-list">${[['Next capture', '<kbd>→</kbd>'], ['Previous capture', '<kbd>←</kbd>'], ['Open selected photo', '<kbd>Enter</kbd>'], ['Back to thumbnails', '<kbd>Esc</kbd>'], ['Switch JPEG / RAW', '<kbd>T</kbd>'], ['Play / pause video', '<kbd>Space</kbd>'], ['Seek video 5 seconds', '<kbd>⌘ / Alt</kbd><kbd>← / →</kbd>'], ['Accept selection', '<kbd>A</kbd>'], ['Reject selection', '<kbd>D</kbd>'], ['Clear review status', '<kbd>S</kbd>'], ['Select all visible captures', '<kbd>⌘ / Ctrl</kbd><kbd>A</kbd>'], ['Show / hide details', '<kbd>I</kbd>'], ['Keyboard shortcuts', '<kbd>?</kbd>']].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl></section></div>`;
}
function exportPhotos() { return state.exportMode === 'event' ? events.find(event => event.id === state.exportEventId)?.photos ?? [] : state.exportMode === 'accepted' ? acceptedPhotos() : selectedPhotos(); }
function exportDialog() {
  const photos = exportPhotos();
  const fileCount = photos.reduce((count, photo) => count + photo.files.length, 0);
  const result = state.exportResult;
  const toPhotos = state.exportTarget === 'photos';
  const eventFolders = state.exportMode !== 'selection';
  return `<div class="modal-backdrop export-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="export-title" class="export-modal"><div class="modal-title"><h2 id="export-title">Export originals</h2><button class="icon-button" data-action="close-export" aria-label="Close export" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}>${icon('X', 18)}</button></div><p>${toPhotos ? 'Import originals into event albums on this Mac, carrying labels as Photos keywords.' : eventFolders ? 'Copy originals into event folders, with metadata JSON beside them.' : 'Copy selected originals directly into the destination, with metadata JSON beside them.'}</p>
  <fieldset class="export-options" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}><legend>Captures to export</legend><label><input type="radio" name="export-mode" value="selection" ${state.exportMode === 'selection' ? 'checked' : ''}>Selected captures<span>${state.selectedIds.size}</span></label><label><input type="radio" name="export-mode" value="accepted" ${state.exportMode === 'accepted' ? 'checked' : ''}>Accepted captures<span>${acceptedPhotos().length}</span></label><label><input type="radio" name="export-mode" value="event" ${state.exportMode === 'event' ? 'checked' : ''}>Event<span>${events.length} ${events.length === 1 ? 'event' : 'events'}</span></label>${state.exportMode === 'event' ? `<label class="export-event-picker">Choose event<select name="export-event" aria-label="Event to export">${events.map(event => `<option value="${escape(event.id)}" ${event.id === state.exportEventId ? 'selected' : ''}>${event.start.slice(0, 10)} ${time(event.start)} – ${event.end.slice(0, 10) !== event.start.slice(0, 10) ? `${event.end.slice(0, 10)} ` : ''}${time(event.end)} · ${event.photos.length} captures</option>`).join('')}</select></label>` : ''}</fieldset>
  ${state.photosAvailable ? `<fieldset class="export-targets" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}><legend>Destination</legend><label><input type="radio" name="export-target" value="folder" ${!toPhotos ? 'checked' : ''}>Folder</label><label><input type="radio" name="export-target" value="photos" ${toPhotos ? 'checked' : ''}>Photos (macOS)</label></fieldset>` : ''}
  ${!toPhotos ? `<div class="export-location"><span>Destination</span><div><strong title="${escape(state.exportLocation)}">${escape(state.exportLocation || 'Loading location…')}</strong><button class="button compact" data-action="choose-export-location" ${state.exportBusy || state.choosingLocation ? 'disabled' : ''}>${state.choosingLocation ? 'Choosing…' : 'Choose folder'}</button></div><small>This location is remembered for your next export.</small></div>` : `<div class="photos-destination">${icon('Image', 22)}<div><strong>Photos</strong><span>Imports into the current Photos library. macOS may ask for permission to control Photos.</span></div></div>`}
  <p class="export-note">${toPhotos ? 'JPEG + RAW pairs include both original files. Photos creates or reuses an album per event and merges labels into imported items’ keywords. Photos manages supported formats and duplicate checking; skipped duplicates cannot receive new labels and are reported. Keep the card connected until the import finishes.' : eventFolders ? 'JPEG + RAW pairs include both original files. Each event gets its own folder and photo-proofing-export.json, containing EXIF, labels, and review decisions. Accepted exports add a short folder summary when Ollama is enabled. Existing event folders are kept; repeated exports receive a numbered folder.' : 'JPEG + RAW pairs include both original files. Selected files and their EXIF, labels, and review decisions in JSON are saved directly in the destination. Existing files are kept; duplicate names receive a number.'}</p>
  ${state.exportBusy ? `<div class="export-progress" role="status"><progress value="${state.exportCopied}" max="${state.exportTotal || 1}"></progress><span>${state.exportCopied} of ${state.exportTotal} files ${toPhotos ? 'processed by Photos' : 'copied'}</span><small>${escape(state.exportCurrent)}</small></div>` : ''}
  ${result ? `<div class="export-result ${result.failures.length ? 'is-error' : result.cancelled || result.warnings?.length ? 'is-warning' : 'is-success'}" role="status"><strong>${result.cancelled ? 'Export stopped.' : result.failures.length ? 'Export finished with errors.' : result.warnings?.length ? 'Export complete with warnings.' : result.target === 'photos' ? 'Photos import complete.' : 'Export complete.'}</strong><span>${result.target === 'photos' ? `${result.copied} of ${result.total} original files processed by Photos. ${result.importedItems ?? 0} ${result.importedItems === 1 ? 'item' : 'items'} imported; duplicates may be skipped.` : `${result.copied} of ${result.total} files copied to ${escape(result.destination)}.`}</span>${result.failures.length ? `<ul>${result.failures.slice(0, 5).map(f => `<li>${escape(f.name)}: ${escape(f.message)}</li>`).join('')}</ul>${result.failures.length > 5 ? `<span>And ${result.failures.length - 5} more failures.</span>` : ''}` : ''}${result.warnings?.length ? `<ul class="export-warnings">${result.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul>` : ''}</div>` : ''}
  ${state.exportError ? `<p role="alert" class="export-error">${escape(state.exportError)}</p>` : ''}
  <div class="export-buttons">${state.exportBusy ? `<button class="button" data-action="cancel-export">Stop after current ${toPhotos ? 'batch' : 'file'}</button>` : `<span>${photos.length} ${photos.length === 1 ? 'capture' : 'captures'} / ${fileCount} ${fileCount === 1 ? 'file' : 'files'}</span><button class="button primary" data-action="start-export" ${!photos.length || (!toPhotos && !state.exportLocation) || state.choosingLocation ? 'disabled' : ''}>Export ${state.exportMode === 'accepted' ? 'accepted' : state.exportMode === 'event' ? 'event' : 'selection'}${toPhotos ? ' to Photos' : ''}</button>`}</div></section></div>`;
}
function refreshExportDialog() {
  const previousEvent = (document.activeElement as HTMLSelectElement | null)?.name === 'export-event';
  const previousAction = (document.activeElement as HTMLElement | null)?.dataset.action;
  const previousRadio = ['export-mode', 'export-target'].includes((document.activeElement as HTMLInputElement | null)?.name ?? '') ? (document.activeElement as HTMLInputElement).value : '';
  const backdrop = root.querySelector('.export-backdrop');
  if (backdrop) backdrop.outerHTML = exportDialog();
  if (previousAction) root.querySelector<HTMLButtonElement>(`.export-modal [data-action="${previousAction}"]`)?.focus();
  else if (previousRadio) root.querySelector<HTMLInputElement>(`.export-modal input[value="${previousRadio}"]`)?.focus();
  else if (previousEvent) root.querySelector<HTMLSelectElement>('[name="export-event"]')?.focus();
}
async function openExport() {
  if (state.demo || state.loading || !window.desktop) return;
  state.exportEventId = state.eventId || events.find(event => event.photos.some(photo => state.selectedIds.has(photo.id)))?.id || events[0]?.id || '';
  state.exportMode = state.selectedIds.size ? 'selection' : 'accepted'; state.exportTarget = 'folder'; state.exportResult = null; state.exportError = ''; state.exportOpen = true;
  render(); root.querySelector<HTMLButtonElement>('.export-modal [data-action="close-export"]')?.focus();
  try { const [location, capabilities] = await Promise.all([window.desktop.getExportLocation(), window.desktop.getExportCapabilities()]); state.exportLocation = location; state.photosAvailable = capabilities.photos; }
  catch (error) { state.exportError = `Unable to load the export location. ${errorMessage(error)}`; }
  refreshExportDialog();
}
async function chooseExportLocation() {
  if (!window.desktop || state.exportBusy || state.choosingLocation) return;
  state.choosingLocation = true; state.exportError = ''; refreshExportDialog();
  try { const location = await window.desktop.chooseExportLocation(); if (location) state.exportLocation = location; }
  catch (error) { state.exportError = `Unable to remember this folder. ${errorMessage(error)}`; }
  finally { state.choosingLocation = false; refreshExportDialog(); }
}
async function startExport() {
  if (!window.desktop || state.exportBusy || state.choosingLocation) return;
  const ids = exportPhotos().flatMap(photo => photo.files.map(file => file.id));
  if (!ids.length) return;
  state.exportBusy = true; state.exportCopied = 0; state.exportTotal = ids.length; state.exportCurrent = ''; state.exportResult = null; state.exportError = ''; refreshExportDialog();
  try { state.exportResult = state.exportTarget === 'photos' ? await window.desktop.exportToPhotos(ids) : await window.desktop.exportFiles(ids, state.exportMode); }
  catch (error) { state.exportError = `Export could not finish. ${errorMessage(error)}`; }
  finally { state.exportBusy = false; state.exportCurrent = ''; render(); }
}
type TagAction = 'enable' | 'disable' | 'start' | 'stop';
function unlabelledPhotos() { return allPhotos.filter(photo => photo.primary.kind !== 'video' && !tags.has(photo.id)); }
function indexedSession() { return Boolean(state.source && !state.demo && !state.loading && allPhotos.some(photo => photo.primary.kind !== 'video')); }
function progressRow(id: string, label: string, completed: number, total: number, detail: string, indeterminate = false, outcome: 'active' | 'success' | 'warning' | 'error' = 'active') {
  return `<div class="activity-row activity-${outcome}"><label for="${id}">${label}</label><progress id="${id}" aria-label="${label} progress" aria-valuetext="${escape(detail)}" ${indeterminate ? '' : `value="${completed}"`} max="${Math.max(1, total)}"></progress><span>${escape(detail)}</span></div>`;
}
function labellingProgress(id = 'labelling-progress') {
  if ((!state.tagging && !state.tagTotal && !state.tagSummary) || (!state.tagTotal && state.summaryTotal)) return '';
  const phase = state.tagging ? state.tagStopping ? state.summaryActive ? 'finishing current event' : 'finishing current photo' : 'in background' : state.tagConfirmation === 'start' || state.tagConfirmation === 'enable' ? 'awaiting confirmation' : state.tagSummary;
  const outcome = state.tagStopping || state.tagSummary === 'stopped' ? 'warning' : state.tagSummary === 'complete' ? 'success' : /failed|could not finish/.test(state.tagSummary) ? 'error' : 'active';
  return progressRow(id, 'Labelling', state.tagCompleted, state.tagTotal, `${state.tagCompleted} of ${state.tagTotal} photos${phase ? ` · ${phase}` : ''}`, false, outcome);
}
function reviewProgress() {
  if (!allPhotos.length) return '';
  const currentIndex = visible.findIndex(photo => photo.id === state.selectedId);
  let accepted = 0, rejected = 0, viewed = 0;
  const runs: { name: string; count: number }[] = [];
  visible.forEach((photo, index) => {
    const status = reviewStatus(photo);
    if (status === 'accepted') accepted++;
    else if (status === 'rejected') rejected++;
    else if (index <= currentIndex) viewed++;
    const name = status ?? (index <= currentIndex ? 'viewed' : 'unviewed');
    const previous = runs.at(-1);
    if (previous?.name === name) previous.count++; else runs.push({ name, count: 1 });
  });
  const total = visible.length;
  const reviewed = accepted + rejected + viewed;
  const text = `${reviewed} of ${total} reviewed`;
  const description = `${text}: ${accepted} accepted, ${rejected} rejected, ${viewed} viewed. Current view; viewed means unmarked captures through the current position.`;
  const segment = (name: string, count: number) => `<span class="review-segment review-${name}" style="width:${total ? count / total * 100 : 0}%"></span>`;
  return `<div class="activity-row review-progress-row"><span class="activity-label">Review</span><div class="review-progress-track" tabindex="${total ? 0 : -1}" aria-disabled="${!total}" aria-description="Hover to preview a capture. Click to focus it. Use Left, Right, Home or End to navigate." role="progressbar" aria-label="Review progress" aria-valuemin="0" aria-valuemax="${Math.max(1, total)}" aria-valuenow="${reviewed}" aria-valuetext="${escape(description)}" >${runs.map(run => segment(run.name, run.count)).join('')}</div><span>${text}</span><div class="review-progress-legend" aria-label="Review progress breakdown"><span class="review-accepted">${accepted} accepted</span><span class="review-rejected">${rejected} rejected</span><span class="review-viewed">${viewed} viewed</span></div></div>`;
}
let reviewPreviewPhotoId = '';
function hideReviewPreview() {
  root.querySelector('#review-hover-preview')?.remove(); reviewPreviewPhotoId = '';
}
function reviewPhotoAt(clientX: number, track: HTMLElement) {
  const bounds = track.getBoundingClientRect();
  return Math.max(0, Math.min(visible.length - 1, Math.floor((clientX - bounds.left) / Math.max(1, bounds.width) * visible.length)));
}
function showReviewPreview(event: PointerEvent, track: HTMLElement) {
  const index = reviewPhotoAt(event.clientX, track), photo = visible[index];
  if (!photo) { hideReviewPreview(); return; }
  let preview = root.querySelector<HTMLElement>('#review-hover-preview');
  if (!preview) { preview = document.createElement('div'); preview.id = 'review-hover-preview'; preview.className = 'review-hover-preview'; preview.setAttribute('role', 'tooltip'); root.append(preview); }
  if (reviewPreviewPhotoId !== photo.id) {
    reviewPreviewPhotoId = photo.id;
    const file = currentFile(photo);
    preview.innerHTML = `<div class="review-hover-image ${reviewStatus(photo) === 'rejected' ? 'is-rejected' : ''}">${mediaMarkup(file, true)}${reviewBadge(photo)}</div><strong>${escape(file.name)}</strong><span>${index + 1} of ${visible.length} · ${time(file.capturedAt)}</span>`;
    bindMediaErrors();
  }
  preview.style.left = `${Math.max(8, Math.min(innerWidth - 196, event.clientX - 94))}px`;
  preview.style.bottom = `${innerHeight - track.getBoundingClientRect().top + 12}px`;
}
function focusReviewPhoto(index: number, keepBarFocus = false) {
  const photo = visible[Math.max(0, Math.min(visible.length - 1, index))];
  if (!photo) return;
  hideReviewPreview(); setSingle(photo.id);
  if (state.full) render(); else updateSelectionUI();
  const target = root.querySelector<HTMLElement>(keepBarFocus ? '.review-progress-track' : state.full ? '.filmstrip-item.selected' : '.photo-card.is-selected');
  target?.focus({ preventScroll: true });
  if (!keepBarFocus) target?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
function eventSummaryProgress(id = 'event-summaries-progress') {
  return state.summaryTotal ? progressRow(id, 'Events', state.summaryCompleted, state.summaryTotal, `${state.summaryCompleted} of ${state.summaryTotal} event summaries${state.summaryActive ? ' · in background' : state.summaryCancelled ? ' · stopped' : eventSummaryErrors.size ? ' · errors' : ' · complete'}`, false, state.summaryActive ? 'active' : state.summaryCancelled ? 'warning' : eventSummaryErrors.size ? 'error' : 'success') : '';
}
function activityProgress() {
  const indexing = !state.demo && state.source && (state.loading || state.scanned < state.total)
    ? progressRow('indexing-progress', 'Indexing', state.scanned, state.total,
      state.loading && !state.total ? 'Finding photos and videos…' : `${state.scanned} of ${state.total} files${state.loading ? '' : state.scanned < state.total ? ' · stopped' : ' · complete'}`, state.loading && !state.total, state.loading ? 'active' : state.scanned < state.total ? 'warning' : 'success') : '';
  return indexing + reviewProgress() + labellingProgress() + eventSummaryProgress();
}
function updateActivityUI() {
  const panel = root.querySelector('.activity-panel');
  if (panel) panel.innerHTML = activityProgress();
  const settingsProgress = root.querySelector('.settings-labelling-activity');
  if (settingsProgress) settingsProgress.innerHTML = labellingProgress('settings-labelling-progress') + eventSummaryProgress('settings-event-summaries-progress');
}
function tagConfirmationDialog() {
  const action = state.tagConfirmation;
  if (!action) return '';
  const stopping = action === 'disable' || action === 'stop';
  const title = stopping ? action === 'disable' ? 'Turn off photo labelling?' : 'Stop queued labelling?' : action === 'enable' ? 'Enable background labelling?' : 'Label this proofing session?';
  const count = unlabelledPhotos().length;
  const message = stopping
    ? state.summaryActive ? 'Event summaries that have not started will be removed from the queue. The current event summary will finish and be saved.' : 'Photos that have not started labelling will be removed from the queue. The current photo will finish, and its labels will be saved. Existing labels are kept. Queued event summaries will also stop.'
    : `${count} unlabelled ${count === 1 ? 'photo' : 'photos'} in the active proofing session will be labelled in the background, followed by ${pendingSummaryEvents().length} event summaries. You can continue browsing, reviewing, and exporting while this runs. Originals stay untouched.`;
  const confirm = stopping ? action === 'disable' ? 'Turn off labelling' : 'Stop queued labelling' : action === 'enable' ? 'Enable and label' : 'Start background labelling';
  return `<div class="modal-backdrop tag-confirmation-backdrop"><section class="labelling-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="labelling-confirm-title" aria-describedby="labelling-confirm-description"><h2 id="labelling-confirm-title">${title}</h2><p id="labelling-confirm-description">${message}</p><div class="confirmation-actions"><button class="button" data-action="cancel-tag-confirmation">Cancel</button><button class="button primary" data-action="confirm-tagging">${confirm}</button></div></section></div>`;
}
function syncTagConfirmation(focusAction = 'cancel-tag-confirmation') {
  root.querySelectorAll<HTMLElement>('.app-shell, .settings-backdrop, .export-backdrop, .modal-backdrop:not(.tag-confirmation-backdrop)').forEach(element => { element.inert = Boolean(state.tagConfirmation) || (state.about && !element.classList.contains('about-backdrop')); });
  if (state.tagConfirmation) root.querySelector<HTMLButtonElement>(`.labelling-confirmation [data-action="${focusAction}"]`)?.focus();
}
function requestTagConfirmation(action: TagAction) {
  if (state.tagConfirmation || state.settingsBusy) return;
  if ((action === 'start' && (!indexedSession() || (!unlabelledPhotos().length && !pendingSummaryEvents().length) || state.tagging)) || (action === 'stop' && !state.tagging)) return;
  state.tagConfirmation = action; state.tagConfirmationEpoch = tagEpoch;
  if (!state.tagging && (action === 'start' || action === 'enable')) {
    state.tagTotal = unlabelledPhotos().length; state.tagCompleted = 0; state.tagSummary = '';
  }
  root.insertAdjacentHTML('beforeend', tagConfirmationDialog());
  syncTagConfirmation(); updateActivityUI();
}
function dismissTagConfirmation() {
  state.tagConfirmation = null;
  root.querySelector('.tag-confirmation-backdrop')?.remove(); syncTagConfirmation();
  if (state.about) root.querySelector<HTMLButtonElement>('[data-action="close-about"]')?.focus();
  else if (state.settingsOpen) root.querySelector<HTMLInputElement>('[data-ollama-enabled]')?.focus();
  else root.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
}
function cancelTagConfirmation() {
  const action = state.tagConfirmation;
  const deferred = state.tagDeferred; state.tagDeferred = false;
  if (action === 'start' || action === 'enable') {
    state.tagDeclinedEpoch = tagEpoch;
    if (!state.tagging) state.tagSummary = 'Not started';
  }
  dismissTagConfirmation(); refreshSettings(); updateActivityUI();
  if (deferred && (action === 'disable' || action === 'stop')) void queueTagging();
}
async function confirmTagAction() {
  const action = state.tagConfirmation;
  if (!action) return;
  if (state.tagConfirmationEpoch !== tagEpoch) { dismissTagConfirmation(); state.settingsError = 'The active session changed. Try again.'; refreshSettings(); return; }
  state.tagDeferred = false;
  if (action === 'enable' || action === 'start') { state.tagApprovedEpoch = tagEpoch; state.tagDeclinedEpoch = -1; }
  else { state.tagApprovedEpoch = -1; state.tagDeclinedEpoch = tagEpoch; state.tagStopping = state.tagging; }
  dismissTagConfirmation(); updateActivityUI();
  if (action === 'enable') await applyOllamaChange(true);
  if (action === 'start') void queueTagging();
  if (action === 'disable') await applyOllamaChange(false);
  if (action === 'stop') {
    try { await window.desktop?.cancelTagging(); }
    catch (error) { state.settingsError = errorMessage(error); }
    refreshSettings(); updateActivityUI();
  }
}
function requestOllamaChange(enabled: boolean) {
  refreshSettings(); // Restore the saved switch value until the user confirms.
  if (!enabled) requestTagConfirmation('disable');
  else if (indexedSession()) requestTagConfirmation('enable');
  else void applyOllamaChange(true);
}

interface SoftwareCredit { name: string; version: string; license: string; notices: { name: string; text: string }[] }
interface AboutCredits { version: string; appLicense: string; software: SoftwareCredit[] }
let aboutCredits: AboutCredits | undefined;
let aboutError = '';
let aboutReturnFocus: HTMLElement | null = null;
function aboutContent() {
  if (aboutError) return `<p role="alert" class="settings-error">${escape(aboutError)}</p><button class="button" data-action="about">Retry loading credits</button>`;
  if (!aboutCredits) return '<p role="status">Loading software licenses…</p>';
  return `<p class="about-version">Version ${escape(aboutCredits.version)}</p><p>© 2026 Juti Noppornpitak</p><details class="license-notice"><summary>Photo Proofer · Apache License 2.0</summary><pre>${escape(aboutCredits.appLicense)}</pre></details>
  <h3>Open-source software</h3><p>Thank you to the projects that make Photo Proofer possible. Software versions and licenses below reflect this build.</p>
  <div class="software-credits">${aboutCredits.software.map(software => `<details class="software-credit"><summary><span><strong>${escape(software.name)}</strong><small>${escape(software.version)}</small></span><span class="software-license">${escape(software.license)}</span></summary>${software.notices.length ? software.notices.map(notice => `<section><h4>${escape(notice.name)}</h4><pre>${escape(notice.text)}</pre></section>`).join('') : `<p>License: ${escape(software.license)}. Bundled native library notices are included with the sharp-libvips entry.</p>`}</details>`).join('')}</div>
  <details class="chromium-credits"><summary>Chromium, Node.js and Electron third-party notices</summary><p>Additional runtime components and their full license notices are included below.</p><iframe title="Chromium and runtime license notices" sandbox src="${import.meta.env.BASE_URL}licenses/chromium.html" loading="lazy"></iframe></details>`;
}
function aboutDialog() {
  return `<div class="modal-backdrop about-backdrop"><section class="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title"><div class="modal-title"><h2 id="about-title">About Photo Proofer</h2>${btn('X', 'Close About', 'close-about')}</div><div class="about-content">${aboutContent()}</div></section></div>`;
}
function syncAboutDialog() {
  if (!state.about) return;
  root.querySelectorAll<HTMLElement>('.app-shell, .settings-backdrop, .export-backdrop, .modal-backdrop:not(.about-backdrop):not(.tag-confirmation-backdrop)').forEach(element => { element.inert = true; });
}
async function openAbout() {
  if (!state.about) {
    aboutReturnFocus = document.activeElement as HTMLElement | null;
    state.about = true;
    root.insertAdjacentHTML('beforeend', aboutDialog());
    syncAboutDialog();
    root.querySelector<HTMLButtonElement>('[data-action="close-about"]')?.focus();
  }
  if (aboutCredits) return;
  aboutError = '';
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}licenses/software.json`);
    if (!response.ok) throw new Error('Credits unavailable');
    aboutCredits = await response.json() as AboutCredits;
  } catch (error) { aboutError = `Software licenses could not be loaded. ${errorMessage(error)}`; }
  const content = root.querySelector('.about-content');
  if (state.about && content) content.innerHTML = aboutContent();
}
function closeAbout() {
  state.about = false;
  root.querySelector('.about-backdrop')?.remove();
  syncTagConfirmation();
  if (aboutReturnFocus?.isConnected) aboutReturnFocus.focus();
  else root.querySelector<HTMLButtonElement>('[data-action="about"]')?.focus();
}

function settingsDialog() {
  const status = state.ollama;
  return `<div class="modal-backdrop settings-backdrop" ${state.tagConfirmation || state.about ? 'inert' : ''}><section role="dialog" aria-modal="true" aria-labelledby="settings-title" class="settings-modal"><div class="modal-title"><h2 id="settings-title">Settings</h2>${btn('X', 'Close settings', 'close-settings')}</div><section class="settings-section"><h3>Appearance</h3><label class="settings-row"><span>Theme<small>System follows your computer’s appearance.</small></span><select data-theme-switcher aria-label="Theme">${['system', 'light', 'dark'].map(value => `<option value="${value}" ${themePreference() === value ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label></section>
  <section class="settings-section"><h3>Events</h3><label class="settings-row"><span>Event separation gap<small>A gap longer than this starts a new event. Overnight captures can stay together.</small></span><span class="event-gap-control"><input id="event-gap" type="number" min="1" max="10080" step="1" value="${escape(state.gapDraft)}" aria-label="Event gap in minutes" ${state.settingsBusy || state.loading || state.tagging || state.exportBusy ? 'disabled' : ''}>minutes</span></label><p class="settings-note">Default: 30 minutes. Applies to the current folder and future sessions. Finish or stop background work before changing this value.</p><button class="button compact" data-action="apply-event-gap" ${!state.libraryReady || state.settingsBusy || state.loading || state.tagging || state.exportBusy || Number(state.gapDraft) === state.eventGapMinutes ? 'disabled' : ''}>Apply event gap</button><p class="settings-note">Use “Reindex &amp; rerun AI” in the sidebar to reread metadata and regenerate labels and summaries. Review decisions for unchanged files are preserved. AI runs only when Ollama is enabled.</p></section>
  <section class="settings-section"><h3>Photo tagging</h3><label class="settings-row"><span>Tag photos with Ollama<small>Uses the local ${status?.model ?? 'gemma4:e2b'} model. Defaults on when ready on macOS; off elsewhere.</small></span><input type="checkbox" role="switch" aria-label="Tag photos with Ollama" data-ollama-enabled ${status?.enabled ? 'checked' : ''} ${state.settingsChecking || state.settingsBusy || !status?.available ? 'disabled' : ''}></label>
  <p class="settings-note">When enabled, each indexed proofing session asks for confirmation before background labelling starts. Resized previews are sent to Ollama on this computer. Originals stay untouched. Videos are skipped.</p>
  ${state.settingsChecking ? `<p class="settings-status" role="status">${icon('LoaderCircle', 15)}Checking availability…</p>` : status ? status.available ? `<p class="settings-status ready">${icon('Check', 15)}Ready${status.gpu ? ` · ${escape(status.gpu)}` : ''}</p>` : `<div class="settings-warning" role="alert">${icon('Info', 17)}<ul>${status.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></div>` : '<p class="settings-note">Open the desktop app to check Ollama and GPU availability.</p>'}
  <div class="settings-tag-actions"><button class="button compact" data-action="check-ollama" ${state.settingsChecking || state.settingsBusy ? 'disabled' : ''}>${icon('RefreshCw', 14)}Check again</button>${state.tagging ? `<button class="button compact" data-action="stop-tagging" ${state.tagStopping ? 'disabled' : ''}>Stop queued labelling</button>` : `<button class="button compact" data-action="retry-tagging" ${!status?.enabled || state.demo || !allPhotos.length || state.loading ? 'disabled' : ''}>Tag untagged photos</button>`}</div>
  <div class="settings-labelling-activity">${labellingProgress('settings-labelling-progress')}${eventSummaryProgress('settings-event-summaries-progress')}</div>${state.tagging ? '<p class="settings-note">Labelling continues in the background. You can close Settings and keep reviewing.</p>' : ''}
  ${state.settingsError ? `<p role="alert" class="settings-error">${escape(state.settingsError)}</p>` : ''}</section><div class="settings-legal">© 2026 Juti Noppornpitak<small>Apache License 2.0</small></div></section></div>`;
}
let settingsPoll: ReturnType<typeof setInterval> | undefined;
function refreshSettings() {
  if (!state.settingsOpen) return;
  const previous = document.activeElement as HTMLElement | null;
  const action = previous?.dataset.action;
  const wasSwitch = previous?.matches('[data-ollama-enabled]');
  const wasTheme = previous?.matches('[data-theme-switcher]');
  const wasGap = previous?.id === 'event-gap';
  const backdrop = root.querySelector('.settings-backdrop');
  if (backdrop) backdrop.outerHTML = settingsDialog();
  if (action) root.querySelector<HTMLButtonElement>(`.settings-modal [data-action="${action}"]`)?.focus();
  else if (wasSwitch) root.querySelector<HTMLInputElement>('.settings-modal [data-ollama-enabled]')?.focus();
  else if (wasTheme) root.querySelector<HTMLSelectElement>('.settings-modal [data-theme-switcher]')?.focus();
  else if (wasGap) root.querySelector<HTMLInputElement>('#event-gap')?.focus();
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
  catch (error) { state.ollama = { model: 'gemma4:e2b', enabled: false, available: false, reasons: [`Ollama availability could not be checked. ${errorMessage(error)}`] }; }
  finally { state.settingsChecking = false; refreshSettings(); }
}
async function applyOllamaChange(enabled: boolean) {
  if (!window.desktop || state.settingsBusy) return;
  state.settingsBusy = true; state.settingsError = ''; refreshSettings();
  try {
    state.ollama = await window.desktop.setOllamaEnabled(enabled);
  } catch (error) {
    state.settingsError = errorMessage(error);
    try { state.ollama = await window.desktop.getOllamaStatus(); } catch { /* Keep the save error. */ }
  }
  finally { state.settingsBusy = false; refreshSettings(); }
  if (!state.settingsError && state.ollama?.enabled) void queueTagging();
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
  updateActivityUI();
  refreshLabelSuggestions();
}
async function loadTags() {
  if (!window.desktop || state.demo || state.loading) return;
  compute(); const epoch = tagEpoch;
  const photos = allPhotos.filter(photo => photo.primary.kind !== 'video');
  try {
    const [saved, savedReviews, status, savedSummaries] = await Promise.all([
      window.desktop.getPhotoTags(photos.map(photo => photo.primary.id)),
      window.desktop.getPhotoReviews(allPhotos.flatMap(photo => photo.files.map(file => file.id))),
      window.desktop.getOllamaStatus(), window.desktop.getEventSummaries(),
    ]);
    if (epoch !== tagEpoch) return;
    for (const photo of allPhotos) {
      const decision = reviewEdits.has(photo.id) ? reviewEdits.get(photo.id) : savedReviews[photo.primary.id] ?? photo.files.map(file => savedReviews[file.id]).find(Boolean);
      if (decision) reviews[reviewKey(photo)] = decision; else delete reviews[reviewKey(photo)];
    }
    // A JPEG/RAW pair may finish indexing after its first member was reviewed.
    for (const decision of ['accepted', 'rejected', null] as const) {
      const ids = allPhotos.filter(photo => reviewEdits.has(photo.id) && reviewEdits.get(photo.id) === decision).flatMap(photo => photo.files.map(file => file.id));
      if (ids.length) await window.desktop.setPhotoReviews(ids, decision);
    }
    if (epoch !== tagEpoch) return;
    updateSelectionUI();
    for (const [id, summary] of Object.entries(savedSummaries)) eventSummaries.set(id, summary);
    updateEventSummaryUI();
    state.ollama = status;
    for (const photo of photos) if (saved[photo.primary.id]) tags.set(photo.id, saved[photo.primary.id]);
    if (state.full || state.labelFilters.length || state.reviewFilter !== 'all' || state.search) render();
    updateTagUI(); refreshSettings();
    if (status.enabled) await queueTagging();
  } catch (error) { if (epoch === tagEpoch) { state.settingsError = `Photo tags could not be loaded. ${errorMessage(error)}`; reportError('Session data could not be loaded.', error); refreshSettings(); } }
}
async function queueTagging() {
  if (!window.desktop || state.demo || state.loading || state.settingsBusy || !state.ollama?.enabled) return;
  if (state.tagging) {
    if (state.tagStopping && state.tagApprovedEpoch === tagEpoch) state.tagDeferred = true;
    return;
  }
  const photos = unlabelledPhotos();
  if (!photos.length && !pendingSummaryEvents().length) return;
  if (state.tagConfirmation) { state.tagDeferred = true; return; }
  if (state.tagApprovedEpoch !== tagEpoch) {
    if (state.tagDeclinedEpoch !== tagEpoch) requestTagConfirmation('start');
    return;
  }
  const epoch = tagEpoch; const jobId = crypto.randomUUID();
  state.tagJobId = jobId; state.tagging = true; state.tagStopping = false; state.tagCompleted = 0; state.tagTotal = photos.length; state.tagSummary = ''; state.settingsError = '';
  refreshSettings(); updateTagUI();
  try {
    const result = await window.desktop.tagPhotos(photos.map(photo => photo.primary.id), jobId);
    if (epoch !== tagEpoch || state.tagJobId !== jobId) return;
    state.tagCompleted = result.completed; state.tagTotal = result.total;
    state.tagSummary = result.cancelled ? 'stopped' : result.failures ? `${result.failures} failed` : 'complete';
    if (result.failures) { state.ollama = await window.desktop.getOllamaStatus(); }
    if (result.failures) state.settingsError = 'Some photos could not be tagged. Select a photo to see its error, then retry after checking Ollama.';
  } catch (error) {
    if (epoch !== tagEpoch || state.tagJobId !== jobId) return;
    state.settingsError = errorMessage(error); state.tagSummary = 'could not finish';
    reportError('Background AI processing could not finish.', error);
    try { state.ollama = await window.desktop.getOllamaStatus(); } catch { /* Keep the original error. */ }
  } finally {
    if (epoch === tagEpoch && state.tagJobId === jobId) {
      state.tagging = false; state.tagStopping = false; updateTagUI(); refreshSettings();
      if (state.search && !state.full) scheduleScanRender();
      const resume = state.tagDeferred && state.ollama?.enabled && state.tagApprovedEpoch === tagEpoch;
      state.tagDeferred = false;
      if (resume) void queueTagging();
    }
  }
}

function render() {
  hideReviewPreview();
  const previousAbout = root.querySelector('.about-backdrop');
  const aboutFocus = previousAbout?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const galleryScroll = root.querySelector('.gallery-scroll')?.scrollTop ?? 0;
  const eventsScroll = root.querySelector('.events-list')?.scrollTop ?? 0;
  const detailsScroll = root.querySelector('.details')?.scrollTop ?? 0;
  const previousMedia = root.querySelector<HTMLVideoElement | HTMLImageElement>('.full-media .media-image');
  const confirmationFocus = (document.activeElement as HTMLElement | null)?.closest('.labelling-confirmation') ? (document.activeElement as HTMLElement).dataset.action : undefined;
  const focusedSearch = document.activeElement?.id === 'search';
  const labelPopup = { open: state.labelOpen, active: state.labelActive };
  const searchCursor = focusedSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
  compute();
  root.innerHTML = `<div class="app-shell ${state.info ? '' : 'no-details'}">${sidebar()}<main>${toolbar()}<div class="cache-notices">${cacheNotices()}</div><div class="error-notices">${errorNotices()}</div><div class="selection-toolbar">${selectionToolbar()}</div><div class="workspace"><div class="gallery-scroll ${state.full ? 'viewer-container' : ''}">${state.full ? viewer() : gallery()}</div>${state.info ? details() : ''}</div><div class="activity-panel" aria-label="Background activity">${activityProgress()}</div><footer><span class="library-status" role="status">${state.source ? `${visible.length} captures${state.skipped ? ` • ${state.skipped} unreadable files or folders` : ''}` : 'Ready when you are'}</span><span>${state.demo ? 'Sample photos • illustrative metadata' : state.loading ? 'You can start reviewing while we read.' : 'Originals stay untouched'}<span class="footer-divider"></span>${state.full ? '<kbd>Esc</kbd> Thumbnails' : 'Double-click to open'}<span class="footer-divider"></span><button data-action="help"><kbd>?</kbd> Shortcuts</button></span></footer></main></div>${state.help ? help() : ''}${state.exportOpen ? exportDialog() : ''}${state.settingsOpen ? settingsDialog() : ''}${state.about ? aboutDialog() : ''}${tagConfirmationDialog()}`;
  if (previousAbout && state.about) root.querySelector('.about-backdrop')?.replaceWith(previousAbout);
  const nextMedia = root.querySelector<HTMLVideoElement | HTMLImageElement>('.full-media .media-image');
  if (previousMedia && nextMedia && previousMedia.getAttribute('src') === nextMedia.getAttribute('src')) nextMedia.replaceWith(previousMedia);
  const galleryElement = root.querySelector('.gallery-scroll');
  if (galleryElement) galleryElement.scrollTop = galleryScroll;
  const eventList = root.querySelector('.events-list');
  if (eventList) eventList.scrollTop = eventsScroll;
  const detailsElement = root.querySelector('.details');
  if (detailsElement) detailsElement.scrollTop = detailsScroll;
  if (focusedSearch) {
    const input = root.querySelector<HTMLInputElement>('#search'); input?.focus();
    state.labelOpen = labelPopup.open; state.labelActive = labelPopup.active; refreshLabelSuggestions();
    if (searchCursor !== null) input?.setSelectionRange(searchCursor, searchCursor);
  }
  bindMediaErrors();
  if (state.full) root.querySelector('.filmstrip-item.selected')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (state.help) root.querySelector<HTMLButtonElement>('.shortcuts-modal button')?.focus();
  syncTagConfirmation(confirmationFocus);
  syncAboutDialog();
  aboutFocus?.focus();
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
async function loadSource(source: Source, reindex = false) {
  await preferencesReady;
  if (state.exportBusy) { state.error = 'Finish or cancel the export before opening another source.'; render(); return; }
  reviewEdits.clear(); state.cacheWarnings = [];
  tagEpoch++; resetEventSummaries(); tags.clear(); tagErrors.clear(); state.tagJobId = ''; state.tagging = false; state.tagSummary = ''; state.tagStopping = false; state.tagTotal = 0; state.tagCompleted = 0; state.tagDeferred = false;
  if (reindex) state.tagApprovedEpoch = tagEpoch;
  clearSelection();
  state.files = []; state.source = source; state.demo = false; state.selectedId = ''; state.eventId = ''; state.full = false;
  state.raw = false; state.loading = true; state.error = ''; state.scanned = 0; state.total = 0; state.skipped = 0; state.search = ''; state.filter = 'all'; state.reviewFilter = 'all'; state.labelFilters = []; state.labelOpen = false; state.labelActive = -1;
  render();
  try { if (reindex) await window.desktop!.reindex(source); else await window.desktop!.scan(source); } catch (error) { state.loading = false; state.error = `Unable to read this source. ${errorMessage(error)}`; render(); }
}
async function applyEventGap() {
  if (state.settingsBusy || state.loading || state.tagging || state.exportBusy) return;
  const minutes = Number(state.gapDraft);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) { state.settingsError = 'Choose a whole-number gap from 1 to 10080 minutes.'; refreshSettings(); return; }
  state.settingsBusy = true; state.settingsError = ''; refreshSettings();
  let changed = false;
  try {
    state.eventGapMinutes = window.desktop ? await window.desktop.setEventGap(minutes) : minutes;
    state.gapDraft = String(state.eventGapMinutes); state.eventId = ''; clearSelection();
    tagEpoch++; resetEventSummaries(); compute(); changed = true;
  } catch (error) { state.settingsError = errorMessage(error); }
  finally { state.settingsBusy = false; render(); root.querySelector<HTMLInputElement>('#event-gap')?.focus(); }
  if (changed && state.source && !state.demo) await loadTags();
}
async function toggleBookmark(folder = state.source?.path) {
  if (!window.desktop || !folder || state.bookmarkBusy) return;
  state.bookmarkBusy = true;
  try { state.bookmarks = await window.desktop.toggleBookmark(folder); }
  catch (error) { state.error = `Unable to update bookmarks. ${errorMessage(error)}`; }
  finally { state.bookmarkBusy = false; render(); }
}
async function openBookmark(index: number) {
  const bookmark = state.bookmarks[index];
  if (!window.desktop || !bookmark || state.exportBusy) return;
  try { await loadSource(await window.desktop.openBookmark(bookmark.path)); }
  catch (error) { state.error = errorMessage(error); render(); }
}
async function reindexSource() {
  if (!window.desktop || !state.source || state.demo || state.loading || state.exportBusy) return;
  await loadSource(state.source, true);
}
async function openFolder() {
  if (state.exportBusy) return;
  if (!window.desktop) { state.error = 'Folder access is available in the desktop app. Run npm start, or explore the sample collection here.'; render(); return; }
  try { const source = await window.desktop.chooseFolder(); if (source) await loadSource(source); }
  catch (error) { state.error = `Unable to open the folder. ${errorMessage(error)}`; render(); }
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
  return `<span class="selection-summary">${count ? `${count} selected` : 'Click to select. Shift for a range. Cmd / Ctrl to add.'}</span><div class="selection-actions"><button data-action="accept" class="review-action accept" ${!count ? 'disabled' : ''}>${icon('Check', 14)}Accept<kbd>A</kbd></button><button data-action="reject" class="review-action reject" ${!count ? 'disabled' : ''}>${icon('X', 14)}Reject<kbd>D</kbd></button>${count ? '<button data-action="clear-review" class="review-action" aria-label="Clear status">Clear status <kbd>S</kbd></button><button data-action="clear-selection" class="review-action" aria-label="Deselect all captures">Deselect</button>' : ''}<span class="accepted-count">${acceptedPhotos().length} accepted</span></div>`;
}
function updateSelectionUI() {
  root.querySelectorAll<HTMLElement>('.photo-card').forEach(card => {
    const isSelected = state.selectedIds.has(card.dataset.photo!);
    card.classList.toggle('is-selected', isSelected); card.setAttribute('aria-pressed', String(isSelected));
    const photo = photoById.get(card.dataset.photo!);
    card.classList.toggle('is-rejected', Boolean(photo && reviewStatus(photo) === 'rejected'));
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
  updateActivityUI();
}
async function markSelection(status?: ReviewStatus) {
  if (!state.selectedIds.size) return;
  const photos = selectedPhotos();
  for (const photo of photos) {
    const next = status ?? null;
    if (next) reviews[reviewKey(photo)] = next; else delete reviews[reviewKey(photo)];
    if (!state.demo) reviewEdits.set(photo.id, next);
  }
  if (state.full || state.reviewFilter !== 'all') render(); else updateSelectionUI();
  try {
    if (state.demo) localStorage.setItem('photo-proofer-demo-reviews', JSON.stringify(Object.fromEntries(Object.entries(reviews).filter(([key]) => key.startsWith('/demo/')))));
    else await Promise.all((['accepted', 'rejected', null] as const).map(next => {
      const ids = photos.filter(photo => (reviewStatus(photo) ?? null) === next).flatMap(photo => photo.files.map(file => file.id));
      return ids.length ? window.desktop?.setPhotoReviews(ids, next) : undefined;
    }));
  } catch (error) { reportError('Review decisions could not be saved.', error); }
}
function cacheNotices() {
  return state.cacheWarnings.map(message => `<div class="cache-warning" role="alert">${icon('Info', 16)}<span>${escape(message)}</span></div>`).join('');
}
function addCacheWarning(message: string) {
  if (!state.cacheWarnings.includes(message)) state.cacheWarnings.push(message);
  const notices = root.querySelector('.cache-notices');
  if (notices) notices.innerHTML = cacheNotices();
}
const actions: Record<string, () => void | Promise<void>> = {
  open: openFolder, bookmark: () => toggleBookmark(), reindex: reindexSource, 'apply-event-gap': applyEventGap,
  all: () => { clearSelection(); state.eventId = ''; state.full = false; render(); },
  back: () => { state.full = false; state.zoom = false; render(); },
  info: () => { state.info = !state.info; render(); },
  help: () => { state.help = !state.help; render(); },
  about: openAbout, 'close-about': closeAbout,
  settings: openSettings,
  'close-settings': closeSettings,
  'check-ollama': checkOllama,
  'retry-tagging': () => requestTagConfirmation('start'),
  'stop-tagging': () => requestTagConfirmation('stop'),
  'confirm-tagging': confirmTagAction,
  'cancel-tag-confirmation': cancelTagConfirmation,
  'dismiss-error': () => { state.error = ''; state.runtimeErrors = []; const notices = root.querySelector('.error-notices'); if (notices) notices.innerHTML = ''; },
  'refresh-sources': async () => { if (window.desktop) { state.sources = await window.desktop.listSources(); render(); } },
  cancel: async () => { await window.desktop?.cancelScan(); state.loading = false; render(); },
  demo: async () => { await preferencesReady; if (state.exportBusy) return; await window.desktop?.cancelScan(); await window.desktop?.cancelTagging(); tagEpoch++; resetEventSummaries(); tags.clear(); tagErrors.clear(); state.tagJobId = ''; state.tagging = false; state.tagSummary = ''; state.tagStopping = false; state.tagTotal = 0; state.tagCompleted = 0; state.tagDeferred = false; clearSelection(); Object.assign(state, { files: demoFiles, source: { name: 'A day in the mountains', path: '/demo' }, demo: true, loading: false, eventId: '', full: false, search: '', filter: 'all', reviewFilter: 'all', labelFilters: [], labelOpen: false, labelActive: -1, error: '', cacheWarnings: [] }); render(); },
  'reset-filters': () => { clearSelection(); state.search = ''; state.filter = 'all'; state.reviewFilter = 'all'; state.labelFilters = []; state.labelOpen = false; state.labelActive = -1; render(); },
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
  enabled: () => !state.full && !state.help && !state.exportOpen && !state.settingsOpen && !state.tagConfirmation,
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
  const bookmark = target.closest<HTMLElement>('[data-bookmark]');
  if (bookmark) { void openBookmark(Number(bookmark.dataset.bookmark)); return; }
  const removeBookmark = target.closest<HTMLElement>('[data-remove-bookmark]');
  if (removeBookmark) { void toggleBookmark(state.bookmarks[Number(removeBookmark.dataset.removeBookmark)]?.path); return; }
  const track = target.closest<HTMLElement>('.review-progress-track');
  if (track) { focusReviewPhoto(reviewPhotoAt(event.clientX, track)); return; }
  const label = target.closest<HTMLElement>('[data-label]');
  if (label) { addLabelFilter(label.dataset.label!); return; }
  const removeLabel = target.closest<HTMLElement>('[data-remove-label]');
  if (removeLabel) { state.labelFilters = state.labelFilters.filter(value => value !== removeLabel.dataset.removeLabel); state.labelOpen = false; render(); return; }
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
  if (input.id === 'event-gap') {
    state.gapDraft = input.value;
    const apply = root.querySelector<HTMLButtonElement>('[data-action="apply-event-gap"]');
    if (apply) apply.disabled = state.settingsBusy || state.loading || state.tagging || state.exportBusy || Number(state.gapDraft) === state.eventGapMinutes;
  }
  if (input.id === 'search') {
    const cursor = input.selectionStart;
    state.search = input.value; state.labelOpen = true; state.labelActive = -1; render();
    const replacement = root.querySelector<HTMLInputElement>('#search'); replacement?.focus();
    if (cursor !== null) { try { replacement?.setSelectionRange(cursor, cursor); } catch { /* Search inputs may not expose a selection. */ } }
  }
  if (input.id === 'thumbnail-size') {
    state.size = Number(input.value);
    root.querySelectorAll<HTMLElement>('.photo-grid').forEach(grid => grid.style.setProperty('--thumb-size', `${state.size}px`));
  }
});
document.addEventListener('keydown', event => {
  if (state.about && !state.tagConfirmation) {
    if (event.key === 'Escape') { event.preventDefault(); closeAbout(); }
    if (event.key === 'Tab') {
      const controls = [...root.querySelectorAll<HTMLElement>('.about-modal button, .about-modal summary, .about-modal iframe')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
  if (state.tagConfirmation) {
    if (event.key === 'Escape') { event.preventDefault(); cancelTagConfirmation(); }
    if (event.key === 'Tab') {
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('.labelling-confirmation button')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    return;
  }
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
  if ((event.target as HTMLElement).matches('.review-progress-track') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const current = visible.findIndex(photo => photo.id === state.selectedId);
    focusReviewPhoto(event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1), true);
    return;
  }
  if ((event.target as HTMLElement).id === 'search') {
    const suggestions = labelSuggestions();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); state.labelOpen = true;
      state.labelActive = !suggestions.length ? -1 : state.labelActive < 0
        ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1
        : (state.labelActive + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      refreshLabelSuggestions();
    } else if (event.key === 'Enter' && state.labelOpen && suggestions.length) {
      event.preventDefault(); addLabelFilter(suggestions[Math.max(0, state.labelActive)][0]);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); state.labelOpen = false; state.labelActive = -1; refreshLabelSuggestions();
    } else if (event.key === 'Tab') { state.labelOpen = false; state.labelActive = -1; refreshLabelSuggestions(); }
    return;
  }
  if ((event.target as HTMLElement).matches('input:not([type=radio]), textarea, select')) return;
  if (state.exportOpen && event.key === 'Tab') {
    const controls = [...root.querySelectorAll<HTMLElement>('.export-modal button:not(:disabled), .export-modal input:not(:disabled), .export-modal select:not(:disabled)')].filter(element => !element.closest('fieldset:disabled'));
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
  if (event.repeat && ['a', 's', 'd'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
  if (event.key.toLowerCase() === 'a') { event.preventDefault(); void markSelection('accepted'); }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); void markSelection(); }
  if (event.key.toLowerCase() === 'd') { event.preventDefault(); markSelection('rejected'); }
  if (event.key.toLowerCase() === 't') { event.preventDefault(); void actions['toggle-raw'](); }
  if (event.key.toLowerCase() === 'i') { event.preventDefault(); void actions.info(); }
  if (event.key === '?') { event.preventDefault(); void actions.help(); }
  if (event.key === 'Escape' && state.full) void actions.back();
  if (event.key === 'Enter' && selected()) { event.preventDefault(); setSingle(state.selectedId); state.full = true; render(); }
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'review-filter') { state.reviewFilter = input.value; clearSelection(); state.full = false; render(); root.querySelector<HTMLSelectElement>('#review-filter')?.focus(); }
  if (input.matches('[data-theme-switcher]')) {
    void setThemePreference(input.value).catch(() => { state.error = 'The theme preference could not be saved. Try again.'; render(); });
  }
  if (input.matches('[data-ollama-enabled]')) requestOllamaChange(input.checked);
  if (input.name === 'export-target' && !state.exportBusy && (input.value !== 'photos' || state.photosAvailable)) { state.exportTarget = input.value as 'folder' | 'photos'; state.exportResult = null; state.exportError = ''; refreshExportDialog(); }
  if (input.name === 'export-event' && !state.exportBusy) { state.exportEventId = input.value; state.exportResult = null; state.exportError = ''; refreshExportDialog(); }
  if (input.name === 'export-mode' && !state.exportBusy) { state.exportMode = input.value as 'selection' | 'accepted' | 'event'; state.exportResult = null; refreshExportDialog(); }
});
window.desktop?.onTagProgress(progress => {
  if (progress.jobId !== state.tagJobId) return;
  state.tagCompleted = progress.completed; state.tagTotal = progress.total;
  const photo = allPhotos.find(photo => photo.primary.id === progress.id);
  if (photo) {
    if (progress.tags) { tags.set(photo.id, progress.tags); tagErrors.delete(photo.id); }
    else if (progress.error) { tagErrors.set(photo.id, progress.error); reportError(`Could not label ${photo.primary.relativePath}.`, progress.error); }
    else tagErrors.delete(photo.id);
  }
  updateTagUI();
  if (progress.tags && (state.labelFilters.length || state.search)) scheduleScanRender();
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
const preferencesReady = window.desktop ? window.desktop.getLibrarySettings().then(settings => {
  state.eventGapMinutes = settings.eventGapMinutes; state.gapDraft = String(settings.eventGapMinutes); state.bookmarks = settings.bookmarks; state.libraryReady = true; render();
}).catch(error => { state.libraryReady = true; state.error = `Library settings could not be loaded. Default event gap is 30 minutes. ${errorMessage(error)}`; render(); }) : Promise.resolve().then(() => { state.libraryReady = true; });
render();
if (window.desktop) void window.desktop.listSources().then(sources => { state.sources = sources; render(); }).catch(error => reportError('Could not list cards and folders.', error));

window.desktop?.onSessionWarning(warning => { if (!state.demo && warning.sourcePath === state.source?.path) addCacheWarning(warning.message); });

window.desktop?.onOpenAbout(() => { if (!state.tagConfirmation) void openAbout(); });

root.addEventListener('focusin', event => {
  if ((event.target as HTMLElement).id === 'search') { state.labelOpen = true; state.labelActive = -1; refreshLabelSuggestions(); }
});
root.addEventListener('focusout', event => {
  if ((event.target as HTMLElement).id === 'search' && !(event.relatedTarget as HTMLElement | null)?.closest('.capture-search')) {
    state.labelOpen = false; state.labelActive = -1; refreshLabelSuggestions();
  }
});
root.addEventListener('pointerdown', event => {
  if ((event.target as HTMLElement).closest('[data-label]')) event.preventDefault();
  else if (!(event.target as HTMLElement).closest('.capture-search')) { state.labelOpen = false; state.labelActive = -1; refreshLabelSuggestions(); }
});

root.addEventListener('pointermove', event => {
  const track = (event.target as HTMLElement).closest<HTMLElement>('.review-progress-track');
  if (track) showReviewPreview(event, track);
});
root.addEventListener('pointerout', event => {
  if ((event.target as HTMLElement).closest('.review-progress-track') && !(event.relatedTarget as HTMLElement | null)?.closest('.review-progress-track')) hideReviewPreview();
});
root.addEventListener('focusout', event => { if ((event.target as HTMLElement).matches('.review-progress-track')) hideReviewPreview(); });

window.desktop?.onEventSummary(update => {
  if (state.demo || update.sourcePath !== state.source?.path) return;
  if (update.id && events.some(event => event.id === update.id)) {
    if (update.summary) { eventSummaries.set(update.id, update.summary); eventSummaryErrors.delete(update.id); }
    if (update.error) {
      eventSummaryErrors.set(update.id, update.error);
      const event = events.find(event => event.id === update.id)!;
      state.settingsError = `Event summary failed. ${errorMessage(update.error)}`;
      reportError(`Could not summarize event ${event.start}.`, update.error);
    }
  }
  if (update.completed !== undefined) {
    state.summaryCompleted = update.completed; state.summaryTotal = update.total ?? 0;
    state.summaryActive = !update.done; state.summaryCancelled = Boolean(update.cancelled);
  }
  updateEventSummaryUI(); refreshSettings();
});
