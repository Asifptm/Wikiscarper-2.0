const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scraperAPI', {
  run: (opts) => ipcRenderer.invoke('scraper:run', opts),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  cacheClear: (opts) => ipcRenderer.invoke('cache:clear', opts),
  cacheList: () => ipcRenderer.invoke('cache:list'),
  reportList: () => ipcRenderer.invoke('report:list'),
  reportGet: (id) => ipcRenderer.invoke('report:get', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scraper:progress', listener);
    return () => ipcRenderer.removeListener('scraper:progress', listener);
  },
});
