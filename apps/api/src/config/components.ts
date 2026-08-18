// Product-surface feature gates. The current default is the lean trading desk:
// Live Ticks + Momentum + History. Experimental screens stay in the codebase
// and their historical tables stay intact, but their fetch/compute/write paths
// do not run unless explicitly re-enabled.

export type ComponentSlug =
  | 'ignition'
  | 'momo'
  | 'setups'
  | 'ema'
  | 'swing'
  | 'outcomes'
  | 'continuation';

export interface ComponentFlags {
  ignition: boolean;
  momo: boolean;
  setups: boolean;
  ema: boolean;
  swing: boolean;
  outcomes: boolean;
  continuation: boolean;
}

export const DEFAULT_DISABLED_COMPONENTS: ComponentSlug[] = [
  'ignition',
  'momo',
  'setups',
  'ema',
  'swing',
  'outcomes',
  'continuation',
];

const KNOWN = new Set<ComponentSlug>(DEFAULT_DISABLED_COMPONENTS);
let cachedRaw: string | undefined;
let cachedFlags: ComponentFlags | undefined;
let warnedRaw: string | undefined;

export function getComponentFlags(): ComponentFlags {
  const raw = process.env.COMPONENTS_DISABLED ?? DEFAULT_DISABLED_COMPONENTS.join(',');
  if (cachedFlags && cachedRaw === raw) return cachedFlags;

  const disabled = new Set<ComponentSlug>();
  const unknown: string[] = [];
  for (const value of raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)) {
    // The UI calls the continuation screen "Faders"; accept either spelling.
    const slug = value === 'faders' ? 'continuation' : value;
    if (KNOWN.has(slug as ComponentSlug)) disabled.add(slug as ComponentSlug);
    else unknown.push(value);
  }
  if (unknown.length > 0 && warnedRaw !== raw) {
    warnedRaw = raw;
    console.warn(`[components] ignored unknown COMPONENTS_DISABLED values: ${unknown.join(', ')}`);
  }

  cachedRaw = raw;
  cachedFlags = {
    ignition: !disabled.has('ignition'),
    momo: !disabled.has('momo'),
    setups: !disabled.has('setups'),
    ema: !disabled.has('ema'),
    swing: !disabled.has('swing'),
    outcomes: !disabled.has('outcomes'),
    continuation: !disabled.has('continuation'),
  };
  return cachedFlags;
}

export function componentEnabled(slug: ComponentSlug): boolean {
  return getComponentFlags()[slug];
}

export function technicalTrackersEnabled(): boolean {
  const f = getComponentFlags();
  return f.ema || f.momo || f.setups;
}

export function dailyBarsEnabled(): boolean {
  const f = getComponentFlags();
  return f.swing || f.outcomes || f.continuation;
}
