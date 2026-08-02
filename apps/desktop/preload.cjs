const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("bitchatDesktopRadio", Object.freeze({
  start: (network) => ipcRenderer.invoke("bitchat-radio:start", network),
  stop: () => ipcRenderer.invoke("bitchat-radio:stop"),
  write: (data) => ipcRenderer.invoke("bitchat-radio:write", data),
  onEvent: (listener) => subscribe("bitchat-radio:event", listener)
}));

contextBridge.exposeInMainWorld("bitchatDesktopIdentity", Object.freeze({
  loadOrCreate: () => ipcRenderer.invoke("bitchat-identity:load-or-create")
}));
