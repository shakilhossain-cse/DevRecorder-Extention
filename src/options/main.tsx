import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@shared/ErrorBoundary';
import { Options } from './Options';
import './options.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Options />
    </ErrorBoundary>
  </StrictMode>
);
