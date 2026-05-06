import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DevRecorder] UI Error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ padding: 20, textAlign: 'center', color: '#ef4444', fontFamily: 'system-ui' }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Something went wrong</p>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px', borderRadius: 8, border: '1px solid #333',
              background: '#1a1b2e', color: '#fff', cursor: 'pointer', fontSize: 12,
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
