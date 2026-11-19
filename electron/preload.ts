import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ScanProgress, ExportProgress, TagProgress, SessionWarning, EventSummaryUpdate } from '../shared/model';
const api: DesktopAPI = {
  exportPanorama: ids => ipcRenderer.invoke('export-panorama', ids),
  findSimilar: () => ipcRenderer.invoke('find-similar'),
  getEditVersions: id => ipcRenderer.invoke('get-edit-versions', id),
  chooseEditLut: id => ipcRenderer.invoke('choose-edit-lut', id),
  previewEdits: (id, edits) => ipcRenderer.invoke('preview-edits', id, edits),
  saveEditVersion: (id, edits, version) => ipcRenderer.invoke('save-edit-version', id, edits, version),
  exportEditVersions: (id, versions, options) => ipcRenderer.invoke('export-edit-versions', id, versions, options),
  getLibrarySettings: () => ipcRenderer.invoke('get-library-settings'),
  setEventGap: minutes => ipcRenderer.invoke('set-event-gap', minutes),
  toggleBookmark: folder => ipcRenderer.invoke('toggle-bookmark', folder),
  openBookmark: folder => ipcRenderer.invoke('open-bookmark', folder),
  reindex: source => ipcRenderer.invoke('reindex', source),
  getEventSummaries: () => ipcRenderer.invoke('get-event-summaries'),
  onEventSummary: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: EventSummaryUpdate) => callback(data);
    ipcRenderer.on('event-summary', listener); return () => ipcRenderer.removeListener('event-summary', listener);
  },
  onOpenAbout: callback => {
    const listener = () => callback();
    ipcRenderer.on('open-about', listener);
    return () => ipcRenderer.removeListener('open-about', listener);
  },
  getPhotoReviews: ids => ipcRenderer.invoke('get-photo-reviews', ids),
  setPhotoReviews: (ids, status) => ipcRenderer.invoke('set-photo-reviews', ids, status),
  onSessionWarning: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: SessionWarning) => callback(data);
    ipcRenderer.on('session-warning', listener);
    return () => ipcRenderer.removeListener('session-warning', listener);
  },
  getOllamaStatus: () => ipcRenderer.invoke('get-ollama-status'),
  setOllamaEnabled: enabled => ipcRenderer.invoke('set-ollama-enabled', enabled),
  getPhotoTags: ids => ipcRenderer.invoke('get-photo-tags', ids),
  tagPhotos: (ids, jobId) => ipcRenderer.invoke('tag-photos', ids, jobId),
  cancelTagging: () => ipcRenderer.invoke('cancel-tagging'),
  onTagProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: TagProgress) => callback(data);
    ipcRenderer.on('tag-progress', listener);
    return () => ipcRenderer.removeListener('tag-progress', listener);
  },
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: preference => ipcRenderer.invoke('set-theme', preference),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  listSources: () => ipcRenderer.invoke('list-sources'),
  scan: source => ipcRenderer.invoke('scan', source),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),
  getExportCapabilities: () => ipcRenderer.invoke('get-export-capabilities'),
  exportToPhotos: ids => ipcRenderer.invoke('export-to-photos', ids),
  getExportLocation: () => ipcRenderer.invoke('get-export-location'),
  chooseExportLocation: () => ipcRenderer.invoke('choose-export-location'),
  exportFiles: (ids, mode) => ipcRenderer.invoke('export-files', ids, mode),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  onExportProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: ExportProgress) => callback(data);
    ipcRenderer.on('export-progress', listener);
    return () => ipcRenderer.removeListener('export-progress', listener);
  },
  onProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: ScanProgress) => callback(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
};
contextBridge.exposeInMainWorld('desktop', api);
