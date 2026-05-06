import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@shared/ErrorBoundary';
import { Viewer } from './Viewer';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Viewer />
    </ErrorBoundary>
  </StrictMode>
);
