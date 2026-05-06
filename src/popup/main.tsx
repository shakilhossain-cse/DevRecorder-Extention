import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@shared/ErrorBoundary';
import { Popup } from './Popup';
import './popup.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Popup />
    </ErrorBoundary>
  </StrictMode>
);
