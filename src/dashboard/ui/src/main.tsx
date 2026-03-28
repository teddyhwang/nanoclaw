import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import './styles/investments.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Unregister any leftover service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) reg.unregister();
  });
}
