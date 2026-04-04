import { useState, useEffect } from 'react';
import { api } from '@shared/api';
import type { Recording } from '@shared/types';
import { RecordingList } from './RecordingList';
import { Playback } from './Playback';

export function Viewer() {
  const [recordingId, setRecordingId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('id');
  });
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecordings = async () => {
    setLoading(true);
    const recs = await api.getRecordings();
    setRecordings(recs);
    setLoading(false);
  };

  useEffect(() => {
    loadRecordings();
  }, []);

  const handleSelect = (id: string) => {
    setRecordingId(id);
    window.history.pushState({}, '', `?id=${id}`);
  };

  const handleBack = () => {
    setRecordingId(null);
    window.history.pushState({}, '', window.location.pathname);
    loadRecordings();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this recording permanently?')) return;
    await api.deleteRecording(id);
    if (recordingId === id) {
      handleBack();
    } else {
      loadRecordings();
    }
  };

  if (recordingId !== null) {
    return (
      <Playback
        recordingId={recordingId}
        onBack={handleBack}
        onDelete={() => handleDelete(recordingId)}
      />
    );
  }

  return (
    <div className="view">
      <header className="top-bar">
        <div className="logo">
          <span className="logo-icon">&#x2B24;</span>
          <span>DevLoom</span>
        </div>
        <span className="subtitle">Recordings</span>
      </header>

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : recordings.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">&#x1F4F9;</div>
          <div className="empty-title">No recordings yet</div>
          <div className="empty-text">Start a recording from the DevLoom extension popup.</div>
        </div>
      ) : (
        <RecordingList
          recordings={recordings}
          onSelect={handleSelect}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
