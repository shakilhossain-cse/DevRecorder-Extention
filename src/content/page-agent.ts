(() => {
  if ((window as any).__devrecorderPageAgent) return;
  (window as any).__devrecorderPageAgent = true;

  // ── Recording state: skip all heavy work when not recording ──
  // Controlled by content.ts via postMessage
  let active = false;

  // ── Buffers for screenshots (always active) ──────────
  const MAX_CONSOLE_BUFFER = 50;
  const MAX_NETWORK_BUFFER = 50;
  const MAX_INTERACTION_BUFFER = 30;

  if (!(window as any).__devrecorder_console_buffer) (window as any).__devrecorder_console_buffer = [];
  if (!(window as any).__devrecorder_network_buffer) (window as any).__devrecorder_network_buffer = [];
  if (!(window as any).__devrecorder_interaction_buffer) (window as any).__devrecorder_interaction_buffer = [];

  const consoleBuffer: { level: string; args: string[]; stack: string; timestamp: number }[] =
    (window as any).__devrecorder_console_buffer;
  const networkBuffer: { url: string; method: string; status: number; duration: number; requestBody: string | null; responseBody: string | null; timestamp: number }[] =
    (window as any).__devrecorder_network_buffer;
  const interactionBuffer: { action: string; selector: string; tag: string; text?: string; timestamp: number }[] =
    (window as any).__devrecorder_interaction_buffer;

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

      const serialized = args.slice(0, 10).map((arg) => {
        try {
          if (arg === null || arg === undefined) return String(arg);
          if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
          if (typeof arg === 'object') {
            // Jam.dev approach: try JSON round-trip (strips non-serializable values safely)
            try {
              const str = JSON.stringify(JSON.parse(JSON.stringify(arg)), null, 2);
              return str.length > 5_000 ? str.slice(0, 5_000) + '… [truncated]' : str;
            } catch {
              // Object can't be serialized — return a safe description
              try { return `[${arg.constructor.name} object cannot be serialized]`; } catch {}
              return '[Unserializable object]';
            }
          }
          return String(arg);
        } catch {
          return '[Unserializable]';
        }
      });

      const stack = new Error().stack?.split('\n').slice(2).join('\n') || '';

      // Always buffer for screenshots (even when not recording)
      consoleBuffer.push({ level, args: serialized, stack, timestamp: Date.now() });
      if (consoleBuffer.length > MAX_CONSOLE_BUFFER) consoleBuffer.shift();

      if (!active) return; // ← skip forwarding when not recording

      window.postMessage(
        {
          source: 'devrecorder-page-agent',
          type: 'console',
          level,
          args: serialized,
          timestamp: Date.now(),
          stack,
        },
        '*'
      );
    };
  });

  window.addEventListener('error', (e) => {
    const args = [`Uncaught ${e.error?.message || e.message}`];
    const stack = e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`;
    // Always buffer for screenshots
    consoleBuffer.push({ level: 'error', args, stack, timestamp: Date.now() });
    if (consoleBuffer.length > MAX_CONSOLE_BUFFER) consoleBuffer.shift();

    if (!active) return;
    window.postMessage(
      { source: 'devrecorder-page-agent', type: 'console', level: 'error', args, timestamp: Date.now(), stack },
      '*'
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    const args = [`Unhandled Promise Rejection: ${e.reason?.message || e.reason}`];
    const stack = e.reason?.stack || '';
    // Always buffer for screenshots
    consoleBuffer.push({ level: 'error', args, stack, timestamp: Date.now() });
    if (consoleBuffer.length > MAX_CONSOLE_BUFFER) consoleBuffer.shift();

    if (!active) return;
    window.postMessage(
      { source: 'devrecorder-page-agent', type: 'console', level: 'error', args, timestamp: Date.now(), stack },
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
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-devrecorder]')) return;

    const info = describeElement(target);
    // Always buffer for screenshots
    interactionBuffer.push({ action: 'click', selector: info.selector, tag: info.tag, text: info.text, timestamp: Date.now() });
    if (interactionBuffer.length > MAX_INTERACTION_BUFFER) interactionBuffer.shift();

    if (!active) return;
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
    try {
      if (init?.body) {
        requestBody = extractBody(init.body);
      } else if (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
        try {
          const clonedReq = input.clone();
          requestBody = await clonedReq.text();
        } catch { /* body already consumed */ }
      }
    } catch {}

    const fetchStart = Date.now();
    try {
      const response = await originalFetch(...args);

      try {
        let responseBody: string | null = null;
        try {
          const ct = response.headers.get('content-type') || '';
          const cl = parseInt(response.headers.get('content-length') || '0', 10);
          const isText = ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('html')
            || ct.includes('javascript') || ct.includes('form-urlencoded') || ct === '';
          if (isText && cl < 500_000) {
            const clone = response.clone();
            const text = await clone.text();
            if (text.length > 0 && text.length < 500_000) responseBody = text;
          }
        } catch { /* can't read */ }

        const redactedReq = redactBody(requestBody);
        const redactedRes = redactBody(responseBody);

        // Always buffer for screenshots
        networkBuffer.push({ url, method, status: response.status, duration: Date.now() - fetchStart, requestBody: redactedReq, responseBody: redactedRes, timestamp: Date.now() });
        if (networkBuffer.length > MAX_NETWORK_BUFFER) networkBuffer.shift();

        if (active) {
          window.postMessage({
            source: 'devrecorder-page-agent',
            type: 'network-response',
            url, method, status: response.status,
            requestBody: redactedReq, responseBody: redactedRes,
            timestamp: Date.now(),
          }, '*');
        }
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
    if (meta) {
      const requestBody: string | null = extractBody(body);
      const sendTime = Date.now();

      this.addEventListener('load', function () {
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

          const redactedReq = redactBody(requestBody);
          const redactedRes = redactBody(responseBody);

          // Always buffer for screenshots
          networkBuffer.push({ url: meta.url, method: meta.method, status: this.status, duration: Date.now() - sendTime, requestBody: redactedReq, responseBody: redactedRes, timestamp: Date.now() });
          if (networkBuffer.length > MAX_NETWORK_BUFFER) networkBuffer.shift();

          if (active) {
            window.postMessage({
              source: 'devrecorder-page-agent',
              type: 'network-response',
              url: meta.url, method: meta.method, status: this.status,
              requestBody: redactedReq, responseBody: redactedRes,
              timestamp: Date.now(),
            }, '*');
          }
        } catch { /* never break the app's XHR */ }
      }, { once: true });
    }
    return origSend.apply(this, [body] as any);
  };
})();
