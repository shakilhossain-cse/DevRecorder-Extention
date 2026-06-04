import { useState, useEffect, useCallback } from 'react';
import { api } from '@shared/api';
import type { Recording } from '@shared/types';
import { RecordingList } from './RecordingList';
import { Playback } from './Playback';
import { RewindPlayback } from './RewindPlayback';
import { RewindClipList } from './RewindClipList';
import { listRewindClipsMetadata } from '@shared/rewind-clips-db';
import type { RewindClipMetadata } from '@shared/rewind-clips-db';

// Both query params can be live at once in the URL; the rewind clip wins
// because it's the more specific deep link.
interface ViewState {
  recordingId: string | null;
  rewindClipId: string | null;
}

function parseLocation(): ViewState {
  const params = new URLSearchParams(window.location.search);
  return {
    recordingId: params.get('id'),
    rewindClipId: params.get('rewindClipId'),
  };
}

export function Viewer() {
  const [view, setView] = useState<ViewState>(() => parseLocation());
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [rewindClips, setRewindClips] = useState<RewindClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecordings = useCallback(async () => {
    setLoading(true);
    const [recs, clips] = await Promise.all([
      api.getRecordings(),
      listRewindClipsMetadata().catch(() => [] as RewindClipMetadata[]),
    ]);
    setRecordings(recs);
    setRewindClips(clips);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadRecordings();
  }, [loadRecordings]);

  // Refresh the rewind clip list independently — used after delete/upload so
  // the home view's clip section reflects the latest state without re-hitting
  // the recordings API.
  const reloadRewindClips = useCallback(async () => {
    try {
      const clips = await listRewindClipsMetadata();
      setRewindClips(clips);
    } catch {
      // ignore
    }
  }, []);

  const handleSelect = (id: string) => {
    setView({ recordingId: id, rewindClipId: null });
    window.history.pushState({}, '', `?id=${id}`);
  };

  const handleSelectRewindClip = (id: string) => {
    setView({ recordingId: null, rewindClipId: id });
    window.history.pushState({}, '', `?rewindClipId=${id}`);
  };

  const handleBack = () => {
    setView({ recordingId: null, rewindClipId: null });
    window.history.pushState({}, '', window.location.pathname);
    loadRecordings();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this recording permanently?')) return;
    await api.deleteRecording(id);
    if (view.recordingId === id) {
      handleBack();
    } else {
      loadRecordings();
    }
  };

  if (view.rewindClipId) {
    return (
      <RewindPlayback
        clipId={view.rewindClipId}
        onBack={handleBack}
        onClipChanged={reloadRewindClips}
      />
    );
  }

  if (view.recordingId) {
    return (
      <Playback
        recordingId={view.recordingId}
        onBack={handleBack}
        onDelete={() => handleDelete(view.recordingId!)}
      />
    );
  }

  return (
    <div className="view">
      <header className="top-bar">
        <div className="logo">
          <span className="logo-icon">&#x2B24;</span>
          <span>DevRecorder</span>
        </div>
        <span className="subtitle">Recordings</span>
      </header>

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <>
          <RewindClipList
            clips={rewindClips}
            onSelect={handleSelectRewindClip}
            onChanged={reloadRewindClips}
          />

          {recordings.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">&#x1F4F9;</div>
              <div className="empty-title">No recordings yet</div>
              <div className="empty-text">Start a recording from the DevRecorder extension popup.</div>
            </div>
          ) : (
            <>
              <h2 className="section-heading">Recordings</h2>
              <RecordingList
                recordings={recordings}
                onSelect={handleSelect}
                onDelete={handleDelete}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
