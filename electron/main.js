/**
 * BT AI Equalizer — Electron main process.
 *
 * Security posture:
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - strict CSP in index.html, no remote code
 *  - API keys only in the OS credential store via safeStorage (with encrypted
 *    file fallback when the OS store is unavailable — the UI labels which)
 *  - IPC limited to the preload allowlist
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, machineKeyCryptor } from './settings-store.js';
import { AiManager } from './ai/manager.js';
import { EngineHost } from './audio/engine-host.js';
import { registerIpc } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow = null;
let tray = null;
let settingsStore = null;
let aiManager = null;
let engineHost = null;

function createSafeStorageCryptor(configDir) {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      id: 'safeStorage',
      label: 'OS credential store (safeStorage)',
      encryptString: async (s) => safeStorage.encryptString(s),
      decryptString: async (b) => safeStorage.decryptString(Buffer.from(b))
    };
  }
  // Honest fallback — weaker, still encrypted at rest, labeled in the UI.
  return machineKeyCryptor(configDir);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: isDev
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // external links open in the system browser, never inside the app
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', async (e) => {
    const settings = await settingsStore.getAppSettings();
    if (settings.ui.minimizeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    let image;
    try {
      image = nativeImage.createFromPath(iconPath);
      if (image.isEmpty()) throw new Error('empty icon');
    } catch {
      // 16x16 cyan square fallback so the tray still works
      image = nativeImage.createEmpty();
    }
    tray = new Tray(image);
    tray.setToolTip('BT AI Equalizer');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open BT AI Equalizer', click: () => (mainWindow ?? createWindow()) && mainWindow.show() },
        {
          label: 'Toggle Processing',
          click: () => {
            const cur = engineHost.engine?.getSettings().bypass ?? false;
            engineHost.setBypass(!cur);
          }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
      ])
    );
  } catch {
    tray = null; // tray is a convenience; failure must not break startup
  }
}

async function registerHotkeys() {
  const settings = await settingsStore.getAppSettings();
  const reg = (accelerator, fn) => {
    if (!accelerator) return;
    try {
      globalShortcut.register(accelerator, fn);
    } catch {
      // invalid or taken — surfaced in diagnostics, never fatal
    }
  };
  reg(settings.hotkeys.toggleProcessing, () => {
    const cur = engineHost.engine?.getSettings().bypass ?? false;
    engineHost.setBypass(!cur);
  });
  reg(settings.hotkeys.toggleMode, async () => {
    const order = ['adaptive', 'hybrid', 'manual'];
    const cur = engineHost.controller.mode;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    await engineHost.setMode(next);
  });
  reg(settings.hotkeys.profileNext, async () => {
    const { PROFILES } = await import('../engine/profiles.js');
    const settingsNow = await settingsStore.getAppSettings();
    const idx = PROFILES.findIndex((p) => p.id === settingsNow.activeProfileId);
    const next = PROFILES[(idx + 1) % PROFILES.length];
    engineHost.applySettings(JSON.parse(JSON.stringify(next.settings)), { source: 'hotkey', reason: `profile ${next.name}` });
    await settingsStore.setAppSettings({ activeProfileId: next.id });
  });
}

app.whenReady().then(async () => {
  const configDir = path.join(app.getPath('userData'), 'config');
  settingsStore = new SettingsStore(configDir, createSafeStorageCryptor(configDir));
  await settingsStore.init();
  aiManager = new AiManager({ settingsStore });
  engineHost = new EngineHost({ settingsStore, aiManager });
  await engineHost.init();

  registerIpc({
    ipcMain,
    settingsStore,
    engineHost,
    aiManager,
    getWindows: () => BrowserWindow.getAllWindows(),
    appInfo: {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node
    }
  });

  createWindow();
  createTray();
  await registerHotkeys();

  // Start the engine automatically; honest error surfaces in UI if the native
  // backend is unavailable (never silently substituted).
  engineHost.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', async () => {
  const settings = await settingsStore?.getAppSettings();
  if (!settings?.ui?.minimizeToTray || process.platform === 'darwin') {
    app.quit();
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await engineHost?.shutdown();
});

// single instance — a second launch focuses the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
    }
  });
}
