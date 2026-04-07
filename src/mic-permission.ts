(async () => {
  const status = document.getElementById('status')!;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Microphone enabled! Closing...';
    status.className = 'status granted';
    // Notify service worker
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: true });
    setTimeout(() => window.close(), 800);
  } catch (err) {
    const msg = (err as Error).message || 'Permission denied';
    status.textContent = `Denied: ${msg}`;
    status.className = 'status denied';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: false, error: msg });
    setTimeout(() => window.close(), 2000);
  }
})();
