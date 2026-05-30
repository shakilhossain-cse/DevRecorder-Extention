(() => {
  if (document.getElementById('devrecorder-screenshot-editor')) return;

  // ── State ─────────────────────────────────────────
  type Tool = 'pen' | 'arrow' | 'rectangle' | 'circle' | 'line' | 'text' | 'blur';
  let currentTool: Tool | null = null;
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let currentColor = '#ef4444';
  let currentWidth = 4;
  let snapshot: ImageData | null = null;
  let screenshotDataUrl = '';
  let fullscreenDataUrl = '';
  let recordingId = '';
  let includeFullscreen = true;
  let saved = false;

  // Undo stack
  const undoStack: ImageData[] = [];
  const redoStack: ImageData[] = [];
  const MAX_UNDO = 30;

  function pushUndo() {
    undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoRedoBtns();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    const prev = undoStack.pop()!;
    drawCtx.putImageData(prev, 0, 0);
    updateUndoRedoBtns();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
    const next = redoStack.pop()!;
    drawCtx.putImageData(next, 0, 0);
    updateUndoRedoBtns();
  }

  // ── Styles ────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dr-ss-in { from { opacity:0; } to { opacity:1; } }
    @keyframes dr-ss-card-in { from { opacity:0; transform:scale(0.97) translateY(8px); } to { opacity:1; transform:scale(1) translateY(0); } }
    #devrecorder-screenshot-editor * { box-sizing:border-box; margin:0; padding:0; }
    #devrecorder-screenshot-editor button { font-family:inherit; cursor:pointer; }
    #devrecorder-screenshot-editor input, #devrecorder-screenshot-editor textarea { font-family:inherit; }
    #devrecorder-screenshot-editor ::-webkit-scrollbar { width:6px; }
    #devrecorder-screenshot-editor ::-webkit-scrollbar-thumb { background:#ddd; border-radius:3px; }
  `;
  document.head.appendChild(style);

  // ── Backdrop ──────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = 'devrecorder-screenshot-editor';
  backdrop.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation:dr-ss-in 0.2s ease-out;
  `;

  // ── Card container ────────────────────────────────
  const card = document.createElement('div');
  card.style.cssText = `
    display:flex;flex-direction:column;width:96vw;max-width:1280px;
    max-height:94vh;background:#fff;border-radius:16px;
    box-shadow:0 25px 80px rgba(0,0,0,0.35);
    animation:dr-ss-card-in 0.25s ease-out;overflow:hidden;
  `;

  // ── Close button (top-left) ───────────────────────
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.style.cssText = `
    position:absolute;top:16px;left:16px;z-index:10;
    width:36px;height:36px;border-radius:50%;border:none;
    background:#f4f4f5;display:flex;align-items:center;justify-content:center;
    transition:background 0.15s;
  `;
  closeBtn.onmouseenter = () => { closeBtn.style.background = '#e4e4e7'; };
  closeBtn.onmouseleave = () => { closeBtn.style.background = '#f4f4f5'; };
  closeBtn.onclick = destroy;

  // ── Body (two columns) ────────────────────────────
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex:1;overflow:hidden;min-height:0;position:relative;';

  // ══════════════════════════════════════════════════
  // LEFT PANEL — Screenshot + Annotation toolbar
  // ══════════════════════════════════════════════════
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = `
    flex:1;min-width:0;background:#fafafa;display:flex;flex-direction:column;
    position:relative;
  `;

  // Canvas area
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = `
    flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;
    padding:40px 32px 16px;min-height:0;position:relative;
  `;

  const canvasStack = document.createElement('div');
  canvasStack.style.cssText = `
    position:relative;display:inline-block;border-radius:8px;overflow:hidden;
    box-shadow:0 2px 20px rgba(0,0,0,0.12);max-width:100%;max-height:100%;
  `;

  const baseCanvas = document.createElement('canvas');
  baseCanvas.style.cssText = 'display:block;max-width:100%;max-height:calc(94vh - 200px);width:auto;height:auto;';

  const drawCanvas = document.createElement('canvas');
  drawCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:default;pointer-events:none;';

  canvasStack.appendChild(baseCanvas);
  canvasStack.appendChild(drawCanvas);
  canvasWrap.appendChild(canvasStack);

  const baseCtx = baseCanvas.getContext('2d')!;
  const drawCtx = drawCanvas.getContext('2d', { willReadFrequently: true })!;

  // ── Annotation Toolbar (bottom of left panel) ─────
  const toolbarArea = document.createElement('div');
  toolbarArea.style.cssText = `
    padding:12px 24px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;
  `;

  const toolbar = document.createElement('div');
  toolbar.style.cssText = `
    display:inline-flex;align-items:center;gap:2px;
    background:#fff;border-radius:12px;padding:6px 8px;
    box-shadow:0 2px 12px rgba(0,0,0,0.1);border:1px solid #f0f0f0;
  `;

  function makeToolBtn(svg: string, title: string, isActive = false): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.innerHTML = svg;
    btn.title = title;
    btn.style.cssText = `
      width:36px;height:36px;border:none;border-radius:8px;
      background:${isActive ? '#f3f4f6' : 'transparent'};color:#52525b;
      display:flex;align-items:center;justify-content:center;
      transition:background 0.12s;padding:0;
    `;
    btn.onmouseenter = () => { if (currentTool !== (btn as any).__tool) btn.style.background = '#f3f4f6'; };
    btn.onmouseleave = () => { if (currentTool !== (btn as any).__tool) btn.style.background = 'transparent'; };
    return btn;
  }

  function makeSep(): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = 'width:1px;height:24px;background:#e5e7eb;margin:0 4px;flex-shrink:0;';
    return d;
  }

  // Color picker button
  const colorBtn = document.createElement('button');
  colorBtn.style.cssText = `
    width:24px;height:24px;border-radius:50%;border:3px solid #fff;
    background:${currentColor};cursor:pointer;
    box-shadow:0 0 0 1px #d4d4d8;transition:transform 0.1s;
    margin:0 4px;
  `;
  colorBtn.title = 'Color';

  // Color picker dropdown
  const colorDropdown = document.createElement('div');
  colorDropdown.style.cssText = `
    position:absolute;bottom:70px;left:24px;
    background:#fff;border-radius:12px;padding:10px;
    box-shadow:0 8px 30px rgba(0,0,0,0.15);border:1px solid #f0f0f0;
    display:none;z-index:10;
    gap:6px;
  `;
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#000000'];
  colors.forEach((c) => {
    const swatch = document.createElement('button');
    swatch.style.cssText = `
      width:28px;height:28px;border-radius:50%;border:3px solid ${c === currentColor ? '#18181b' : 'transparent'};
      background:${c};cursor:pointer;transition:border-color 0.12s;display:inline-block;margin:2px;
    `;
    swatch.onclick = (e) => {
      e.stopPropagation();
      currentColor = c;
      colorBtn.style.background = c;
      colorDropdown.querySelectorAll('button').forEach((b, i) => {
        (b as HTMLElement).style.borderColor = colors[i] === c ? '#18181b' : 'transparent';
      });
      colorDropdown.style.display = 'none';
    };
    colorDropdown.appendChild(swatch);
  });

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    colorDropdown.style.display = colorDropdown.style.display === 'none' ? 'flex' : 'none';
  };

  // Tool definitions
  const toolDefs: { name: Tool; svg: string; title: string }[] = [
    { name: 'pen', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>', title: 'Pen (D)' },
    { name: 'rectangle', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="1"/></svg>', title: 'Rectangle' },
    { name: 'circle', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>', title: 'Circle' },
    { name: 'arrow', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>', title: 'Arrow' },
    { name: 'line', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>', title: 'Line' },
    { name: 'text', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/></svg>', title: 'Text (T)' },
    { name: 'blur', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>', title: 'Blur' },
  ];

  const toolBtns = new Map<Tool, HTMLButtonElement>();
  toolbar.appendChild(colorBtn);
  toolbar.appendChild(makeSep());

  toolDefs.forEach(({ name, svg, title }) => {
    const btn = makeToolBtn(svg, title);
    (btn as any).__tool = name;
    btn.onclick = (e) => { e.stopPropagation(); selectTool(name); };
    toolBtns.set(name, btn);
    toolbar.appendChild(btn);
  });

  toolbar.appendChild(makeSep());

  // Stroke size buttons
  const sizes = [
    { value: 2, label: 'S', title: 'Thin stroke' },
    { value: 4, label: 'M', title: 'Medium stroke' },
    { value: 8, label: 'L', title: 'Thick stroke' },
  ];
  const sizeBtns: HTMLButtonElement[] = [];
  sizes.forEach(({ value, label, title }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = `
      width:32px;height:32px;border:none;border-radius:8px;
      background:${value === currentWidth ? '#f3f4f6' : 'transparent'};
      color:${value === currentWidth ? '#18181b' : '#a1a1aa'};
      font-size:11px;font-weight:700;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      transition:all 0.12s;padding:0;
    `;
    btn.onmouseenter = () => { if (value !== currentWidth) btn.style.background = '#f3f4f6'; };
    btn.onmouseleave = () => { if (value !== currentWidth) btn.style.background = 'transparent'; };
    btn.onclick = (e) => {
      e.stopPropagation();
      currentWidth = value;
      sizeBtns.forEach((b, i) => {
        const active = sizes[i].value === value;
        b.style.background = active ? '#f3f4f6' : 'transparent';
        b.style.color = active ? '#18181b' : '#a1a1aa';
      });
    };
    sizeBtns.push(btn);
    toolbar.appendChild(btn);
  });

  toolbar.appendChild(makeSep());

  // Undo button
  const undoBtn = makeToolBtn('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>', 'Undo');
  undoBtn.onclick = (e) => { e.stopPropagation(); undo(); };
  toolbar.appendChild(undoBtn);

  // Redo button
  const redoBtn = makeToolBtn('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>', 'Redo');
  redoBtn.onclick = (e) => { e.stopPropagation(); redo(); };
  toolbar.appendChild(redoBtn);

  function updateUndoRedoBtns() {
    undoBtn.style.opacity = undoStack.length > 0 ? '1' : '0.3';
    redoBtn.style.opacity = redoStack.length > 0 ? '1' : '0.3';
  }
  // Initial state
  setTimeout(updateUndoRedoBtns, 0);

  // ── Fullscreen checkbox row ───────────────────────
  const fullscreenRow = document.createElement('div');
  fullscreenRow.style.cssText = 'display:flex;align-items:center;gap:10px;';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.style.cssText = 'width:16px;height:16px;accent-color:#ef4444;cursor:pointer;';
  checkbox.onchange = () => { includeFullscreen = checkbox.checked; fullThumb.style.opacity = checkbox.checked ? '1' : '0.4'; };

  // Fullscreen thumbnail
  const fullThumb = document.createElement('div');
  fullThumb.style.cssText = `
    width:40px;height:26px;border-radius:4px;background:#18181b;
    border:1px solid #3f3f46;overflow:hidden;flex-shrink:0;
  `;
  const fullThumbImg = document.createElement('img');
  fullThumbImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  fullThumb.appendChild(fullThumbImg);

  const fullLabel = document.createElement('span');
  fullLabel.textContent = 'Also include fullscreen screenshot';
  fullLabel.style.cssText = 'font-size:13px;color:#52525b;user-select:none;cursor:pointer;';
  fullLabel.onclick = () => { checkbox.click(); };

  const infoIcon = document.createElement('span');
  infoIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  infoIcon.title = 'Includes browser info, console logs, and network data';
  infoIcon.style.cssText = 'cursor:help;display:flex;';

  fullscreenRow.appendChild(checkbox);
  fullscreenRow.appendChild(fullThumb);
  fullscreenRow.appendChild(fullLabel);
  fullscreenRow.appendChild(infoIcon);

  toolbarArea.appendChild(toolbar);
  toolbarArea.appendChild(fullscreenRow);
  toolbarArea.appendChild(colorDropdown);
  toolbarArea.style.position = 'relative';

  leftPanel.appendChild(closeBtn);
  leftPanel.appendChild(canvasWrap);
  leftPanel.appendChild(toolbarArea);

  // ══════════════════════════════════════════════════
  // RIGHT PANEL — Title, Description, Create button
  // ══════════════════════════════════════════════════
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = `
    width:360px;flex-shrink:0;display:flex;flex-direction:column;
    border-left:1px solid #f0f0f0;background:#fff;
  `;

  // Title input
  const titleSection = document.createElement('div');
  titleSection.style.cssText = 'padding:24px 24px 0;';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title';
  titleInput.style.cssText = `
    width:100%;border:none;outline:none;font-size:18px;font-weight:700;
    color:#18181b;padding:0;background:transparent;
  `;

  // Description textarea
  const descSection = document.createElement('div');
  descSection.style.cssText = 'padding:12px 24px;flex:1;';

  const descInput = document.createElement('textarea');
  descInput.placeholder = 'Write a description or @ to mention';
  descInput.style.cssText = `
    width:100%;height:100%;border:none;outline:none;font-size:14px;
    color:#52525b;padding:0;background:transparent;resize:none;
    line-height:1.6;
  `;

  titleSection.appendChild(titleInput);
  descSection.appendChild(descInput);

  // Footer with create button
  const rightFooter = document.createElement('div');
  rightFooter.style.cssText = `
    padding:16px 24px;border-top:1px solid #f0f0f0;
    display:flex;align-items:center;justify-content:flex-end;gap:12px;
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding:10px 20px;border-radius:10px;
    border:1px solid #e4e4e7;background:#fff;color:#52525b;
    font-size:14px;font-weight:500;cursor:pointer;
    transition:all 0.15s;
  `;
  cancelBtn.onmouseenter = () => { cancelBtn.style.background = '#f4f4f5'; };
  cancelBtn.onmouseleave = () => { cancelBtn.style.background = '#fff'; };
  cancelBtn.onclick = destroy;

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create & copy link';
  createBtn.style.cssText = `
    padding:10px 24px;border-radius:10px;border:none;
    background:linear-gradient(135deg, #ef4444, #dc2626);color:#fff;
    font-size:14px;font-weight:600;cursor:pointer;
    transition:all 0.15s;box-shadow:0 2px 8px rgba(239,68,68,0.3);
  `;
  createBtn.onmouseenter = () => { createBtn.style.transform = 'translateY(-1px)'; createBtn.style.boxShadow = '0 4px 16px rgba(239,68,68,0.4)'; };
  createBtn.onmouseleave = () => { createBtn.style.transform = 'translateY(0)'; createBtn.style.boxShadow = '0 2px 8px rgba(239,68,68,0.3)'; };
  createBtn.onclick = saveScreenshot;

  rightFooter.appendChild(cancelBtn);
  rightFooter.appendChild(createBtn);

  rightPanel.appendChild(titleSection);
  rightPanel.appendChild(descSection);
  rightPanel.appendChild(rightFooter);

  // ── Assemble ──────────────────────────────────────
  body.appendChild(leftPanel);
  body.appendChild(rightPanel);
  card.appendChild(body);
  backdrop.appendChild(card);

  // ── Tool selection ────────────────────────────────
  function selectTool(tool: Tool) {
    if (currentTool === tool) {
      currentTool = null;
      toolBtns.forEach((btn) => { btn.style.background = 'transparent'; });
      drawCanvas.style.cursor = 'default';
      drawCanvas.style.pointerEvents = 'none';
      return;
    }
    currentTool = tool;
    toolBtns.forEach((btn, t) => {
      btn.style.background = t === tool ? '#f3f4f6' : 'transparent';
    });
    drawCanvas.style.cursor = 'crosshair';
    drawCanvas.style.pointerEvents = 'all';
    colorDropdown.style.display = 'none';
  }

  // ── Drawing logic ─────────────────────────────────
  function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = drawCanvas.getBoundingClientRect();
    const scaleX = drawCanvas.width / rect.width;
    const scaleY = drawCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  drawCanvas.onmousedown = (e) => {
    if (!currentTool) return;
    const { x, y } = getCanvasCoords(e);
    if (currentTool === 'text') {
      placeText(e.clientX, e.clientY, x, y);
      return;
    }
    pushUndo();
    isDrawing = true;
    startX = x;
    startY = y;
    drawCtx.strokeStyle = currentColor;
    drawCtx.lineWidth = currentWidth;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';

    if (currentTool === 'pen') {
      drawCtx.beginPath();
      drawCtx.moveTo(x, y);
    } else {
      snapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    }
  };

  drawCanvas.onmousemove = (e) => {
    if (!isDrawing || !currentTool) return;
    const { x, y } = getCanvasCoords(e);

    if (currentTool === 'pen') {
      drawCtx.lineTo(x, y);
      drawCtx.stroke();
    } else if (currentTool === 'blur') {
      if (snapshot) {
        drawCtx.putImageData(snapshot, 0, 0);
        drawBlurRect(startX, startY, x, y);
      }
    } else if (snapshot) {
      drawCtx.putImageData(snapshot, 0, 0);
      drawCtx.strokeStyle = currentColor;
      drawCtx.lineWidth = currentWidth;
      drawCtx.lineCap = 'round';
      drawCtx.lineJoin = 'round';
      drawShape(x, y);
    }
  };

  drawCanvas.onmouseup = () => { isDrawing = false; snapshot = null; };
  drawCanvas.onmouseleave = () => { isDrawing = false; snapshot = null; };

  function drawShape(x: number, y: number) {
    drawCtx.beginPath();
    switch (currentTool) {
      case 'line':
        drawCtx.moveTo(startX, startY);
        drawCtx.lineTo(x, y);
        break;
      case 'arrow':
        drawArrow(startX, startY, x, y);
        return;
      case 'rectangle':
        drawCtx.rect(startX, startY, x - startX, y - startY);
        break;
      case 'circle': {
        const rx = (x - startX) / 2;
        const ry = (y - startY) / 2;
        const r = Math.max(Math.abs(rx), Math.abs(ry));
        drawCtx.arc(startX + rx, startY + ry, r, 0, Math.PI * 2);
        break;
      }
    }
    drawCtx.stroke();
  }

  function drawArrow(fx: number, fy: number, tx: number, ty: number) {
    const headLen = Math.max(14, currentWidth * 4);
    const angle = Math.atan2(ty - fy, tx - fx);
    drawCtx.beginPath();
    drawCtx.moveTo(fx, fy);
    drawCtx.lineTo(tx, ty);
    drawCtx.stroke();
    drawCtx.beginPath();
    drawCtx.moveTo(tx, ty);
    drawCtx.lineTo(tx - headLen * Math.cos(angle - Math.PI / 6), ty - headLen * Math.sin(angle - Math.PI / 6));
    drawCtx.moveTo(tx, ty);
    drawCtx.lineTo(tx - headLen * Math.cos(angle + Math.PI / 6), ty - headLen * Math.sin(angle + Math.PI / 6));
    drawCtx.stroke();
  }

  function drawBlurRect(x1: number, y1: number, x2: number, y2: number) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (w < 2 || h < 2) return;
    const blockSize = 10;
    drawCtx.save();
    drawCtx.globalAlpha = 0.5;
    drawCtx.fillStyle = 'rgb(100,100,120)';
    drawCtx.fillRect(left, top, w, h);
    for (let bx = 0; bx < w; bx += blockSize) {
      for (let by = 0; by < h; by += blockSize) {
        drawCtx.fillStyle = ((bx + by) % (blockSize * 2) === 0) ? 'rgb(60,60,80)' : 'rgb(130,130,150)';
        drawCtx.fillRect(left + bx, top + by, blockSize, blockSize);
      }
    }
    drawCtx.globalAlpha = 1;
    drawCtx.strokeStyle = 'rgba(255,255,255,0.2)';
    drawCtx.lineWidth = 1;
    drawCtx.strokeRect(left, top, w, h);
    drawCtx.restore();
  }

  function placeText(clientX: number, clientY: number, canvasX: number, canvasY: number) {
    pushUndo();
    drawCanvas.style.pointerEvents = 'none';
    const fontSize = Math.max(16, currentWidth * 5);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type here...';
    input.style.cssText = `
      position:fixed;left:${clientX}px;top:${clientY - fontSize / 2 - 4}px;z-index:2147483647;
      background:rgba(255,255,255,0.95);color:${currentColor};
      border:2px solid ${currentColor};border-radius:6px;
      padding:6px 10px;font-size:${fontSize}px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      outline:none;min-width:150px;box-shadow:0 4px 16px rgba(0,0,0,0.15);
    `;
    document.body.appendChild(input);
    setTimeout(() => input.focus(), 10);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      if (text) {
        drawCtx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        drawCtx.fillStyle = currentColor;
        drawCtx.fillText(text, canvasX, canvasY);
      }
      input.remove();
      if (currentTool) drawCanvas.style.pointerEvents = 'all';
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; input.remove(); if (currentTool) drawCanvas.style.pointerEvents = 'all'; }
      e.stopPropagation();
    };
    input.onblur = commit;
  }

  // ── Save screenshot ───────────────────────────────
  async function saveScreenshot() {
    createBtn.textContent = 'Creating...';
    createBtn.style.opacity = '0.7';
    (createBtn as HTMLButtonElement).disabled = true;

    // Merge base + drawings
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = baseCanvas.width;
    finalCanvas.height = baseCanvas.height;
    const finalCtx = finalCanvas.getContext('2d')!;
    finalCtx.drawImage(baseCanvas, 0, 0);
    finalCtx.drawImage(drawCanvas, 0, 0);

    const dataUrl = finalCanvas.toDataURL('image/png');

    try {
      await chrome.runtime.sendMessage({
        type: 'SCREENSHOT_SAVE',
        recordingId,
        imageDataUrl: dataUrl,
        fullscreenDataUrl: includeFullscreen ? fullscreenDataUrl : null,
        title: titleInput.value.trim() || 'Untitled Screenshot',
        description: descInput.value.trim(),
      });

      // Copy link to clipboard
      const shareLink = `https://www.devrecorder.com/share/${recordingId}`;
      await navigator.clipboard.writeText(shareLink).catch(() => {});

      // Show success
      saved = true;
      createBtn.textContent = 'Copied!';
      createBtn.style.background = '#22c55e';
      createBtn.style.boxShadow = '0 2px 8px rgba(34,197,94,0.3)';
      setTimeout(destroy, 1200);
    } catch {
      createBtn.textContent = 'Create & copy link';
      createBtn.style.opacity = '1';
      (createBtn as HTMLButtonElement).disabled = false;
    }
  }

  // ── Keyboard shortcuts ────────────────────────────
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { destroy(); return; }
    // Don't handle shortcuts when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key === 'd' || e.key === 'x') selectTool('pen');
    if (e.key === 't') selectTool('text');
    if (e.key === 'v') { currentTool = null; toolBtns.forEach(b => { b.style.background = 'transparent'; }); drawCanvas.style.pointerEvents = 'none'; drawCanvas.style.cursor = 'default'; }
  }
  document.addEventListener('keydown', onKeydown);

  // Close color dropdown on outside click
  backdrop.addEventListener('click', () => { colorDropdown.style.display = 'none'; });

  // ── Cleanup ───────────────────────────────────────
  function destroy() {
    backdrop.remove();
    style.remove();
    document.removeEventListener('keydown', onKeydown);

    // If closed without saving, delete the recording from DB
    if (!saved && recordingId) {
      try {
        chrome.storage.local.get('apiToken').then(({ apiToken }) => {
          if (apiToken) {
            fetch(`https://www.devrecorder.com/api/recordings/${recordingId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${apiToken}` },
            }).catch(() => {});
          }
        }).catch(() => {});
      } catch {}
    }
  }

  // ── Init ──────────────────────────────────────────
  async function init() {
    try {
      const result = await chrome.storage.session.get(['devrecorderScreenshot', 'devrecorderScreenshotCrop']);
      const data = result.devrecorderScreenshot as { dataUrl: string; recordingId: string } | undefined;
      const cropRect = result.devrecorderScreenshotCrop as { x: number; y: number; width: number; height: number } | undefined;
      if (!data) { destroy(); return; }

      screenshotDataUrl = data.dataUrl;
      fullscreenDataUrl = data.dataUrl; // Original full-page capture
      recordingId = data.recordingId;

      chrome.storage.session.remove(['devrecorderScreenshot', 'devrecorderScreenshotCrop']);

      const img = new Image();
      img.onload = () => {
        // Set fullscreen thumbnail
        fullThumbImg.src = data.dataUrl;

        if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
          const cw = cropRect.width;
          const ch = cropRect.height;
          baseCanvas.width = cw;
          baseCanvas.height = ch;
          drawCanvas.width = cw;
          drawCanvas.height = ch;
          baseCtx.drawImage(img, cropRect.x, cropRect.y, cw, ch, 0, 0, cw, ch);
        } else {
          baseCanvas.width = img.width;
          baseCanvas.height = img.height;
          drawCanvas.width = img.width;
          drawCanvas.height = img.height;
          baseCtx.drawImage(img, 0, 0);
          // No crop — hide fullscreen row since it's the same image
          fullscreenRow.style.display = 'none';
        }

        document.body.appendChild(backdrop);
        titleInput.focus();
      };
      img.src = screenshotDataUrl;
    } catch {
      destroy();
    }
  }

  init();
})();
