const state = {
  outputDir: '',
  urls: [],
  running: false,
  tasks: new Map(),
  disposers: []
};

const elements = {
  minimizeBtn: document.querySelector('#minimizeBtn'),
  maximizeBtn: document.querySelector('#maximizeBtn'),
  closeBtn: document.querySelector('#closeBtn'),
  toolStatus: document.querySelector('#toolStatus'),
  openFolderBtn: document.querySelector('#openFolderBtn'),
  pageUrlInput: document.querySelector('#pageUrlInput'),
  linkInput: document.querySelector('#linkInput'),
  outputDir: document.querySelector('#outputDir'),
  chooseDirBtn: document.querySelector('#chooseDirBtn'),
  openCaptureBtn: document.querySelector('#openCaptureBtn'),
  openDouyinHomeBtn: document.querySelector('#openDouyinHomeBtn'),
  openWechatChannelsBtn: document.querySelector('#openWechatChannelsBtn'),
  useCapturedBtn: document.querySelector('#useCapturedBtn'),
  captureStatus: document.querySelector('#captureStatus'),
  startBtn: document.querySelector('#startBtn'),
  cancelBtn: document.querySelector('#cancelBtn'),
  batchStatus: document.querySelector('#batchStatus'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  tasks: document.querySelector('#tasks'),
  logBox: document.querySelector('#logBox')
};

function setWindowMaximized(maximized) {
  document.body.classList.toggle('is-maximized', Boolean(maximized));
  elements.maximizeBtn.textContent = maximized ? '❐' : '□';
  elements.maximizeBtn.title = maximized ? '还原' : '最大化';
  elements.maximizeBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
}

function setRunning(running) {
  state.running = running;
  elements.startBtn.disabled = running;
  elements.cancelBtn.disabled = !running;
  elements.useCapturedBtn.disabled = running;
  elements.openCaptureBtn.disabled = running;
  elements.openDouyinHomeBtn.disabled = running;
  elements.openWechatChannelsBtn.disabled = running;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  elements.logBox.textContent += `[${timestamp}] ${message}\n`;
  elements.logBox.scrollTop = elements.logBox.scrollHeight;
}

function renderTasks() {
  elements.tasks.innerHTML = '';

  if (state.tasks.size === 0) {
    elements.tasks.className = 'tasks empty-state';
    elements.tasks.textContent = '暂无任务';
    return;
  }

  elements.tasks.className = 'tasks';

  for (const task of state.tasks.values()) {
    const item = document.createElement('article');
    item.className = `task-item status-${task.status || 'queued'}`;

    const topLine = document.createElement('div');
    topLine.className = 'task-topline';

    const name = document.createElement('span');
    name.textContent = `#${task.index + 1} ${task.label || '等待中'}`;

    const percent = document.createElement('span');
    percent.textContent = task.percent == null ? '--' : `${Math.round(task.percent)}%`;

    topLine.append(name, percent);

    const url = document.createElement('div');
    url.className = 'task-url';
    url.title = task.url;
    url.textContent = task.url;

    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('span');
    bar.style.width = `${Math.max(0, Math.min(100, task.percent || 0))}%`;
    progress.append(bar);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const status = document.createElement('span');
    status.textContent = task.statusText || '';
    const details = document.createElement('span');
    details.textContent = [task.totalSize, task.speed, task.eta ? `ETA ${task.eta}` : '']
      .filter(Boolean)
      .join(' · ');

    meta.append(status, details);
    item.append(topLine, url, progress, meta);
    elements.tasks.append(item);
  }
}

function setCapturedUrl(url) {
  state.urls = url ? [url] : [];
  state.tasks.clear();

  state.urls.forEach((taskUrl, index) => {
    state.tasks.set(index, {
      index,
      url: taskUrl,
      status: 'queued',
      percent: 0,
      label: '已捕获',
      statusText: '排队'
    });
  });

  elements.batchStatus.textContent = state.urls.length > 0 ? '视频已捕获' : '等待捕获';
  renderTasks();
}

async function startDownload() {
  if (state.urls.length === 0) {
    appendLog('还没有可下载的捕获视频。');
    elements.captureStatus.textContent = '请先打开内置捕获窗口播放视频，再点击使用捕获视频';
    return;
  }

  setRunning(true);
  elements.batchStatus.textContent = '下载中';

  const result = await window.nativeApi.startDownload({
    urls: state.urls,
    outputDir: state.outputDir
  });

  if (!result.ok) {
    appendLog(result.message);
    elements.batchStatus.textContent = result.message;
    setRunning(false);
    return;
  }

  appendLog(`任务已开始，共 ${result.count} 个链接。`);
}

async function openCaptureWindow(url) {
  const targetUrl = url == null ? elements.pageUrlInput.value : url;
  const result = await window.nativeApi.openCaptureWindow(targetUrl);
  if (result.ok) {
    elements.captureStatus.textContent = '内置捕获窗口已打开，请播放目标视频';
    appendLog('内置视频捕获窗口已打开。');
  }
}

async function useLatestCapturedVideo() {
  const result = await window.nativeApi.getLatestCapturedVideo();

  if (!result.ok) {
    elements.captureStatus.textContent = result.message;
    appendLog(result.message);
    return;
  }

  elements.linkInput.value = result.video.url;
  elements.captureStatus.textContent = `已使用捕获视频：${result.video.filename} (${result.video.contentType || 'video'})`;
  appendLog(`已填入捕获视频直链：${result.video.filename} (${result.video.contentType || 'video'})`);
  setCapturedUrl(result.video.url);
}

function updateTask(index, patch) {
  const existing = state.tasks.get(index) || { index, url: patch.url || '' };
  state.tasks.set(index, { ...existing, ...patch });
  renderTasks();
}

function handleDownloadEvent(event) {
  switch (event.type) {
    case 'batch-start':
      elements.batchStatus.textContent = `共 ${event.count} 个任务`;
      appendLog(`保存目录：${event.outputDir}`);
      break;
    case 'tool-progress':
      if (event.percent != null) {
        elements.toolStatus.textContent = `正在下载组件 ${event.percent}%`;
      }
      break;
    case 'item-start':
      updateTask(event.index, {
        url: event.url,
        status: 'running',
        label: event.method === 'direct' ? '直链下载' : '解析下载',
        statusText: '运行中',
        percent: 0
      });
      appendLog(`#${event.index + 1} 开始：${event.url}`);
      break;
    case 'item-progress':
      updateTask(event.index, {
        status: 'running',
        percent: event.percent,
        speed: event.speed || '',
        eta: event.eta || '',
        totalSize: event.totalSize || formatBytes(event.total)
      });
      break;
    case 'item-log':
      appendLog(`#${event.index + 1} ${event.message}`);
      break;
    case 'item-success':
      updateTask(event.index, {
        status: 'success',
        label: '已完成',
        statusText: event.filePath || '完成',
        percent: 100
      });
      appendLog(`#${event.index + 1} 完成。`);
      break;
    case 'item-error':
      updateTask(event.index, {
        status: 'error',
        label: '失败',
        statusText: event.message,
        percent: 100
      });
      appendLog(`#${event.index + 1} 失败：${event.message}`);
      break;
    case 'batch-error':
      elements.batchStatus.textContent = '任务异常';
      appendLog(`任务异常：${event.message}`);
      setRunning(false);
      break;
    case 'batch-complete':
      elements.batchStatus.textContent = '任务结束';
      appendLog('任务结束。');
      setRunning(false);
      break;
    default:
      break;
  }
}

async function init() {
  const config = await window.nativeApi.getConfig();
  state.outputDir = config.outputDir;
  elements.outputDir.value = state.outputDir;
  elements.toolStatus.textContent = '使用内置浏览器捕获视频流';
  setWindowMaximized(config.maximized);

  state.disposers.push(window.nativeApi.onDownloadEvent(handleDownloadEvent));
  state.disposers.push(window.nativeApi.onCaptureEvent(event => {
    if (event.type === 'video-captured') {
      elements.captureStatus.textContent = `已捕获 ${event.count} 条视频流，最新：${event.latest.filename} (${event.latest.contentType || 'video'})`;
      appendLog(`捕获到视频流：${event.latest.filename} (${event.latest.contentType || 'video'})`);
    }
  }));
  state.disposers.push(window.nativeApi.onWindowState(event => {
    setWindowMaximized(event.maximized);
  }));

  elements.minimizeBtn.addEventListener('click', () => window.nativeApi.minimizeWindow());
  elements.maximizeBtn.addEventListener('click', async () => {
    const result = await window.nativeApi.toggleMaximizeWindow();
    setWindowMaximized(result.maximized);
  });
  elements.closeBtn.addEventListener('click', () => window.nativeApi.closeWindow());
  elements.openFolderBtn.addEventListener('click', () => window.nativeApi.openPath(state.outputDir));
  elements.chooseDirBtn.addEventListener('click', async () => {
    const selected = await window.nativeApi.pickDirectory();
    if (selected) {
      state.outputDir = selected;
      elements.outputDir.value = selected;
    }
  });
  elements.openCaptureBtn.addEventListener('click', () => openCaptureWindow());
  elements.openDouyinHomeBtn.addEventListener('click', () => {
    elements.pageUrlInput.value = 'https://www.douyin.com/';
    openCaptureWindow(elements.pageUrlInput.value);
  });
  elements.openWechatChannelsBtn.addEventListener('click', () => {
    elements.pageUrlInput.value = 'https://channels.weixin.qq.com/';
    openCaptureWindow(elements.pageUrlInput.value);
  });
  elements.useCapturedBtn.addEventListener('click', useLatestCapturedVideo);
  elements.startBtn.addEventListener('click', startDownload);
  elements.cancelBtn.addEventListener('click', async () => {
    const result = await window.nativeApi.cancelDownload();
    appendLog(result.ok ? '已发送取消请求。' : result.message);
  });
  elements.clearLogBtn.addEventListener('click', () => {
    elements.logBox.textContent = '';
  });

  window.addEventListener('beforeunload', () => {
    for (const dispose of state.disposers) {
      dispose();
    }
  });

  renderTasks();
}

init().catch(error => {
  appendLog(`启动失败：${error.message || error}`);
});
