import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer';
import './viewer.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Viewer />
  </StrictMode>
);
