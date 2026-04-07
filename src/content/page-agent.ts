(() => {
  if ((window as any).__devrecorderPageAgent) return;
  (window as any).__devrecorderPageAgent = true;

  // ── Console interception ────────────────────
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;

  levels.forEach((level) => {
    console[level] = function (...args: unknown[]) {
      original[level](...args);

      const serialized = args.map((arg) => {
        try {
          if (arg instanceof Error) return arg.stack || arg.message;
          if (typeof arg === 'object') return JSON.stringify(arg, null, 2);
          return String(arg);
        } catch {
          return '[Unserializable]';
        }
      });

      window.postMessage(
        {
          source: 'devrecorder-page-agent',
          type: 'console',
          level,
          args: serialized,
          timestamp: Date.now(),
          stack: new Error().stack?.split('\n').slice(2).join('\n') || '',
        },
        '*'
      );
    };
  });

  window.addEventListener('error', (e) => {
    window.postMessage(
      {
        source: 'devrecorder-page-agent',
        type: 'console',
        level: 'error',
        args: [`Uncaught ${e.error?.message || e.message}`],
        timestamp: Date.now(),
        stack: e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`,
      },
      '*'
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    window.postMessage(
      {
        source: 'devrecorder-page-agent',
        type: 'console',
        level: 'error',
        args: [`Unhandled Promise Rejection: ${e.reason?.message || e.reason}`],
        timestamp: Date.now(),
        stack: e.reason?.stack || '',
      },
      '*'
    );
  });

  // ── Fetch interception (capture response body) ──
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const input = args[0];
    const init = args[1];

    // Extract metadata WITHOUT creating a new Request (which would consume the body)
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');

    let requestBody: string | null = null;
    if (init?.body && typeof init.body === 'string') {
      requestBody = init.body;
    }

    try {
      const response = await originalFetch(...args);

      // Clone to read body without consuming it
      const clone = response.clone();
      let responseBody: string | null = null;
      try {
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('html')) {
          const text = await clone.text();
          if (text.length < 100_000) responseBody = text; // limit size
        }
      } catch { /* can't read */ }

      window.postMessage({
        source: 'devrecorder-page-agent',
        type: 'network-response',
        url,
        method,
        status: response.status,
        requestBody,
        responseBody,
        timestamp: Date.now(),
      }, '*');

      return response;
    } catch (err) {
      throw err;
    }
  };

  // ── XMLHttpRequest interception (capture response body) ──
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__devrecorder = { method, url: String(url) };
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  OrigXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = (this as any).__devrecorder;
    if (meta) {
      let requestBody: string | null = null;
      if (typeof body === 'string') requestBody = body;

      this.addEventListener('load', function () {
        let responseBody: string | null = null;
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('json') || ct.includes('text') || ct.includes('xml')) {
            if (this.responseText.length < 100_000) responseBody = this.responseText;
          }
        } catch { /* can't read */ }

        window.postMessage({
          source: 'devrecorder-page-agent',
          type: 'network-response',
          url: meta.url,
          method: meta.method,
          status: this.status,
          requestBody,
          responseBody,
          timestamp: Date.now(),
        }, '*');
      });
    }
    return origSend.apply(this, [body] as any);
  };
})();
