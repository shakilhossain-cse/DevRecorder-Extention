import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@shared/api';
import {
  getRewindClip,
  deleteRewindClip,
  markClipUploaded,
} from '@shared/rewind-clips-db';
import type { RewindClip } from '@shared/rewind-clips-db';
import type { TimelineEvent } from '@shared/types';
import { Playback } from './Playback';
import { formatDuration } from './utils';

const FRONTEND_URL = 'https://www.devrecorder.com';

// Bulk events endpoint accepts batches; we chunk locally so a very chatty
// page (worst-case 5000 events) doesn't blow the JSON body size. The current
// server-side limit isn't enforced here, but 500 has worked well for the
// primary recording's flush loop.
const EVENT_UPLOAD_BATCH = 500;

interface Props {
  clipId: string;
  onBack: () => void;
  onClipChanged: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; clip: RewindClip; videoUrl: string };

export function RewindPlayback({ clipId, onBack, onClipChanged }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [hasApiToken, setHasApiToken] = useState<boolean>(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const videoUrlRef = useRef<string | null>(null);

  // Track whether we mounted so we don't update state after unmount in the
  // long IDB read path.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Pull the clip + a fresh object URL on every clipId change.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setUploadError(null);
    setUploadProgress(0);
    setUploadStage('');
    setCopied(false);

    (async () => {
      try {
        const clip = await getRewindClip(clipId);
        if (cancelled || !mountedRef.current) return;
        if (!clip) {
          setState({ kind: 'missing' });
          return;
        }
        const videoUrl = URL.createObjectURL(clip.blob);
        videoUrlRef.current = videoUrl;
        setState({ kind: 'ready', clip, videoUrl });
      } catch {
        if (!cancelled) setState({ kind: 'missing' });
      }
    })();

    return () => {
      cancelled = true;
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
  }, [clipId]);

  // Detect whether the popup-side auth flow has stashed an API token. Without
  // one, uploads will fail at the createRecording call, so we just disable the
  // button up-front and tell the user where to sign in.
  useEffect(() => {
    chrome.storage.local.get('apiToken').then(({ apiToken }) => {
      if (mountedRef.current) setHasApiToken(!!apiToken);
    });
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes.apiToken) {
        setHasApiToken(!!changes.apiToken.newValue);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const reloadClip = useCallback(async () => {
    try {
      const fresh = await getRewindClip(clipId);
      if (!fresh || !mountedRef.current) return;
      setState((prev) => {
        if (prev.kind !== 'ready') return prev;
        // Keep the existing object URL — the blob bytes haven't changed.
        return { kind: 'ready', clip: fresh, videoUrl: prev.videoUrl };
      });
    } catch {
      // ignore
    }
  }, [clipId]);

  // Phase 5: ship the clip's events to the bulk-events endpoint. Filled-in
  // recordingId, batched at EVENT_UPLOAD_BATCH per request. Errors are
  // surfaced but don't abort the rest of the upload — the video is already
  // up, and a missing-events server-side state is recoverable.
  const uploadEvents = useCallback(
    async (recordingId: string, events: TimelineEvent[]) => {
      if (events.length === 0) return;
      // Convert TimelineEvent -> the shape api.sendEvents wants
      // ({type, relativeTime, data}). recordingId is passed separately.
      const payload: { type: string; relativeTime: number; data: Record<string, any> }[] =
        events.map((e) => ({
          type: e.type,
          relativeTime: e.relativeTime,
          data: e.data as unknown as Record<string, any>,
        }));
      for (let i = 0; i < payload.length; i += EVENT_UPLOAD_BATCH) {
        await api.sendEvents(recordingId, payload.slice(i, i + EVENT_UPLOAD_BATCH));
      }
    },
    [],
  );

  const handleUpload = async () => {
    if (state.kind !== 'ready' || uploading) return;
    if (state.clip.uploaded) return; // already uploaded — idempotency guard
    setUploadError(null);
    setUploading(true);
    setUploadProgress(0);
    setUploadStage('Preparing');

    const clip = state.clip;
    try {
      const titleHost = clip.host || 'capture';
      const title = `Rewind: ${titleHost}`;
      const durationSec = Math.max(1, Math.round(clip.durationMs / 1000));
      const { _id } = await api.createRecording({
        title,
        url: clip.sourceTabUrl,
        startTime: clip.capturedAt,
        duration: durationSec,
        mediaType: 'video',
        recordingSurface: 'tab',
      });

      setUploadStage('Uploading video');
      await api.uploadVideo(_id, clip.blob, (pct) => {
        if (mountedRef.current) setUploadProgress(pct);
      });

      // Phase 5: ship events + device-info AFTER the video upload completes.
      // Mirrors the primary recording's "video first, events trail" ordering.
      if (clip.events && clip.events.length > 0) {
        setUploadStage(`Uploading ${clip.events.length} events`);
        try {
          await uploadEvents(_id, clip.events);
        } catch (err) {
          // Don't fail the whole upload — the video is already uploaded and
          // playable. Surface the partial failure to the user.
          console.warn('[DevRecorder] Event upload failed:', err);
          setUploadError(
            `Video uploaded, but ${clip.events.length} events failed to ship: ${(err as Error).message}`,
          );
        }
      }

      // Phase 5: device-info snapshot — ships as a single device-info event
      // at relativeTime 0, matching primary recording's captureDeviceInfo()
      // pattern. The server bulk-events endpoint accepts any type string
      // present in EventType including 'device-info'.
      if (clip.deviceInfo) {
        setUploadStage('Uploading device info');
        try {
          await api.sendEvents(_id, [
            {
              type: 'device-info',
              relativeTime: 0,
              data: clip.deviceInfo as unknown as Record<string, any>,
            },
          ]);
        } catch (err) {
          console.warn('[DevRecorder] Device-info upload failed:', err);
          // Non-fatal — the recording is still useful without it.
        }
      }

      // The server already has duration from createRecording, but the API
      // accepts a follow-up patch to refine in case we want to revise after
      // upload. We call it here so re-runs of this code don't have to.
      try {
        await api.updateRecording(_id, { duration: durationSec });
      } catch {
        // best-effort — duration was already set on create
      }

      const shareUrl = `${FRONTEND_URL}/recordings/${_id}`;
      await markClipUploaded(clip.id, { recordingId: _id, shareUrl });
      await reloadClip();
      onClipChanged();
      if (mountedRef.current) {
        setUploadProgress(100);
        setUploadStage('');
      }
    } catch (err) {
      if (mountedRef.current) {
        setUploadError((err as Error).message || 'Upload failed');
        setUploadStage('');
      }
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (state.kind !== 'ready') return;
    if (!confirm('Delete this replay clip permanently?')) return;
    try {
      await deleteRewindClip(state.clip.id);
    } catch {
      // ignore
    }
    onClipChanged();
    onBack();
  };

  const handleCopyShare = () => {
    if (state.kind !== 'ready' || !state.clip.uploaded) return;
    const shareUrl = state.clip.uploaded.shareUrl;
    navigator.clipboard.writeText(shareUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setUploadError('Failed to copy link'),
    );
  };

  if (state.kind === 'loading') {
    return (
      <div className="view">
        <header className="top-bar">
          <button className="btn-back" onClick={onBack}>&larr; Back</button>
          <div className="rec-title">Loading replay clip...</div>
        </header>
      </div>
    );
  }

  if (state.kind === 'missing') {
    return (
      <div className="view">
        <header className="top-bar">
          <button className="btn-back" onClick={onBack}>&larr; Back</button>
          <div className="rec-title">Clip not found</div>
        </header>
        <div className="empty-state">
          <div className="empty-title">This replay clip is no longer available.</div>
          <div className="empty-text">
            It may have been deleted or evicted by the local storage cap.
          </div>
        </div>
      </div>
    );
  }

  const { clip, videoUrl } = state;
  const uploaded = clip.uploaded;
  const uploadDisabled = uploading || !!uploaded || !hasApiToken;
  const uploadTooltip = !hasApiToken
    ? 'Sign in via the extension popup to upload'
    : uploaded
      ? 'Already uploaded'
      : '';
  const eventCount = clip.events?.length ?? clip.eventCount ?? 0;

  // Phase 5: render the shared Playback timeline with this clip's local
  // video + events. The actions panel (upload / delete / copy) is plugged
  // into Playback's `sidebar` slot so the upload controls live alongside
  // the video without duplicating Playback's event UI.
  const actions = (
    <div className="rewind-actions-panel">
      <h3 className="section-heading">Actions</h3>
      {uploaded ? (
        <div className="rewind-share-box">
          <div className="rewind-share-label">Share link</div>
          <div className="rewind-share-row">
            <span className="rewind-share-url">{uploaded.shareUrl}</span>
            <button className="rewind-share-copy" onClick={handleCopyShare}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <a
            className="rewind-share-open"
            href={uploaded.shareUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open in DevRecorder
          </a>
        </div>
      ) : (
        <>
          <button
            className="rewind-upload-btn"
            onClick={handleUpload}
            disabled={uploadDisabled}
            title={uploadTooltip}
          >
            {uploading
              ? `${uploadStage || 'Uploading'}${uploadProgress > 0 ? `... ${uploadProgress}%` : '...'}`
              : 'Upload to DevRecorder'}
          </button>
          {!hasApiToken && (
            <div className="rewind-action-hint">
              Sign in via the extension popup to upload this clip.
            </div>
          )}
        </>
      )}

      {uploadError && (
        <div className="rewind-action-error">{uploadError}</div>
      )}

      <button className="rewind-delete-btn" onClick={handleDelete} disabled={uploading}>
        Delete clip
      </button>
    </div>
  );

  const subtitle = clip.host || undefined;
  const metaChips = (
    <>
      <span>{formatRelative(clip.capturedAt)}</span>
      <span>{formatDuration(clip.durationMs)}</span>
      <span>{formatBytes(clip.sizeBytes)}</span>
      {eventCount > 0 && (
        <span>
          {eventCount} event{eventCount === 1 ? '' : 's'}
        </span>
      )}
      {clip.sourceTabTitle && (
        <span title={clip.sourceTabUrl}>{clip.sourceTabTitle}</span>
      )}
    </>
  );

  return (
    <Playback
      recordingId={null}
      onBack={onBack}
      localVideoUrl={videoUrl}
      localEvents={clip.events ?? []}
      localTitle="Replay clip"
      localSubtitle={subtitle}
      localMetaChips={metaChips}
      sidebar={actions}
      hideTopActions
    />
  );
}
