/**
 * KMB Bookmarks Module
 * Handles stop bookmarks, group management, and live ETA polling.
 * Persists to localStorage under key 'kmb_bookmarks'.
 *
 * Exposed as window.bookmarkEngine for CDN/Babel usage.
 */

'use strict';

const STORAGE_KEY = 'kmb_bookmarks';
const POLL_INTERVAL_MS = 30000; // 30 seconds

// ─────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────────────

function loadBookmarks() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

function saveBookmarks(bookmarks) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
    } catch (e) {
        console.warn('Could not save bookmarks:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────
// BOOKMARK OPERATIONS
// ─────────────────────────────────────────────────────────────────────

function createGroup(bookmarks, groupName) {
    const updated = [...bookmarks, { groupName, stops: [] }];
    saveBookmarks(updated);
    return updated;
}

function renameGroup(bookmarks, groupIndex, newName) {
    const updated = bookmarks.map((g, i) =>
        i === groupIndex ? { ...g, groupName: newName } : g
    );
    saveBookmarks(updated);
    return updated;
}

function deleteGroup(bookmarks, groupIndex) {
    const updated = bookmarks.filter((_, i) => i !== groupIndex);
    saveBookmarks(updated);
    return updated;
}

function addStop(bookmarks, groupIndex, { stopId, stopName, routes }) {
    // Avoid duplicates within group
    const updated = bookmarks.map((g, i) => {
        if (i !== groupIndex) return g;
        const exists = g.stops.some(s => s.stopId === stopId);
        if (exists) return g;
        return { ...g, stops: [...g.stops, { stopId, stopName, routes }] };
    });
    saveBookmarks(updated);
    return updated;
}

function removeStop(bookmarks, groupIndex, stopId) {
    const updated = bookmarks.map((g, i) => {
        if (i !== groupIndex) return g;
        return { ...g, stops: g.stops.filter(s => s.stopId !== stopId) };
    });
    saveBookmarks(updated);
    return updated;
}

// ─────────────────────────────────────────────────────────────────────
// ETA FETCHING FOR BOOKMARKS
// ─────────────────────────────────────────────────────────────────────

async function fetchStopETAs(stopId, routes) {
    const results = await Promise.all(
        routes.map(async ({ route, service_type }) => {
            try {
                // const res = await fetch(`/api/kmb/eta/${stopId}/${route}/${service_type}`);
                const res = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/eta/${seg.fromStop}/${seg.route}/${seg.service_type}`);
                const data = await res.json();
                const now = new Date();
                const upcoming = (data.data || [])
                    .filter(e => e.eta && new Date(e.eta) > now)
                    .slice(0, 3)
                    .map(e => {
                        const waitMs = new Date(e.eta) - now;
                        const waitMin = Math.round(waitMs / 60000);
                        return {
                            route,
                            eta: e.eta,
                            waitMin,
                            color: waitMin <= 5 ? 'green' : waitMin <= 15 ? 'yellow' : 'grey',
                        };
                    });
                return upcoming;
            } catch {
                return [];
            }
        })
    );
    return results.flat().sort((a, b) => a.waitMin - b.waitMin);
}

// ─────────────────────────────────────────────────────────────────────
// POLLING MANAGER
// ─────────────────────────────────────────────────────────────────────

class ETAPoller {
    constructor(onUpdate) {
        this.onUpdate = onUpdate; // (updates: Map<stopId, ETAs[]>) => void
        this.intervalId = null;
        this.bookmarks = [];
    }

    start(bookmarks) {
        this.bookmarks = bookmarks;
        this._poll(); // immediate first poll
        this.intervalId = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    }

    update(bookmarks) {
        this.bookmarks = bookmarks;
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async _poll() {
        const allStops = [];
        for (const group of this.bookmarks) {
            for (const s of group.stops) {
                if (!allStops.find(x => x.stopId === s.stopId)) {
                    allStops.push(s);
                }
            }
        }
        if (allStops.length === 0) return;

        const updates = new Map();
        await Promise.all(
            allStops.map(async (s) => {
                const etas = await fetchStopETAs(s.stopId, s.routes);
                updates.set(s.stopId, etas);
            })
        );
        this.onUpdate(updates);
    }
}

// ─────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────
window.bookmarkEngine = {
    loadBookmarks,
    saveBookmarks,
    createGroup,
    renameGroup,
    deleteGroup,
    addStop,
    removeStop,
    fetchStopETAs,
    ETAPoller,
};
