// Music engine — lives in the MAIN window only (owns the HTMLAudio element so
// playback survives closing the music window). The music window acts as a
// remote control via `music:command` events; state is broadcast on `music:state`.
//
// Playback rules:
//   - Picking a channel (work or break) in the music panel plays it right away,
//     FlowTunes-style — no need to start the timer first.
//   - Timer events still drive it: started/resumed → play the round's channel,
//     round-change → switch to the new round's channel, paused → pause,
//     reset → stop.
//   - The panel's play/pause button controls music+ambient only (not the timer).

import { get, writable } from 'svelte/store';
import { emit, listen } from '@tauri-apps/api/event';
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
import type { RoundType } from '$lib/types';

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
/** Consecutive 'error'-event skips; reset on successful playback. */
let consecutiveErrors = 0;

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
      nextTrack();
    });
    audio.addEventListener('error', () => {
      // Bad/missing track or network hiccup: skip forward so playback never
      // stalls, but bail out after a few consecutive failures (offline).
      consecutiveErrors += 1;
      void logError(`[music] track load failed (${consecutiveErrors} consecutive): ${audio?.src}`);
      if (consecutiveErrors <= 3) nextTrack();
      else publish({ isPlaying: false });
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
  tracks = [...tracks].sort(() => Math.random() - 0.5); // shuffle for variety
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
  publish({ activeChannelSlug: '', trackIndex: 0, trackTotal: 0, isPlaying: false });
}

function nextTrack() {
  if (tracks.length === 0) return;
  const { trackIndex } = get(musicState);
  const next = (trackIndex + 1) % tracks.length;
  getAudio().src = trackUrl(tracks[next]);
  getAudio().load();
  publish({ trackIndex: next });
  void play();
}

function prevTrack() {
  if (tracks.length === 0) return;
  const { trackIndex } = get(musicState);
  const prev = (trackIndex - 1 + tracks.length) % tracks.length;
  getAudio().src = trackUrl(tracks[prev]);
  getAudio().load();
  publish({ trackIndex: prev });
  void play();
}

// ---------------------------------------------------------------------------
// Timer-facing API (called from Timer.svelte event handlers, main window only)
// ---------------------------------------------------------------------------

export const music = {
  /** Load bundled data once and wire the settings subscription. */
  async init() {
    if (initialized) return;
    initialized = true;
    try {
      await loadFlowData();
      publish({ ready: true });
      void logInfo('[music] FlowTunes data loaded');
    } catch (e) {
      void logError(`[music] FlowTunes data failed to load: ${e}`);
      initialized = false;
      return;
    }

    // Live-apply music settings (also fires on startup with loaded values).
    let prevWork = get(settings).music_channel_work;
    let prevBreak = get(settings).music_channel_break;
    let prevOnBreak = get(settings).music_on_break;
    settings.subscribe((s) => {
      applyVolume();
      const channelChanged =
        s.music_channel_work !== prevWork ||
        s.music_channel_break !== prevBreak ||
        s.music_on_break !== prevOnBreak;
      if (!channelChanged) return;
      prevWork = s.music_channel_work;
      prevBreak = s.music_channel_break;
      prevOnBreak = s.music_on_break;

      // Picking a channel plays it right away — timer or not.
      const wanted = channelForRound(get(musicState).roundType);
      if (!wanted) {
        stop();
        return;
      }
      if (wanted !== get(musicState).activeChannelSlug) {
        loadChannel(wanted);
      }
      void play();
    });
  },

  /** A round actually began (user pressed play or auto-start). */
  onTimerStarted() {
    const wanted = channelForRound(get(musicState).roundType);
    if (!wanted) {
      stop();
      return;
    }
    if (wanted !== get(musicState).activeChannelSlug) loadChannel(wanted);
    void play();
  },

  /** Timer entered the next round — switch channel and keep playing so the
   *  soundscape carries over (round-change is followed by auto-start's
   *  started event, which re-asserts playback anyway). */
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
    void play();
  },

  onTimerPaused() {
    pause();
  },

  onTimerReset() {
    stop();
  },
};

// ---------------------------------------------------------------------------
// Remote control (music window): transport commands for music+ambient only.
// State is broadcast from publish() on 'music:state'.
// ---------------------------------------------------------------------------

export async function initMusicRemote() {
  await listen<{ type: string }>('music:command', (event) => {
    switch (event.payload?.type) {
      case 'play':
        void play();
        ambient.play();
        break;
      case 'pause':
        pause();
        ambient.pause();
        break;
      case 'next':
        nextTrack();
        break;
      case 'prev':
        prevTrack();
        break;
    }
  });
}

export async function emitMusicCommand(type: string) {
  await emit('music:command', { type });
}
