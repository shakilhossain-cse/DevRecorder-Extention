// Runs on the extension-auth page to pick up the API token and send it to the background script.
(function () {
  const el = document.getElementById('devrecorder-token');
  if (!el) return;

  const token = el.dataset.token;
  if (!token) return;

  chrome.runtime.sendMessage({ type: 'AUTH_TOKEN_RECEIVED', token });
})();
