const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  createDownloader,
  getExtensionFromContentType
} = require('./services/downloader');

let mainWindow;
let captureWindow;
let activeDownloader = null;
let capturedVideos = [];
const CAPTURE_PARTITION = 'persist:douyin-login';
const DEFAULT_CAPTURE_URL = 'https://www.douyin.com/';
const CAPTURE_SCROLLBAR_CSS = `
html,
body,
* {
  scrollbar-width: thin !important;
  scrollbar-color: rgba(112, 124, 136, 0.62) transparent !important;
}

::-webkit-scrollbar {
  width: 12px !important;
  height: 12px !important;
}

::-webkit-scrollbar-track,
::-webkit-scrollbar-track-piece {
  margin: 8px !important;
  background: transparent !important;
  border: 0 !important;
  border-radius: 999px !important;
}

::-webkit-scrollbar-thumb {
  min-height: 56px !important;
  background-color: rgba(102, 116, 130, 0.62) !important;
  border: 4px solid transparent !important;
  border-radius: 999px !important;
  background-clip: padding-box !important;
}

::-webkit-scrollbar-thumb:hover {
  background-color: rgba(75, 89, 104, 0.82) !important;
  border: 3px solid transparent !important;
  background-clip: padding-box !important;
}

::-webkit-scrollbar-button,
::-webkit-scrollbar-corner {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  background: transparent !important;
}
`;

function getCaptureUserAgent() {
  const chromeVersion = process.versions.chrome || '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function injectCaptureScrollbarStyles(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.insertCSS(CAPTURE_SCROLLBAR_CSS, { cssOrigin: 'user' })
    .catch(() => {});
}

function setupCaptureWindowStyling(window) {
  const webContents = window.webContents;
  webContents.on('dom-ready', () => injectCaptureScrollbarStyles(webContents));
  webContents.on('did-frame-finish-load', () => injectCaptureScrollbarStyles(webContents));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: '短视频链接下载器',
    icon: path.join(__dirname, 'assets', 'app-icon.ico'),
    frame: false,
    transparent: true,
    hasShadow: true,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.on('maximize', () => sendToRenderer('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => sendToRenderer('window:state', { maximized: false }));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function getDefaultOutputDir() {
  return path.join(app.getPath('downloads'), 'ShortVideoDownloads');
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function sanitizeCaptureFilename(value) {
  return String(value || 'captured-video')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'captured-video';
}

function normalizeCaptureUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    return DEFAULT_CAPTURE_URL;
  }

  const sharedUrl = value.match(/https?:\/\/[^\s"'<>]+/i);
  if (sharedUrl) {
    return sharedUrl[0].replace(/[，。！？、,.)\]}）】]+$/u, '');
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://${value}`;
}

function openCaptureWindow(rawUrl) {
  const targetUrl = normalizeCaptureUrl(rawUrl);

  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.loadURL(targetUrl);
    return;
  }

  captureWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: '内置视频捕获',
    backgroundColor: '#ffffff',
    parent: mainWindow,
    webPreferences: {
      partition: CAPTURE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  captureWindow.webContents.setUserAgent(getCaptureUserAgent());
  setupCaptureWindowStyling(captureWindow);
  setupCaptureHooks(captureWindow);

  captureWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      captureWindow.loadURL(url);
    }
    return { action: 'deny' };
  });

  captureWindow.on('closed', () => {
    captureWindow = null;
  });

  captureWindow.loadURL(targetUrl);
}

function isLikelyVideoResponse(details) {
  const headers = details.responseHeaders || {};
  const contentTypeHeader = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
  const contentType = contentTypeHeader ? String(headers[contentTypeHeader][0] || '') : '';
  const normalizedType = contentType.toLowerCase();
  const normalizedUrl = String(details.url || '').toLowerCase();
  const looksLikeVideoUrl = /(^|[/?&._-])(video|media-video|video_mp4|mp4|webm)([/?&._=-]|$)|mime_type=video|finder\.video\.qq\.com|mpvideo|wxvideo/i.test(normalizedUrl);

  if (
    normalizedType.startsWith('audio/') ||
    /(^|[/_-])audio([/_-]|$)/i.test(normalizedUrl) ||
    /mp4a|m4a|mime_type=audio/i.test(normalizedUrl)
  ) {
    return false;
  }

  if (!normalizedType.startsWith('video/')) {
    return details.resourceType === 'media' &&
      /application\/octet-stream|binary\/octet-stream|^$/i.test(normalizedType) &&
      looksLikeVideoUrl;
  }

  return !/media-audio|audio-und|audio_und|mp4a/i.test(normalizedUrl);
}

function extractNumberFromUrl(rawUrl, key) {
  try {
    const value = new URL(rawUrl).searchParams.get(key);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function getCaptureScore(video) {
  const url = String(video.url || '').toLowerCase();
  const contentType = String(video.contentType || '').toLowerCase();
  let score = 0;

  if (contentType.startsWith('video/')) score += 1000;
  if (/mime_type=video|video_mp4|video\/tos|\/video\/|finder\.video\.qq\.com|mpvideo|wxvideo/i.test(url)) score += 300;
  if (/media-audio|audio-und|audio_und|mp4a|m4a|mime_type=audio/i.test(url)) score -= 2000;
  score += Math.min(extractNumberFromUrl(video.url, 'br'), 10000);
  score += Math.min(extractNumberFromUrl(video.url, 'bt'), 10000);
  score += Math.floor((video.capturedAt || 0) / 100000000);

  return score;
}

function setupCaptureHooks(window) {
  const filter = { urls: ['*://*/*'] };
  const webContents = window.webContents;
  const cookieSession = webContents.session;
  const requestHeaders = new Map();

  cookieSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (details.resourceType === 'media' || /\.(mp4|webm|mov)(\?|$)/i.test(details.url)) {
      requestHeaders.set(details.id, details.requestHeaders || {});
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  cookieSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (isLikelyVideoResponse(details)) {
      const headers = requestHeaders.get(details.id) || {};
      const contentTypeKey = Object.keys(details.responseHeaders || {}).find(key => key.toLowerCase() === 'content-type');
      const contentType = contentTypeKey ? String(details.responseHeaders[contentTypeKey][0] || '') : '';
      const title = sanitizeCaptureFilename(webContents.getTitle());
      const filename = `${title}-${Date.now()}${getExtensionFromContentType(contentType)}`;
      const captured = {
        id: `${Date.now()}-${capturedVideos.length}`,
        url: details.url,
        pageUrl: webContents.getURL(),
        title,
        filename,
        contentType,
        capturedAt: Date.now(),
        headers: {
          'User-Agent': headers['User-Agent'] || headers['user-agent'] || getCaptureUserAgent(),
          Referer: headers.Referer || headers.referer || webContents.getURL()
        }
      };

      capturedVideos = [captured, ...capturedVideos.filter(item => item.url !== captured.url)].slice(0, 20);
      sendToRenderer('capture:event', {
        type: 'video-captured',
        count: capturedVideos.length,
        latest: {
          id: captured.id,
          url: captured.url,
          title: captured.title,
          filename: captured.filename,
          contentType: captured.contentType,
          capturedAt: captured.capturedAt
        }
      });
    }

    requestHeaders.delete(details.id);
    callback({ responseHeaders: details.responseHeaders });
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-config', () => {
  const outputDir = getDefaultOutputDir();

  return {
    outputDir,
    maximized: mainWindow ? mainWindow.isMaximized() : false,
    platform: process.platform
  };
});

ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { maximized: false };
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }

  return { maximized: mainWindow.isMaximized() };
});

ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.handle('dialog:pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存目录',
    defaultPath: getDefaultOutputDir(),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('capture:open-window', (_event, rawUrl) => {
  openCaptureWindow(rawUrl);
  return { ok: true };
});

ipcMain.handle('auth:open-douyin-login', () => {
  openCaptureWindow(DEFAULT_CAPTURE_URL);
  return { ok: true };
});

ipcMain.handle('capture:get-latest-video', () => {
  const latest = capturedVideos
    .filter(video => isLikelyVideoResponse({
      url: video.url,
      resourceType: 'media',
      responseHeaders: { 'content-type': [video.contentType] }
    }))
    .sort((a, b) => getCaptureScore(b) - getCaptureScore(a))[0];

  if (!latest) {
    return {
      ok: false,
      message: '还没有捕获到视频流。请先在内置捕获窗口里打开目标视频并让它开始播放。'
    };
  }

  return {
    ok: true,
    video: {
      id: latest.id,
      url: latest.url,
      title: latest.title,
      filename: latest.filename,
      contentType: latest.contentType,
      capturedAt: latest.capturedAt
    }
  };
});

ipcMain.handle('download:start', async (_event, options) => {
  if (activeDownloader) {
    return { ok: false, message: '已有下载任务正在运行。' };
  }

  const urls = Array.isArray(options?.urls) ? options.urls : [];
  const uniqueUrls = [...new Set(urls.map(url => String(url).trim()).filter(Boolean))];

  if (uniqueUrls.length === 0) {
    return { ok: false, message: '没有识别到可下载链接。' };
  }

  const outputDir = options?.outputDir || getDefaultOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });

  activeDownloader = createDownloader(app, {
    session: session.fromPartition(CAPTURE_PARTITION),
    webContents: captureWindow && !captureWindow.isDestroyed() ? captureWindow.webContents : null,
    urls: uniqueUrls,
    outputDir,
    capturedVideos: Object.fromEntries(capturedVideos.map(video => [video.url, video])),
    onEvent: payload => sendToRenderer('download:event', payload)
  });

  activeDownloader.run()
    .catch(error => {
      sendToRenderer('download:event', {
        type: 'batch-error',
        message: error.message || String(error)
      });
    })
    .finally(() => {
      activeDownloader = null;
      sendToRenderer('download:event', { type: 'batch-complete' });
    });

  return { ok: true, count: uniqueUrls.length, outputDir };
});

ipcMain.handle('download:cancel', () => {
  if (!activeDownloader) {
    return { ok: false, message: '没有正在运行的任务。' };
  }

  activeDownloader.cancel();
  return { ok: true };
});

ipcMain.handle('shell:open-path', async (_event, targetPath) => {
  if (!targetPath) {
    return { ok: false, message: '路径为空。' };
  }

  const errorMessage = await shell.openPath(targetPath);
  return errorMessage ? { ok: false, message: errorMessage } : { ok: true };
});
