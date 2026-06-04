import type { RewindClipMetadata } from '@shared/rewind-clips-db';
import { deleteRewindClip } from '@shared/rewind-clips-db';
import { formatDuration } from './utils';

interface Props {
  clips: RewindClipMetadata[];
  onSelect: (id: string) => void;
  onChanged: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function RewindClipList({ clips, onSelect, onChanged }: Props) {
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this replay clip from local storage?')) return;
    try {
      await deleteRewindClip(id);
    } catch {
      // ignore
    }
    onChanged();
  };

  return (
    <section className="rewind-clips-section">
      <h2 className="section-heading">Rewind clips</h2>
      {clips.length === 0 ? (
        <div className="rewind-clips-empty">
          No replay clips yet. Click "Share Last Minute" from the popup to save the last minute of activity on a tab.
        </div>
      ) : (
        <div className="rewind-clips-list">
          {clips.map((clip) => (
            <div
              key={clip.id}
              className="rewind-clip-row"
              onClick={() => onSelect(clip.id)}
            >
              <div className="rewind-clip-thumb">&#x23F4;</div>
              <div className="rewind-clip-body">
                <div className="rewind-clip-title">
                  <span className="rewind-clip-host">{clip.host || 'unknown host'}</span>
                  {clip.uploaded && (
                    <span className="rewind-clip-badge">Uploaded</span>
                  )}
                </div>
                <div className="rewind-clip-meta">
                  <span>{formatRelative(clip.capturedAt)}</span>
                  <span>{formatDuration(clip.durationMs)}</span>
                  <span>{formatBytes(clip.sizeBytes)}</span>
                </div>
              </div>
              <div className="rewind-clip-actions">
                <button
                  className="rewind-clip-open"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(clip.id);
                  }}
                >
                  Open
                </button>
                <button
                  className="rewind-clip-delete"
                  onClick={(e) => handleDelete(e, clip.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
