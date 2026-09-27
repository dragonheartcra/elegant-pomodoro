<script lang="ts">
  // Music panel window: remote control for the audio engine running in the
  // main window. Channel selection, volume and ambient sounds persist through
  // the settings pipeline; transport state arrives via 'music:state' events.
  import '../../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { getSettings, getThemes, onSettingsChanged, onThemesChanged, setSetting } from '$lib/ipc';
  import { settings } from '$lib/stores/settings';
  import { applyTheme } from '$lib/stores/theme';
  import { resolveThemeName } from '$lib/utils/theme';
  import { setLocale } from '$lib/locale.svelte.js';
  import { emitMusicCommand, type MusicState } from '$lib/stores/music';
  import {
    allChannels,
    allSoundCategories,
    allSounds,
    loadFlowData,
    loopIconUrl,
    type FlowChannel,
    type FlowSound,
  } from '$lib/flowtunes/data';
  import SettingsToggle from '$lib/components/settings/SettingsToggle.svelte';
  import { isMac } from '$lib/utils/platform';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import * as m from '$paraglide/messages.js';

  let tab = $state<'focus' | 'break'>('focus');
  let channels = $state<FlowChannel[]>([]);
  let sounds = $state<FlowSound[]>([]);
  let categories = $state<{ id: string; title: string; loopIds: string[] }[]>([]);
  let pickerOpen = $state(false);
  let dataError = $state(false);

  const emptyMusicState: MusicState = {
    roundType: 'work',
    activeChannelSlug: '',
    trackIndex: 0,
    trackTotal: 0,
    isPlaying: false,
    ready: false,
  };
  let np = $state<MusicState>(emptyMusicState);

  const selectedLoops = $derived.by<string[]>(() => {
    try {
      const parsed = JSON.parse($settings.ambient_selected);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const loopVolumes = $derived.by<Record<string, number>>(() => {
    try {
      return JSON.parse($settings.ambient_volumes) ?? {};
    } catch {
      return {};
    }
  });

  const currentChannelSlug = $derived(
    tab === 'focus' ? $settings.music_channel_work : $settings.music_channel_break
  );

  const npChannelTitle = $derived.by(() => {
    if (!np.activeChannelSlug) return '';
    const ch = channels.find((c) => c.slug === np.activeChannelSlug);
    return ch?.title ?? np.activeChannelSlug;
  });

  function soundById(id: string): FlowSound | undefined {
    return sounds.find((s) => s.id === id);
  }

  function soundTitle(id: string): string {
    return soundById(id)?.title ?? id;
  }

  async function pickChannel(slug: string) {
    const key = tab === 'focus' ? 'music_channel_work' : 'music_channel_break';
    const updated = await setSetting(key, slug);
    settings.set(updated);
    // Clicking a channel plays it right away (FlowTunes-style), explicitly.
    await emitMusicCommand('preview', slug);
  }

  async function setMusicVolume(v: number) {
    const updated = await setSetting('music_volume', String(Math.round(v * 100)));
    settings.set(updated);
  }

  // Slider drags fire oninput per tick — debounce the IPC round-trips, and
  // commit immediately on release (onchange) so the final value always lands.
  let volumeTimer: ReturnType<typeof setTimeout> | undefined;
  function onMusicVolumeInput(v: number) {
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => setMusicVolume(v), 120);
  }
  function onMusicVolumeChange(v: number) {
    clearTimeout(volumeTimer);
    void setMusicVolume(v);
  }

  const loopVolumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function onLoopVolumeInput(id: string, v: number) {
    clearTimeout(loopVolumeTimers.get(id));
    loopVolumeTimers.set(
      id,
      setTimeout(() => {
        loopVolumeTimers.delete(id);
        void setLoopVolume(id, v);
      }, 120)
    );
  }
  function onLoopVolumeChange(id: string, v: number) {
    clearTimeout(loopVolumeTimers.get(id));
    loopVolumeTimers.delete(id);
    void setLoopVolume(id, v);
  }

  async function setMusicOnBreak(v: boolean) {
    const updated = await setSetting('music_on_break', String(v));
    settings.set(updated);
  }

  async function toggleLoop(id: string) {
    const next = selectedLoops.includes(id)
      ? selectedLoops.filter((x) => x !== id)
      : [...selectedLoops, id];
    const updated = await setSetting('ambient_selected', JSON.stringify(next));
    settings.set(updated);
  }

  async function setLoopVolume(id: string, v: number) {
    const next = { ...loopVolumes, [id]: Math.round(v * 100) / 100 };
    const updated = await setSetting('ambient_volumes', JSON.stringify(next));
    settings.set(updated);
  }

  async function clearAllLoops() {
    const updated = await setSetting('ambient_selected', '[]');
    settings.set(updated);
  }

  onMount(() => {
    const cleanups: UnlistenFn[] = [];

    (async () => {
      try {
        const s = await getSettings();
        settings.set(s);
        setLocale(s.language);

        const themes = await getThemes();
        const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const activeTheme = themes.find((t) => t.name === resolveThemeName(s, osDark)) ?? themes[0];
        if (activeTheme) applyTheme(activeTheme);

        await loadFlowData();
        channels = allChannels();
        sounds = allSounds();
        categories = allSoundCategories();
        dataError = false;
      } catch {
        dataError = true;
      }

      await getCurrentWebviewWindow().show();

      cleanups.push(
        await listen<MusicState>('music:state', (e) => {
          np = e.payload;
        }),
        await onSettingsChanged(async (updated) => {
          const prevLanguage = $settings.language;
          settings.set(updated);
          if (updated.language !== prevLanguage) setLocale(updated.language);
        }),
        await onThemesChanged(async (updated) => {
          const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          const current = updated.find((t) => t.name === resolveThemeName($settings, dark)) ?? updated[0];
          if (current) applyTheme(current);
        })
      );

      // Ask the main window for the current playback snapshot (it only
      // broadcasts on changes, which may never have happened).
      await emitMusicCommand('getState');

      // Live OS color scheme changes — re-resolve only in auto mode.
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const mqListener = async (e: MediaQueryListEvent) => {
        if ($settings.theme_mode !== 'auto') return;
        const allThemes = await getThemes();
        const t = allThemes.find((th) => th.name === resolveThemeName($settings, e.matches));
        if (t) applyTheme(t);
      };
      mq.addEventListener('change', mqListener);
      cleanups.push(() => mq.removeEventListener('change', mqListener));
    })();

    return () => {
      for (const fn of cleanups) fn();
    };
  });
</script>

<div class="window">
  <nav class="titlebar" class:macos={isMac} data-tauri-drag-region>
    <h1 class="title">{m.music_title()}</h1>
    {#if !isMac}
      <button
        class="btn-close"
        onclick={() => getCurrentWebviewWindow().close()}
        aria-label="Close"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    {/if}
  </nav>

  <div class="body">
    {#if dataError}
      <p class="error">{m.music_load_error()}</p>
    {:else}
      <!-- Now playing -->
      <section class="now-playing">
        <div class="np-meta">
          <span class="np-label">{m.music_now_playing()}</span>
          {#if np.activeChannelSlug}
            <span class="np-channel">{npChannelTitle}</span>
            {#if np.trackTotal > 0}
              <span class="np-track">
                {m.music_track_of({ n: np.trackIndex + 1, total: np.trackTotal })}
              </span>
            {/if}
          {:else}
            <span class="np-idle">{m.music_idle_hint()}</span>
          {/if}
        </div>
        <div class="transport">
          <button class="t-btn" onclick={() => emitMusicCommand('prev')} aria-label="Previous track">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2.5" y="3" width="2" height="10" rx="0.6" />
              <path d="M13.5 3.6v8.8a.6.6 0 0 1-.94.5L6.2 8.5a.62.62 0 0 1 0-1L12.56 3.1a.6.6 0 0 1 .94.5Z" />
            </svg>
          </button>
          <button
            class="t-btn t-play"
            onclick={() => emitMusicCommand(np.isPlaying ? 'pause' : 'play')}
            aria-label="Play / pause"
          >
            {#if np.isPlaying}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3.5" y="2.5" width="3.4" height="11" rx="0.8" />
                <rect x="9.1" y="2.5" width="3.4" height="11" rx="0.8" />
              </svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.4 2.7a.7.7 0 0 0-1.05.6v9.4a.7.7 0 0 0 1.05.6l7.6-4.7a.7.7 0 0 0 0-1.2Z" />
              </svg>
            {/if}
          </button>
          <button class="t-btn" onclick={() => emitMusicCommand('next')} aria-label="Next track">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 3.6v8.8a.6.6 0 0 0 .94.5l6.36-4.4a.62.62 0 0 0 0-1L3.44 3.1a.6.6 0 0 0-.94.5Z" />
              <rect x="11.5" y="3" width="2" height="10" rx="0.6" />
            </svg>
          </button>
        </div>
      </section>

      <div class="volume-row">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 6v4h2.6L9 13V3L5.1 6Z"
            fill="currentColor"
          />
          <path
            d="M11 5.5a3.2 3.2 0 0 1 0 5"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={$settings.music_volume}
          oninput={(e) => onMusicVolumeInput(Number(e.currentTarget.value))}
          onchange={(e) => onMusicVolumeChange(Number(e.currentTarget.value))}
          aria-label={m.music_volume()}
        />
      </div>

      <!-- Focus / Break tabs -->
      <div class="tabs" role="tablist">
        <button role="tab" class:active={tab === 'focus'} onclick={() => (tab = 'focus')}>
          {m.music_tab_focus()}
        </button>
        <button role="tab" class:active={tab === 'break'} onclick={() => (tab = 'break')}>
          {m.music_tab_break()}
        </button>
      </div>

      {#if tab === 'break'}
        <div class="break-toggle">
          <SettingsToggle
            label={m.music_on_break_toggle()}
            description={m.music_on_break_toggle_desc()}
            checked={$settings.music_on_break}
            onclick={() => setMusicOnBreak(!$settings.music_on_break)}
          />
        </div>
      {/if}

      <!-- Channel list -->
      <div class="channel-list" role="listbox">
        {#each channels as c (c.id)}
          <button
            class="channel-row"
            class:selected={currentChannelSlug === c.slug}
            onclick={() => pickChannel(c.slug)}
          >
            <img
              class="ch-cover"
              src={c.cover}
              alt=""
              loading="lazy"
              onerror={(e) => {
                (e.currentTarget as HTMLImageElement).src = '/app-icon.png';
              }}
            />
            <span class="ch-text">
              <span class="ch-title">{c.title}</span>
              <span class="ch-sub">{c.subtitle}</span>
            </span>
            {#if currentChannelSlug === c.slug}
              <svg class="ch-check" width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 8.5 6.5 12 13 4.5"
                  stroke="var(--color-accent)"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Ambient sounds -->
      <section class="ambient">
        <div class="amb-head">
          <h3>{m.ambient_title()}</h3>
          <div class="amb-head-actions">
            {#if selectedLoops.length > 0}
              <button class="amb-clear" onclick={clearAllLoops}>{m.ambient_clear_all()}</button>
            {/if}
            <button class="amb-toggle-picker" onclick={() => (pickerOpen = !pickerOpen)}>
              {pickerOpen ? m.ambient_hide() : m.ambient_add()}
            </button>
          </div>
        </div>

        {#if !pickerOpen}
          {#if selectedLoops.length === 0}
            <p class="amb-empty">{m.ambient_none_selected()}</p>
          {:else}
            <div class="amb-quickbar">
              {#each selectedLoops as id (id)}
                <span class="amb-quick-icon" title={soundTitle(id)}>
                  <img src={loopIconUrl(id)} alt={soundTitle(id)} />
                </span>
              {/each}
            </div>
          {/if}
        {:else}
          {#each categories as cat (cat.id)}
            <div class="amb-cat">
              <h4>{cat.title}</h4>
              <div class="amb-grid">
                {#each cat.loopIds as id (id)}
                  {@const active = selectedLoops.includes(id)}
                  <div class="amb-tile" class:active>
                    <button class="amb-hit" onclick={() => toggleLoop(id)}>
                      <span class="amb-icon"><img src={loopIconUrl(id)} alt="" /></span>
                      <span class="amb-name">{soundTitle(id)}</span>
                    </button>
                    {#if active}
                      <input
                        type="range"
                        class="amb-vol"
                        min="0"
                        max="1"
                        step="0.01"
                        value={loopVolumes[id] ?? 0.375}
                        oninput={(e) => onLoopVolumeInput(id, Number(e.currentTarget.value))}
                        onchange={(e) => onLoopVolumeChange(id, Number(e.currentTarget.value))}
                        aria-label={soundTitle(id)}
                      />
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .window {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-background);
    animation: app-fade-in 0.2s ease both;
  }

  .titlebar {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background: var(--color-background-light);
  }

  .title {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--color-foreground-darker, var(--color-foreground));
    letter-spacing: 0.03em;
  }

  .btn-close {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--color-foreground-darker, var(--color-foreground));
    cursor: pointer;
  }

  .btn-close:hover {
    background: var(--color-hover);
    color: var(--color-focus-round);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .error {
    color: var(--color-focus-round);
    text-align: center;
    margin-top: 40px;
  }

  /* Now playing */
  .now-playing {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 14px;
    background: var(--color-background-light);
    border-radius: 10px;
  }

  .np-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .np-label {
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-foreground-darkest, var(--color-foreground-darker));
    opacity: 0.7;
  }

  .np-channel {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--color-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .np-track {
    font-size: 0.72rem;
    color: var(--color-foreground-darker, var(--color-foreground));
    opacity: 0.75;
  }

  .np-idle {
    font-size: 0.8rem;
    color: var(--color-foreground-darker, var(--color-foreground));
    opacity: 0.7;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .t-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    background: none;
    border: none;
    border-radius: 8px;
    color: var(--color-foreground-darker, var(--color-foreground));
    cursor: pointer;
    transition: background var(--transition-default), color var(--transition-default);
  }

  .t-btn:hover {
    background: var(--color-hover);
    color: var(--color-foreground);
  }

  .t-play {
    width: 38px;
    height: 38px;
    background: var(--color-hover);
    color: var(--color-accent);
  }

  /* Volume */
  .volume-row {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-foreground-darker, var(--color-foreground));
    padding: 0 4px;
  }

  .volume-row input {
    flex: 1;
    accent-color: var(--color-accent);
    height: 4px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    background: var(--color-background-light);
    border-radius: 8px;
    padding: 3px;
  }

  .tabs button {
    flex: 1;
    padding: 7px 0;
    background: none;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-foreground-darker, var(--color-foreground));
    cursor: pointer;
    transition: background var(--transition-default), color var(--transition-default);
  }

  .tabs button.active {
    background: var(--color-accent);
    color: var(--color-background);
  }

  .break-toggle {
    border: 1px solid var(--color-separator);
    border-radius: 8px;
    padding: 4px 10px 4px 14px;
  }

  /* Channel list */
  .channel-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .channel-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    background: none;
    border: 1px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-default), border-color var(--transition-default);
  }

  .channel-row:hover {
    background: var(--color-hover);
  }

  .channel-row.selected {
    border-color: var(--color-accent);
    background: var(--color-hover);
  }

  .ch-cover {
    width: 42px;
    height: 42px;
    border-radius: 8px;
    object-fit: cover;
    background: var(--color-background-light);
    flex-shrink: 0;
  }

  .ch-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .ch-title {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--color-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ch-sub {
    font-size: 0.72rem;
    color: var(--color-foreground-darker, var(--color-foreground));
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ch-check {
    flex-shrink: 0;
  }

  /* Ambient */
  .ambient {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .amb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .amb-head h3 {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--color-foreground);
  }

  .amb-head-actions {
    display: flex;
    gap: 6px;
  }

  .amb-toggle-picker,
  .amb-clear {
    padding: 5px 10px;
    background: var(--color-background-light);
    border: 1px solid var(--color-separator);
    border-radius: 7px;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-foreground-darker, var(--color-foreground));
    cursor: pointer;
    transition: background var(--transition-default), color var(--transition-default);
  }

  .amb-toggle-picker:hover,
  .amb-clear:hover {
    background: var(--color-hover);
    color: var(--color-foreground);
  }

  .amb-clear:hover {
    color: var(--color-focus-round);
  }

  .amb-empty {
    font-size: 0.78rem;
    color: var(--color-foreground-darker, var(--color-foreground));
    opacity: 0.7;
  }

  .amb-quickbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .amb-quick-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--color-background-light);
    color: var(--color-accent);
  }

  .amb-quick-icon img {
    width: 22px;
    height: 22px;
  }

  .amb-cat h4 {
    font-size: 0.66rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-foreground-darker, var(--color-foreground));
    opacity: 0.6;
    margin: 6px 0;
  }

  .amb-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 6px;
  }

  .amb-tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    border: 1px solid transparent;
    border-radius: 9px;
  }

  .amb-tile.active {
    border-color: var(--color-accent);
    background: var(--color-hover);
  }

  .amb-hit {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px 6px;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }

  .amb-hit:hover {
    background: var(--color-hover);
  }

  .amb-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    color: var(--color-foreground-darker, var(--color-foreground));
  }

  .amb-tile.active .amb-icon {
    color: var(--color-accent);
  }

  .amb-icon img {
    width: 26px;
    height: 26px;
  }

  .amb-name {
    font-size: 0.66rem;
    color: var(--color-foreground-darker, var(--color-foreground));
    text-align: center;
    line-height: 1.2;
  }

  .amb-tile.active .amb-name {
    color: var(--color-foreground);
  }

  .amb-vol {
    width: 100%;
    accent-color: var(--color-accent);
    height: 4px;
  }
</style>
