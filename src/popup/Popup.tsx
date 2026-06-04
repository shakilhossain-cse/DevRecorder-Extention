import { useState, useEffect, useRef, useCallback } from 'react';
import { MSG } from '@shared/types';
import type { RecordingState, CaptureMode, RewindStatus, TimelineEvent } from '@shared/types';
import { api } from '@shared/api';
import { getRewindClip, markClipUploaded } from '@shared/rewind-clips-db';
import type { RewindClip } from '@shared/rewind-clips-db';

const FRONTEND_URL = 'https://www.devrecorder.com';

// Events bulk-upload batch size for rewind clip uploads. Matches the value in
// src/viewer/RewindPlayback.tsx so chatty pages don't blow JSON body limits.
const REWIND_EVENT_UPLOAD_BATCH = 500;

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
  // Share Last Minute (Rewind) state
  const [rewindStatus, setRewindStatus] = useState<RewindStatus>({ status: 'idle' });
  const [shareLastMinuteBusy, setShareLastMinuteBusy] = useState(false);
  const [shareLastMinuteNotice, setShareLastMinuteNotice] = useState<string | null>(null);
  // Phase 6: id of the tab the popup is currently looking at. Resolved at
  // popup mount via chrome.tabs.query. Needed to fill REWIND_SWITCH_TAB's
  // `targetTabId` when the user clicks the rewind button while it's
  // showing `enabledOnOtherTab`.
  const [popupActiveTabId, setPopupActiveTabId] = useState<number | null>(null);
  // Rewind clip saved modal — parallel state machine to `savedLink` (the
  // primary post-recording modal). The two never coexist: this gates on
  // `rewindSavedClipId !== null && savedLink === null` at render time.
  const [rewindSavedClipId, setRewindSavedClipId] = useState<string | null>(null);
  const [rewindSavedClip, setRewindSavedClip] = useState<RewindClip | null>(null);
  const [rewindSavedVideoUrl, setRewindSavedVideoUrl] = useState<string | null>(null);
  const [rewindUploading, setRewindUploading] = useState(false);
  const [rewindUploadProgress, setRewindUploadProgress] = useState(0);
  const [rewindUploadError, setRewindUploadError] = useState<string | null>(null);
  const [rewindShareUrl, setRewindShareUrl] = useState<string | null>(null);
  const [rewindCopied, setRewindCopied] = useState(false);
  // Inline confirmation modal for re-enabling rewind on a blocked/auto-disabled
  // host. When non-null, the popup body is replaced by a confirm/cancel card.
  const [rewindConfirm, setRewindConfirm] = useState<{
    kind: 'urlBlocked' | 'autoDisabled' | 'defaultBlocked';
    host: string;
  } | null>(null);
  const [rewindConfirmBusy, setRewindConfirmBusy] = useState(false);
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

  // Phase 6: resolve the active tab id once on mount. The popup uses this
  // as REWIND_SWITCH_TAB's `targetTabId` when the user wants to move capture
  // onto the tab they're currently on. We don't subscribe to onActivated
  // here — the popup's lifetime is short, and the user can only click the
  // button on the tab they're already looking at.
  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => {
        if (t && typeof t.id === 'number') setPopupActiveTabId(t.id);
      })
      .catch(() => {});
  }, []);

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

  // Rewind / Share Last Minute status. We query on popup open (which carries a
  // user gesture — this is how the SW can call tabCapture.getMediaStreamId for
  // the active tab) and then listen for status-change broadcasts.
  useEffect(() => {
    if (!authed) return;

    const validStatuses = new Set([
      'enabled',
      'forceEnabled',
      // Phase 6: buffer is alive on a different tab than the user's active
      // tab. The popup renders a "switch capture to this tab" affordance
      // when this status arrives.
      'enabledOnOtherTab',
      'autoDisabled',
      'urlBlocked',
      'defaultBlocked',
      'fileBlocked',
      'fullyDisabled',
      'browserInternal',
      'needsPopupOpen',
      'idle',
    ]);

    const acceptStatus = (incoming: unknown): RewindStatus | null => {
      if (!incoming || typeof incoming !== 'object') return null;
      const s = (incoming as { status?: string }).status;
      if (!s || !validStatuses.has(s)) return null;
      return incoming as RewindStatus;
    };

    const queryStatus = () => {
      chrome.runtime.sendMessage({ type: MSG.REWIND_STATUS }).then((res) => {
        const next = acceptStatus(res);
        if (next) setRewindStatus(next);
      }).catch(() => {});
    };

    queryStatus();

    const listener = (
      msg: { type?: string; status?: RewindStatus; clipId?: string; error?: string },
    ) => {
      if (msg?.type === MSG.REWIND_STATUS_CHANGED) {
        const next = acceptStatus(msg.status);
        if (next) setRewindStatus(next);
      }
      // Phase 3 / 5 — once the SW persists the clip to IndexedDB it broadcasts
      // REWIND_CLIP_SAVED. We no longer auto-close the popup: instead, we load
      // the clip from IDB and render the inline rewind-saved modal so the user
      // can preview, upload, copy the share link, or open the rich viewer.
      if (msg?.type === MSG.REWIND_CLIP_SAVED) {
        setShareLastMinuteBusy(false);
        // Clear the inline success notice — the modal is now the success UI.
        setShareLastMinuteNotice(null);
        if (msg.clipId) {
          setRewindSavedClipId(msg.clipId);
          setRewindUploadError(null);
          setRewindUploadProgress(0);
          setRewindShareUrl(null);
          setRewindCopied(false);
          getRewindClip(msg.clipId)
            .then((clip) => {
              if (!clip) return;
              setRewindSavedClip(clip);
              const url = URL.createObjectURL(clip.blob);
              setRewindSavedVideoUrl(url);
              if (clip.uploaded) setRewindShareUrl(clip.uploaded.shareUrl);
            })
            .catch(() => {});
        }
      }
      if (msg?.type === MSG.REWIND_CLIP_SAVE_FAILED) {
        setShareLastMinuteBusy(false);
        setShareLastMinuteNotice(msg.error || 'Failed to save replay clip');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [authed]);

  // Revoke the rewind preview's object URL when it's replaced or unmounted.
  // We track the URL in state so the JSX can read it directly; cleanup runs
  // when `rewindSavedVideoUrl` changes (revoking the previous value) and on
  // unmount.
  useEffect(() => {
    return () => {
      if (rewindSavedVideoUrl) URL.revokeObjectURL(rewindSavedVideoUrl);
    };
  }, [rewindSavedVideoUrl]);

  // Upload the saved rewind clip to DevRecorder. This mirrors the upload
  // pipeline in src/viewer/RewindPlayback.tsx (createRecording -> uploadVideo
  // -> bulk events -> device-info -> updateRecording -> markClipUploaded). We
  // intentionally keep this inline rather than extracting a shared helper —
  // the popup needs a slimmer UI surface and we don't want to thread setters
  // through a shared module. RewindPlayback.tsx remains the source of truth
  // for the richer viewer-side flow.
  const handleRewindUpload = async () => {
    if (rewindUploading) return;
    const clip = rewindSavedClip;
    if (!clip) return;
    if (!authed) return;
    if (rewindShareUrl || clip.uploaded) return;

    setRewindUploadError(null);
    setRewindUploading(true);
    setRewindUploadProgress(0);

    try {
      const titleHost = clip.host || 'capture';
      const durationSec = Math.max(1, Math.round(clip.durationMs / 1000));
      const { _id } = await api.createRecording({
        title: `Rewind: ${titleHost}`,
        url: clip.sourceTabUrl,
        startTime: clip.capturedAt,
        duration: durationSec,
        mediaType: 'video',
        recordingSurface: 'tab',
      });

      await api.uploadVideo(_id, clip.blob, (pct) => setRewindUploadProgress(pct));

      // Ship events after the video lands — same ordering as RewindPlayback.
      // Non-fatal: a failure here still leaves a playable recording on the
      // server, so we surface the error but don't abort.
      if (clip.events && clip.events.length > 0) {
        try {
          const payload: { type: string; relativeTime: number; data: Record<string, any> }[] =
            clip.events.map((e: TimelineEvent) => ({
              type: e.type,
              relativeTime: e.relativeTime,
              data: e.data as unknown as Record<string, any>,
            }));
          for (let i = 0; i < payload.length; i += REWIND_EVENT_UPLOAD_BATCH) {
            await api.sendEvents(_id, payload.slice(i, i + REWIND_EVENT_UPLOAD_BATCH));
          }
        } catch (err) {
          setRewindUploadError(
            `Video uploaded, but ${clip.events.length} events failed: ${(err as Error).message}`,
          );
        }
      }

      // Device-info snapshot (one synthetic event at relativeTime 0).
      if (clip.deviceInfo) {
        try {
          await api.sendEvents(_id, [
            {
              type: 'device-info',
              relativeTime: 0,
              data: clip.deviceInfo as unknown as Record<string, any>,
            },
          ]);
        } catch {
          // best-effort
        }
      }

      // Refine duration server-side (idempotent — best-effort).
      try {
        await api.updateRecording(_id, { duration: durationSec });
      } catch {
        // best-effort
      }

      const shareUrl = `${FRONTEND_URL}/recordings/${_id}`;
      try {
        await markClipUploaded(clip.id, { recordingId: _id, shareUrl });
      } catch {
        // The IDB write is convenience-only; the share URL we already have
        // works regardless of whether the local clip is marked uploaded.
      }
      setRewindShareUrl(shareUrl);
      setRewindUploadProgress(100);
    } catch (err) {
      setRewindUploadError((err as Error).message || 'Upload failed');
    } finally {
      setRewindUploading(false);
    }
  };

  // Reset all rewind-saved-modal state and revoke the preview URL. Called by
  // the modal's Close button and after "Open in Viewer".
  const handleRewindClose = () => {
    if (rewindSavedVideoUrl) URL.revokeObjectURL(rewindSavedVideoUrl);
    setRewindSavedClipId(null);
    setRewindSavedClip(null);
    setRewindSavedVideoUrl(null);
    setRewindUploading(false);
    setRewindUploadProgress(0);
    setRewindUploadError(null);
    setRewindShareUrl(null);
    setRewindCopied(false);
  };

  // Open the rich viewer for this clip and dismiss the modal. The viewer URL
  // path (viewer.html?rewindClipId=…) is unchanged from the previous flow —
  // we're just gating it behind a user click instead of auto-opening.
  const handleRewindOpenViewer = () => {
    if (!rewindSavedClipId) return;
    const url = chrome.runtime.getURL('viewer.html') + `?rewindClipId=${rewindSavedClipId}`;
    chrome.tabs.create({ url, active: true });
    handleRewindClose();
  };

  const handleRewindCopyShare = () => {
    if (!rewindShareUrl) return;
    navigator.clipboard.writeText(rewindShareUrl).then(
      () => {
        setRewindCopied(true);
        setTimeout(() => setRewindCopied(false), 2000);
      },
      () => setRewindUploadError('Failed to copy link'),
    );
  };

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

  // Fire the actual SHARE_LAST_MINUTE flow. Separated from the click handler
  // so the "re-enable then immediately share" path (after the user confirms
  // on a blocked or auto-disabled host) can call it directly.
  //
  // Phase 3 / 5 flow:
  //   - SW persists the clip to IndexedDB.
  //   - SW broadcasts REWIND_CLIP_SAVED on success / REWIND_CLIP_SAVE_FAILED on
  //     failure. The success listener above loads the clip and swaps the popup
  //     body to the rewind-saved modal.
  //   - We still inspect the direct response as a fallback (in case the
  //     broadcast races, or the listener hasn't attached yet). On a direct
  //     success response, we also seed the modal state from the clipId so the
  //     UI doesn't depend on the broadcast.
  const fireShareLastMinute = async () => {
    setShareLastMinuteBusy(true);
    setShareLastMinuteNotice('Capturing...');
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.SHARE_LAST_MINUTE });
      if (res && res.success) {
        // The broadcast listener will populate the modal. Clear the inline
        // notice now that capture is done. Don't auto-close — the modal stays
        // up until the user dismisses it.
        setShareLastMinuteNotice(null);
        // Fallback seed in case the broadcast listener didn't fire (it's the
        // same chrome.runtime in this context, so it will, but belt-and-braces).
        if (res.clipId && !rewindSavedClipId) {
          setRewindSavedClipId(res.clipId);
        }
      } else {
        setShareLastMinuteNotice(res?.error || 'Failed to share replay');
        setShareLastMinuteBusy(false);
      }
    } catch (err) {
      setShareLastMinuteNotice((err as Error).message);
      setShareLastMinuteBusy(false);
    }
  };

  // Resolve the latest status snapshot, since the broadcast may not have
  // landed before we send the SHARE_LAST_MINUTE message after re-enabling /
  // switching tabs (Phase 6). Hoisted above handleShareLastMinute so the
  // Phase 6 switch-then-share path can reference it.
  const isRewindActive = (s: RewindStatus): boolean =>
    s.status === 'enabled' || s.status === 'forceEnabled';

  const handleShareLastMinute = async () => {
    if (shareLastMinuteBusy) return;
    switch (rewindStatus.status) {
      case 'enabled':
      case 'forceEnabled':
        await fireShareLastMinute();
        return;
      case 'enabledOnOtherTab': {
        // Buffer is alive on a different tab. Share what's already buffered
        // there — DON'T switch capture (that would destroy the bufferedHost's
        // accumulated minute and start a fresh 0-second buffer on this tab).
        // A separate "Switch capture to this tab" affordance lives below the
        // share button for users who explicitly want to change capture target.
        await fireShareLastMinute();
        return;
      }
      case 'urlBlocked':
        setRewindConfirm({ kind: 'urlBlocked', host: rewindStatus.host });
        return;
      case 'autoDisabled':
        setRewindConfirm({ kind: 'autoDisabled', host: rewindStatus.host });
        return;
      case 'defaultBlocked':
        setRewindConfirm({ kind: 'defaultBlocked', host: rewindStatus.host });
        return;
      case 'fileBlocked':
      case 'fullyDisabled':
      case 'browserInternal':
      case 'needsPopupOpen':
      case 'idle':
        // Non-interactive — the button visual already shows it's unavailable.
        return;
      default: {
        const _exhaustive: never = rewindStatus;
        return _exhaustive;
      }
    }
  };

  const handleRewindConfirm = async () => {
    if (!rewindConfirm || rewindConfirmBusy) return;
    setRewindConfirmBusy(true);
    try {
      if (rewindConfirm.kind === 'urlBlocked') {
        // User-managed blocklist: removing the host lets the buffer run normally.
        await chrome.runtime.sendMessage({
          type: MSG.UPDATE_REWIND_BLOCKLIST,
          action: 'remove',
          host: rewindConfirm.host,
        });
      } else {
        // autoDisabled OR defaultBlocked: the entry isn't user-editable (or is
        // the heuristic's), so the only way past it is to force-enable per-site.
        await chrome.runtime.sendMessage({
          type: MSG.FORCE_ENABLE_REWIND,
          host: rewindConfirm.host,
        });
      }
      // Close the confirmation card immediately. The SW has already finished
      // its mutation + evaluateRewind() by the time the message resolves, so
      // a single status query will tell us whether to fire share.
      setRewindConfirm(null);
      // Poll once for the fresh status. The broadcast may still be in flight,
      // so we use the response from REWIND_STATUS as ground truth.
      const fresh = await chrome.runtime.sendMessage({ type: MSG.REWIND_STATUS }).catch(() => null);
      const next = fresh && typeof fresh === 'object' && (fresh as { status?: string }).status
        ? (fresh as RewindStatus)
        : null;
      if (next) {
        setRewindStatus(next);
        if (isRewindActive(next)) {
          await fireShareLastMinute();
        }
      }
    } catch (err) {
      setShareLastMinuteNotice((err as Error).message);
      setRewindConfirm(null);
    }
    setRewindConfirmBusy(false);
  };

  const handleRewindConfirmCancel = () => {
    if (rewindConfirmBusy) return;
    setRewindConfirm(null);
  };

  // Tooltip copy per status — exhaustive over the union.
  const rewindTooltip = (s: RewindStatus): string => {
    switch (s.status) {
      case 'enabled':
        return 'Share the last ~60 seconds of this tab';
      case 'forceEnabled':
        return 'Instant Replay was automatically turned off for this site, but you turned it back on. It might make your device run slower.';
      case 'enabledOnOtherTab':
        // The buffer is rolling on bufferedHost, not the active tab. Clicking
        // the share button captures what's already in that buffer; a separate
        // "Switch capture" link below the button moves capture if the user
        // wants the active tab instead.
        return `Share the last ~60 seconds of ${s.bufferedHost} (the tab currently being buffered).`;
      case 'autoDisabled':
        return 'Instant Replay was turned off automatically because capturing this site was found to be resource-intensive. Click to turn it on if needed.';
      case 'urlBlocked':
        return 'Instant Replay is off for this website to avoid slowing down your device. Click to turn it on if needed.';
      case 'defaultBlocked':
        return 'Instant Replay is off by default on this site for privacy. Click to turn it on if you understand the risk.';
      case 'fileBlocked':
        return 'Cannot replay on file:// URLs. Navigate to any website to use Instant Replay.';
      case 'fullyDisabled':
        return 'Instant Replay is fully disabled in settings.';
      case 'browserInternal':
        return 'Cannot replay on browser-internal pages. Navigate to any website to use Instant Replay.';
      case 'needsPopupOpen':
        return 'Opening the popup activates Instant Replay for this tab.';
      case 'idle':
        return 'Waiting for an active tab...';
      default: {
        const _exhaustive: never = s;
        return _exhaustive;
      }
    }
  };

  // Whether clicking the rewind button does anything for the given status.
  // enabled / forceEnabled go straight to share; urlBlocked / autoDisabled
  // open the confirmation card; enabledOnOtherTab swaps capture then shares.
  // All other statuses are non-interactive.
  const isRewindButtonInteractive = (s: RewindStatus): boolean => {
    switch (s.status) {
      case 'enabled':
      case 'forceEnabled':
      case 'enabledOnOtherTab':
      case 'urlBlocked':
      case 'autoDisabled':
      case 'defaultBlocked':
        return true;
      case 'fileBlocked':
      case 'fullyDisabled':
      case 'browserInternal':
      case 'needsPopupOpen':
      case 'idle':
        return false;
      default: {
        const _exhaustive: never = s;
        return _exhaustive;
      }
    }
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

  // ── Rewind clip saved modal ───────────────────
  // Mutually exclusive with the primary saved modal above (we'd already have
  // returned). Triggered by the REWIND_CLIP_SAVED broadcast — see the listener
  // in the rewind-status effect.
  if (rewindSavedClipId !== null && savedLink === null) {
    const clip = rewindSavedClip;
    const durSec = clip ? Math.round(clip.durationMs / 1000) : 0;
    const sizeMb = clip ? (clip.sizeBytes / 1048576).toFixed(1) : '0.0';
    return (
      <div className="container">
        <div className="saved-modal">
          <div className={`saved-icon${rewindUploading ? ' uploading' : ''}`}>
            {/* Counter-clockwise arrow — same SVG as the "Share Last Minute"
                button's icon, kept in sync visually with the popup's rewind
                affordance. */}
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={rewindUploading ? '#f59e0b' : '#22c55e'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </div>
          <h2 className="saved-title">
            {rewindUploading
              ? `Uploading... ${rewindUploadProgress > 0 ? `${rewindUploadProgress}%` : ''}`
              : 'Replay Clip Saved'}
          </h2>
          <p className="saved-subtitle">
            {clip
              ? `Last ${durSec}s · ${sizeMb} MB${clip.host ? ` · ${clip.host}` : ''}`
              : 'Loading clip...'}
          </p>

          {/* Inline preview while we still have the local blob URL. The blob
              is also retained in IDB so "Open in Viewer" works post-dismiss. */}
          {rewindSavedVideoUrl && (
            <video
              src={rewindSavedVideoUrl}
              controls
              style={{ width: '100%', borderRadius: '8px', maxHeight: '200px', background: '#000' }}
            />
          )}

          {rewindUploading && (
            <div className="upload-progress-bar">
              <div
                className="upload-progress-fill"
                style={rewindUploadProgress > 0 ? { width: `${rewindUploadProgress}%`, animation: 'none' } : undefined}
              />
            </div>
          )}

          {rewindShareUrl && !rewindUploading && (
            <div className="saved-link-box">
              <span className="saved-link-text">{rewindShareUrl}</span>
              <button className="saved-copy-btn" onClick={handleRewindCopyShare}>
                {rewindCopied ? (
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
          )}

          {rewindUploadError && (
            <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>
              {rewindUploadError}
            </div>
          )}

          <div className="saved-actions">
            {!rewindShareUrl && (
              <button
                className="saved-open-btn"
                onClick={handleRewindUpload}
                disabled={rewindUploading || !authed || !clip}
                title={!authed ? 'Sign in to upload' : ''}
              >
                {rewindUploading ? 'Uploading...' : 'Upload to DevRecorder'}
              </button>
            )}
            {rewindShareUrl && (
              <button
                className="saved-open-btn"
                onClick={() => {
                  chrome.tabs.create({ url: rewindShareUrl });
                }}
              >
                Open Share Link
              </button>
            )}
            <button
              className="saved-close-btn"
              onClick={handleRewindOpenViewer}
              disabled={rewindUploading}
            >
              Open in Viewer
            </button>
            <button
              className="saved-close-btn"
              onClick={handleRewindClose}
              disabled={rewindUploading}
            >
              Close
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
            {/* Share Last Minute / Instant Replay (Phase 2) */}
            {rewindConfirm ? (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  padding: '12px',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                  {rewindConfirm.kind === 'defaultBlocked'
                    ? 'Turn on Instant Replay on this site?'
                    : 'Turn on Instant Replay for this site?'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {rewindConfirm.kind === 'defaultBlocked'
                    ? 'This site is on the built-in privacy blocklist because pages here may contain sensitive personal, financial, or proprietary information. Continuing will buffer this tab in the background. You can turn it off again from the extension settings.'
                    : 'Capturing this site may slow down your device. You can turn it off again from the extension settings.'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Site: <strong style={{ color: 'var(--text)' }}>{rewindConfirm.host}</strong>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    className="saved-close-btn"
                    style={{ flex: 1, padding: '8px' }}
                    onClick={handleRewindConfirmCancel}
                    disabled={rewindConfirmBusy}
                  >
                    Cancel
                  </button>
                  <button
                    className="saved-open-btn"
                    style={{ flex: 1, padding: '8px' }}
                    onClick={handleRewindConfirm}
                    disabled={rewindConfirmBusy}
                  >
                    {rewindConfirmBusy ? 'Working...' : 'Continue'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  className={`btn-screenshot ${!isRewindButtonInteractive(rewindStatus) || shareLastMinuteBusy ? 'disabled' : ''}`}
                  onClick={handleShareLastMinute}
                  disabled={!isRewindButtonInteractive(rewindStatus) || shareLastMinuteBusy}
                  title={rewindTooltip(rewindStatus)}
                  // Phase 6: subtle amber accent when the rolling buffer is
                  // on a different tab, so the user notices that clicking
                  // will swap capture (not share immediately). Same button
                  // structure; just inline border + tint.
                  style={
                    rewindStatus.status === 'enabledOnOtherTab'
                      ? {
                          width: '100%',
                          borderColor: '#f59e0b',
                          boxShadow: 'inset 0 0 0 1px #f59e0b',
                        }
                      : { width: '100%' }
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10"/>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                  </svg>
                  <span>
                    {shareLastMinuteBusy
                      ? 'Capturing...'
                      : rewindStatus.status === 'enabledOnOtherTab'
                        ? `Share Last Minute (${rewindStatus.bufferedHost})`
                        : 'Share Last Minute'}
                  </span>
                </button>
                {/* Explicit "switch capture" link, shown only when buffer is on
                    a different tab. The main share button captures the buffered
                    tab's content; this link discards that buffer and starts a
                    fresh one on the current tab (will take ~60s to fill). */}
                {rewindStatus.status === 'enabledOnOtherTab' && popupActiveTabId !== null && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (popupActiveTabId === null) return;
                      setShareLastMinuteNotice('Switching capture to this tab...');
                      try {
                        const swap = await chrome.runtime.sendMessage({
                          type: MSG.REWIND_SWITCH_TAB,
                          targetTabId: popupActiveTabId,
                        });
                        if (!swap || !swap.success) {
                          setShareLastMinuteNotice((swap && swap.error) || 'Failed to switch');
                        } else {
                          setShareLastMinuteNotice('Capture switched. Buffer is filling...');
                        }
                      } catch (err) {
                        setShareLastMinuteNotice((err as Error).message);
                      }
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '11px',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      padding: '4px 0',
                      width: '100%',
                      textAlign: 'center',
                    }}
                  >
                    Switch capture to this tab instead
                  </button>
                )}
                {shareLastMinuteNotice && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '-4px' }}>
                    {shareLastMinuteNotice}
                  </div>
                )}
              </>
            )}
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
        {/*
          Settings entry point. Reuses .theme-toggle for the 32x32 icon-button
          shape so we don't add a new style for a tiny addition. Calls
          chrome.runtime.openOptionsPage() (Phase 4) which opens options.html
          in a new tab per manifest options_ui.open_in_tab.
        */}
        <button
          className="theme-toggle"
          onClick={() => {
            chrome.runtime.openOptionsPage();
            window.close();
          }}
          title="Instant Replay settings"
          aria-label="Open settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
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
