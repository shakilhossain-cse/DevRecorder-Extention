(() => {
  // Inject page-agent once (early, at document_start via manifest)
  if (!(window as any).__devrecorderPageAgent) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/page-agent.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // Only set up message forwarding once
  if ((window as any).__devrecorderContent) return;
  (window as any).__devrecorderContent = true;

  // Check if we should activate (service worker re-injects content.js when recording starts)
  chrome.runtime.sendMessage({ type: 'RECORDING_STATE' }, (state: any) => {
    if (chrome.runtime.lastError) return;
    if (state && (state.status === 'recording' || state.status === 'paused')) {
      window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*');
    }
  });

  // Forward page-agent messages to service worker
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'devrecorder-page-agent') return;

    try {
      if (event.data.type === 'console') {
        chrome.runtime.sendMessage({
          type: 'CONSOLE_EVENT',
          data: {
            level: event.data.level,
            args: event.data.args,
            timestamp: event.data.timestamp,
            stack: event.data.stack,
          },
        }).catch(() => {});
      } else if (event.data.type === 'network-response') {
        chrome.runtime.sendMessage({
          type: 'NETWORK_RESPONSE',
          data: {
            url: event.data.url,
            method: event.data.method,
            status: event.data.status,
            requestBody: event.data.requestBody,
            responseBody: event.data.responseBody,
            timestamp: event.data.timestamp,
          },
        }).catch(() => {});
      }
    } catch {
      // Extension context invalidated after reload
    }
  });
})();
