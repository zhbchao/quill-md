const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const isMac = process.platform === 'darwin';
const isSmoke = process.argv.includes('--smoke-test');
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// --screenshot <out.png> [--dark] [--file <doc.md>] renders offscreen and exits.
const shotIndex = process.argv.indexOf('--screenshot');
const isShot = shotIndex !== -1;
const shotOut = isShot ? process.argv[shotIndex + 1] : null;

let win = null;
let documentEdited = false;
let allowClose = false;
let pendingOpenPath = null;

const fileIndex = process.argv.indexOf('--file');
if (fileIndex !== -1) pendingOpenPath = process.argv[fileIndex + 1];
if (isShot) nativeTheme.themeSource = process.argv.includes('--dark') ? 'dark' : 'light';

app.setName('Quill');
app.setAboutPanelOptions({
  applicationName: 'Quill',
  applicationVersion: app.getVersion(),
  credits: 'A refined WYSIWYG Markdown editor.',
});

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1d' : '#fcfcfa';
}

function titleBarOverlay() {
  return {
    color: backgroundColor(),
    symbolColor: nativeTheme.shouldUseDarkColors ? '#e7e7e5' : '#1d1d1f',
    height: 52,
  };
}

// On macOS files arrive via the open-file event; elsewhere via argv.
// `cwd` matters for second instances: their relative paths are relative to
// THEIR working directory, not ours.
function fileFromArgv(argv, cwd) {
  const candidate = argv
    .slice(1)
    .find((a) => /\.(md|markdown|mdown|txt)$/i.test(a) && !a.startsWith('-'));
  if (!candidate) return null;
  const resolved = path.resolve(cwd || process.cwd(), candidate);
  return fsSync.existsSync(resolved) ? resolved : null;
}

function sendCommand(name, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('command', name, arg);
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 520,
    minHeight: 400,
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 19, y: 19 } }
      : { titleBarOverlay: titleBarOverlay() }),
    backgroundColor: backgroundColor(),
    // Packaged builds get the icon from the executable; dev needs it explicitly.
    ...(!isMac && !app.isPackaged
      ? { icon: path.join(__dirname, '..', 'build', 'icon.png') }
      : {}),
    title: 'Untitled',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      offscreen: isShot,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.once('ready-to-show', () => {
    if (!isSmoke && !isShot) win.show();
  });

  if (isShot) {
    setTimeout(() => {
      console.error('SHOT_TIMEOUT');
      app.exit(1);
    }, 30000);
    const scrollIndex = process.argv.indexOf('--scroll');
    const scrollTo = scrollIndex !== -1 ? Number(process.argv[scrollIndex + 1]) : 0;
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (scrollTo) {
            await win.webContents.executeJavaScript(
              `document.getElementById('scroll').scrollTop = ${scrollTo}; null`
            );
            await new Promise((r) => setTimeout(r, 300));
          }
          if (process.argv.includes('--select')) {
            await win.webContents.executeJavaScript(
              `window.__editor.chain().focus().setTextSelection({ from: 22, to: 45 }).run(); null`
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          const menuArg = process.argv.indexOf('--open-menu');
          if (menuArg !== -1) {
            await win.webContents.executeJavaScript(
              `window.__openMenu && window.__openMenu(${Number(process.argv[menuArg + 1]) || 0}); null`
            );
            await new Promise((r) => setTimeout(r, 300));
          }
          const image = await win.webContents.capturePage();
          await fs.writeFile(shotOut, image.toPNG());
          console.log('SHOT_OK', shotOut);
          app.exit(0);
        } catch (err) {
          console.error('SHOT_FAIL', err);
          app.exit(1);
        }
      }, 1500);
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (allowClose || !documentEdited) return;
    e.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Save…', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Do you want to save the changes you made to this document?',
        detail: "Your changes will be lost if you don't save them.",
      })
      .then(({ response }) => {
        if (response === 0) sendCommand('save-then-close');
        else if (response === 1) {
          allowClose = true;
          win.close();
        }
      });
  });

  if (isSmoke) {
    win.webContents.on('console-message', (e, level, message) => {
      const text = typeof message === 'string' ? message : e?.message;
      const lvl = typeof level === 'number' ? level : e?.level;
      if (lvl === 2 || lvl === 3 || lvl === 'error' || lvl === 'warning') {
        console.error('[renderer]', text);
      }
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => sendCommand('self-test'), 500);
    });
    setTimeout(() => {
      console.error('SMOKE_TIMEOUT');
      app.exit(1);
    }, 20000);
  }
}

nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(backgroundColor());
    if (process.platform === 'win32') win.setTitleBarOverlay(titleBarOverlay());
  }
});

function formatItem(label, command, accelerator) {
  return { label, accelerator, click: () => sendCommand(command) };
}

function buildMenu() {
  // Windows: titleBarStyle 'hidden' removes the native menu bar entirely, so
  // the renderer draws its own (src/main.js) and the native menu would only
  // duplicate accelerators. Editor shortcuts live in Tiptap's keymap; the
  // rest are bound in the renderer.
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        formatItem('New', 'new', 'CmdOrCtrl+N'),
        formatItem('Open…', 'open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        formatItem('Save', 'save', 'CmdOrCtrl+S'),
        formatItem('Save As…', 'save-as', 'Shift+CmdOrCtrl+S'),
        { type: 'separator' },
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        formatItem('Undo', 'undo', 'CmdOrCtrl+Z'),
        formatItem('Redo', 'redo', 'Shift+CmdOrCtrl+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        ...(isMac
          ? [
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
              },
            ]
          : []),
      ],
    },
    {
      label: 'Format',
      submenu: [
        formatItem('Bold', 'bold', 'CmdOrCtrl+B'),
        formatItem('Italic', 'italic', 'CmdOrCtrl+I'),
        formatItem('Strikethrough', 'strike', 'Shift+CmdOrCtrl+X'),
        formatItem('Inline Code', 'code', 'CmdOrCtrl+E'),
        formatItem('Link…', 'link', 'CmdOrCtrl+K'),
        { type: 'separator' },
        formatItem('Heading 1', 'h1', 'Alt+CmdOrCtrl+1'),
        formatItem('Heading 2', 'h2', 'Alt+CmdOrCtrl+2'),
        formatItem('Heading 3', 'h3', 'Alt+CmdOrCtrl+3'),
        formatItem('Body', 'paragraph', 'Alt+CmdOrCtrl+0'),
        { type: 'separator' },
        formatItem('Bulleted List', 'bulletList', 'Shift+CmdOrCtrl+8'),
        formatItem('Numbered List', 'orderedList', 'Shift+CmdOrCtrl+7'),
        formatItem('Task List', 'taskList', 'Shift+CmdOrCtrl+9'),
        { type: 'separator' },
        formatItem('Blockquote', 'blockquote', 'Shift+CmdOrCtrl+B'),
        formatItem('Code Block', 'codeBlock', 'Alt+CmdOrCtrl+C'),
        formatItem('Divider', 'hr'),
      ],
    },
    {
      label: 'Table',
      submenu: [
        formatItem('Insert Table', 'tableInsert', 'Alt+CmdOrCtrl+T'),
        { type: 'separator' },
        formatItem('Add Row Above', 'tableRowAbove'),
        formatItem('Add Row Below', 'tableRowBelow'),
        formatItem('Delete Row', 'tableRowDelete'),
        { type: 'separator' },
        formatItem('Add Column Before', 'tableColBefore'),
        formatItem('Add Column After', 'tableColAfter'),
        formatItem('Delete Column', 'tableColDelete'),
        { type: 'separator' },
        formatItem('Delete Table', 'tableDelete'),
      ],
    },
    {
      label: 'View',
      submenu: [
        formatItem('Markdown Source', 'toggle-source', 'CmdOrCtrl+/'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC ---

function showFileError(verb, filePath, err) {
  if (!win || win.isDestroyed()) return;
  dialog.showMessageBox(win, {
    type: 'error',
    message: `The document could not be ${verb}.`,
    detail: `${filePath}\n\n${(err && err.message) || err}`,
    buttons: ['OK'],
  });
}

ipcMain.handle('doc:openDialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths[0]) return null;
  try {
    const content = await fs.readFile(filePaths[0], 'utf8');
    return { path: filePaths[0], content };
  } catch (err) {
    showFileError('opened', filePaths[0], err);
    return null;
  }
});

ipcMain.handle('doc:readFile', async (e, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  } catch (err) {
    showFileError('opened', filePath, err);
    return null;
  }
});

ipcMain.handle('doc:save', async (e, { path: filePath, content }) => {
  let target = filePath;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      defaultPath: 'Untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !chosen) return null;
    target = chosen;
  }
  // Write-then-rename so a crash or full disk mid-write can never leave the
  // user's file truncated; the rename replaces the target in one step.
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.quill-tmp`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
    return { path: target };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    showFileError('saved', target, err);
    return null;
  }
});

// 0 = save, 1 = discard, 2 = cancel
ipcMain.handle('doc:confirmChange', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save…', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Do you want to save the changes you made to this document?',
    detail: "Your changes will be lost if you don't save them.",
  });
  return response;
});

ipcMain.handle('doc:getPendingOpen', async () => {
  if (!pendingOpenPath) return null;
  const p = pendingOpenPath;
  pendingOpenPath = null;
  try {
    const content = await fs.readFile(p, 'utf8');
    return { path: p, content };
  } catch {
    return null;
  }
});

ipcMain.on('doc:setEdited', (e, edited) => {
  documentEdited = Boolean(edited);
  if (win && !win.isDestroyed() && isMac) win.setDocumentEdited(documentEdited);
});

ipcMain.on('doc:setFile', (e, filePath) => {
  if (!win || win.isDestroyed()) return;
  if (isMac) win.setRepresentedFilename(filePath || '');
  win.setTitle(filePath ? path.basename(filePath) : 'Untitled');
});

ipcMain.on('doc:closeNow', () => {
  allowClose = true;
  if (win && !win.isDestroyed()) win.close();
});

// Clipboard/window actions the custom Windows menu bar can't do from the
// renderer. Allowlisted — nothing else is reachable over this channel.
const EDIT_ACTIONS = new Set(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll', 'delete']);
ipcMain.on('menu:action', (e, name) => {
  if (!win || win.isDestroyed()) return;
  if (EDIT_ACTIONS.has(name)) win.webContents[name]();
  else if (name === 'quit') app.quit();
  else if (name === 'toggle-fullscreen') win.setFullScreen(!win.isFullScreen());
});

ipcMain.on('shell:openExternal', (e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

ipcMain.on('smoke:result', (e, ok, detail) => {
  if (!isSmoke) return;
  if (ok) console.log('SMOKE_OK');
  else console.error('SMOKE_FAIL', detail || '');
  setTimeout(() => app.exit(ok ? 0 : 1), 150);
});

// --- App lifecycle ---

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (win && !win.isDestroyed()) {
    fs.readFile(filePath, 'utf8')
      .then((content) => sendCommand('load-file', { path: filePath, content }))
      .catch(() => {});
  } else {
    pendingOpenPath = filePath;
  }
});

// Windows: route "Open With" / double-clicked files through a single instance.
if (process.platform === 'win32' && !isSmoke && !isShot) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (e, argv, workingDirectory) => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      const filePath = fileFromArgv(argv, workingDirectory);
      if (filePath) {
        fs.readFile(filePath, 'utf8')
          .then((content) => sendCommand('load-file', { path: filePath, content }))
          .catch(() => {});
      }
    });
  }
  const launchFile = fileFromArgv(process.argv);
  if (launchFile) pendingOpenPath = launchFile;
}

app.whenReady().then(() => {
  if (!app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
    } catch {
      /* icon is cosmetic; ignore if missing */
    }
  }
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
