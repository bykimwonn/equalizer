import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';

// Pin renderer zoom at 100%: accidental Ctrl+wheel / Ctrl+plus/minus zoom
// scales the fixed app shell and pushes content beyond reach (body never
// scrolls). The main process also enforces setZoomFactor(1); this blocks the
// gesture before it changes anything.
window.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  },
  { passive: false }
);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '_', '0'].includes(e.key)) {
    e.preventDefault();
  }
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
