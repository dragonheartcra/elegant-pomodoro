// FlowTunes bundled data + remote audio URL helpers.
// catalog.json / channels.json are bundled under /static/flowtunes and
// loaded once; audio streams from the public Supabase bucket.

export interface FlowChannel {
  id: string; // UUID — key into the catalog
  slug: string;
  title: string;
  subtitle: string;
  cover: string;
}

export interface FlowSound {
  id: string;
  title: string;
  description: string;
}

export interface FlowSoundCategory {
  id: string;
  title: string;
  description: string;
  loopIds: string[];
}

const AUDIO_BASE =
  'https://uaugvlfehjnmqwcsscnp.supabase.co/storage/v1/object/public';

export function trackUrl(trackId: string): string {
  return `${AUDIO_BASE}/track-audio-v3/mds/${trackId}.m4a`;
}

export function loopUrl(loopId: string): string {
  return `${AUDIO_BASE}/loop-audio-v3/${loopId}.m4a`;
}

export function loopIconUrl(loopId: string): string {
  return `/loop-icons/${loopId}.svg`;
}

let channelsCache: FlowChannel[] | null = null;
let catalogCache: { tracks: Record<string, string[]> } | null = null;
let soundsCache: FlowSound[] | null = null;
let soundCategoriesCache: FlowSoundCategory[] | null = null;

/** Track ids for a channel UUID, in playlist order. */
export function tracksForChannel(channelId: string): string[] {
  return catalogCache?.tracks?.[channelId] ?? [];
}export function channelBySlug(slug: string): FlowChannel | undefined {
  return channelsCache?.find((c) => c.slug === slug);
}

export function allChannels(): FlowChannel[] {
  if (!channelsCache) throw new Error('FlowTunes data not loaded');
  return channelsCache;
}

export function allSounds(): FlowSound[] {
  if (!soundsCache) throw new Error('FlowTunes data not loaded');
  return soundsCache;
}

export function allSoundCategories(): FlowSoundCategory[] {
  if (!soundCategoriesCache) throw new Error('FlowTunes data not loaded');
  return soundCategoriesCache;
}

export async function loadFlowData(): Promise<void> {
  if (channelsCache && catalogCache && soundsCache) return;
  const [channelsRes, catalogRes, ambientRes] = await Promise.all([
    fetch('/flowtunes/channels.json'),
    fetch('/flowtunes/catalog.json'),
    fetch('/flowtunes/ambient.json'),
  ]);
  if (!channelsRes.ok || !catalogRes.ok || !ambientRes.ok) {
    throw new Error('Failed to load FlowTunes data');
  }
  channelsCache = (await channelsRes.json()) as FlowChannel[];
  catalogCache = (await catalogRes.json()) as { tracks: Record<string, string[]> };
  const ambient = (await ambientRes.json()) as {
    sounds: FlowSound[];
    categories: FlowSoundCategory[];
  };
  soundsCache = ambient.sounds;
  soundCategoriesCache = ambient.categories;
}
