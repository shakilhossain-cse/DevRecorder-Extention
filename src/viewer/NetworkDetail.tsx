import { useState } from 'react';
import type { NetworkEventData } from '@shared/types';
import { formatTime } from './utils';

interface Props {
  data: NetworkEventData;
  relativeTime: number;
  onClose: () => void;
}

type DetailTab = 'headers' | 'payload' | 'response';

export function NetworkDetail({ data, relativeTime, onClose }: Props) {
  const [tab, setTab] = useState<DetailTab>('headers');

  const tabs: { label: string; value: DetailTab }[] = [
    { label: 'Headers', value: 'headers' },
    { label: 'Payload', value: 'payload' },
    { label: 'Response', value: 'response' },
  ];

  return (
    <div className="net-detail">
      <div className="net-detail-header">
        <div className="net-detail-title">
          <span className={`event-badge ${getBadgeClass(data.method)}`}>
            {data.method}
          </span>
          <span className={`net-detail-status ${getStatusClass(data.status)}`}>
            {data.status || 'ERR'}
          </span>
          <span className="net-detail-time">{formatTime(relativeTime)}</span>
          <span className="net-detail-dur">
            {data.duration > 0 ? `${Math.round(data.duration)}ms` : ''}
          </span>
        </div>
        <button className="net-detail-close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="net-detail-url">{data.url}</div>

      <div className="net-detail-tabs">
        {tabs.map((t) => (
          <button
            key={t.value}
            className={`net-detail-tab ${tab === t.value ? 'active' : ''}`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="net-detail-body">
        {tab === 'headers' && <HeadersView data={data} />}
        {tab === 'payload' && <PayloadView body={data.requestBody} />}
        {tab === 'response' && <ResponseView body={data.responseBody} />}
      </div>
    </div>
  );
}

function HeadersView({ data }: { data: NetworkEventData }) {
  const reqHeaders = Object.entries(data.requestHeaders || {});
  const resHeaders = Object.entries(data.responseHeaders || {});

  return (
    <div className="net-headers">
      <div className="net-headers-section">
        <div className="net-headers-title">General</div>
        <div className="net-header-row">
          <span className="net-header-name">Request URL</span>
          <span className="net-header-value">{data.url}</span>
        </div>
        <div className="net-header-row">
          <span className="net-header-name">Request Method</span>
          <span className="net-header-value">{data.method}</span>
        </div>
        <div className="net-header-row">
          <span className="net-header-name">Status Code</span>
          <span className={`net-header-value ${getStatusClass(data.status)}`}>
            {data.statusLine || data.status}
          </span>
        </div>
        <div className="net-header-row">
          <span className="net-header-name">Resource Type</span>
          <span className="net-header-value">{data.resourceType}</span>
        </div>
        {data.initiator && (
          <div className="net-header-row">
            <span className="net-header-name">Initiator</span>
            <span className="net-header-value">{data.initiator}</span>
          </div>
        )}
      </div>

      {resHeaders.length > 0 && (
        <div className="net-headers-section">
          <div className="net-headers-title">
            Response Headers ({resHeaders.length})
          </div>
          {resHeaders.map(([name, value]) => (
            <div key={name} className="net-header-row">
              <span className="net-header-name">{name}</span>
              <span className="net-header-value">{value}</span>
            </div>
          ))}
        </div>
      )}

      {reqHeaders.length > 0 && (
        <div className="net-headers-section">
          <div className="net-headers-title">
            Request Headers ({reqHeaders.length})
          </div>
          {reqHeaders.map(([name, value]) => (
            <div key={name} className="net-header-row">
              <span className="net-header-name">{name}</span>
              <span className="net-header-value">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PayloadView({ body }: { body: string | null }) {
  if (!body) {
    return (
      <div className="net-empty">
        <div className="net-empty-icon">📦</div>
        <div>No request payload</div>
        <div className="net-empty-hint">This request did not include a body (e.g. GET requests)</div>
      </div>
    );
  }

  const formatted = tryFormatJson(body);
  return (
    <div className="net-body-view">
      <pre className="net-body-pre">{formatted}</pre>
    </div>
  );
}

function ResponseView({ body }: { body: string | null }) {
  if (!body) {
    return (
      <div className="net-empty">
        <div className="net-empty-icon">📄</div>
        <div>Response body not available</div>
        <div className="net-empty-hint">Response bodies are not captured during recording to avoid the browser debug bar</div>
      </div>
    );
  }

  const formatted = tryFormatJson(body);
  return (
    <div className="net-body-view">
      <pre className="net-body-pre">{formatted}</pre>
    </div>
  );
}

function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
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
