const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { ScraperEngine } = require('../core/scraper');
const { registerIpcHandlers } = require('./ipc-handlers');
const { createTray } = require('./tray');
const { ROOT } = require('../shared/config');

let mainWindow = null;
const engine = new ScraperEngine();

function getRendererPath() {
  const distIndex = path.join(ROOT, 'dist/index.html');
  if (fs.existsSync(distIndex)) return distIndex;
  return path.join(ROOT, 'src/renderer/index.html');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'ElectronScraper Pro',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(getRendererPath());

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(engine, () => mainWindow);
  createWindow();
  createTray(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await engine.close();
});
