import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { api } from '@shared/api';
import type { Recording, TimelineEvent, EventType, NetworkEventData } from '@shared/types';
import { EventRow } from './EventRow';
import { NetworkDetail } from './NetworkDetail';
import { formatDuration, formatDate } from './utils';

interface Props {
  // null when the playback target is a local-only clip (e.g. rewind / Share
  // Last Minute) — in that case the parent supplies the data via the props
  // below and we skip the API round-trips entirely.
  recordingId: string | null;
  onBack: () => void;
  onDelete?: () => void;
  // Local-only video source. When set, used as the <video src> directly
  // instead of fetching the server-side recording row.
  localVideoUrl?: string;
  // Local-only event timeline. When set, skipped the events fetch and seeded
  // straight into state. Phase 5 — used by RewindPlayback for clips that
  // haven't been uploaded yet.
  localEvents?: TimelineEvent[];
  // Override title / subtitle / metadata strip when there's no server
  // Recording row to lean on. Falls back to the api result if both are
  // omitted (the normal recording-list case).
  localTitle?: string;
  localSubtitle?: string;
  // Free-form metadata strip (renders below the header). When provided it
  // replaces the standard duration + URL + date strip.
  localMetaChips?: ReactNode;
  // Optional sidebar slot rendered to the right of the video panel, above
  // the events column. Used by RewindPlayback to surface its upload / share
  // / delete actions inside the shared layout.
  sidebar?: ReactNode;
  // Hide the standard Download / Delete header actions when the parent
  // wants to render its own (e.g. RewindPlayback's actions panel).
  hideTopActions?: boolean;
}

type FilterType = EventType | 'all';

export function Playback({
  recordingId,
  onBack,
  onDelete,
  localVideoUrl,
  localEvents,
  localTitle,
  localSubtitle,
  localMetaChips,
  sidebar,
  hideTopActions,
}: Props) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>(localEvents ?? []);
  const [filter, setFilter] = useState<FilterType>('all');
  const [activeTime, setActiveTime] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [scrollPaused, setScrollPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const eventsListRef = useRef<HTMLDivElement>(null);
  const scrollPauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local-only mode: seed events from props and skip the API fetch. Switch
  // back to API mode whenever recordingId becomes set.
  const isLocalMode = recordingId === null;

  useEffect(() => {
    if (isLocalMode) {
      // Local mode — events came from props. Sync from any updates the
      // parent passes in (e.g. clip swap inside the viewer).
      if (localEvents) setEvents(localEvents);
      if (videoRef.current && localVideoUrl) {
        videoRef.current.src = localVideoUrl;
      }
      return () => {
        if (scrollPauseTimerRef.current) clearTimeout(scrollPauseTimerRef.current);
      };
    }

    (async () => {
      const rec = await api.getRecording(recordingId);
      if (!rec) return;
      setRecording(rec);

      // Video comes from R2 URL
      if (rec.videoUrl && videoRef.current) {
        videoRef.current.src = rec.videoUrl;
      }

      const evts = await api.getEvents(recordingId);
      setEvents(evts);
    })();

    // Clean up scroll pause timer on unmount
    return () => {
      if (scrollPauseTimerRef.current) clearTimeout(scrollPauseTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, isLocalMode, localEvents, localVideoUrl]);

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    setActiveTime(videoRef.current.currentTime * 1000);
  }, []);

  const seekTo = (ms: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = ms / 1000;
    videoRef.current.play();
  };

  const handleEventClick = (event: TimelineEvent) => {
    if (event.type === 'network') {
      // Select network event to show detail panel  don't seek
      setSelectedEvent(event);
      pauseScroll();
    } else {
      seekTo(event.relativeTime);
    }
  };

  // Pause auto-scroll when user interacts with the list
  const pauseScroll = () => {
    setScrollPaused(true);
    // Resume after 10 seconds of no interaction
    if (scrollPauseTimerRef.current) clearTimeout(scrollPauseTimerRef.current);
    scrollPauseTimerRef.current = setTimeout(() => {
      setScrollPaused(false);
    }, 10000);
  };

  const handleListScroll = () => {
    pauseScroll();
  };

  const handleExport = () => {
    const url = localVideoUrl || recording?.videoUrl;
    const title = localTitle || recording?.title || 'recording';
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.webm`;
    a.click();
  };

  const filtered =
    filter === 'all' ? events : events.filter((e) => e.type === filter);

  const tabs: { label: string; value: FilterType }[] = [
    { label: 'All', value: 'all' },
    { label: 'Console', value: 'console' },
    { label: 'Network', value: 'network' },
    { label: 'Navigation', value: 'navigation' },
  ];

  // Auto-scroll to active event (unless paused)
  useEffect(() => {
    if (scrollPaused || !eventsListRef.current) return;
    const activeRow = eventsListRef.current.querySelector('.event-row.active');
    if (activeRow) {
      const container = eventsListRef.current;
      const rowTop = (activeRow as HTMLElement).offsetTop;
      const containerScroll = container.scrollTop;
      const containerHeight = container.clientHeight;
      if (rowTop < containerScroll || rowTop > containerScroll + containerHeight - 40) {
        container.scrollTop = rowTop - containerHeight / 3;
      }
    }
  }, [activeTime, scrollPaused]);

  const headerTitle = isLocalMode
    ? (localTitle || 'Replay clip')
    : (recording?.title || 'Loading...');

  return (
    <div className="view">
      <header className="top-bar">
        <button className="btn-back" onClick={onBack}>
          &larr; Back
        </button>
        <div className="rec-title">
          {headerTitle}
          {localSubtitle && <span className="rec-subtitle"> &middot; {localSubtitle}</span>}
        </div>
        {!hideTopActions && (
          <div className="rec-actions">
            <button className="btn-action" onClick={handleExport}>
              &#x2B07; Download
            </button>
            {onDelete && (
              <button className="btn-action btn-delete" onClick={onDelete}>
                &#x1F5D1; Delete
              </button>
            )}
          </div>
        )}
      </header>

      {localMetaChips ? (
        <div className="video-meta">{localMetaChips}</div>
      ) : recording ? (
        <div className="video-meta">
          <span>{formatDuration(recording.duration)}</span>
          <span>{recording.url}</span>
          <span>{formatDate(new Date(recording.createdAt).getTime())}</span>
        </div>
      ) : null}

      <div className="playback-layout">
        <div className="video-panel">
          <video ref={videoRef} controls onTimeUpdate={handleTimeUpdate} />
          {sidebar && <div className="video-sidebar">{sidebar}</div>}
        </div>

        <div className="events-panel">
          <div className="events-tabs">
            {tabs.map((t) => (
              <button
                key={t.value}
                className={`tab ${filter === t.value ? 'active' : ''}`}
                onClick={() => {
                  setFilter(t.value);
                  setSelectedEvent(null);
                }}
              >
                {t.label}
                {t.value !== 'all' && (
                  <span className="tab-count">
                    {events.filter((e) => e.type === t.value).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {selectedEvent && selectedEvent.type === 'network' ? (
            <NetworkDetail
              data={selectedEvent.data as NetworkEventData}
              relativeTime={selectedEvent.relativeTime}
              onClose={() => setSelectedEvent(null)}
            />
          ) : (
            <div
              className="events-list"
              ref={eventsListRef}
              onScroll={handleListScroll}
            >
              {filtered.length === 0 ? (
                <div className="events-empty">No events</div>
              ) : (
                filtered.map((event, idx) => (
                  <EventRow
                    // Server events carry an _id; local-only events don't, so
                    // fall back to an index-based key. The events array
                    // identity is stable within a clip so this is fine.
                    key={event._id || `${event.type}-${event.relativeTime}-${idx}`}
                    event={event}
                    isActive={
                      !scrollPaused &&
                      event.relativeTime <= activeTime &&
                      event.relativeTime > activeTime - 1000
                    }
                    isSelected={
                      selectedEvent
                        ? selectedEvent._id
                          ? selectedEvent._id === event._id
                          : selectedEvent === event
                        : false
                    }
                    onClick={() => handleEventClick(event)}
                  />
                ))
              )}
            </div>
          )}

          {scrollPaused && !selectedEvent && (
            <div className="scroll-paused-bar">
              <span>Auto-scroll paused</span>
              <button onClick={() => setScrollPaused(false)}>Resume</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
