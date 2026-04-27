import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
import { registerSW } from 'virtual:pwa-register';
import { operatorAdapters } from './data/operatorAdapters';

registerSW({ immediate: true });

if (typeof window !== 'undefined') {
    window.operatorAdapters = operatorAdapters;
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
