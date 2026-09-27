// Music engine — lives in the MAIN window only (owns the HTMLAudio element so
// playback survives closing the music window). The music window acts as a
// remote control via `music:command` events; state is broadcast on `music:state`.
//
// Playback is driven strictly by timer events (wired in Timer.svelte):
//   timer:started / timer:resumed → play the current round's channel
//   timer:round-change            → switch to the new round's channel (paused)
//   timer:paused                  → pause
//   timer:reset                   → stop
// Settings changes (channel pick, volume, music_on_break) are applied live via
// the settings store subscription.

import { get, writable } from 'svelte/store';
import { emit, listen } from '@tauri-apps/api/event';
import {
  channelBySlug,
  loadFlowData,
  tracksForChannel,
  trackUrl,
  type FlowChannel,
} from '$lib/flowtunes/data';
import { settings } from '$lib/stores/settings';
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
    audio.addEventListener('ended', () => nextTrack());
    audio.addEventListener('error', () => nextTrack()); // skip bad/missing track
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
function loadChannel(slug: string) {
  const channel: FlowChannel | undefined = channelBySlug(slug);
  if (!channel || tracksForChannel(channel.id).length === 0) {
    stop();
    return;
  }
  tracks = tracksForChannel(channel.id);
  getAudio().src = trackUrl(tracks[0]);
  getAudio().load();
  publish({ activeChannelSlug: slug, trackIndex: 0, trackTotal: tracks.length });
}

async function play() {
  if (!get(musicState).activeChannelSlug) return;
  applyVolume();
  try {
    await getAudio().play();
    publish({ isPlaying: true });
  } catch {
    publish({ isPlaying: false });
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
  if (get(musicState).isPlaying) void play();
}

function prevTrack() {
  if (tracks.length === 0) return;
  const { trackIndex } = get(musicState);
  const prev = (trackIndex - 1 + tracks.length) % tracks.length;
  getAudio().src = trackUrl(tracks[prev]);
  getAudio().load();
  publish({ trackIndex: prev });
  if (get(musicState).isPlaying) void play();
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
    } catch (e) {
      console.error('FlowTunes data failed to load', e);
      initialized = false;
      return;
    }

    // Live-apply music settings (also fires on startup with loaded values).
    let prevWork = get(settings).music_channel_work;
    let prevBreak = get(settings).music_channel_break;
    let prevOnBreak = get(settings).music_on_break;
    settings.subscribe((s) => {
      applyVolume();
      const roundType = get(musicState).roundType;
      const wanted = channelForRound(roundType);
      const channelChanged =
        s.music_channel_work !== prevWork ||
        s.music_channel_break !== prevBreak ||
        s.music_on_break !== prevOnBreak;
      if (channelChanged) {
        prevWork = s.music_channel_work;
        prevBreak = s.music_channel_break;
        prevOnBreak = s.music_on_break;
        const { activeChannelSlug, isPlaying } = get(musicState);
        if (wanted !== activeChannelSlug) {
          if (!wanted) {
            stop();
          } else {
            loadChannel(wanted);
            if (isPlaying) void play();
          }
        }
      }
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

  /** Timer entered the next round — switch channel but stay paused until
   *  started/resumed (auto-start fires started immediately after). */
  onRoundChange(roundType: RoundType) {
    publish({ roundType });
    const wanted = channelForRound(roundType);
    if (!wanted) {
      stop();
      return;
    }
    if (wanted !== get(musicState).activeChannelSlug) {
      loadChannel(wanted);
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
// Remote control (music window): next/prev only. Play/pause maps to the timer
// (the music window invokes timerToggle directly); volume/channel go through
// settings. State is broadcast from publish() on 'music:state'.
// ---------------------------------------------------------------------------

export async function initMusicRemote() {
  await listen<{ type: string }>('music:command', (event) => {
    switch (event.payload?.type) {
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
