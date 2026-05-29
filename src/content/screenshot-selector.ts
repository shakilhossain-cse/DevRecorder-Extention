(() => {
  if (document.getElementById('devrecorder-ss-overlay')) return;

  // ── Styles ────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dr-ss-fade-in { from { opacity:0; } to { opacity:1; } }
    #devrecorder-ss-overlay { animation: dr-ss-fade-in 0.15s ease-out; }
  `;
  document.head.appendChild(style);

  // ── Overlay ───────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'devrecorder-ss-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(0,0,0,0.35);
    cursor:crosshair;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  `;

  // ── Floating label that follows cursor ────────────
  const pill = document.createElement('div');
  pill.textContent = 'click or drag to screenshot';
  pill.style.cssText = `
    position:fixed;z-index:2147483647;
    background:rgba(255,255,255,0.12);backdrop-filter:blur(12px);
    color:#fff;padding:10px 22px;border-radius:40px;
    font-size:14px;font-weight:500;letter-spacing:0.2px;
    pointer-events:none;
    border:1px solid rgba(255,255,255,0.08);
    box-shadow:0 8px 32px rgba(0,0,0,0.3);
    white-space:nowrap;
    transform:translate(-50%, 20px);
    transition:opacity 0.12s;
  `;
  overlay.appendChild(pill);

  // ── Selection box ─────────────────────────────────
  const selBox = document.createElement('div');
  selBox.style.cssText = `
    position:fixed;border:2px solid #ef4444;background:rgba(239,68,68,0.08);
    display:none;z-index:2147483647;pointer-events:none;
    box-shadow:0 0 0 9999px rgba(0,0,0,0.35);
  `;
  overlay.appendChild(selBox);

  // ── Dimension label ───────────────────────────────
  const dimLabel = document.createElement('div');
  dimLabel.style.cssText = `
    position:fixed;background:#ef4444;color:#fff;padding:3px 8px;
    border-radius:4px;font-size:11px;font-weight:600;
    pointer-events:none;display:none;z-index:2147483647;
  `;
  overlay.appendChild(dimLabel);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let hasMoved = false;
  let delay = 0;

  // ── Read delay from storage ───────────────────────
  chrome.storage.session.get('devrecorderScreenshotDelay').then((result) => {
    delay = (result.devrecorderScreenshotDelay as number) || 0;
    chrome.storage.session.remove('devrecorderScreenshotDelay');
  }).catch(() => {});

  // ── Move pill with cursor ─────────────────────────
  overlay.onmousemove = (e) => {
    // Follow cursor when not dragging
    if (!dragging) {
      pill.style.left = `${e.clientX}px`;
      pill.style.top = `${e.clientY}px`;
      return;
    }

    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);

    // Only show selection box after moving at least 5px
    if (dx < 5 && dy < 5) return;
    hasMoved = true;

    // Hide pill once dragging starts
    pill.style.display = 'none';

    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    // Remove dark tint so the cutout effect works
    overlay.style.background = 'transparent';

    selBox.style.display = 'block';
    selBox.style.left = `${x}px`;
    selBox.style.top = `${y}px`;
    selBox.style.width = `${w}px`;
    selBox.style.height = `${h}px`;

    dimLabel.style.display = 'block';
    dimLabel.style.left = `${x}px`;
    dimLabel.style.top = `${y + h + 6}px`;
    dimLabel.textContent = `${w} \u00d7 ${h}`;
  };

  // ── Mouse handlers ────────────────────────────────
  overlay.onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
  };

  overlay.onmouseup = (e) => {
    if (!dragging) return;
    dragging = false;

    if (!hasMoved) {
      // Click = full page screenshot
      cleanup();
      captureScreenshot(null);
      return;
    }

    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (w < 10 || h < 10) {
      cleanup();
      captureScreenshot(null);
      return;
    }

    // Drag = cropped screenshot
    cleanup();
    const dpr = window.devicePixelRatio || 1;
    captureScreenshot({
      x: Math.round(x * dpr),
      y: Math.round(y * dpr),
      width: Math.round(w * dpr),
      height: Math.round(h * dpr),
    });
  };

  // ── Escape to cancel ──────────────────────────────
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }
  document.addEventListener('keydown', onKeydown);

  function cleanup() {
    overlay.remove();
    style.remove();
    document.removeEventListener('keydown', onKeydown);
  }

  // ── Capture & send to service worker ──────────────
  function captureScreenshot(cropRect: { x: number; y: number; width: number; height: number } | null) {
    chrome.runtime.sendMessage({
      type: 'SCREENSHOT_CAPTURE',
      cropRect,
      delay,
    });
  }

  // ── Mount ─────────────────────────────────────────
  document.body.appendChild(overlay);
})();
