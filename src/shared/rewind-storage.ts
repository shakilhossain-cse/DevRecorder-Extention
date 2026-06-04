// Preferences for the Share Last Minute / Rewind feature.
// Backed by chrome.storage.local under a single key so we can read/write atomically.
//
// Phase 1 only reads globallyEnabled and bufferSeconds. The host-list fields are
// declared so the schema is stable across phases — Phase 2 will start writing them
// from the options page.

import type { RewindPreferences } from './types';

const STORAGE_KEY = 'rewind_preferences';

export const DEFAULT_REWIND_PREFERENCES: RewindPreferences = {
  globallyEnabled: true,
  bufferSeconds: 60,
  blockedHosts: [],
  forceEnabledHosts: [],
  autoDisabledHosts: [],
};

// Merge a possibly-partial stored object with defaults so older installs / corrupted
// values still produce a fully-populated RewindPreferences.
function mergeWithDefaults(stored: unknown): RewindPreferences {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_REWIND_PREFERENCES };
  const s = stored as Partial<RewindPreferences>;
  return {
    globallyEnabled:
      typeof s.globallyEnabled === 'boolean' ? s.globallyEnabled : DEFAULT_REWIND_PREFERENCES.globallyEnabled,
    bufferSeconds:
      typeof s.bufferSeconds === 'number' && s.bufferSeconds > 0 && s.bufferSeconds <= 600
        ? s.bufferSeconds
        : DEFAULT_REWIND_PREFERENCES.bufferSeconds,
    blockedHosts: Array.isArray(s.blockedHosts) ? s.blockedHosts.slice() : [],
    forceEnabledHosts: Array.isArray(s.forceEnabledHosts) ? s.forceEnabledHosts.slice() : [],
    autoDisabledHosts: Array.isArray(s.autoDisabledHosts) ? s.autoDisabledHosts.slice() : [],
  };
}

export async function getRewindPreferences(): Promise<RewindPreferences> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return mergeWithDefaults(result[STORAGE_KEY]);
  } catch {
    return { ...DEFAULT_REWIND_PREFERENCES };
  }
}

export async function setRewindPreferences(partial: Partial<RewindPreferences>): Promise<RewindPreferences> {
  const current = await getRewindPreferences();
  const next: RewindPreferences = { ...current, ...partial };
  // Re-merge to apply field validation on writes too.
  const validated = mergeWithDefaults(next);
  await chrome.storage.local.set({ [STORAGE_KEY]: validated });
  return validated;
}

// Subscribes to changes to the rewind_preferences key. Returns an unsubscribe function.
export function onRewindPreferencesChanged(cb: (preferences: RewindPreferences) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    cb(mergeWithDefaults(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ── Host-list helpers ─────────────────────────────────
// Used in Phase 2 by the gating logic; implemented now so the surface is stable.
// All inputs are normalized to lowercase, leading-www stripped, so preferences entered
// as "example.com" match the URL "https://www.example.com/foo".
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

function listIncludesHost(list: string[], host: string): boolean {
  const target = normalizeHost(host);
  if (!target) return false;
  for (const raw of list) {
    if (normalizeHost(raw) === target) return true;
  }
  return false;
}

export function isHostBlocked(preferences: RewindPreferences, host: string): boolean {
  return listIncludesHost(preferences.blockedHosts, host);
}

export function isHostForceEnabled(preferences: RewindPreferences, host: string): boolean {
  return listIncludesHost(preferences.forceEnabledHosts, host);
}

export function isHostAutoDisabled(preferences: RewindPreferences, host: string): boolean {
  return listIncludesHost(preferences.autoDisabledHosts, host);
}
