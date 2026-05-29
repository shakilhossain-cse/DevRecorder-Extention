import { useState, useEffect, useRef, useCallback } from 'react';
import { MSG } from '@shared/types';
import type { RecordingState, CaptureMode } from '@shared/types';
import { api } from '@shared/api';

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
  const [mode, setMode] = useState<CaptureMode>('tab');
  const [micEnabled, setMicEnabled] = useState(false);
  const [savedLink, setSavedLink] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('devrecorder-theme') as 'dark' | 'light') || 'dark';
  });
  // Integration state
  const [integrations, setIntegrations] = useState<{ clickup: boolean; trello: boolean }>({ clickup: false, trello: false });
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskProvider, setTaskProvider] = useState<'clickup' | 'trello' | null>(null);
  const [taskLists, setTaskLists] = useState<{ id: string; name: string; group: string }[]>([]);
  const [taskListsLoading, setTaskListsLoading] = useState(false);
  const [taskSelectedList, setTaskSelectedList] = useState('');
  const [taskName, setTaskName] = useState('');
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskCreated, setTaskCreated] = useState<{ name: string; url: string } | null>(null);
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

  // Listen for upload completion and progress via storage
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session') {
        if (changes.uploadComplete?.newValue) {
          setUploading(false);
          setUploadProgress(100);
        }
        if (changes.uploadProgress?.newValue != null) {
          setUploadProgress(changes.uploadProgress.newValue as number);
        }
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Check if upload already completed (popup reopened after upload finished)
  useEffect(() => {
    if (!uploading) return;
    chrome.runtime.sendMessage({ type: MSG.RECORDING_STATE }).then((res) => {
      if (res && res.status === 'idle') {
        setUploading(false);
      }
    });
  }, [uploading]);

  // Fetch initial state + check mic permission (only when authed)
  useEffect(() => {
    if (!authed) return;

    chrome.runtime.sendMessage({ type: MSG.RECORDING_STATE }).then((res) => {
      if (res) {
        setState(res);
        if ((res.status === 'recording' || res.status === 'paused' || res.status === 'countdown') && res.startTime) {
          startTimeRef.current = res.startTime;
          startTimer();
        }
        // Restore uploading state if popup was reopened during upload
        if (res.status === 'uploading' && res.id) {
          setSavedLink(`${FRONTEND_URL}/share/${res.id}`);
          setUploading(true);
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

  const handleScreenshot = async (delay?: number) => {
    setError('');
    setLoading(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab found');
        setLoading(false);
        return;
      }

      const result = await chrome.runtime.sendMessage({
        type: MSG.TAKE_SCREENSHOT,
        tabId: tab.id,
        tabTitle: tab.title || '',
        tabUrl: tab.url || '',
        delay,
      });

      if (result.success) {
        window.close();
      } else {
        setError(result.error || 'Failed to take screenshot');
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
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
          // State starts as 'countdown' — timer will begin when countdown finishes
          setState({ status: 'countdown', id: result.recordingId, tabId: tab.id, startTime: null });
          // Close popup so user sees the countdown on the page
          window.close();
        } else {
          setError(result.error || 'Failed to start');
        }
      } else if (state.status === 'recording' || state.status === 'paused' || state.status === 'countdown') {
        const recId = state.id;
        const result = await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });

        if (result.success) {
          setState({ status: 'idle', id: null, tabId: null, startTime: null });
          stopTimer();
          setElapsed('00:00');
          if (recId) {
            setSavedLink(`${FRONTEND_URL}/share/${recId}`);
            setUploading(true);
            // Fetch connected integrations
            api.getConnectedIntegrations().then(setIntegrations).catch(() => {});
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
    }).catch(() => {
      setError('Failed to copy link');
    });
  };

  const handleOpen = () => {
    if (!savedLink) return;
    chrome.tabs.create({ url: savedLink });
    window.close();
  };

  const handleOpenCreateTask = async (provider: 'clickup' | 'trello') => {
    setTaskProvider(provider);
    setShowCreateTask(true);
    setTaskName(`Bug: ${state.id ? 'Recording' : 'Issue'}`);
    setTaskCreated(null);
    setTaskListsLoading(true);
    try {
      if (provider === 'clickup') {
        const lists = await api.getClickUpLists();
        setTaskLists(lists.map((l) => ({ id: l.id, name: l.name, group: l.space })));
        if (lists.length > 0) setTaskSelectedList(lists[0].id);
      } else {
        const lists = await api.getTrelloLists();
        setTaskLists(lists.map((l) => ({ id: l.id, name: l.name, group: l.board })));
        if (lists.length > 0) setTaskSelectedList(lists[0].id);
      }
    } catch {}
    setTaskListsLoading(false);
  };

  const handleCreateTask = async () => {
    if (!taskProvider || !taskSelectedList || !taskName.trim()) return;
    setTaskCreating(true);
    const recId = savedLink?.split('/share/')[1] || '';
    const description = `Recording: ${savedLink}\n\nCreated from DevRecorder extension.`;
    try {
      if (taskProvider === 'clickup') {
        const { task } = await api.createClickUpTask({
          listId: taskSelectedList,
          name: taskName,
          description,
          recordingId: recId,
        });
        setTaskCreated({ name: task.name, url: task.url });
      } else {
        const { card } = await api.createTrelloCard({
          listId: taskSelectedList,
          name: taskName,
          description,
          recordingId: recId,
        });
        setTaskCreated({ name: card.name, url: card.shortUrl || card.url });
      }
    } catch {
      setError(`Failed to create ${taskProvider === 'clickup' ? 'task' : 'card'}`);
    }
    setTaskCreating(false);
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

  const isRecording = state.status === 'recording' || state.status === 'paused' || state.status === 'countdown';
  const isPaused = state.status === 'paused';

  const handlePauseResume = async () => {
    try {
      if (isPaused) {
        await chrome.runtime.sendMessage({ type: MSG.RESUME_RECORDING });
        setState((s) => ({ ...s, status: 'recording' }));
      } else {
        await chrome.runtime.sendMessage({ type: MSG.PAUSE_RECORDING });
        setState((s) => ({ ...s, status: 'paused' }));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── Saved modal ────────────────────────
  if (savedLink) {
    // Task creation sub-panel
    if (showCreateTask && taskProvider) {
      return (
        <div className="container">
          <div className="saved-modal">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <button
                onClick={() => { setShowCreateTask(false); setTaskProvider(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: 'var(--text-secondary)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
                </svg>
              </button>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Create a</span>
              <span style={{
                fontSize: '12px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '6px',
                background: taskProvider === 'clickup' ? 'rgba(236,72,153,0.1)' : 'rgba(14,165,233,0.1)',
                color: taskProvider === 'clickup' ? '#ec4899' : '#0ea5e9',
              }}>
                {taskProvider === 'clickup' ? 'ClickUp task' : 'Trello card'}
              </span>
            </div>

            {taskCreated ? (
              <>
                <div className="saved-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <h2 className="saved-title">{taskProvider === 'clickup' ? 'Task' : 'Card'} Created!</h2>
                <p className="saved-subtitle" style={{ wordBreak: 'break-all' }}>{taskCreated.name}</p>
                <div className="saved-actions">
                  <button className="saved-open-btn" onClick={() => {
                    chrome.tabs.create({ url: taskCreated.url });
                    window.close();
                  }}>
                    Open in {taskProvider === 'clickup' ? 'ClickUp' : 'Trello'}
                  </button>
                  <button className="saved-close-btn" onClick={() => { setShowCreateTask(false); setTaskProvider(null); }}>
                    Back
                  </button>
                </div>
              </>
            ) : taskListsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
                <svg style={{ animation: 'spin 1s linear infinite' }} width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25"/>
                  <path d="M4 12a8 8 0 0 1 8-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                </svg>
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    {taskProvider === 'clickup' ? 'Task' : 'Card'} name
                  </label>
                  <input
                    type="text"
                    value={taskName}
                    onChange={(e) => setTaskName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      fontSize: '13px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    {taskProvider === 'clickup' ? 'List' : 'Board / List'}
                  </label>
                  {taskLists.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>No lists found</p>
                  ) : (
                    <select
                      value={taskSelectedList}
                      onChange={(e) => setTaskSelectedList(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '13px',
                        outline: 'none',
                        cursor: 'pointer',
                        boxSizing: 'border-box',
                      }}
                    >
                      {taskLists.map((list) => (
                        <option key={list.id} value={list.id}>{list.group} — {list.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="saved-actions">
                  <button
                    className="saved-open-btn"
                    onClick={handleCreateTask}
                    disabled={taskCreating || !taskSelectedList || !taskName.trim()}
                    style={taskProvider === 'clickup' ? { background: '#ec4899' } : { background: '#0ea5e9' }}
                  >
                    {taskCreating ? 'Creating...' : 'Create'}
                  </button>
                  <button className="saved-close-btn" onClick={() => { setShowCreateTask(false); setTaskProvider(null); }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="container">
        <div className="saved-modal">
          {uploading ? (
            <>
              <div className="saved-icon uploading">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <h2 className="saved-title">Uploading Video... {uploadProgress > 0 ? `${uploadProgress}%` : ''}</h2>
              <p className="saved-subtitle">Your recording is being uploaded. This may take a moment.</p>
              <div className="upload-progress-bar">
                <div className="upload-progress-fill" style={uploadProgress > 0 ? { width: `${uploadProgress}%`, animation: 'none' } : undefined} />
              </div>
            </>
          ) : (
            <>
              <div className="saved-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </div>
              <h2 className="saved-title">Recording Saved</h2>
              <p className="saved-subtitle">Your recording is ready. Share it with the link below.</p>
            </>
          )}

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

          {/* Integration buttons */}
          {(integrations.clickup || integrations.trello) && !uploading && (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
              {integrations.clickup && (
                <button
                  onClick={() => handleOpenCreateTask('clickup')}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    padding: '8px 12px',
                    borderRadius: '10px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 9 19 20 6"/><polyline points="4 8 9 13 20 2"/>
                  </svg>
                  ClickUp
                </button>
              )}
              {integrations.trello && (
                <button
                  onClick={() => handleOpenCreateTask('trello')}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    padding: '8px 12px',
                    borderRadius: '10px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="16" rx="1.5"/><rect x="14" y="3" width="7" height="10" rx="1.5"/>
                  </svg>
                  Trello
                </button>
              )}
            </div>
          )}

          <div className="saved-actions">
            <button className="saved-open-btn" onClick={handleOpen} disabled={uploading}>
              {uploading ? 'Uploading...' : 'View Recording'}
            </button>
            <button className="saved-close-btn" onClick={() => { setSavedLink(null); setUploading(false); setShowCreateTask(false); setTaskProvider(null); setTaskCreated(null); }}>
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
        <div className={`status-badge ${isRecording ? (isPaused ? 'paused' : state.status === 'countdown' ? 'countdown' : 'recording') : ''}`}>
          <span className={`status-dot ${isRecording ? (isPaused ? 'paused' : state.status === 'countdown' ? 'countdown' : 'recording') : ''}`} />
          <span>{isRecording ? (isPaused ? 'Paused' : state.status === 'countdown' ? 'Starting...' : 'Recording') : 'Ready'}</span>
        </div>
      </div>

      {/* Timer */}
      <div className="timer-section">
        <div className={`timer ${isRecording ? 'active' : ''}`}>{elapsed}</div>
        {isRecording && <div className="timer-glow" />}
      </div>

      {/* Record area toggle */}
      {!isRecording && (
        <div className="record-area-row">
          <span className="record-area-label">Record area</span>
          <div className="record-area-toggle">
            <button
              className={`record-area-btn ${mode === 'tab' ? 'active' : ''}`}
              onClick={() => setMode('tab')}
            >
              Tab
            </button>
            <button
              className={`record-area-btn ${mode === 'desktop' ? 'active' : ''}`}
              onClick={() => setMode('desktop')}
            >
              Desktop
            </button>
          </div>
        </div>
      )}

      {/* Mic toggle  only show when idle */}
      {!isRecording && (
        <button
          className={`mic-btn ${micEnabled ? 'enabled' : ''}`}
          onClick={async () => {
            if (micEnabled) {
              setMicEnabled(false);
              return;
            }
            setError('');
            try {
              const result = await chrome.runtime.sendMessage({ type: MSG.REQUEST_MIC_PERMISSION });
              if (result?.granted) {
                setMicEnabled(true);
              } else {
                setError(result?.error || 'Microphone permission denied. Check browser settings.');
              }
            } catch {
              setError('Failed to request microphone permission.');
            }
          }}
        >
          {micEnabled ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23"/>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
            </svg>
          )}
          <span>{micEnabled ? 'Mute Microphone' : 'Enable Microphone'}</span>
        </button>
      )}

      {/* Main Actions */}
      <div className="actions">
        {isRecording ? (
          <div className="recording-controls">
            <button
              className={`btn-pause ${isPaused ? 'is-paused' : ''}`}
              onClick={handlePauseResume}
            >
              {isPaused ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                  <span>Resume</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                  <span>Pause</span>
                </>
              )}
            </button>
            <button
              className={`btn-stop ${loading ? 'disabled' : ''}`}
              onClick={handleRecord}
              disabled={loading}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              <span>Stop</span>
            </button>
          </div>
        ) : (
          <>
            <button
              className={`btn-record ${loading ? 'disabled' : ''}`}
              onClick={handleRecord}
              disabled={loading}
            >
              <span className="btn-icon">●</span>
              <span>Start Recording</span>
            </button>
            <div className="screenshot-actions">
              <button
                className={`btn-screenshot ${loading ? 'disabled' : ''}`}
                onClick={() => handleScreenshot()}
                disabled={loading}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <path d="m21 15-5-5L5 21"/>
                </svg>
                <span>Screenshot</span>
              </button>
              <div className="screenshot-delay-group">
                <button
                  className="btn-screenshot-delay"
                  onClick={() => handleScreenshot(3000)}
                  disabled={loading}
                  title="3 second delay — capture hover states"
                >
                  3s
                </button>
                <button
                  className="btn-screenshot-delay"
                  onClick={() => handleScreenshot(6000)}
                  disabled={loading}
                  title="6 second delay — capture hover states"
                >
                  6s
                </button>
              </div>
            </div>
          </>
        )}
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
