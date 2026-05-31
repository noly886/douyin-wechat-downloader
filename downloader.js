const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

const DIRECT_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

async function downloadWithSessionFetch(session, url, destination, onProgress, requestOptions = {}) {
  const controller = new AbortController();
  if (typeof requestOptions.onCancel === 'function') {
    requestOptions.onCancel(() => controller.abort());
  }

  const headers = {};
  for (const [name, value] of Object.entries(requestOptions.headers || {})) {
    if (value != null && String(value).trim()) {
      headers[name] = String(value);
    }
  }

  const response = await session.fetch(url, {
    headers,
    redirect: 'follow',
    signal: controller.signal
  });

  if (!response.ok) {
    throw new Error(`下载失败，HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const file = fs.createWriteStream(destination);
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloaded += chunk.length;
      if (!file.write(chunk)) {
        await new Promise(resolve => file.once('drain', resolve));
      }

      if (typeof onProgress === 'function') {
        onProgress({
          downloaded,
          total,
          percent: total > 0 ? Math.round((downloaded / total) * 100) : null
        });
      }
    }
  } finally {
    file.end();
  }

  await new Promise((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

function downloadWithWebContents(webContents, session, url, destination, onProgress, requestOptions = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.reject(new Error('内置捕获窗口不可用，请重新打开内置捕获窗口并播放视频后再下载。'));
  }

  return new Promise((resolve, reject) => {
    let matched = false;
    let timeout = null;
    let activeItem = null;

    const cleanup = () => {
      clearTimeout(timeout);
      session.removeListener('will-download', handleDownload);
    };

    const handleDownload = (event, item) => {
      if (matched) {
        return;
      }

      const itemUrl = item.getURL();
      const urlChain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
      if (itemUrl !== url && !urlChain.includes(url)) {
        return;
      }

      matched = true;
      activeItem = item;
      item.setSavePath(destination);

      if (typeof requestOptions.onCancel === 'function') {
        requestOptions.onCancel(() => item.cancel());
      }

      item.on('updated', () => {
        const total = item.getTotalBytes();
        const downloaded = item.getReceivedBytes();
        if (typeof onProgress === 'function') {
          onProgress({
            downloaded,
            total,
            percent: total > 0 ? Math.round((downloaded / total) * 100) : null
          });
        }
      });

      item.once('done', (_event, state) => {
        cleanup();
        if (state === 'completed') {
          resolve();
          return;
        }

        reject(new Error(state === 'cancelled' ? '任务已取消。' : `下载中断：${state}`));
      });
    };

    session.on('will-download', handleDownload);
    timeout = setTimeout(() => {
      cleanup();
      if (activeItem) {
        activeItem.cancel();
      }
      reject(new Error('下载没有开始，可能被当前会话拦截。'));
    }, 30000);

    webContents.downloadURL(url, { headers: requestOptions.headers || {} });
  });
}

function isDirectVideoUrl(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    return DIRECT_VIDEO_EXTENSIONS.has(path.extname(parsedUrl.pathname).toLowerCase());
  } catch {
    return false;
  }
}

function sanitizeFilename(value) {
  return String(value || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function inferDirectFilename(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    const basename = path.basename(decodeURIComponent(parsedUrl.pathname));
    return sanitizeFilename(basename || `video-${Date.now()}.mp4`);
  } catch {
    return `video-${Date.now()}.mp4`;
  }
}

function getExtensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mp4')) return '.mp4';
  if (type.includes('webm')) return '.webm';
  if (type.includes('quicktime')) return '.mov';
  if (type.includes('mpegurl')) return '.m3u8';
  return '.mp4';
}

function createDownloader(app, options) {
  let activeCancel = null;
  let cancelled = false;

  function emit(payload) {
    if (typeof options.onEvent === 'function') {
      options.onEvent(payload);
    }
  }

  function cancel() {
    cancelled = true;
    if (activeCancel) {
      activeCancel();
    }
  }

  async function downloadDirectVideo(url, index) {
    const capture = options.capturedVideos?.[url];
    const filename = capture?.filename || inferDirectFilename(url);
    const filePath = path.join(options.outputDir, filename);

    emit({ type: 'item-start', index, url, method: 'direct', filename });

    const headers = capture?.headers || {};
    const runDownload = progressHandler => downloadWithWebContents(
      options.webContents,
      options.session,
      url,
      filePath,
      progressHandler,
      {
        headers,
        onCancel: cancelRequest => {
          activeCancel = cancelRequest;
        }
      }
    ).catch(error => {
      const message = error.message || String(error);
      if (!message.includes('拦截') && !message.includes('BLOCKED_BY_CLIENT')) {
        throw error;
      }

      return downloadWithSessionFetch(options.session, url, filePath, progressHandler, {
        headers,
        onCancel: cancelRequest => {
          activeCancel = cancelRequest;
        }
      });
    });

    await runDownload(progress => {
      emit({
        type: 'item-progress',
        index,
        percent: progress.percent,
        downloaded: progress.downloaded,
        total: progress.total
      });
    });

    activeCancel = null;

    emit({ type: 'item-success', index, url, filePath });
  }

  async function run() {
    emit({ type: 'batch-start', count: options.urls.length, outputDir: options.outputDir });

    for (let index = 0; index < options.urls.length; index += 1) {
      if (cancelled) {
        break;
      }

      const url = options.urls[index];

      try {
        if (!options.capturedVideos?.[url] && !isDirectVideoUrl(url)) {
          throw new Error('只支持内置窗口捕获到的视频流。');
        }
        await downloadDirectVideo(url, index);
      } catch (error) {
        const message = error.message || String(error);
        emit({
          type: 'item-error',
          index,
          url,
          message: message.includes('ERR_BLOCKED_BY_CLIENT')
            ? '请求被当前网络会话拦截。请关闭内置窗口里的拦截插件/代理规则，或把目标视频 CDN 域名加入代理直连/允许列表后重新捕获。'
            : message
        });
      }
    }
  }

  return { run, cancel };
}

module.exports = {
  createDownloader,
  getExtensionFromContentType
};
