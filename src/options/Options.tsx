import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RewindPreferences } from '@shared/types';
import {
  DEFAULT_REWIND_PREFERENCES,
  getRewindPreferences,
  isHostBlocked,
  isHostForceEnabled,
  normalizeHost,
  onRewindPreferencesChanged,
  setRewindPreferences,
} from '@shared/rewind-storage';
import { DEFAULT_BLOCKED_HOSTS } from '@shared/rewind-default-blocklist';

// Buffer-length save trigger:
//   - The <input type="number"> commits onBlur or on Enter — this matches the
//     way the user typically tabs out of a field. Mid-typing keystrokes do not
//     hit storage to avoid validation churn.
//   - The <input type="range"> saves on change but is debounced so dragging
//     does not write to storage on every pixel.
// The two inputs share `bufferDraft` so the UI shows the in-progress value
// even before it commits to storage.
const BUFFER_SAVE_DEBOUNCE_MS = 250;
const MIN_BUFFER_SECONDS = 10;
const MAX_BUFFER_SECONDS = 600;

export function Options() {
  const [preferences, setPreferences] = useState<RewindPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bufferDraft, setBufferDraft] = useState<number>(DEFAULT_REWIND_PREFERENCES.bufferSeconds);
  const [blockedHostInput, setBlockedHostInput] = useState('');
  const [blockedHostError, setBlockedHostError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('devrecorder-theme') as 'dark' | 'light') || 'dark';
  });

  // Apply theme — mirrors the popup's data-theme + localStorage pattern.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('devrecorder-theme', theme);
  }, [theme]);

  // Debounce timer for the buffer-length range input.
  const bufferDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the latest committed buffer value so the storage listener can avoid
  // clobbering an in-progress local edit when an echoed change comes back.
  const lastWrittenBufferRef = useRef<number>(DEFAULT_REWIND_PREFERENCES.bufferSeconds);

  // Transient error toast clear.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // Load preferences + subscribe to changes.
  useEffect(() => {
    let alive = true;
    getRewindPreferences().then((p) => {
      if (!alive) return;
      setPreferences(p);
      setBufferDraft(p.bufferSeconds);
      lastWrittenBufferRef.current = p.bufferSeconds;
      setLoading(false);
    });
    const unsub = onRewindPreferencesChanged((next) => {
      setPreferences(next);
      // Only sync the buffer draft from storage if it matches the last value
      // we wrote (i.e. the user is not actively editing). Otherwise preserve
      // the user's in-progress draft.
      if (next.bufferSeconds === lastWrittenBufferRef.current) {
        setBufferDraft(next.bufferSeconds);
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const save = useCallback(async (partial: Partial<RewindPreferences>) => {
    try {
      // Optimistic local update so the UI stays snappy. The
      // onRewindPreferencesChanged listener will reconcile.
      setPreferences((prev) => (prev ? { ...prev, ...partial } : prev));
      const validated = await setRewindPreferences(partial);
      if (typeof partial.bufferSeconds === 'number') {
        lastWrittenBufferRef.current = validated.bufferSeconds;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save settings';
      setError(message);
      // Reconcile with the actual stored value on failure.
      const fresh = await getRewindPreferences().catch(() => null);
      if (fresh) {
        setPreferences(fresh);
        setBufferDraft(fresh.bufferSeconds);
        lastWrittenBufferRef.current = fresh.bufferSeconds;
      }
    }
  }, []);

  const handleGloballyEnabledToggle = useCallback(() => {
    if (!preferences) return;
    save({ globallyEnabled: !preferences.globallyEnabled });
  }, [preferences, save]);

  const clampBuffer = (n: number): number => {
    if (!Number.isFinite(n)) return DEFAULT_REWIND_PREFERENCES.bufferSeconds;
    return Math.max(MIN_BUFFER_SECONDS, Math.min(MAX_BUFFER_SECONDS, Math.round(n)));
  };

  const commitBuffer = useCallback(
    (raw: number) => {
      const next = clampBuffer(raw);
      setBufferDraft(next);
      save({ bufferSeconds: next });
    },
    [save],
  );

  const handleBufferRangeChange = useCallback(
    (raw: number) => {
      // Update the local draft immediately so the slider position and label
      // track the user's input, then debounce the storage write so dragging
      // does not generate dozens of writes per second.
      setBufferDraft(raw);
      if (bufferDebounceRef.current) clearTimeout(bufferDebounceRef.current);
      bufferDebounceRef.current = setTimeout(() => {
        commitBuffer(raw);
      }, BUFFER_SAVE_DEBOUNCE_MS);
    },
    [commitBuffer],
  );

  const handleBufferNumberBlur = useCallback(() => {
    commitBuffer(bufferDraft);
  }, [bufferDraft, commitBuffer]);

  const handleBufferNumberKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  const addBlockedHost = useCallback(() => {
    if (!preferences) return;
    const normalized = normalizeHost(blockedHostInput);
    if (!normalized) {
      setBlockedHostError('Enter a hostname like example.com');
      return;
    }
    if (isHostBlocked(preferences, normalized)) {
      setBlockedHostError('That site is already blocked');
      return;
    }
    setBlockedHostError(null);
    setBlockedHostInput('');
    // Mirror the SW's UPDATE_REWIND_BLOCKLIST {action:'add'} precedence:
    // an explicit block trumps any prior force-enable override, so drop
    // the host from forceEnabledHosts in the same write.
    const blockedHosts = [...preferences.blockedHosts, normalized];
    const forceEnabledHosts = preferences.forceEnabledHosts.filter(
      (h) => normalizeHost(h) !== normalized,
    );
    save({ blockedHosts, forceEnabledHosts });
  }, [blockedHostInput, preferences, save]);

  const removeBlockedHost = useCallback(
    (host: string) => {
      if (!preferences) return;
      const target = normalizeHost(host);
      const blockedHosts = preferences.blockedHosts.filter(
        (h) => normalizeHost(h) !== target,
      );
      save({ blockedHosts });
    },
    [preferences, save],
  );

  const removeForceEnabledHost = useCallback(
    (host: string) => {
      if (!preferences) return;
      const target = normalizeHost(host);
      const forceEnabledHosts = preferences.forceEnabledHosts.filter(
        (h) => normalizeHost(h) !== target,
      );
      save({ forceEnabledHosts });
    },
    [preferences, save],
  );

  const clearAutoDisabledHost = useCallback(
    (host: string) => {
      if (!preferences) return;
      const target = normalizeHost(host);
      const autoDisabledHosts = preferences.autoDisabledHosts.filter(
        (h) => normalizeHost(h) !== target,
      );
      save({ autoDisabledHosts });
    },
    [preferences, save],
  );

  const clearAllAutoDisabled = useCallback(() => {
    if (!preferences) return;
    save({ autoDisabledHosts: [] });
  }, [preferences, save]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const globallyEnabled = preferences?.globallyEnabled ?? true;
  const sectionDisabled = !globallyEnabled;

  const blockedHosts = preferences?.blockedHosts ?? [];
  const forceEnabledHosts = preferences?.forceEnabledHosts ?? [];
  const autoDisabledHosts = preferences?.autoDisabledHosts ?? [];

  // Help screen readers understand the disabled section without using the
  // disabled attribute on every input — we use aria-disabled for that.
  const sectionDimClass = useMemo(
    () => (sectionDisabled ? 'section-dim' : ''),
    [sectionDisabled],
  );

  if (loading || !preferences) {
    return (
      <div className="page">
        <div className="page-inner">
          <div className="loading">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div className="logo">
            <span className="logo-icon">&#x2B24;</span>
            <span className="logo-text">DevRecorder Settings</span>
          </div>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Instant Replay</h2>
          </div>
          <p className="section-intro">
            Instant Replay continuously buffers the last few seconds of the current tab so you
            can share what just happened. Recording happens locally — nothing is uploaded until
            you choose to share.
          </p>

          {/* Global toggle */}
          <div className="row">
            <div className="row-main">
              <div className="row-label">Enable Instant Replay</div>
              <div className="row-help">
                Master switch. When off, the buffer never runs on any site.
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={globallyEnabled}
                onChange={handleGloballyEnabledToggle}
                aria-label="Enable Instant Replay"
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
            </label>
          </div>

          {/* Buffer length */}
          <div className={`subsection ${sectionDimClass}`} aria-disabled={sectionDisabled}>
            <div className="subsection-head">
              <div className="row-label">Last seconds to keep</div>
              <div className="row-help">
                How much rolling video to keep buffered for the current tab.
                Allowed range: {MIN_BUFFER_SECONDS}–{MAX_BUFFER_SECONDS} seconds.
              </div>
              {/*
                Note: changes apply on the next buffer (re)start. A buffer that
                is already running on a tab keeps its previous length until the
                tab changes or the buffer is otherwise re-evaluated. The SW
                subscribes to storage and calls evaluateRewind() on every
                preferences change, so no manual "restart" button is needed.
              */}
            </div>
            <div className="buffer-controls">
              <input
                type="range"
                min={MIN_BUFFER_SECONDS}
                max={MAX_BUFFER_SECONDS}
                step={5}
                value={bufferDraft}
                onChange={(e) => handleBufferRangeChange(Number(e.target.value))}
                disabled={sectionDisabled}
                aria-label="Buffer length seconds slider"
              />
              <input
                type="number"
                min={MIN_BUFFER_SECONDS}
                max={MAX_BUFFER_SECONDS}
                step={5}
                value={bufferDraft}
                onChange={(e) => setBufferDraft(Number(e.target.value))}
                onBlur={handleBufferNumberBlur}
                onKeyDown={handleBufferNumberKeyDown}
                disabled={sectionDisabled}
                aria-label="Buffer length seconds"
                className="buffer-number"
              />
              <div className="buffer-current" aria-live="polite">
                Currently: {bufferDraft}s
              </div>
            </div>
          </div>

          {/* Blocked sites */}
          <div className={`subsection ${sectionDimClass}`} aria-disabled={sectionDisabled}>
            <div className="subsection-head">
              <div className="row-label">Blocked sites</div>
              <div className="row-help">
                Instant Replay will never run on these sites. Adding a site here
                also removes it from the force-enabled list.
              </div>
            </div>
            <form
              className="host-add"
              onSubmit={(e) => {
                e.preventDefault();
                addBlockedHost();
              }}
            >
              <input
                type="text"
                placeholder="example.com"
                value={blockedHostInput}
                onChange={(e) => {
                  setBlockedHostInput(e.target.value);
                  if (blockedHostError) setBlockedHostError(null);
                }}
                disabled={sectionDisabled}
                aria-label="Site to block"
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={sectionDisabled || !blockedHostInput.trim()}
              >
                Add
              </button>
            </form>
            {blockedHostError && <div className="inline-error">{blockedHostError}</div>}
            <ul className="host-list">
              {blockedHosts.length === 0 ? (
                <li className="host-empty">
                  No blocked sites. Add a host above to disable Instant Replay there.
                </li>
              ) : (
                blockedHosts.map((host) => (
                  <li key={host} className="host-row">
                    <span className="host-name">{host}</span>
                    <button
                      type="button"
                      className="btn-link-danger"
                      onClick={() => removeBlockedHost(host)}
                      disabled={sectionDisabled}
                    >
                      Remove
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Built-in privacy blocklist (read-only) */}
          <div className={`subsection ${sectionDimClass}`} aria-disabled={sectionDisabled}>
            <div className="subsection-head">
              <div className="row-label">Built-in privacy blocklist</div>
              <div className="row-help">
                These sites are blocked by default because pages here may
                contain sensitive personal, financial, or proprietary
                information. Matching is suffix-based, so an entry like
                "paypal.com" also covers every subdomain of it. To override
                per-site, click "Share Last Minute" on that site and choose
                Continue in the confirmation prompt.
              </div>
            </div>
            <ul className="host-list">
              {DEFAULT_BLOCKED_HOSTS.map((host) => {
                const isForced = preferences ? isHostForceEnabled(preferences, host) : false;
                return (
                  <li key={host} className="host-row">
                    <span className="host-name">
                      {host}
                      {isForced && <span className="host-tag">force-enabled</span>}
                    </span>
                    <span className="host-tag" aria-label="Built-in entry">built-in</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Force-enabled sites */}
          <div className={`subsection ${sectionDimClass}`} aria-disabled={sectionDisabled}>
            <div className="subsection-head">
              <div className="row-label">Force-enabled sites</div>
              <div className="row-help">
                Sites where you've manually turned Instant Replay back on after
                it was auto-disabled.
              </div>
            </div>
            <ul className="host-list">
              {forceEnabledHosts.length === 0 ? (
                <li className="host-empty">No sites have been manually force-enabled.</li>
              ) : (
                forceEnabledHosts.map((host) => {
                  // Defensive: a host should not appear here and on the
                  // blocklist at the same time, but if it does (e.g. an older
                  // install before Phase 2 enforcement) show a quiet hint.
                  const conflictsWithBlock = preferences ? isHostBlocked(preferences, host) : false;
                  return (
                    <li key={host} className="host-row">
                      <span className="host-name">
                        {host}
                        {conflictsWithBlock && (
                          <span className="host-tag">also blocked</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="btn-link-danger"
                        onClick={() => removeForceEnabledHost(host)}
                        disabled={sectionDisabled}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Auto-disabled sites */}
          <div className={`subsection ${sectionDimClass}`} aria-disabled={sectionDisabled}>
            <div className="subsection-head">
              <div className="row-label">Auto-disabled sites</div>
              <div className="row-help">
                Sites that Instant Replay turned off automatically due to high CPU or
                memory pressure. Clearing a site here lets the heuristic try again.
              </div>
            </div>
            <div className="host-list-toolbar">
              <button
                type="button"
                className="btn-secondary"
                onClick={clearAllAutoDisabled}
                disabled={sectionDisabled || autoDisabledHosts.length === 0}
              >
                Clear all
              </button>
            </div>
            <ul className="host-list">
              {autoDisabledHosts.length === 0 ? (
                <li className="host-empty">No sites have been auto-disabled.</li>
              ) : (
                autoDisabledHosts.map((host) => {
                  const isForced = preferences ? isHostForceEnabled(preferences, host) : false;
                  return (
                    <li key={host} className="host-row">
                      <span className="host-name">
                        {host}
                        {isForced && <span className="host-tag">force-enabled</span>}
                      </span>
                      <button
                        type="button"
                        className="btn-link-danger"
                        onClick={() => clearAutoDisabledHost(host)}
                        disabled={sectionDisabled}
                      >
                        Clear
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">About this feature</h2>
          </div>
          <p className="section-intro">
            Instant Replay keeps a short rolling buffer of the active tab on your device.
            Nothing leaves your machine until you click Share Last Minute from the popup.
            If a site becomes resource-intensive, DevRecorder will automatically pause
            buffering there to keep your browser responsive.
          </p>
        </section>
      </div>
    </div>
  );
}
