import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
import { registerSW } from 'virtual:pwa-register';
import { operatorAdapters } from './data/operatorAdapters';
import { fallbackRouteGenerator } from './data/fallbackRouteGenerator';

registerSW({ immediate: true });

if (typeof window !== 'undefined') {
    window.operatorAdapters = operatorAdapters;
    if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_FALLBACK_DEBUG === 'true') {
        window.fallbackRouteGenerator = fallbackRouteGenerator;
    }
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
