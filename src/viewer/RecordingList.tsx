import { useState } from 'react';
import type { Recording } from '@shared/types';
import { formatDuration, formatDate } from './utils';

interface Props {
  recordings: Recording[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function RecordingList({ recordings, onSelect, onDelete }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleShare = (e: React.MouseEvent, rec: Recording) => {
    e.stopPropagation();
    if (!rec.videoUrl) return;
    navigator.clipboard.writeText(rec.videoUrl).then(() => {
      setCopiedId(rec._id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div className="recordings-grid">
      {recordings.map((rec) => (
        <div
          key={rec._id}
          className="rec-card"
          onClick={() => onSelect(rec._id)}
        >
          <div className="rec-card-thumb">&#x25B6;</div>
          <div className="rec-card-body">
            <div className="rec-card-title">{rec.title}</div>
            <div className="rec-card-meta">
              <span>{formatDuration(rec.duration)}</span>
              <span>{formatDate(new Date(rec.createdAt).getTime())}</span>
            </div>
          </div>
          <div className="rec-card-actions">
            <button
              className="rec-card-share"
              onClick={(e) => handleShare(e, rec)}
              title="Copy share link"
            >
              {copiedId === rec._id ? 'Copied!' : 'Share'}
            </button>
            <button
              className="rec-card-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(rec._id);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
