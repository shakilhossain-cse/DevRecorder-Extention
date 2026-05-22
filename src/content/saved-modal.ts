(() => {
  if (document.getElementById('devrecorder-saved-modal')) return;

  let shareLink = '';
  let viewLink = '';
  let recId = '';
  let uploadDone = false;
  let uploadProgress = 0;
  let copied = false;

  // ── Styles ────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes dr-modal-in { from { opacity:0; } to { opacity:1; } }
    @keyframes dr-card-in { from { opacity:0; transform:scale(0.96) translateY(12px); } to { opacity:1; transform:scale(1) translateY(0); } }
    @keyframes dr-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    @keyframes dr-progress { from{background-position:200% 0} to{background-position:-200% 0} }
    #devrecorder-saved-modal * { box-sizing:border-box; margin:0; padding:0; }
    #devrecorder-saved-modal button { font-family:inherit; }
  `;
  document.head.appendChild(style);

  // ── Backdrop ──────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = 'devrecorder-saved-modal';
  backdrop.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation:dr-modal-in 0.2s ease-out;
  `;

  // ── Card ──────────────────────────────────────
  const card = document.createElement('div');
  card.style.cssText = `
    background:#fff;border-radius:16px;width:820px;max-width:92vw;max-height:88vh;
    box-shadow:0 25px 80px rgba(0,0,0,0.35);
    animation:dr-card-in 0.25s ease-out;
    display:flex;flex-direction:column;overflow:hidden;
  `;

  // ── Header ────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    padding:16px 20px;display:flex;align-items:center;justify-content:space-between;
    border-bottom:1px solid #f4f4f5;flex-shrink:0;
  `;

  const headerLeft = document.createElement('div');
  headerLeft.style.cssText = 'display:flex;align-items:center;gap:10px;';
  headerLeft.innerHTML = `
    <div style="width:28px;height:28px;border-radius:8px;background:rgba(239,68,68,0.1);display:flex;align-items:center;justify-content:center;">
      <div style="width:8px;height:8px;border-radius:50%;background:#ef4444;"></div>
    </div>
    <span style="font-size:14px;font-weight:700;color:#18181b;">DevRecorder</span>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.style.cssText = 'border:none;background:none;cursor:pointer;padding:6px;border-radius:8px;display:flex;';
  closeBtn.onmouseenter = () => { closeBtn.style.background = '#f4f4f5'; };
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'none'; };
  closeBtn.onclick = destroy;

  header.appendChild(headerLeft);
  header.appendChild(closeBtn);

  // ── Body (two columns) ────────────────────────
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex:1;overflow:hidden;min-height:0;';

  // ── Left: Video Preview ───────────────────────
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = `
    flex:1;min-width:0;background:#09090b;display:flex;flex-direction:column;
    align-items:center;justify-content:center;padding:24px;position:relative;
  `;

  const videoPlaceholder = document.createElement('div');
  videoPlaceholder.style.cssText = `
    width:100%;aspect-ratio:16/9;border-radius:12px;background:#18181b;
    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;
    border:1px solid #27272a;overflow:hidden;position:relative;
  `;

  const uploadStatusEl = document.createElement('div');
  uploadStatusEl.style.cssText = 'text-align:center;';

  const uploadIconEl = document.createElement('div');
  uploadIconEl.style.cssText = 'margin-bottom:8px;';

  const uploadTitleEl = document.createElement('div');
  uploadTitleEl.style.cssText = 'font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;';

  const uploadSubEl = document.createElement('div');
  uploadSubEl.style.cssText = 'font-size:12px;color:#71717a;';

  uploadStatusEl.appendChild(uploadIconEl);
  uploadStatusEl.appendChild(uploadTitleEl);
  uploadStatusEl.appendChild(uploadSubEl);
  videoPlaceholder.appendChild(uploadStatusEl);

  // Progress bar inside video area
  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:4px;background:#27272a;';
  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'height:100%;background:#ef4444;width:0%;transition:width 0.4s ease;';
  progressWrap.appendChild(progressFill);
  videoPlaceholder.appendChild(progressWrap);

  leftPanel.appendChild(videoPlaceholder);

  // Duration label below video
  const durationLabel = document.createElement('div');
  durationLabel.style.cssText = 'margin-top:12px;font-size:12px;color:#52525b;';
  durationLabel.textContent = 'Processing...';
  leftPanel.appendChild(durationLabel);

  // ── Right: Share + Task Creation ──────────────
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = `
    width:320px;flex-shrink:0;display:flex;flex-direction:column;
    border-left:1px solid #f4f4f5;background:#fafafa;
  `;

  // Share section
  const shareSection = document.createElement('div');
  shareSection.style.cssText = 'padding:20px;border-bottom:1px solid #f4f4f5;';

  const shareTitle = document.createElement('div');
  shareTitle.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#a1a1aa;margin-bottom:10px;';
  shareTitle.textContent = 'Share link';

  const linkRow = document.createElement('div');
  linkRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const linkInput = document.createElement('input');
  linkInput.readOnly = true;
  linkInput.style.cssText = `
    flex:1;padding:8px 10px;border-radius:8px;border:1px solid #e4e4e7;
    background:#fff;font-size:12px;color:#52525b;font-family:monospace;
    outline:none;min-width:0;
  `;

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText = `
    padding:8px 14px;border-radius:8px;border:none;
    background:#18181b;color:#fff;font-size:12px;font-weight:600;
    cursor:pointer;white-space:nowrap;transition:background 0.15s;
  `;
  copyBtn.onmouseenter = () => { if (!copied) copyBtn.style.background = '#27272a'; };
  copyBtn.onmouseleave = () => { if (!copied) copyBtn.style.background = '#18181b'; };
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(shareLink).then(() => {
      copied = true;
      copyBtn.textContent = 'Copied!';
      copyBtn.style.background = '#16a34a';
      setTimeout(() => { copied = false; copyBtn.textContent = 'Copy'; copyBtn.style.background = '#18181b'; }, 2000);
    });
  };

  linkRow.appendChild(linkInput);
  linkRow.appendChild(copyBtn);
  shareSection.appendChild(shareTitle);
  shareSection.appendChild(linkRow);

  // Integration section
  const integSection = document.createElement('div');
  integSection.style.cssText = 'padding:20px;flex:1;overflow-y:auto;';

  const integTitle = document.createElement('div');
  integTitle.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#a1a1aa;margin-bottom:12px;';
  integTitle.textContent = 'Create task';

  const integButtons = document.createElement('div');
  integButtons.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  // ClickUp button
  const clickupBtn = document.createElement('button');
  clickupBtn.style.cssText = `
    display:flex;align-items:center;gap:10px;width:100%;padding:12px;
    border-radius:10px;border:1px solid #e4e4e7;background:#fff;
    cursor:pointer;transition:border-color 0.15s,background 0.15s;text-align:left;
  `;
  clickupBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 9 19 20 6"/><polyline points="4 8 9 13 20 2"/></svg>
    <div>
      <div style="font-size:13px;font-weight:600;color:#18181b;">ClickUp</div>
      <div style="font-size:11px;color:#71717a;">Create a task</div>
    </div>
  `;
  clickupBtn.onmouseenter = () => { clickupBtn.style.borderColor = '#ec4899'; clickupBtn.style.background = '#fdf2f8'; };
  clickupBtn.onmouseleave = () => { clickupBtn.style.borderColor = '#e4e4e7'; clickupBtn.style.background = '#fff'; };
  clickupBtn.onclick = () => {
    window.open(`https://www.devrecorder.com/recordings/${recId}`, '_blank');
  };

  // Trello button
  const trelloBtn = document.createElement('button');
  trelloBtn.style.cssText = clickupBtn.style.cssText;
  trelloBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="16" rx="1.5"/><rect x="14" y="3" width="7" height="10" rx="1.5"/></svg>
    <div>
      <div style="font-size:13px;font-weight:600;color:#18181b;">Trello</div>
      <div style="font-size:11px;color:#71717a;">Create a card</div>
    </div>
  `;
  trelloBtn.onmouseenter = () => { trelloBtn.style.borderColor = '#0ea5e9'; trelloBtn.style.background = '#f0f9ff'; };
  trelloBtn.onmouseleave = () => { trelloBtn.style.borderColor = '#e4e4e7'; trelloBtn.style.background = '#fff'; };
  trelloBtn.onclick = () => {
    window.open(`https://www.devrecorder.com/recordings/${recId}`, '_blank');
  };

  integButtons.appendChild(clickupBtn);
  integButtons.appendChild(trelloBtn);
  integSection.appendChild(integTitle);
  integSection.appendChild(integButtons);

  rightPanel.appendChild(shareSection);
  rightPanel.appendChild(integSection);

  // Footer actions
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:16px 20px;border-top:1px solid #f4f4f5;display:flex;gap:10px;flex-shrink:0;';

  const viewBtn = document.createElement('button');
  viewBtn.style.cssText = `
    flex:1;padding:11px;border-radius:10px;border:none;
    background:#ef4444;color:#fff;font-size:13px;font-weight:600;
    cursor:pointer;transition:background 0.15s;
  `;
  viewBtn.textContent = 'View Recording';
  viewBtn.onmouseenter = () => { viewBtn.style.background = '#dc2626'; };
  viewBtn.onmouseleave = () => { viewBtn.style.background = '#ef4444'; };
  viewBtn.onclick = () => { window.open(viewLink, '_blank'); destroy(); };

  const closeFooterBtn = document.createElement('button');
  closeFooterBtn.style.cssText = `
    flex:1;padding:11px;border-radius:10px;
    border:1px solid #e4e4e7;background:#fff;color:#3f3f46;
    font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s;
  `;
  closeFooterBtn.textContent = 'Close';
  closeFooterBtn.onmouseenter = () => { closeFooterBtn.style.background = '#fafafa'; };
  closeFooterBtn.onmouseleave = () => { closeFooterBtn.style.background = '#fff'; };
  closeFooterBtn.onclick = destroy;

  footer.appendChild(viewBtn);
  footer.appendChild(closeFooterBtn);

  // ── Assemble ──────────────────────────────────
  body.appendChild(leftPanel);
  body.appendChild(rightPanel);
  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  backdrop.appendChild(card);

  // ── Render ────────────────────────────────────
  function render() {
    linkInput.value = shareLink;

    if (uploadDone) {
      uploadIconEl.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
      uploadTitleEl.textContent = 'Ready to view';
      uploadSubEl.textContent = 'Click "View Recording" to watch';
      progressFill.style.width = '100%';
      progressFill.style.background = '#22c55e';
      durationLabel.textContent = 'Upload complete';
      viewBtn.style.opacity = '1';
      viewBtn.disabled = false;
    } else {
      uploadIconEl.innerHTML = `<svg style="animation:dr-pulse 1.5s ease-in-out infinite" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      uploadTitleEl.textContent = uploadProgress > 0 ? `Uploading ${uploadProgress}%` : 'Uploading...';
      uploadSubEl.textContent = 'Please wait while your video uploads';
      progressFill.style.width = `${Math.max(uploadProgress, 3)}%`;
      progressFill.style.background = '#ef4444';
      durationLabel.textContent = `Uploading${uploadProgress > 0 ? ` — ${uploadProgress}%` : '...'}`;
      viewBtn.style.opacity = '0.5';
      viewBtn.disabled = true;
    }
  }

  // ── Init ──────────────────────────────────────
  async function init() {
    try {
      const result = await chrome.storage.session.get('devrecorderSavedModal');
      const modal = result.devrecorderSavedModal as { recId: string; shareLink: string; viewLink: string } | undefined;
      if (modal) {
        recId = modal.recId;
        shareLink = modal.shareLink;
        viewLink = modal.viewLink;
      }
    } catch {}

    try {
      const result = await chrome.storage.session.get('uploadComplete');
      const uc = result.uploadComplete as { recordingId: string } | undefined;
      if (uc && uc.recordingId === recId) {
        uploadDone = true;
      }
    } catch {}

    // Check connected integrations to show/hide buttons
    try {
      const result = await chrome.storage.session.get('devrecorderSavedModal');
      if (result.devrecorderSavedModal) {
        // Fetch integration status
        const { apiToken } = await chrome.storage.local.get('apiToken');
        if (apiToken) {
          const res = await fetch('https://www.devrecorder.com/api/integrations/status', {
            headers: { Authorization: `Bearer ${apiToken}` },
          });
          if (res.ok) {
            const status = await res.json();
            if (!status.clickup) clickupBtn.style.display = 'none';
            if (!status.trello) trelloBtn.style.display = 'none';
            if (!status.clickup && !status.trello) {
              integSection.style.display = 'none';
            }
          }
        }
      }
    } catch {}

    render();
    document.body.appendChild(backdrop);

    // Listen for upload progress and completion
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      if (changes.uploadProgress?.newValue != null) {
        uploadProgress = changes.uploadProgress.newValue as number;
        render();
      }
      if (changes.uploadComplete?.newValue) {
        const uc = changes.uploadComplete.newValue as { recordingId: string };
        if (uc.recordingId === recId) {
          uploadDone = true;
          uploadProgress = 100;
          render();
        }
      }
    });
  }

  function destroy() {
    backdrop.remove();
    style.remove();
    chrome.storage.session.remove('devrecorderSavedModal').catch(() => {});
  }

  init();
})();
