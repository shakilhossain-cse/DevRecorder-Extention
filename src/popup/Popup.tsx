import { useState, useEffect, useRef, useCallback } from 'react';
import { MSG } from '@shared/types';
import type { RecordingState, CaptureMode } from '@shared/types';

const FRONTEND_URL = 'https://www.devrecorder.com';

export function Popup() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = loading
  const [state, setState] = useState<RecordingState>({
    status: 'idle',
    id: null,
    tabId: null,
    startTime: null,
  });
  const [elapsed, setElapsed] = useState('00:00');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CaptureMode>('window');
  const [micEnabled, setMicEnabled] = useState(false);
  const [savedLink, setSavedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('devrecorder-theme') as 'dark' | 'light') || 'dark';
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('devrecorder-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Check auth on mount
  useEffect(() => {
    chrome.storage.local.get('apiToken').then(({ apiToken }) => {
      setAuthed(!!apiToken);
    });

    // Listen for token changes (e.g. auth-detector stores it)
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.apiToken) {
        setAuthed(!!changes.apiToken.newValue);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Fetch initial state + check mic permission (only when authed)
  useEffect(() => {
    if (!authed) return;

    chrome.runtime.sendMessage({ type: MSG.RECORDING_STATE }).then((res) => {
      if (res) {
        setState(res);
        if (res.status === 'recording' && res.startTime) {
          startTimeRef.current = res.startTime;
          startTimer();
        }
      }
    });
    navigator.permissions.query({ name: 'microphone' as PermissionName }).then((p) => {
      setMicEnabled(p.state === 'granted');
    }).catch(() => {});
    return () => stopTimer();
  }, [authed]);

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = setInterval(() => {
      if (!startTimeRef.current) return;
      const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      setElapsed(`${m}:${s}`);
    }, 1000);
  }, []);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const handleSignIn = () => {
    chrome.tabs.create({ url: `${FRONTEND_URL}/extension-auth` });
    window.close();
  };

  const handleSignOut = () => {
    chrome.storage.local.remove('apiToken');
    setAuthed(false);
  };

  const handleRecord = async () => {
    setError('');
    setLoading(true);
    setSavedLink(null);

    try {
      if (state.status === 'idle') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setError('No active tab found');
          setLoading(false);
          return;
        }

        const result = await chrome.runtime.sendMessage({
          type: MSG.START_RECORDING,
          tabId: tab.id,
          tabTitle: tab.title || '',
          tabUrl: tab.url || '',
          captureMode: mode,
        });

        if (result.success) {
          startTimeRef.current = Date.now();
          setState({ status: 'recording', id: result.recordingId, tabId: tab.id, startTime: Date.now() });
          startTimer();
        } else {
          setError(result.error || 'Failed to start');
        }
      } else if (state.status === 'recording') {
        const recId = state.id;
        const result = await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });

        if (result.success) {
          setState({ status: 'idle', id: null, tabId: null, startTime: null });
          stopTimer();
          setElapsed('00:00');
          if (recId) {
            setSavedLink(`${FRONTEND_URL}/recordings/${recId}`);
          }
        } else {
          setError(result.error || 'Failed to stop');
        }
      }
    } catch (err) {
      setError((err as Error).message);
    }

    setLoading(false);
  };

  const handleCopy = () => {
    if (!savedLink) return;
    navigator.clipboard.writeText(savedLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleOpen = () => {
    if (!savedLink) return;
    chrome.tabs.create({ url: savedLink });
    window.close();
  };

  // ── Loading state ──────────────────────
  if (authed === null) {
    return (
      <div className="container">
        <div className="header">
          <div className="logo">
            <span className="logo-icon">&#x2B24;</span>
            <span className="logo-text">DevRecorder</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Login screen ───────────────────────
  if (!authed) {
    return (
      <div className="container">
        <div className="header">
          <div className="logo">
            <span className="logo-icon">&#x2B24;</span>
            <span className="logo-text">DevRecorder</span>
          </div>
        </div>
        <div className="login-section">
          <div className="login-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
          </div>
          <h2 className="login-title">Sign in to record</h2>
          <p className="login-subtitle">Connect your DevRecorder account to start capturing debug sessions.</p>
          <button className="btn-login" onClick={handleSignIn}>
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>
        <div className="footer">
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
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
        </div>
      </div>
    );
  }

  const isRecording = state.status === 'recording';

  // ── Saved modal ────────────────────────
  if (savedLink) {
    return (
      <div className="container">
        <div className="saved-modal">
          <div className="saved-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <h2 className="saved-title">Recording Saved</h2>
          <p className="saved-subtitle">Your recording is being uploaded. Share it with the link below.</p>

          <div className="saved-link-box">
            <span className="saved-link-text">{savedLink}</span>
            <button className="saved-copy-btn" onClick={handleCopy}>
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              )}
            </button>
          </div>

          <div className="saved-actions">
            <button className="saved-open-btn" onClick={handleOpen}>
              Open Recording
            </button>
            <button className="saved-close-btn" onClick={() => setSavedLink(null)}>
              New Recording
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main UI ────────────────────────────
  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div className="logo">
          <span className="logo-icon">&#x2B24;</span>
          <span className="logo-text">DevRecorder</span>
        </div>
        <div className={`status-badge ${isRecording ? 'recording' : ''}`}>
          <span className={`status-dot ${isRecording ? 'recording' : ''}`} />
          <span>{isRecording ? 'Recording' : 'Ready'}</span>
        </div>
      </div>

      {/* Timer */}
      <div className="timer-section">
        <div className={`timer ${isRecording ? 'active' : ''}`}>{elapsed}</div>
        {isRecording && <div className="timer-glow" />}
      </div>

      {/* Mode Selector — only show when idle */}
      {!isRecording && (
        <div className="mode-selector">
          <button
            className={`mode-btn ${mode === 'window' ? 'active' : ''}`}
            onClick={() => setMode('window')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <span>Window</span>
          </button>
          <button
            className={`mode-btn ${mode === 'region' ? 'active' : ''}`}
            onClick={() => setMode('region')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2L2 6"/><path d="M2 12v-2"/><path d="M2 18l4 4"/><path d="M12 2h2"/>
              <path d="M18 2l4 4"/><path d="M22 12v2"/><path d="M22 18l-4 4"/><path d="M12 22h-2"/>
            </svg>
            <span>Region</span>
          </button>
        </div>
      )}

      {/* Mic toggle — only show when idle */}
      {!isRecording && (
        <button
          className={`mic-btn ${micEnabled ? 'enabled' : ''}`}
          onClick={async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              setMicEnabled(true);
            } catch {
              setMicEnabled(false);
            }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
          <span>{micEnabled ? 'Microphone On' : 'Enable Microphone'}</span>
        </button>
      )}

      {/* Main Actions */}
      <div className="actions">
        <button
          className={`btn-record ${isRecording ? 'recording' : ''} ${loading ? 'disabled' : ''}`}
          onClick={handleRecord}
          disabled={loading}
        >
          <span className="btn-icon">{isRecording ? '■' : '●'}</span>
          <span>{isRecording ? 'Stop Recording' : 'Start Recording'}</span>
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Footer */}
      <div className="footer">
        <button className="btn-viewer" onClick={() => {
          chrome.tabs.create({ url: FRONTEND_URL });
          window.close();
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <span>View Recordings</span>
        </button>
        <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
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
        <button className="btn-signout" onClick={handleSignOut} title="Sign out">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
