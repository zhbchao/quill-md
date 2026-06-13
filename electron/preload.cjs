const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('quill', {
  openDialog: () => ipcRenderer.invoke('doc:openDialog'),
  readFile: (filePath) => ipcRenderer.invoke('doc:readFile', filePath),
  save: (filePath, content) => ipcRenderer.invoke('doc:save', { path: filePath, content }),
  confirmChange: () => ipcRenderer.invoke('doc:confirmChange'),
  getPendingOpen: () => ipcRenderer.invoke('doc:getPendingOpen'),
  setEdited: (edited) => ipcRenderer.send('doc:setEdited', edited),
  setFile: (filePath) => ipcRenderer.send('doc:setFile', filePath),
  closeNow: () => ipcRenderer.send('doc:closeNow'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  smokeResult: (ok, detail) => ipcRenderer.send('smoke:result', ok, detail),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCommand: (callback) =>
    ipcRenderer.on('command', (event, name, arg) => callback(name, arg)),
});
