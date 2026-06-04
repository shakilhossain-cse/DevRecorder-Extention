// Auto-disable heuristic for the Share Last Minute / Rewind feature.
//
// While the rolling buffer is actively running on a host, we sample system CPU
// and memory pressure on a 5-second cadence (alarm-driven so it survives
// service-worker suspension). If we observe sustained heavy pressure that can
// plausibly be attributed to the rewind buffer on the active host, the host is
// added to `autoDisabledHosts` in rewind_preferences and the storage-change
// subscription in the service worker triggers a re-evaluation, which then
// transitions the status to `autoDisabled`.
//
// Heuristic design notes
// ----------------------
//   - CPU pressure: chrome.system.cpu.getInfo() returns per-processor usage as
//     monotonically increasing tick counters since boot. We compute the delta
//     of (user+kernel)/total against the previous snapshot, average across
//     processors, and consider the sample bad when > 0.85.
//   - Memory pressure: chrome.system.memory.getInfo() returns capacity and
//     availableCapacity in bytes. We treat (capacity - avail)/capacity > 0.85
//     as bad.
//   - Both must be bad in the same tick to count as a bad sample (conservative
//     — we don't want a memory-greedy site that's otherwise idle to trip the
//     wire, nor a CPU-spinning site that hasn't blown up memory yet).
//   - 3 consecutive bad samples (~15 s of sustained pressure) trigger the
//     auto-disable. Any non-bad sample resets the counter.
//   - Attribution: the heuristic only runs while the buffer is enabled AND a
//     specific host is being captured (see startHeuristic). When the active
//     tab changes, stopHeuristic() is called and any in-progress counter is
//     discarded — so we never attribute pressure observed on host A to host B.
//   - We deliberately do NOT run while status is `forceEnabled`: the user
//     explicitly opted in despite a prior auto-disable, so flipping them off
//     again would be infuriating.

import { getRewindPreferences, setRewindPreferences, normalizeHost } from '@shared/rewind-storage';

const ALARM_NAME = 'rewind-heuristic-tick';
const SAMPLE_INTERVAL_MINUTES = 5 / 60; // 5 seconds, expressed in minutes for chrome.alarms
const CPU_PRESSURE_THRESHOLD = 0.85;
const MEMORY_PRESSURE_THRESHOLD = 0.85;
const BAD_SAMPLES_REQUIRED = 3;

interface CpuSnapshot {
  // Sum across processors of (user+kernel) and total at sample time. Storing
  // sums (not per-processor) is fine because the delta-of-ratios across the
  // same processor set is mathematically equivalent.
  busyTicks: number;
  totalTicks: number;
}

let monitoringHost: string | null = null;
let badSampleCount = 0;
let lastCpuSnapshot: CpuSnapshot | null = null;
let alarmListenerInstalled = false;

function installAlarmListener(): void {
  if (alarmListenerInstalled) return;
  alarmListenerInstalled = true;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void runSample();
  });
}

async function captureCpuSnapshot(): Promise<CpuSnapshot | null> {
  try {
    const info = await chrome.system.cpu.getInfo();
    if (!info || !Array.isArray(info.processors) || info.processors.length === 0) return null;
    let busy = 0;
    let total = 0;
    for (const p of info.processors) {
      const u = p.usage;
      if (!u) continue;
      busy += u.user + u.kernel;
      total += u.total;
    }
    if (total <= 0) return null;
    return { busyTicks: busy, totalTicks: total };
  } catch {
    return null;
  }
}

async function captureMemoryPressure(): Promise<number | null> {
  try {
    const info = await chrome.system.memory.getInfo();
    if (!info || !info.capacity || info.capacity <= 0) return null;
    return (info.capacity - info.availableCapacity) / info.capacity;
  } catch {
    return null;
  }
}

function computeCpuDelta(prev: CpuSnapshot, next: CpuSnapshot): number | null {
  const busyDelta = next.busyTicks - prev.busyTicks;
  const totalDelta = next.totalTicks - prev.totalTicks;
  if (totalDelta <= 0) return null;
  // Clamp negatives that can occur if Chrome resets a counter mid-sample.
  if (busyDelta < 0) return 0;
  return busyDelta / totalDelta;
}

async function autoDisableHost(host: string): Promise<void> {
  const normalized = normalizeHost(host);
  if (!normalized) return;
  const current = await getRewindPreferences();
  // If the user has already force-enabled this host since we started sampling,
  // back off — don't override an explicit user choice.
  if (current.forceEnabledHosts.some((h) => normalizeHost(h) === normalized)) return;
  // Dedupe.
  if (current.autoDisabledHosts.some((h) => normalizeHost(h) === normalized)) return;
  const autoDisabledHosts = [...current.autoDisabledHosts, normalized];
  await setRewindPreferences({ autoDisabledHosts });
  // The SW's onRewindPreferencesChanged subscription will pick this up and
  // call evaluateRewind(), which will transition status to `autoDisabled`.
}

async function runSample(): Promise<void> {
  const host = monitoringHost;
  if (!host) return;

  const [cpuNow, memPressure] = await Promise.all([captureCpuSnapshot(), captureMemoryPressure()]);

  // First sample after start has no baseline for the CPU delta — record it and
  // return without judging. The next tick will produce a usable delta.
  if (!lastCpuSnapshot) {
    if (cpuNow) lastCpuSnapshot = cpuNow;
    return;
  }
  if (!cpuNow || memPressure === null) {
    // Sampling failed; don't penalize the host for an API hiccup.
    return;
  }

  const cpuDelta = computeCpuDelta(lastCpuSnapshot, cpuNow);
  lastCpuSnapshot = cpuNow;

  if (cpuDelta === null) return;

  const cpuBad = cpuDelta > CPU_PRESSURE_THRESHOLD;
  const memBad = memPressure > MEMORY_PRESSURE_THRESHOLD;
  const sampleBad = cpuBad && memBad;

  if (!sampleBad) {
    badSampleCount = 0;
    return;
  }

  badSampleCount += 1;
  if (badSampleCount < BAD_SAMPLES_REQUIRED) return;

  // Sustained pressure — auto-disable. Capture the host into a local before
  // any awaits because stopHeuristic() may clear monitoringHost concurrently.
  const target = monitoringHost;
  // Stop sampling immediately so we don't double-trigger while the write
  // round-trips through storage.
  stopHeuristic();
  if (target) {
    await autoDisableHost(target);
  }
}

// Begin sampling for the given host. Idempotent: if the host hasn't changed,
// the existing sampler keeps running; if it has, the counter and CPU baseline
// are reset.
export function startHeuristic(host: string): void {
  const normalized = normalizeHost(host);
  if (!normalized) return;
  installAlarmListener();
  if (monitoringHost === normalized) return;
  monitoringHost = normalized;
  badSampleCount = 0;
  lastCpuSnapshot = null;
  // Create the alarm (or replace any existing one with the same name).
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: SAMPLE_INTERVAL_MINUTES,
    // delayInMinutes lets us pick up a baseline CPU snapshot on the next fire
    // instead of waiting a full period; the first sample is discarded anyway.
    delayInMinutes: SAMPLE_INTERVAL_MINUTES,
  });
}

// Stop sampling. Called on tab change, rewind pause, status flip away from
// `enabled`, or after auto-disable fires.
export function stopHeuristic(): void {
  monitoringHost = null;
  badSampleCount = 0;
  lastCpuSnapshot = null;
  chrome.alarms.clear(ALARM_NAME).catch(() => {});
}
