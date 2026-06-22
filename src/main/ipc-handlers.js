const { ipcMain, BrowserWindow, app } = require('electron');

function registerIpcHandlers(engine, getMainWindow) {
  ipcMain.handle('scraper:run', async (_, opts) => {
    engine.setProgressCallback((data) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('scraper:progress', data);
      }
    });

    try {
      const run = await engine.run(opts);
      return { success: true, run };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cache:stats', async () => engine.cache.getStats());

  ipcMain.handle('cache:clear', async (_, opts) => {
    if (opts?.url) engine.cache.delete(opts.url);
    else engine.cache.clear(opts?.layer);
    return engine.cache.getStats();
  });

  ipcMain.handle('cache:list', async () => engine.cache.list());

  ipcMain.handle('report:list', async () => engine.reporter.list());

  ipcMain.handle('report:get', async (_, id) => engine.reporter.get(id));

  ipcMain.handle('config:get', async () => engine.config);

  ipcMain.handle('app:quit', async () => {
    app.quit();
  });
}

module.exports = { registerIpcHandlers };
