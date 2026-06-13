// Renders build/icon.html to a 1024x1024 transparent PNG.
// Usage: npx electron build/render-icon.cjs <out.png>
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const out = process.argv[2] || '/tmp/icon.png';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  win.loadFile(path.join(__dirname, 'icon.html'));
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        await fs.writeFile(out, image.toPNG());
        console.log('ICON_OK', out);
        app.exit(0);
      } catch (err) {
        console.error('ICON_FAIL', err);
        app.exit(1);
      }
    }, 800);
  });
});
