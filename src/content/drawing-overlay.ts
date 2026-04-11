(() => {
  if (document.getElementById('devrecorder-fab')) return;

  // ── State ─────────────────────────────────────────
  type Tool = 'pen' | 'line' | 'arrow' | 'circle' | 'rectangle' | 'square' | 'text' | 'blur';
  let currentTool: Tool | null = null;
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let currentColor = '#ff4444';
  let currentWidth = 3;
  let blurOpacity = 0.5;
  let snapshot: ImageData | null = null;

  // ── Canvas state persistence ────────────────────
  // Save canvas as dataURL to chrome.storage.session so it survives tab switches
  function saveCanvasState() {
    try {
      // Save at logical (CSS) pixel size so it restores correctly on any tab
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = window.innerWidth;
      tempCanvas.height = window.innerHeight;
      const tempCtx = tempCanvas.getContext('2d')!;
      tempCtx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
      const dataUrl = tempCanvas.toDataURL('image/png');
      chrome.storage.session.set({ devrecorderCanvas: dataUrl });
    } catch {
      // ignore
    }
  }

  function restoreCanvasState() {
    try {
      chrome.storage.session.get('devrecorderCanvas', (result) => {
        if (chrome.runtime.lastError || !result || !result.devrecorderCanvas) return;
        const img = new Image();
        img.onload = () => {
          // Draw at logical size, ctx.scale handles DPR
          ctx.drawImage(img, 0, 0, window.innerWidth, window.innerHeight);
        };
        img.src = result.devrecorderCanvas;
      });
    } catch {
      // storage.session may not be available
    }
  }

  // Debounced save — save after each draw action
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCanvasState, 300);
  }

  // ── Inject styles ─────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes devrecorder-fab-in {
      from { transform: scale(0); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes devrecorder-pulse {
      0% { box-shadow: 0 4px 20px rgba(239,68,68,0.4), 0 0 0 0 rgba(239,68,68,0.3); }
      70% { box-shadow: 0 4px 20px rgba(239,68,68,0.4), 0 0 0 10px rgba(239,68,68,0); }
      100% { box-shadow: 0 4px 20px rgba(239,68,68,0.4), 0 0 0 0 rgba(239,68,68,0); }
    }
    #devrecorder-toolbar::-webkit-scrollbar { width: 0; }
  `;
  document.head.appendChild(style);

  // ── Recording Control Bar ────────────────────────────
  let isPaused = false;
  let elapsedSeconds = 0;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  function formatTime(totalSec: number): string {
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  const controlBar = document.createElement('div');
  controlBar.id = 'devrecorder-control-bar';
  controlBar.style.cssText = `
    position:fixed;bottom:24px;left:24px;z-index:2147483647;
    display:flex;align-items:center;gap:6px;
    height:40px;padding:0 10px 0 6px;
    background:#1a1b2e;border-radius:24px;
    box-shadow:0 4px 24px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.06);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    user-select:none;
    animation:devrecorder-fab-in 0.3s ease-out;
  `;

  // Recording dot indicator
  const recDot = document.createElement('div');
  recDot.style.cssText = `
    width:8px;height:8px;border-radius:50%;background:#ef4444;
    animation:devrecorder-pulse 1.5s ease-out infinite;
    flex-shrink:0;margin-left:4px;
  `;

  // Timer display
  const timerDisplay = document.createElement('span');
  timerDisplay.textContent = '00:00';
  timerDisplay.style.cssText = `
    color:#fff;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;
    min-width:40px;text-align:center;letter-spacing:0.5px;
  `;

  // Pause/Play button
  const pausePlayBtn = document.createElement('button');
  const pauseIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  const playIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>`;
  pausePlayBtn.innerHTML = pauseIcon;
  pausePlayBtn.title = 'Pause recording';
  pausePlayBtn.style.cssText = `
    width:28px;height:28px;border-radius:50%;border:none;
    background:rgba(255,255,255,0.1);
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;transition:background 0.15s;padding:0;
  `;
  pausePlayBtn.onmouseenter = () => { pausePlayBtn.style.background = 'rgba(255,255,255,0.2)'; };
  pausePlayBtn.onmouseleave = () => { pausePlayBtn.style.background = 'rgba(255,255,255,0.1)'; };
  pausePlayBtn.onclick = (e) => {
    e.stopPropagation();
    if (isPaused) {
      chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    } else {
      chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    }
  };

  // Divider
  const divider = document.createElement('div');
  divider.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.1);flex-shrink:0;';

  // Annotation (pencil) button
  const annotateBtn = document.createElement('button');
  annotateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
  annotateBtn.title = 'Annotation tools';
  annotateBtn.style.cssText = `
    width:28px;height:28px;border-radius:50%;border:none;
    background:rgba(255,255,255,0.1);
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;transition:background 0.15s;padding:0;
  `;
  annotateBtn.onmouseenter = () => { annotateBtn.style.background = 'rgba(255,255,255,0.2)'; };
  annotateBtn.onmouseleave = () => { annotateBtn.style.background = 'rgba(255,255,255,0.1)'; };

  controlBar.appendChild(recDot);
  controlBar.appendChild(timerDisplay);
  controlBar.appendChild(pausePlayBtn);
  controlBar.appendChild(divider);
  controlBar.appendChild(annotateBtn);

  function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      if (!isPaused) {
        elapsedSeconds++;
        timerDisplay.textContent = formatTime(elapsedSeconds);
      }
    }, 1000);
  }

  function setPausedState(paused: boolean) {
    isPaused = paused;
    pausePlayBtn.innerHTML = paused ? playIcon : pauseIcon;
    pausePlayBtn.title = paused ? 'Resume recording' : 'Pause recording';
    recDot.style.background = paused ? '#666' : '#ef4444';
    recDot.style.animation = paused ? 'none' : 'devrecorder-pulse 1.5s ease-out infinite';
  }

  // Listen for pause/resume messages from service worker
  function onControlMessage(msg: any) {
    if (msg?.type === 'DEVRECORDER_PAUSED') setPausedState(true);
    if (msg?.type === 'DEVRECORDER_RESUMED') setPausedState(false);
  }
  chrome.runtime.onMessage.addListener(onControlMessage);

  startTimer();

  // ── FAB (hidden by default, replaced by control bar) ──
  const fab = document.createElement('div');
  fab.id = 'devrecorder-fab';
  fab.style.cssText = 'display:none;';

  // ── Toolbar ───────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.id = 'devrecorder-toolbar';
  toolbar.style.cssText = `
    position:fixed;bottom:24px;left:24px;z-index:2147483647;
    display:none;flex-direction:column;align-items:center;gap:3px;
    width:42px;max-height:780px;overflow-y:auto;padding:6px 3px;
    background:#1a1b2e;border-radius:12px;
    box-shadow:0 8px 40px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.06);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    user-select:none;pointer-events:all;
    animation:devrecorder-fab-in 0.2s ease-out;
  `;

  // ── Helper: icon button ───────────────────────────
  function makeBtn(svg: string, title: string, size = 30): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.innerHTML = svg;
    btn.title = title;
    btn.style.cssText = `
      width:${size}px;height:${size}px;min-height:${size}px;border:none;border-radius:8px;
      background:#252640;color:#e0e0e8;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      transition:background 0.15s;padding:0;
    `;
    btn.onmouseenter = () => { if (!btn.dataset.active) btn.style.background = '#333458'; };
    btn.onmouseleave = () => { if (!btn.dataset.active) btn.style.background = '#252640'; };
    return btn;
  }

  // SVG icons
  const icons: Record<Tool, string> = {
    pen: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
    line: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>`,
    arrow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>`,
    circle: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`,
    rectangle: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="1"/></svg>`,
    square: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>`,
    text: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/></svg>`,
    blur: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  };

  const toolOrder: Tool[] = ['pen', 'line', 'arrow', 'circle', 'rectangle', 'square', 'text', 'blur'];
  const toolBtns = new Map<Tool, HTMLButtonElement>();

  // Selecting a tool activates drawing; selecting same tool deselects
  function selectTool(tool: Tool) {
    if (currentTool === tool) {
      // Deselect
      deselectTool();
      return;
    }
    currentTool = tool;
    toolBtns.forEach((btn, t) => {
      const active = t === tool;
      btn.dataset.active = active ? '1' : '';
      btn.style.background = active ? '#ef4444' : '#252640';
    });
    updateOpacityVisibility();
    activateDrawing();
  }

  function deselectTool() {
    currentTool = null;
    toolBtns.forEach((btn) => {
      btn.dataset.active = '';
      btn.style.background = '#252640';
    });
    updateOpacityVisibility();
    deactivateDrawing();
  }

  toolOrder.forEach((t) => {
    const btn = makeBtn(icons[t], t.charAt(0).toUpperCase() + t.slice(1));
    btn.onclick = (e) => { e.stopPropagation(); selectTool(t); };
    toolBtns.set(t, btn);
    toolbar.appendChild(btn);
  });

  // Separator
  const sep = () => {
    const d = document.createElement('div');
    d.style.cssText = 'width:26px;height:1px;background:#2a2b4a;margin:3px 0;flex-shrink:0;';
    return d;
  };
  toolbar.appendChild(sep());

  // ── Colors ────────────────────────────────────────
  const colors = ['#ff4444', '#ff9f43', '#feca57', '#48dbfb', '#6a7bff', '#ffffff'];
  const colorBtns: HTMLButtonElement[] = [];

  colors.forEach((c) => {
    const btn = document.createElement('button');
    btn.style.cssText = `
      width:18px;height:18px;min-height:18px;padding:0;cursor:pointer;flex-shrink:0;
      border:2px solid ${c === currentColor ? '#fff' : 'transparent'};
      border-radius:50%;background:${c};transition:border-color 0.15s;
    `;
    btn.onclick = (e) => {
      e.stopPropagation();
      currentColor = c;
      colorBtns.forEach((b, i) => { b.style.borderColor = colors[i] === c ? '#fff' : 'transparent'; });
    };
    colorBtns.push(btn);
    toolbar.appendChild(btn);
  });
  toolbar.appendChild(sep());

  // ── Width slider (vertical) ───────────────────────
  const sliderWrap = document.createElement('div');
  sliderWrap.style.cssText = 'width:32px;height:60px;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '12';
  slider.value = String(currentWidth);
  slider.style.cssText = 'width:50px;accent-color:#ef4444;cursor:pointer;transform:rotate(-90deg);transform-origin:center;';
  slider.oninput = () => { currentWidth = Number(slider.value); };
  sliderWrap.appendChild(slider);
  toolbar.appendChild(sliderWrap);
  toolbar.appendChild(sep());

  // ── Blur opacity slider (vertical) ────────────────
  const opacityLabel = document.createElement('div');
  opacityLabel.textContent = '◐';
  opacityLabel.title = 'Blur Intensity';
  opacityLabel.style.cssText = 'color:#8a8ba8;font-size:16px;text-align:center;flex-shrink:0;display:none;';

  const opacityWrap = document.createElement('div');
  opacityWrap.style.cssText = 'width:32px;height:60px;display:none;align-items:center;justify-content:center;flex-shrink:0;';
  const opacitySlider = document.createElement('input');
  opacitySlider.type = 'range';
  opacitySlider.min = '10';
  opacitySlider.max = '100';
  opacitySlider.value = String(Math.round(blurOpacity * 100));
  opacitySlider.style.cssText = 'width:50px;accent-color:#9b59b6;cursor:pointer;transform:rotate(-90deg);transform-origin:center;';
  opacitySlider.oninput = () => { blurOpacity = Number(opacitySlider.value) / 100; };
  opacityWrap.appendChild(opacitySlider);

  const opacitySep = sep();
  opacitySep.style.display = 'none';

  toolbar.appendChild(opacityLabel);
  toolbar.appendChild(opacityWrap);
  toolbar.appendChild(opacitySep);

  // Show/hide opacity controls based on tool
  function updateOpacityVisibility() {
    const show = currentTool === 'blur';
    opacityLabel.style.display = show ? 'block' : 'none';
    opacityWrap.style.display = show ? 'flex' : 'none';
    opacitySep.style.display = show ? 'block' : 'none';
  }

  // ── Clear button ──────────────────────────────────
  const clearBtn = makeBtn(
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
    'Clear'
  );
  clearBtn.onclick = (e) => {
    e.stopPropagation();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Clear saved state too
    chrome.storage.session.remove('devrecorderCanvas');
  };
  toolbar.appendChild(clearBtn);

  // ── Close button (X) — deselects tool & collapses ─
  const closeBtn = makeBtn(
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    'Close'
  );
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    deselectTool();
    collapsePanel();
  };
  toolbar.appendChild(closeBtn);

  // ── Canvas container ──────────────────────────────
  const canvasContainer = document.createElement('div');
  canvasContainer.id = 'devrecorder-canvas-container';
  canvasContainer.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  canvasContainer.appendChild(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const imgData = canvas.width > 0 && canvas.height > 0 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
    if (imgData) ctx.putImageData(imgData, 0, 0);
  }

  // ── Drawing logic ─────────────────────────────────
  canvas.onmousedown = (e) => {
    if (!currentTool) return;
    if (currentTool === 'text') {
      placeText(e.clientX, e.clientY);
      return;
    }
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (currentTool === 'pen') {
      ctx.beginPath();
      ctx.moveTo(e.clientX, e.clientY);
    } else {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  };

  canvas.onmousemove = (e) => {
    if (!isDrawing || !currentTool) return;
    const x = e.clientX;
    const y = e.clientY;

    if (currentTool === 'pen') {
      ctx.lineTo(x, y);
      ctx.stroke();
    } else if (currentTool === 'blur') {
      if (snapshot) {
        ctx.putImageData(snapshot, 0, 0);
        drawBlurRect(startX, startY, x, y);
      }
    } else if (snapshot) {
      ctx.putImageData(snapshot, 0, 0);
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = currentWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawShape(x, y);
    }
  };

  canvas.onmouseup = () => {
    if (isDrawing) {
      isDrawing = false;
      snapshot = null;
      debouncedSave(); // Persist after each stroke
    }
  };
  canvas.onmouseleave = () => {
    if (isDrawing) {
      isDrawing = false;
      snapshot = null;
      debouncedSave();
    }
  };
  canvas.onclick = (e) => { e.stopPropagation(); e.preventDefault(); };
  canvas.oncontextmenu = (e) => { e.preventDefault(); };

  function drawShape(x: number, y: number) {
    ctx.beginPath();
    switch (currentTool) {
      case 'line':
        ctx.moveTo(startX, startY);
        ctx.lineTo(x, y);
        break;
      case 'arrow':
        drawArrow(startX, startY, x, y);
        return;
      case 'circle': {
        const rx = (x - startX) / 2;
        const ry = (y - startY) / 2;
        const r = Math.max(Math.abs(rx), Math.abs(ry));
        ctx.arc(startX + rx, startY + ry, r, 0, Math.PI * 2);
        break;
      }
      case 'rectangle':
        ctx.rect(startX, startY, x - startX, y - startY);
        break;
      case 'square': {
        const side = Math.max(Math.abs(x - startX), Math.abs(y - startY));
        ctx.rect(startX, startY, side * (x > startX ? 1 : -1), side * (y > startY ? 1 : -1));
        break;
      }
    }
    ctx.stroke();
  }

  function drawArrow(fx: number, fy: number, tx: number, ty: number) {
    const headLen = Math.max(14, currentWidth * 4);
    const angle = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(angle - Math.PI / 6), ty - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(angle + Math.PI / 6), ty - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  // ── Blur tool ─────────────────────────────────────
  function drawBlurRect(x1: number, y1: number, x2: number, y2: number) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (w < 2 || h < 2) return;

    const blockSize = 10;
    ctx.save();
    ctx.globalAlpha = blurOpacity;
    ctx.fillStyle = 'rgb(100, 100, 120)';
    ctx.fillRect(left, top, w, h);
    for (let bx = 0; bx < w; bx += blockSize) {
      for (let by = 0; by < h; by += blockSize) {
        ctx.fillStyle = ((bx + by) % (blockSize * 2) === 0) ? 'rgb(60,60,80)' : 'rgb(130,130,150)';
        ctx.fillRect(left + bx, top + by, blockSize, blockSize);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, w, h);
    ctx.restore();
  }

  // ── Text tool ─────────────────────────────────────
  function placeText(x: number, y: number) {
    // Temporarily disable canvas so the input can receive focus/clicks
    canvas.style.pointerEvents = 'none';

    const fontSize = Math.max(14, currentWidth * 4);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type here...';
    input.style.cssText = `
      position:fixed;left:${x}px;top:${y - fontSize / 2 - 4}px;z-index:2147483647;
      background:rgba(26,27,46,0.95);color:${currentColor};
      border:2px solid #ef4444;border-radius:6px;
      padding:6px 10px;font-size:${fontSize}px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      outline:none;min-width:150px;
      box-shadow:0 4px 16px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(input);

    // Need a small delay so the click event from canvas doesn't steal focus
    setTimeout(() => input.focus(), 10);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      if (text) {
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        ctx.fillStyle = currentColor;
        ctx.fillText(text, x, y);
        debouncedSave(); // Persist text drawing
      }
      input.remove();
      // Re-enable canvas
      if (currentTool) canvas.style.pointerEvents = 'all';
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; input.remove(); if (currentTool) canvas.style.pointerEvents = 'all'; }
      e.stopPropagation();
    };
    input.onblur = commit;
  }

  // ── Activate / Deactivate drawing ─────────────────
  function activateDrawing() {
    canvasContainer.style.display = 'block';
    canvas.style.pointerEvents = 'all';
    canvas.style.cursor = 'crosshair';
    resize();
  }

  function deactivateDrawing() {
    canvas.style.pointerEvents = 'none';
    canvas.style.cursor = 'default';
  }

  // ── Expand / Collapse ─────────────────────────────
  function expandPanel() {
    controlBar.style.display = 'none';
    toolbar.style.display = 'flex';
  }

  function collapsePanel() {
    toolbar.style.display = 'none';
    controlBar.style.display = 'flex';
    deselectTool();
  }

  annotateBtn.onclick = (e) => { e.stopPropagation(); expandPanel(); };

  // ── Escape key ────────────────────────────────────
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (currentTool) deselectTool();
      else if (toolbar.style.display !== 'none') collapsePanel();
    }
  }
  document.addEventListener('keydown', onKeydown);

  // ── Cleanup (recording stops) ─────────────────────
  function onMessage(msg: any) {
    if (msg && msg.type === 'DEVRECORDER_REMOVE_DRAWING') destroy();
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function destroy() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    fab.remove();
    controlBar.remove();
    toolbar.remove();
    canvasContainer.remove();
    style.remove();
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', resize);
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.runtime.onMessage.removeListener(onControlMessage);
    // Clear saved canvas on recording stop
    chrome.storage.session.remove('devrecorderCanvas');
  }

  // ── Mount ─────────────────────────────────────────
  window.addEventListener('resize', () => { if (currentTool) resize(); });
  document.body.appendChild(canvasContainer);
  document.body.appendChild(controlBar);
  document.body.appendChild(toolbar);
  resize();

  // Restore previous drawings from other tabs
  restoreCanvasState();
})();
