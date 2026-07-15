import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 4000000, // Keep oversized optional datasets out of install-time precache.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => (
              (url.hostname === 'data.etabus.gov.hk' &&
                /^\/v1\/transport\/kmb\/(stop|route|route-stop)$/.test(url.pathname)) ||
              /^\/api\/kmb\/(stop|route|route-stop)$/.test(url.pathname)
            ),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'kmb-static-v1',
              expiration: { maxEntries: 6, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/operator-data/kmb_operation_time_slots.runtime.json',
            handler: 'CacheFirst',
            options: {
              cacheName: 'kmb-historical-v3',
              expiration: { maxEntries: 2, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      includeAssets: ['pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'KMB Route Master',
        short_name: 'KMB Master',
        description: 'Advanced HK Bus Navigation',
        theme_color: '#E1251B',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
