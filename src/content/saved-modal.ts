(() => {
  if (document.getElementById('devrecorder-saved-modal')) return;

  let shareLink = '';
  let recId = '';
  let saved = false;
  let trimStart = 0;
  let trimEnd = 1; // fraction 0-1

  // ── Styles ────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dr-ss-in { from { opacity:0; } to { opacity:1; } }
    @keyframes dr-ss-card-in { from { opacity:0; transform:scale(0.97) translateY(8px); } to { opacity:1; transform:scale(1) translateY(0); } }
    #devrecorder-saved-modal * { box-sizing:border-box; margin:0; padding:0; }
    #devrecorder-saved-modal button { font-family:inherit; cursor:pointer; }
    #devrecorder-saved-modal input, #devrecorder-saved-modal textarea { font-family:inherit; }
  `;
  document.head.appendChild(style);

  // ── Backdrop ──────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = 'devrecorder-saved-modal';
  backdrop.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation:dr-ss-in 0.2s ease-out;
  `;

  // ── Card ──────────────────────────────────────
  const card = document.createElement('div');
  card.style.cssText = `
    display:flex;flex-direction:column;width:calc(100vw - 80px);
    height:calc(100vh - 60px);background:#fff;border-radius:16px;
    box-shadow:0 25px 80px rgba(0,0,0,0.35);
    animation:dr-ss-card-in 0.25s ease-out;overflow:hidden;
  `;

  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex:1;overflow:hidden;min-height:0;position:relative;';

  // ══════════════════════════════════════════════
  // LEFT PANEL — Video player + timeline + trim
  // ══════════════════════════════════════════════
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = `
    flex:1;min-width:0;background:#09090b;display:flex;flex-direction:column;
    position:relative;overflow:hidden;
  `;

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.style.cssText = `
    position:absolute;top:14px;left:14px;z-index:10;
    width:36px;height:36px;border-radius:50%;border:none;
    background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;
    transition:background 0.12s;backdrop-filter:blur(4px);
  `;
  closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255,255,255,0.2)'; };
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(255,255,255,0.1)'; };
  closeBtn.onclick = destroy;

  // Video element
  const video = document.createElement('video');
  video.style.cssText = `
    flex:1;width:100%;min-height:0;object-fit:contain;background:#09090b;cursor:pointer;
  `;
  video.playsInline = true;
  video.muted = false;
  video.onclick = () => { video.paused ? video.play() : video.pause(); updatePlayBtn(); };

  // Preview image (shown until video loads)
  const previewImg = document.createElement('img');
  previewImg.style.cssText = `
    position:absolute;inset:0;width:100%;height:calc(100% - 80px);
    object-fit:contain;background:#09090b;pointer-events:none;
  `;

  // Play overlay (shown on top of preview)
  const playOverlay = document.createElement('div');
  playOverlay.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:80px;
    display:flex;align-items:center;justify-content:center;
    pointer-events:none;
  `;
  const playCircle = document.createElement('div');
  playCircle.style.cssText = `
    width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.9);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 4px 20px rgba(0,0,0,0.3);transition:transform 0.15s,opacity 0.15s;
  `;
  playCircle.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="#18181b"><polygon points="6,3 20,12 6,21"/></svg>`;
  playOverlay.appendChild(playCircle);

  function updatePlayBtn() {
    playCircle.style.opacity = video.paused ? '1' : '0';
  }

  video.onplay = updatePlayBtn;
  video.onpause = updatePlayBtn;

  // ── Bottom controls bar ───────────────────────
  const controlsBar = document.createElement('div');
  controlsBar.style.cssText = `
    height:80px;flex-shrink:0;background:#111;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:8px 20px;gap:6px;
  `;

  // Play button + timeline row
  const timelineRow = document.createElement('div');
  timelineRow.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;';

  const playBtn = document.createElement('button');
  playBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><polygon points="6,3 20,12 6,21"/></svg>`;
  playBtn.style.cssText = `
    width:36px;height:36px;border-radius:50%;border:none;
    background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;
    transition:background 0.12s;flex-shrink:0;
  `;
  playBtn.onmouseenter = () => { playBtn.style.background = 'rgba(255,255,255,0.2)'; };
  playBtn.onmouseleave = () => { playBtn.style.background = 'rgba(255,255,255,0.1)'; };
  playBtn.onclick = () => { video.paused ? video.play() : video.pause(); };

  // Timeline with trim handles
  const timelineWrap = document.createElement('div');
  timelineWrap.style.cssText = 'flex:1;position:relative;height:36px;display:flex;align-items:center;';

  const timelineTrack = document.createElement('div');
  timelineTrack.style.cssText = `
    width:100%;height:8px;background:#333;border-radius:4px;position:relative;
    cursor:pointer;overflow:visible;
  `;

  // Trim region (highlighted area)
  const trimRegion = document.createElement('div');
  trimRegion.style.cssText = `
    position:absolute;top:0;height:100%;background:#ef4444;border-radius:4px;
    left:0%;width:100%;
  `;

  // Progress indicator
  const progressHead = document.createElement('div');
  progressHead.style.cssText = `
    position:absolute;top:-4px;width:3px;height:16px;background:#fff;
    border-radius:2px;left:0%;transform:translateX(-50%);z-index:5;
    box-shadow:0 1px 4px rgba(0,0,0,0.4);pointer-events:none;
  `;

  // Left trim handle
  const trimLeftHandle = document.createElement('div');
  trimLeftHandle.style.cssText = `
    position:absolute;top:-6px;width:10px;height:20px;background:#fff;
    border-radius:3px;left:0%;transform:translateX(-50%);cursor:ew-resize;z-index:6;
    box-shadow:0 1px 4px rgba(0,0,0,0.4);
  `;

  // Right trim handle
  const trimRightHandle = document.createElement('div');
  trimRightHandle.style.cssText = `
    position:absolute;top:-6px;width:10px;height:20px;background:#fff;
    border-radius:3px;right:0%;transform:translateX(50%);cursor:ew-resize;z-index:6;
    box-shadow:0 1px 4px rgba(0,0,0,0.4);
  `;

  timelineTrack.appendChild(trimRegion);
  timelineTrack.appendChild(progressHead);
  timelineTrack.appendChild(trimLeftHandle);
  timelineTrack.appendChild(trimRightHandle);
  timelineWrap.appendChild(timelineTrack);

  // Duration label
  const durationLabel = document.createElement('span');
  durationLabel.style.cssText = 'font-size:12px;color:#a1a1aa;font-variant-numeric:tabular-nums;min-width:52px;text-align:center;flex-shrink:0;';
  durationLabel.textContent = '0:00';

  timelineRow.appendChild(playBtn);
  timelineRow.appendChild(timelineWrap);
  timelineRow.appendChild(durationLabel);
  controlsBar.appendChild(timelineRow);

  // ── Timeline interactions ─────────────────────
  function getTrackFraction(e: MouseEvent): number {
    const rect = timelineTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  // Click to seek
  timelineTrack.onmousedown = (e) => {
    if (e.target === trimLeftHandle || e.target === trimRightHandle) return;
    const frac = getTrackFraction(e);
    if (video.duration) video.currentTime = frac * video.duration;
  };

  // Trim handles drag
  function setupTrimDrag(handle: HTMLElement, isLeft: boolean) {
    handle.onmousedown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const onMove = (ev: MouseEvent) => {
        const frac = getTrackFraction(ev);
        if (isLeft) {
          trimStart = Math.min(frac, trimEnd - 0.02);
        } else {
          trimEnd = Math.max(frac, trimStart + 0.02);
        }
        updateTrimUI();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }
  setupTrimDrag(trimLeftHandle, true);
  setupTrimDrag(trimRightHandle, false);

  function updateTrimUI() {
    trimRegion.style.left = `${trimStart * 100}%`;
    trimRegion.style.width = `${(trimEnd - trimStart) * 100}%`;
    trimLeftHandle.style.left = `${trimStart * 100}%`;
    trimRightHandle.style.right = `${(1 - trimEnd) * 100}%`;

    if (video.duration) {
      const dur = (trimEnd - trimStart) * video.duration;
      durationLabel.textContent = formatTime(dur);
    }
  }

  // Update progress on timeupdate
  video.ontimeupdate = () => {
    if (!video.duration) return;
    const frac = video.currentTime / video.duration;
    progressHead.style.left = `${frac * 100}%`;

    // Loop within trim region
    if (frac >= trimEnd) {
      video.currentTime = trimStart * video.duration;
    }
  };

  video.onloadedmetadata = () => {
    durationLabel.textContent = formatTime(video.duration);
    previewImg.style.display = 'none';
  };

  function formatTime(sec: number): string {
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  leftPanel.appendChild(closeBtn);
  leftPanel.appendChild(video);
  leftPanel.appendChild(previewImg);
  leftPanel.appendChild(playOverlay);
  leftPanel.appendChild(controlsBar);

  // ══════════════════════════════════════════════
  // RIGHT PANEL — Title, Description, Create
  // ══════════════════════════════════════════════
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = `
    width:380px;flex-shrink:0;display:flex;flex-direction:column;
    border-left:1px solid #f0f0f0;background:#fff;
  `;

  const titleSection = document.createElement('div');
  titleSection.style.cssText = 'padding:24px 24px 0;';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title';
  titleInput.style.cssText = 'width:100%;border:none;outline:none;font-size:18px;font-weight:700;color:#18181b;padding:0;background:transparent;';
  titleSection.appendChild(titleInput);

  const descSection = document.createElement('div');
  descSection.style.cssText = 'padding:12px 24px;flex:1;';
  const descInput = document.createElement('textarea');
  descInput.placeholder = 'Write a description or @ to mention';
  descInput.style.cssText = 'width:100%;height:100%;border:none;outline:none;font-size:14px;color:#52525b;padding:0;background:transparent;resize:none;line-height:1.6;';
  descSection.appendChild(descInput);

  const rightFooter = document.createElement('div');
  rightFooter.style.cssText = 'padding:16px 24px;border-top:1px solid #f0f0f0;display:flex;align-items:center;justify-content:flex-end;gap:12px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding:10px 20px;border-radius:10px;
    border:1px solid #e4e4e7;background:#fff;color:#52525b;
    font-size:14px;font-weight:500;
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
    font-size:14px;font-weight:600;
    transition:all 0.15s;box-shadow:0 2px 8px rgba(239,68,68,0.3);
  `;
  createBtn.onmouseenter = () => { createBtn.style.transform = 'translateY(-1px)'; createBtn.style.boxShadow = '0 4px 16px rgba(239,68,68,0.4)'; };
  createBtn.onmouseleave = () => { createBtn.style.transform = 'translateY(0)'; createBtn.style.boxShadow = '0 2px 8px rgba(239,68,68,0.3)'; };
  createBtn.onclick = handleCreate;

  rightFooter.appendChild(cancelBtn);
  rightFooter.appendChild(createBtn);

  rightPanel.appendChild(titleSection);
  rightPanel.appendChild(descSection);
  rightPanel.appendChild(rightFooter);

  // ── Assemble ──────────────────────────────────
  body.appendChild(leftPanel);
  body.appendChild(rightPanel);
  card.appendChild(body);
  backdrop.appendChild(card);

  // ── Create & copy link ────────────────────────
  async function handleCreate() {
    createBtn.textContent = 'Creating...';
    createBtn.style.opacity = '0.7';
    (createBtn as HTMLButtonElement).disabled = true;

    const title = titleInput.value.trim();
    const description = descInput.value.trim();
    if (recId) {
      try {
        const { apiToken } = await chrome.storage.local.get('apiToken');
        if (apiToken) {
          const updateData: Record<string, unknown> = {};
          if (title) updateData.title = title;
          if (description) updateData.description = description;
          // Send trim range if user adjusted it
          if (video.duration && (trimStart > 0 || trimEnd < 1)) {
            updateData.clipBetweenMs = [
              Math.round(trimStart * video.duration * 1000),
              Math.round(trimEnd * video.duration * 1000),
            ];
          }
          if (Object.keys(updateData).length > 0) {
            const apiBase = await chrome.storage.local.get('apiBase').then(r => r.apiBase).catch(() => null) || 'https://www.devrecorder.com/api';
            await fetch(`${apiBase}/recordings/${recId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
              body: JSON.stringify(updateData),
            });
          }
        }
      } catch {}
    }

    try { await navigator.clipboard.writeText(shareLink); } catch {}

    saved = true;
    createBtn.textContent = 'Copied!';
    createBtn.style.background = '#22c55e';
    createBtn.style.boxShadow = '0 2px 8px rgba(34,197,94,0.3)';
    createBtn.style.opacity = '1';
    setTimeout(destroy, 1200);
  }

  // ── Escape ────────────────────────────────────
  function onKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') destroy();
    if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  }
  document.addEventListener('keydown', onKeydown);

  // ── Init ──────────────────────────────────────
  async function init() {
    try {
      const result = await chrome.storage.session.get('devrecorderSavedModal');
      const modal = result.devrecorderSavedModal as { recId: string; shareLink: string; viewLink: string; previewThumb?: string } | undefined;
      if (modal) {
        recId = modal.recId;
        shareLink = modal.shareLink;
        if (modal.previewThumb) {
          previewImg.src = modal.previewThumb;
        }
      }
    } catch {}

    document.body.appendChild(backdrop);
    titleInput.focus();

    // Request video blob from offscreen for local playback
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_DATA' });
      if (res?.success && res.buffer) {
        const blob = new Blob([new Uint8Array(res.buffer)], { type: res.mimeType || 'video/webm' });
        const blobUrl = URL.createObjectURL(blob);
        video.src = blobUrl;
        video.load();
        // Clean up blob URL when modal closes
        video.dataset.blobUrl = blobUrl;
      }
    } catch {}
  }

  function destroy() {
    video.pause();
    if (video.dataset.blobUrl) URL.revokeObjectURL(video.dataset.blobUrl);
    video.src = '';
    backdrop.remove();
    style.remove();
    document.removeEventListener('keydown', onKeydown);
    try { chrome.storage.session.remove('devrecorderSavedModal').catch(() => {}); } catch {}

    // If user closed without saving, delete the recording from DB
    if (!saved && recId) {
      try {
        chrome.storage.local.get('apiToken').then(({ apiToken }) => {
          if (apiToken) {
            fetch(`https://www.devrecorder.com/api/recordings/${recId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${apiToken}` },
            }).catch(() => {});
          }
        }).catch(() => {});
      } catch {}
    }
  }

  init();
})();
