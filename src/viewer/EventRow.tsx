import { useState } from 'react';
import type {
  TimelineEvent,
  ConsoleEventData,
  NetworkEventData,
  NavigationEventData,
} from '@shared/types';
import { formatTime } from './utils';

interface Props {
  event: TimelineEvent;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
}

export function EventRow({ event, isActive, isSelected, onClick }: Props) {
  const [expanded, setExpanded] = useState(false);

  const time = formatTime(event.relativeTime);
  const classes = [
    'event-row',
    isActive ? 'active' : '',
    isSelected ? 'selected' : '',
    expanded ? 'expanded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      onClick={onClick}
      onDoubleClick={() => setExpanded(!expanded)}
    >
      <span className="event-time">{time}</span>
      {event.type === 'console' && (
        <ConsoleEvent data={event.data as ConsoleEventData} />
      )}
      {event.type === 'network' && (
        <NetworkEvent data={event.data as NetworkEventData} />
      )}
      {event.type === 'navigation' && (
        <NavigationEvent data={event.data as NavigationEventData} />
      )}
    </div>
  );
}

function ConsoleEvent({ data }: { data: ConsoleEventData }) {
  return (
    <>
      <span className={`event-badge badge-${data.level}`}>{data.level}</span>
      <div className="event-content">
        <span>{data.args.join(' ')}</span>
        {data.stack && <span className="stack">{data.stack}</span>}
      </div>
    </>
  );
}

function NetworkEvent({ data }: { data: NetworkEventData }) {
  const badgeClass = getBadgeClass(data.method);
  const statusClass = getStatusClass(data.status);
  const url = truncateUrl(data.url);

  return (
    <>
      <span className={`event-badge ${badgeClass}`}>{data.method}</span>
      <div className="event-content">
        <span className="url">{url}</span>
        <span className={`status ${statusClass}`}>{data.status || 'ERR'}</span>
        {data.duration > 0 && (
          <span className="duration">{Math.round(data.duration)}ms</span>
        )}
        {data.error && <span className="error-text"> {data.error}</span>}
      </div>
    </>
  );
}

function NavigationEvent({ data }: { data: NavigationEventData }) {
  return (
    <>
      <span className="event-badge badge-nav">NAV</span>
      <div className="event-content">
        <span className="nav-url">{data.url}</span>
        <span className="transition">{data.transitionType}</span>
      </div>
    </>
  );
}

function getBadgeClass(method: string): string {
  const m = method.toUpperCase();
  const map: Record<string, string> = {
    GET: 'badge-get',
    POST: 'badge-post',
    PUT: 'badge-put',
    DELETE: 'badge-delete',
    PATCH: 'badge-patch',
  };
  return map[m] || 'badge-other-method';
}

function getStatusClass(status: number): string {
  if (!status || status === 0) return 'status-0';
  if (status < 300) return 'status-2xx';
  if (status < 400) return 'status-3xx';
  if (status < 500) return 'status-4xx';
  return 'status-5xx';
}

function truncateUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 80 ? path.slice(0, 77) + '...' : path;
  } catch {
    return url.length > 80 ? url.slice(0, 77) + '...' : url;
  }
}
