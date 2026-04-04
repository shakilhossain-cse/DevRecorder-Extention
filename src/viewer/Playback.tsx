import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@shared/api';
import type { Recording, TimelineEvent, EventType, NetworkEventData } from '@shared/types';
import { EventRow } from './EventRow';
import { NetworkDetail } from './NetworkDetail';
import { formatDuration, formatDate } from './utils';

interface Props {
  recordingId: string;
  onBack: () => void;
  onDelete: () => void;
}

type FilterType = EventType | 'all';

export function Playback({ recordingId, onBack, onDelete }: Props) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [activeTime, setActiveTime] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [scrollPaused, setScrollPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const eventsListRef = useRef<HTMLDivElement>(null);
  const scrollPauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
  }, [recordingId]);

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
      // Select network event to show detail panel — don't seek
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
    if (!recording?.videoUrl) return;
    const a = document.createElement('a');
    a.href = recording.videoUrl;
    a.download = `${recording.title.replace(/[^a-zA-Z0-9]/g, '_')}.webm`;
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

  return (
    <div className="view">
      <header className="top-bar">
        <button className="btn-back" onClick={onBack}>
          &larr; Back
        </button>
        <div className="rec-title">{recording?.title || 'Loading...'}</div>
        <div className="rec-actions">
          <button className="btn-action" onClick={handleExport}>
            &#x2B07; Download
          </button>
          <button className="btn-action btn-delete" onClick={onDelete}>
            &#x1F5D1; Delete
          </button>
        </div>
      </header>

      {recording && (
        <div className="video-meta">
          <span>{formatDuration(recording.duration)}</span>
          <span>{recording.url}</span>
          <span>{formatDate(new Date(recording.createdAt).getTime())}</span>
        </div>
      )}

      <div className="playback-layout">
        <div className="video-panel">
          <video ref={videoRef} controls onTimeUpdate={handleTimeUpdate} />
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
                filtered.map((event) => (
                  <EventRow
                    key={event._id}
                    event={event}
                    isActive={
                      !scrollPaused &&
                      event.relativeTime <= activeTime &&
                      event.relativeTime > activeTime - 1000
                    }
                    isSelected={selectedEvent?._id === event._id}
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
