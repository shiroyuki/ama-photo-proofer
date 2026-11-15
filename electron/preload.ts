import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ScanProgress, ExportProgress, TagProgress } from '../shared/model';
const api: DesktopAPI = {
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
  exportFiles: ids => ipcRenderer.invoke('export-files', ids),
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
