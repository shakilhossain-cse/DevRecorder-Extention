(async () => {
  const status = document.getElementById('status');
  if (!status) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Microphone enabled!';
    status.className = 'status granted';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: true });
    setTimeout(() => window.close(), 250);
  } catch (err) {
    const msg = (err as Error).message || 'Permission denied';
    status.textContent = `Denied: ${msg}`;
    status.className = 'status denied';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: false, error: msg });
    setTimeout(() => window.close(), 5000);
  }
})();
