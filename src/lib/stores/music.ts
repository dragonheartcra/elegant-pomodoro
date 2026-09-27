// Music engine — lives in the MAIN window only (owns the HTMLAudio element so
// playback survives closing the music window). The music window acts as a
// remote control via `music:command` events; state is broadcast on `music:state`.
//
// Playback rules:
//   - Clicking a channel in the panel plays it right away (explicit preview
//     command) — timer or not, FlowTunes-style.
//   - The music_on_break toggle has NO immediate effect on playback; it only
//     changes what plays when the next break round starts (applied immediately
//     if we are already inside a break).
//   - Timer events govern round transitions: started/resumed → play the
//     round's channel, round-change → switch channel, paused → pause,
//     reset → stop + resync round type.

import { get, writable } from 'svelte/store';
import { emit, listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { error as logError, info as logInfo } from '@tauri-apps/plugin-log';
import {
  channelBySlug,
  loadFlowData,
  tracksForChannel,
  trackUrl,
  type FlowChannel,
} from '$lib/flowtunes/data';
import { settings } from '$lib/stores/settings';
import { ambient } from '$lib/stores/ambient';
import { getSettings } from '$lib/ipc';
import type { RoundType, TimerState } from '$lib/types';

export interface MusicState {
  /** Round the engine last saw ('work' initially). */
  roundType: RoundType;
  /** Channel actually loaded in the player ('' = nothing loaded). */
  activeChannelSlug: string;
  trackIndex: number; // 0-based
  trackTotal: number;
  isPlaying: boolean;
  /** True once bundled data has loaded. */
  ready: boolean;
}

const initial: MusicState = {
  roundType: 'work',
  activeChannelSlug: '',
  trackIndex: 0,
  trackTotal: 0,
  isPlaying: false,
  ready: false,
};

export const musicState = writable<MusicState>(initial);

let audio: HTMLAudioElement | null = null;
let tracks: string[] = [];
let initialized = false;
let lastAppliedVolume = -1;
/** Consecutive 'error'-event skips; reset on successful playback or stop(). */
let consecutiveErrors = 0;
/** timer:started/resumed arrived before FlowTunes data finished loading. */
let pendingStart = false;

function publish(patch: Partial<MusicState>) {
  musicState.update((s) => {
    const next = { ...s, ...patch };
    void emit('music:state', next);
    return next;
  });
}

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.addEventListener('ended', () => {
      consecutiveErrors = 0;
      nextTrack(true);
    });
    audio.addEventListener('error', () => {
      // Bad/missing track or network hiccup: skip forward so playback never
      // stalls, but bail out after a few consecutive failures (offline) —
      // stop() clears the error state so the next start/resume reloads fresh.
      consecutiveErrors += 1;
      void logError(`[music] track load failed (${consecutiveErrors} consecutive): ${audio?.src}`);
      if (consecutiveErrors <= 3) nextTrack(true);
      else stop();
    });
    audio.addEventListener('playing', () => {
      consecutiveErrors = 0;
    });
  }
  return audio;
}

function applyVolume() {
  const v = get(settings).music_volume;
  if (v !== lastAppliedVolume) {
    lastAppliedVolume = v;
    getAudio().volume = v;
  }
}

function channelForRound(roundType: RoundType): string {
  const s = get(settings);
  if (roundType === 'work') return s.music_channel_work;
  return s.music_on_break ? s.music_channel_break : '';
}

/** Load a channel's playlist and the given track index. */
function loadChannel(slug: string, startIndex = 0): boolean {
  const channel: FlowChannel | undefined = channelBySlug(slug);
  if (!channel) {
    void logError(`[music] unknown channel slug: ${slug}`);
    stop();
    return false;
  }
  tracks = tracksForChannel(channel.id);
  if (tracks.length === 0) {
    void logError(`[music] empty catalog for channel: ${slug}`);
    stop();
    return false;
  }
  getAudio().src = trackUrl(tracks[startIndex]);
  getAudio().load();
  publish({ activeChannelSlug: slug, trackIndex: startIndex, trackTotal: tracks.length });
  return true;
}

async function play(): Promise<boolean> {
  if (!get(musicState).activeChannelSlug) return false;
  applyVolume();
  try {
    await getAudio().play();
    publish({ isPlaying: true });
    return true;
  } catch (e) {
    void logError(`[music] play() rejected: ${e}`);
    publish({ isPlaying: false });
    return false;
  }
}

function pause() {
  if (!audio) return;
  audio.pause();
  publish({ isPlaying: false });
}

function stop() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  tracks = [];
  consecutiveErrors = 0;
  publish({ activeChannelSlug: '', trackIndex: 0, trackTotal: 0, isPlaying: false });
}

/** Switch playlist tracks. Autoplay for ended/error chains and explicit
 *  user clicks; false for remote next/prev while paused (keep paused). */
function nextTrack(autoplay: boolean) {
  if (tracks.length === 0) return;
  const { trackIndex } = get(musicState);
  const next = (trackIndex + 1) % tracks.length;
  getAudio().src = trackUrl(tracks[next]);
  getAudio().load();
  publish({ trackIndex: next });
  if (autoplay) void play();
}

function prevTrack(autoplay: boolean) {
  if (tracks.length === 0) return;
  const { trackIndex } = get(musicState);
  const prev = (trackIndex - 1 + tracks.length) % tracks.length;
  getAudio().src = trackUrl(tracks[prev]);
  getAudio().load();
  publish({ trackIndex: prev });
  if (autoplay) void play();
}

// ---------------------------------------------------------------------------
// Timer-facing API (called from Timer.svelte event handlers, main window only)
// ---------------------------------------------------------------------------

/** A timer:started / timer:resumed arrived — make sure the current round's
 *  channel is loaded and playing (self-heals any silent stop). */
function ensurePlaying() {
  const wanted = channelForRound(get(musicState).roundType);
  if (!wanted) {
    stop();
    return;
  }
  if (wanted !== get(musicState).activeChannelSlug) loadChannel(wanted);
  void play();
}

export const music = {
  /** Load bundled data once and wire the settings subscription. */
  async init() {
    if (initialized) return;
    initialized = true;
    // Hydrate settings first so the subscription's "previous values" snapshot
    // reflects the database, not compile-time defaults.
    try {
      settings.set(await getSettings());
    } catch {
      // Keep compile-time defaults; hydration via settings:changed may follow.
    }
    try {
      await loadFlowData();
      publish({ ready: true });
      void logInfo('[music] FlowTunes data loaded');
    } catch (e) {
      void logError(`[music] FlowTunes data failed to load: ${e}`);
      initialized = false;
      return;
    }

    // The music_on_break toggle applies immediately only while INSIDE a break
    // round; channel picks never auto-play from here — the panel sends an
    // explicit `preview` command when the user clicks a channel.
    let prevOnBreak = get(settings).music_on_break;
    settings.subscribe((s) => {
      applyVolume();
      const changedOnBreak = s.music_on_break !== prevOnBreak;
      if (!changedOnBreak) return;
      prevOnBreak = s.music_on_break;
      const roundType = get(musicState).roundType;
      if (roundType === 'work') return; // toggle only governs break rounds
      const wanted = s.music_on_break ? s.music_channel_break : '';
      if (!wanted) {
        stop();
        return;
      }
      if (wanted !== get(musicState).activeChannelSlug) loadChannel(wanted);
      void play();
    });

    // A timer start raced ahead of data loading — replay it now.
    if (pendingStart) {
      pendingStart = false;
      ensurePlaying();
    }
  },

  /** A round actually began (user pressed play or auto-start). */
  onTimerStarted() {
    if (!get(musicState).ready) {
      pendingStart = true;
      return;
    }
    ensurePlaying();
  },

  /** Timer entered the next round — switch channel and keep playing so the
   *  soundscape carries over (auto-start's started event re-asserts playback
   *  right after). */
  onRoundChange(roundType: RoundType) {
    publish({ roundType });
    const wanted = channelForRound(roundType);
    if (!wanted) {
      stop();
      return;
    }
    if (wanted !== get(musicState).activeChannelSlug) {
      loadChannel(wanted);
      if (get(musicState).isPlaying) void play();
    }
  },

  onTimerResumed() {
    if (!get(musicState).ready) {
      pendingStart = true;
      return;
    }
    // Self-healing: if anything stopped/cleared the engine mid-round, resume
    // reloads the current round's channel instead of playing nothing.
    ensurePlaying();
  },

  onTimerPaused() {
    pendingStart = false;
    pause();
  },

  onTimerReset(snap: TimerState) {
    pendingStart = false;
    stop();
    // Reset rewinds the sequence to Work — resync so the next start picks the
    // right channel.
    publish({ roundType: snap.round_type });
  },
};

// ---------------------------------------------------------------------------
// Remote control (music window): explicit preview + transport commands for
// music+ambient. State is broadcast from publish() on 'music:state'.
// ---------------------------------------------------------------------------

export async function initMusicRemote(): Promise<UnlistenFn> {
  return await listen<{ type: string; payload?: unknown }>('music:command', (event) => {
    const cmd = event.payload;
    switch (cmd?.type) {
      case 'getState':
        // Music window just opened — give it the current snapshot.
        void emit('music:state', get(musicState));
        break;
      case 'preview': {
        // User clicked a channel in the panel — play exactly that one.
        const slug = String(cmd.payload ?? '');
        if (!slug) break;
        if (slug !== get(musicState).activeChannelSlug) loadChannel(slug);
        void play();
        break;
      }
      case 'play':
        if (!get(musicState).ready) break;
        ensurePlaying();
        ambient.play();
        break;
      case 'pause':
        pause();
        ambient.pause();
        break;
      case 'next':
        nextTrack(false);
        break;
      case 'prev':
        prevTrack(false);
        break;
    }
  });
}

export async function emitMusicCommand(type: string, payload?: unknown) {
  await emit('music:command', { type, payload });
}
