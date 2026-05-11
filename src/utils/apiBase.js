const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').trim();

export const API_BASE_URL = rawApiBaseUrl.replace(/\/+$/, '');

export function toApiUrl(path) {
  if (typeof path !== 'string') return path;
  if (!path.startsWith('/api/')) return path;
  if (!API_BASE_URL) return path;
  if (API_BASE_URL.endsWith('/api')) {
    return `${API_BASE_URL}${path.slice('/api'.length)}`;
  }
  return `${API_BASE_URL}${path}`;
}

export function publishApiBaseUrl() {
  if (typeof window !== 'undefined') {
    window.__KMB_API_BASE_URL__ = API_BASE_URL;
  }
}
