(() => {
  if ((window as any).__devrecorderPageAgent) return;
  (window as any).__devrecorderPageAgent = true;

  // ── Recording state: skip all heavy work when not recording ──
  // Controlled by content.ts via postMessage
  let active = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'devrecorder-control') {
      if (e.data.action === 'start') active = true;
      if (e.data.action === 'stop') active = false;
    }
  });

  // ── Sensitive body redaction ──────────────
  const REDACTED = '[REDACTED]';
  const SENSITIVE_KEYS = /^(password|passwd|secret|token|access_token|refresh_token|api_key|apikey|api_secret|authorization|credit_card|card_number|cvv|ssn|private_key)$/i;

  function redactBody(raw: string | null): string | null {
    if (!raw) return raw;
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(redactObj(obj));
    } catch {
      return raw;
    }
  }

  function redactObj(val: unknown): unknown {
    if (Array.isArray(val)) return val.map(redactObj);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.test(k) ? REDACTED : redactObj(v);
      }
      return out;
    }
    return val;
  }

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
      if (!active) return; // ← skip when not recording

      const serialized = args.slice(0, 10).map((arg) => {
        try {
          if (arg instanceof Error) return arg.stack || arg.message;
          if (typeof arg === 'object') {
            const str = JSON.stringify(arg, null, 2);
            return str.length > 5_000 ? str.slice(0, 5_000) + '… [truncated]' : str;
          }
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
    if (!active) return;
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
    if (!active) return;
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

  // ── DOM Interaction tracking ─────────────────
  function describeElement(el: Element): {
    selector: string;
    tag: string;
    text?: string;
    attributes: Record<string, string>;
    attrCount: number;
  } {
    const tag = el.tagName.toLowerCase();
    const attrs: Record<string, string> = {};
    const SHOW_ATTRS = ['type', 'class', 'id', 'name', 'href', 'src', 'placeholder', 'role', 'aria-label', 'value'];
    let shown = 0;
    for (const a of Array.from(el.attributes)) {
      if (SHOW_ATTRS.includes(a.name) && a.value) {
        let val = a.value;
        if (val.length > 40) val = val.slice(0, 37) + '...';
        attrs[a.name] = val;
        shown++;
      }
      if (shown >= 3) break;
    }

    // Build a short CSS selector
    let selector = tag;
    if (attrs.id) selector += `#${attrs.id}`;
    else if (attrs.class) {
      const cls = attrs.class.split(/\s+/).slice(0, 2).join('.');
      selector += `.${cls}`;
    }

    // Get visible text (short)
    let text: string | undefined;
    const textContent = el.textContent?.trim();
    if (textContent && textContent.length > 0 && textContent.length < 80) {
      text = textContent;
    }

    return {
      selector,
      tag,
      text,
      attributes: attrs,
      attrCount: el.attributes.length,
    };
  }

  // Click tracking
  document.addEventListener('click', (e) => {
    if (!active) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Skip clicks on the devrecorder UI itself
    if (target.closest('[data-devrecorder]')) return;

    const info = describeElement(target);
    window.postMessage({
      source: 'devrecorder-page-agent',
      type: 'interaction',
      action: 'click',
      ...info,
      timestamp: Date.now(),
    }, '*');
  }, true);

  // Input/typing tracking (debounced per element)
  const inputTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const inputBuffers = new WeakMap<Element, string>();

  document.addEventListener('input', (e) => {
    if (!active) return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable))) return;

    const el = target as Element;
    const value = (target as HTMLInputElement).value || (target as HTMLElement).textContent || '';

    // Buffer the value and debounce
    inputBuffers.set(el, value);
    const existing = inputTimers.get(el);
    if (existing) clearTimeout(existing);

    inputTimers.set(el, setTimeout(() => {
      const buffered = inputBuffers.get(el) || '';
      if (!buffered) return;

      const info = describeElement(el);
      // Truncate and partially redact typed text
      let typedText = buffered;
      if (typedText.length > 50) typedText = typedText.slice(0, 47) + '...';

      window.postMessage({
        source: 'devrecorder-page-agent',
        type: 'interaction',
        action: 'input',
        ...info,
        text: typedText,
        timestamp: Date.now(),
      }, '*');
      inputBuffers.delete(el);
    }, 500));
  }, true);

  // ── Helpers ──────────────────────────────────
  function resolveUrl(raw: string): string {
    try { return new URL(raw, location.href).href; } catch { return raw; }
  }

  function extractBody(body: any): string | null {
    if (!body) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const obj: Record<string, string> = {};
      body.forEach((v, k) => { obj[k] = typeof v === 'string' ? v : `[File: ${v.name}]`; });
      return JSON.stringify(obj);
    }
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try { return new TextDecoder().decode(body); } catch { return '[Binary data]'; }
    }
    return null;
  }

  // ── Fetch interception ──────────────────────
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args: Parameters<typeof fetch>) {
    if (!active) return originalFetch(...args); // ← pass through when not recording

    const input = args[0];
    const init = args[1];

    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const url = resolveUrl(rawUrl);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    let requestBody: string | null = null;
    if (init?.body) {
      requestBody = extractBody(init.body);
    } else if (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
      try {
        const clonedReq = input.clone();
        requestBody = await clonedReq.text();
      } catch { /* body already consumed */ }
    }

    try {
      const response = await originalFetch(...args);

      try {
        let responseBody: string | null = null;
        try {
          const ct = response.headers.get('content-type') || '';
          const cl = parseInt(response.headers.get('content-length') || '0', 10);
          const isText = ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('html')
            || ct.includes('javascript') || ct.includes('form-urlencoded') || ct === '';
          // Only clone if text-like and not too large (skip binary, images, video, etc.)
          if (isText && cl < 500_000) {
            const clone = response.clone();
            const text = await clone.text();
            if (text.length > 0 && text.length < 500_000) responseBody = text;
          }
        } catch { /* can't read */ }

        window.postMessage({
          source: 'devrecorder-page-agent',
          type: 'network-response',
          url,
          method,
          status: response.status,
          requestBody: redactBody(requestBody),
          responseBody: redactBody(responseBody),
          timestamp: Date.now(),
        }, '*');
      } catch { /* never break the app's fetch */ }

      return response;
    } catch (err) {
      throw err;
    }
  };

  // ── XMLHttpRequest interception ──────────────
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  // Use WeakMap to avoid leaking properties on XHR objects
  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

  OrigXHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    xhrMeta.set(this, { method: method.toUpperCase(), url: resolveUrl(String(url)) });
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  OrigXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);
    if (meta && active) { // ← only intercept when recording
      const requestBody: string | null = extractBody(body);

      // Use { once: true } to auto-remove listener after firing  prevents accumulation
      this.addEventListener('load', function () {
        if (!active) return;
        try {
          let responseBody: string | null = null;
          try {
            const ct = this.getResponseHeader('content-type') || '';
            const isText = ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('html')
              || ct.includes('javascript') || ct.includes('form-urlencoded') || ct === '';
            if (isText && this.responseText && this.responseText.length > 0 && this.responseText.length < 500_000) {
              responseBody = this.responseText;
            }
          } catch { /* can't read */ }

          window.postMessage({
            source: 'devrecorder-page-agent',
            type: 'network-response',
            url: meta.url,
            method: meta.method,
            status: this.status,
            requestBody: redactBody(requestBody),
            responseBody: redactBody(responseBody),
            timestamp: Date.now(),
          }, '*');
        } catch { /* never break the app's XHR */ }
      }, { once: true });
    }
    return origSend.apply(this, [body] as any);
  };
})();
