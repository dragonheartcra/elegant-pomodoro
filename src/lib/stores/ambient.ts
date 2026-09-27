// Ambient sound engine — lives in the MAIN window only, like the music engine.
// One looping HTMLAudio element per selected loop id. Selection and per-loop
// volumes come from settings (`ambient_selected` / `ambient_volumes` JSON
// strings), so the music window edits them via setSetting and this engine
// reacts through the settings store subscription.
//
// Transport mirrors the timer: play/resume on started/resumed, pause on
// paused, full stop on reset (wired in Timer.svelte).

import { get } from 'svelte/store';
import { loopUrl } from '$lib/flowtunes/data';
import { settings } from '$lib/stores/settings';

const DEFAULT_VOLUME = 0.375;

let instances = new Map<string, HTMLAudioElement>();
/** Whether loops should be sounding right now (timer running). */
let shouldPlay = false;
let initialized = false;

function selectedIds(): string[] {
  try {
    const parsed = JSON.parse(get(settings).ambient_selected);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function volumeOf(id: string): number {
  try {
    const v = JSON.parse(get(settings).ambient_volumes);
    const n = v?.[id];
    return typeof n === 'number' && n >= 0 && n <= 1 ? n : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/** Reconcile instances with settings: add/remove loops, apply volumes. */
function sync() {
  const selected = selectedIds();

  for (const [id, el] of instances) {
    if (!selected.includes(id)) {
      el.pause();
      instances.delete(id);
    }
  }
  for (const id of selected) {
    if (!instances.has(id)) {
      const el = new Audio(loopUrl(id));
      el.loop = true;
      el.volume = volumeOf(id);
      instances.set(id, el);
    }
  }
  for (const [id, el] of instances) {
    el.volume = volumeOf(id);
  }

  if (shouldPlay) void playAll();
}

async function playAll() {
  shouldPlay = true;
  for (const el of instances.values()) {
    try {
      await el.play();
    } catch {
      // autoplay rejection or network error — leave paused, retried on next event
    }
  }
}

function pauseAll() {
  shouldPlay = false;
  for (const el of instances.values()) el.pause();
}

function stopAll() {
  shouldPlay = false;
  for (const el of instances.values()) {
    el.pause();
    el.currentTime = 0;
  }
}

export const ambient = {
  init() {
    if (initialized) return;
    initialized = true;
    settings.subscribe(() => sync());
    sync();
  },

  play() {
    void playAll();
  },

  pause() {
    pauseAll();
  },

  stop() {
    stopAll();
  },
};
