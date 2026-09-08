export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;
export type ThemeId =
  | 'neutral'
  | 'solarized'
  | 'catppuccin'
  | 'gruvbox'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'rose-pine';
export interface ThemePreference {
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  mode: ThemeMode;
}
export interface ThemePalette {
  surface: string;
  panel: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  hover: string;
  alternate: string;
  header: string;
  input: string;
  borderStrong: string;
  selection: string;
  success: string;
  warning: string;
  error: string;
  cyan: string;
  scrollThumb: string;
}
export interface Theme {
  id: ThemeId;
  name: string;
  light: ThemePalette;
  dark: ThemePalette;
}

// The semantic mappings are ReiTunes adaptations of these upstream palettes.
// Additional shades keep table striping subtle and interactive text readable.
export const THEMES: readonly Theme[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    light: {
      surface: '#ffffff',
      panel: '#f3f3f3',
      text: '#222222',
      muted: '#666666',
      line: '#dddddd',
      accent: '#2468b4',
      accentText: '#ffffff',
      accentSoft: '#e7f0fa',
      hover: '#eaf1f8',
      alternate: '#fafafa',
      header: '#eeeeee',
      input: '#ffffff',
      borderStrong: '#999999',
      selection: '#d9e9fa',
      success: '#2e7135',
      warning: '#946000',
      error: '#b52d2d',
      cyan: '#176b80',
      scrollThumb: '#b8b8b8',
    },
    dark: {
      surface: '#202020',
      panel: '#292929',
      text: '#e6e6e6',
      muted: '#aaaaaa',
      line: '#3d3d3d',
      accent: '#8ab4f8',
      accentText: '#152238',
      accentSoft: '#293b55',
      hover: '#303a46',
      alternate: '#242424',
      header: '#303030',
      input: '#202020',
      borderStrong: '#777777',
      selection: '#2b3c55',
      success: '#91c996',
      warning: '#e6bc70',
      error: '#ee9999',
      cyan: '#82c9d8',
      scrollThumb: '#686868',
    },
  },
  {
    // https://github.com/altercation/solarized#the-values
    id: 'solarized',
    name: 'Solarized',
    light: {
      surface: '#fdf6e3',
      panel: '#eee8d5',
      text: '#40555c',
      muted: '#53676e',
      line: '#d9d3c1',
      accent: '#1b6ca3',
      accentText: '#fdf6e3',
      accentSoft: '#e3ece9',
      hover: '#e9e4d2',
      alternate: '#f8f1df',
      header: '#eee8d5',
      input: '#fdf6e3',
      borderStrong: '#93a1a1',
      selection: '#d3e6e6',
      success: '#606e00',
      warning: '#846300',
      error: '#c32c29',
      cyan: '#16746e',
      scrollThumb: '#93a1a1',
    },
    dark: {
      surface: '#002b36',
      panel: '#073642',
      text: '#a5b1b1',
      muted: '#93a1a1',
      line: '#214954',
      accent: '#48a2df',
      accentText: '#001820',
      accentSoft: '#123f50',
      hover: '#0b3e4b',
      alternate: '#03313d',
      header: '#073642',
      input: '#002b36',
      borderStrong: '#586e75',
      selection: '#083b46',
      success: '#90a217',
      warning: '#bc9417',
      error: '#f0746b',
      cyan: '#3ba9a0',
      scrollThumb: '#586e75',
    },
  },
  {
    // Latte and Mocha: https://github.com/catppuccin/catppuccin#-palette
    id: 'catppuccin',
    name: 'Catppuccin',
    light: {
      surface: '#eff1f5',
      panel: '#e6e9ef',
      text: '#4c4f69',
      muted: '#55586f',
      line: '#ccd0da',
      accent: '#8538ea',
      accentText: '#ffffff',
      accentSoft: '#e8ddf8',
      hover: '#e1e4ec',
      alternate: '#eaeef3',
      header: '#dce0e8',
      input: '#eff1f5',
      borderStrong: '#9ca0b0',
      selection: '#dccbf1',
      success: '#307621',
      warning: '#905d15',
      error: '#ce0f38',
      cyan: '#127278',
      scrollThumb: '#acb0be',
    },
    dark: {
      surface: '#1e1e2e',
      panel: '#181825',
      text: '#cdd6f4',
      muted: '#a6adc8',
      line: '#313244',
      accent: '#cba6f7',
      accentText: '#1e1e2e',
      accentSoft: '#3d314f',
      hover: '#313244',
      alternate: '#232334',
      header: '#181825',
      input: '#1e1e2e',
      borderStrong: '#585b70',
      selection: '#3b354d',
      success: '#a6e3a1',
      warning: '#f9e2af',
      error: '#f38ba8',
      cyan: '#94e2d5',
      scrollThumb: '#585b70',
    },
  },
  {
    // https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim
    id: 'gruvbox',
    name: 'Gruvbox',
    light: {
      surface: '#fbf1c7',
      panel: '#ebdbb2',
      text: '#3c3836',
      muted: '#5a5048',
      line: '#d5c4a1',
      accent: '#ad3903',
      accentText: '#fbf1c7',
      accentSoft: '#eed6b1',
      hover: '#ebdbb2',
      alternate: '#f2e5bc',
      header: '#ebdbb2',
      input: '#fbf1c7',
      borderStrong: '#a89984',
      selection: '#dfc89e',
      success: '#67620b',
      warning: '#855612',
      error: '#9d0006',
      cyan: '#076678',
      scrollThumb: '#bdae93',
    },
    dark: {
      surface: '#282828',
      panel: '#32302f',
      text: '#ebdbb2',
      muted: '#bdae93',
      line: '#504945',
      accent: '#fe8019',
      accentText: '#282828',
      accentSoft: '#4d3828',
      hover: '#3c3836',
      alternate: '#2e2c2b',
      header: '#3c3836',
      input: '#282828',
      borderStrong: '#7c6f64',
      selection: '#493e30',
      success: '#b8bb26',
      warning: '#fabd2f',
      error: '#ff6553',
      cyan: '#8ec07c',
      scrollThumb: '#7c6f64',
    },
  },
  {
    // Nord documents Snow Storm backgrounds for light interfaces:
    // https://www.nordtheme.com/docs/colors-and-palettes/
    id: 'nord',
    name: 'Nord',
    light: {
      surface: '#eceff4',
      panel: '#e5e9f0',
      text: '#2e3440',
      muted: '#4c566a',
      line: '#d8dee9',
      accent: '#4a6a91',
      accentText: '#eceff4',
      accentSoft: '#dce5ef',
      hover: '#d8dee9',
      alternate: '#e8ecf2',
      header: '#d8dee9',
      input: '#eceff4',
      borderStrong: '#8b97aa',
      selection: '#ccd9e9',
      success: '#526e3d',
      warning: '#826325',
      error: '#a23f49',
      cyan: '#426c7b',
      scrollThumb: '#a4afbf',
    },
    dark: {
      surface: '#2e3440',
      panel: '#3b4252',
      text: '#eceff4',
      muted: '#d8dee9',
      line: '#434c5e',
      accent: '#88c0d0',
      accentText: '#2e3440',
      accentSoft: '#3b4d5e',
      hover: '#434c5e',
      alternate: '#343b49',
      header: '#3b4252',
      input: '#2e3440',
      borderStrong: '#66758d',
      selection: '#485b70',
      success: '#a3be8c',
      warning: '#ebcb8b',
      error: '#df9ea3',
      cyan: '#8fbcbb',
      scrollThumb: '#66758d',
    },
  },
  {
    // Alucard (light) and Dracula (dark):
    // https://github.com/dracula/dracula-theme#color-palette-oss
    // UI shades: https://github.com/dracula/draculatheme.com/blob/main/content/spec.mdx
    id: 'dracula',
    name: 'Dracula',
    light: {
      surface: '#fffbeb',
      panel: '#efeddc',
      text: '#1f1f1f',
      muted: '#5d5740',
      line: '#dedccf',
      accent: '#644ac9',
      accentText: '#fffbeb',
      accentSoft: '#ece7f4',
      hover: '#ece9df',
      alternate: '#f8f5e6',
      header: '#efeddc',
      input: '#fffbeb',
      borderStrong: '#bcbab3',
      selection: '#cfcfde',
      success: '#14710a',
      warning: '#7d6914',
      error: '#c13728',
      cyan: '#036a96',
      scrollThumb: '#bcbab3',
    },
    dark: {
      surface: '#282a36',
      panel: '#343746',
      text: '#f8f8f2',
      muted: '#a1accb',
      line: '#44475a',
      accent: '#bd93f9',
      accentText: '#282a36',
      accentSoft: '#443952',
      hover: '#343746',
      alternate: '#2d2f3d',
      header: '#343746',
      input: '#282a36',
      borderStrong: '#6272a4',
      selection: '#393c4c',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff7777',
      cyan: '#8be9fd',
      scrollThumb: '#6272a4',
    },
  },
  {
    // Day and Night: https://github.com/folke/tokyonight.nvim/tree/main/extras/alacritty
    // UI shades: https://github.com/folke/tokyonight.nvim/tree/main/lua/tokyonight/colors
    id: 'tokyo-night',
    name: 'Tokyo Night',
    light: {
      surface: '#e1e2e7',
      panel: '#d5d6db',
      text: '#294c9f',
      muted: '#424e79',
      line: '#c5c7d1',
      accent: '#235aaf',
      accentText: '#ffffff',
      accentSoft: '#d3dced',
      hover: '#d3d7e1',
      alternate: '#dcdde3',
      header: '#d5d6db',
      input: '#e1e2e7',
      borderStrong: '#a1a6c5',
      selection: '#c0cdea',
      success: '#4b6430',
      warning: '#735832',
      error: '#b41946',
      cyan: '#006486',
      scrollThumb: '#a1a6c5',
    },
    dark: {
      surface: '#1a1b26',
      panel: '#1f2335',
      text: '#c0caf5',
      muted: '#a9b1d6',
      line: '#292e42',
      accent: '#7aa2f7',
      accentText: '#1a1b26',
      accentSoft: '#283652',
      hover: '#292e42',
      alternate: '#1e2030',
      header: '#1f2335',
      input: '#1a1b26',
      borderStrong: '#565f89',
      selection: '#30405f',
      success: '#9ece6a',
      warning: '#e0af68',
      error: '#f7768e',
      cyan: '#7dcfff',
      scrollThumb: '#565f89',
    },
  },
  {
    // Main and Dawn: https://github.com/rose-pine/neovim/blob/main/lua/rose-pine/palette.lua
    id: 'rose-pine',
    name: 'Rosé Pine',
    light: {
      surface: '#faf4ed',
      panel: '#f2e9e1',
      text: '#464261',
      muted: '#605c79',
      line: '#dfdad9',
      accent: '#286983',
      accentText: '#fffaf3',
      accentSoft: '#e5ebeb',
      hover: '#f2e9e1',
      alternate: '#f4ede8',
      header: '#f2e9e1',
      input: '#fffaf3',
      borderStrong: '#9893a5',
      selection: '#dfdad9',
      success: '#487169',
      warning: '#935d1f',
      error: '#a14f66',
      cyan: '#286983',
      scrollThumb: '#cecacd',
    },
    dark: {
      surface: '#191724',
      panel: '#1f1d2e',
      text: '#e0def4',
      muted: '#908caa',
      line: '#403d52',
      accent: '#c4a7e7',
      accentText: '#191724',
      accentSoft: '#3c304b',
      hover: '#26233a',
      alternate: '#1d1b2a',
      header: '#1f1d2e',
      input: '#191724',
      borderStrong: '#6e6a86',
      selection: '#292538',
      success: '#95b1ac',
      warning: '#f6c177',
      error: '#eb6f92',
      cyan: '#9ccfd8',
      scrollThumb: '#6e6a86',
    },
  },
];

export const DEFAULT_THEME: Readonly<ThemePreference> = Object.freeze({
  lightTheme: 'neutral',
  darkTheme: 'neutral',
  mode: 'system',
});
export const THEME_STORAGE_KEY = 'reitunes-theme';
let snapshot: Readonly<ThemePreference> = DEFAULT_THEME;
let mediaQuery: MediaQueryList | null = null;
let resolvedMode: ResolvedThemeMode = 'light';
let initialized = false;
const listeners = new Set<() => void>();

export function resolveThemeMode(
  mode: ThemeMode,
  systemDark = mediaQuery?.matches ?? false
): ResolvedThemeMode {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

export function getPalette(
  themeId: ThemeId,
  mode: ResolvedThemeMode
): ThemePalette {
  return (THEMES.find((theme) => theme.id === themeId) ?? THEMES[0])[mode];
}

function validThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function validThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function validPreference(value: unknown): value is ThemePreference {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ThemePreference>;
  return (
    validThemeId(candidate.lightTheme) &&
    validThemeId(candidate.darkTheme) &&
    validThemeMode(candidate.mode)
  );
}

function parsePreference(value: string | null): {
  preference: Readonly<ThemePreference>;
  migrated: boolean;
} {
  try {
    const parsed: unknown = value === null ? null : JSON.parse(value);
    if (validPreference(parsed)) {
      return {
        preference: Object.freeze({
          lightTheme: parsed.lightTheme,
          darkTheme: parsed.darkTheme,
          mode: parsed.mode,
        }),
        migrated: false,
      };
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !('lightTheme' in parsed) &&
      !('darkTheme' in parsed)
    ) {
      const legacy = parsed as { theme?: unknown; mode?: unknown };
      if (validThemeId(legacy.theme) && validThemeMode(legacy.mode)) {
        return {
          preference: Object.freeze({
            lightTheme: legacy.theme,
            darkTheme: legacy.theme,
            mode: legacy.mode,
          }),
          migrated: true,
        };
      }
    }
  } catch {
    /* Malformed preferences use the default. */
  }
  return { preference: DEFAULT_THEME, migrated: false };
}

function persistPreference(preference: Readonly<ThemePreference>): void {
  try {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        lightTheme: preference.lightTheme,
        darkTheme: preference.darkTheme,
        mode: preference.mode,
      })
    );
  } catch {
    /* The selection still works for this page when storage is blocked. */
  }
}

function applyTheme(): void {
  resolvedMode = resolveThemeMode(snapshot.mode);
  const themeId =
    resolvedMode === 'light' ? snapshot.lightTheme : snapshot.darkTheme;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.themeMode = resolvedMode;
  root.dataset.themePreference = snapshot.mode;
  root.style.colorScheme = resolvedMode;
  for (const [token, value] of Object.entries(
    getPalette(themeId, resolvedMode)
  )) {
    root.style.setProperty(
      `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value
    );
  }
}

function updatePreference(preference: Readonly<ThemePreference>): void {
  if (
    snapshot.lightTheme === preference.lightTheme &&
    snapshot.darkTheme === preference.darkTheme &&
    snapshot.mode === preference.mode
  )
    return;
  snapshot = Object.freeze({
    lightTheme: preference.lightTheme,
    darkTheme: preference.darkTheme,
    mode: preference.mode,
  });
  applyTheme();
  listeners.forEach((listener) => listener());
}

/** Apply preferences before createRoot so the first rendered frame has the right palette. */
export function initializeTheme(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try {
    const loaded = parsePreference(
      window.localStorage.getItem(THEME_STORAGE_KEY)
    );
    snapshot = loaded.preference;
    if (loaded.migrated) persistPreference(snapshot);
  } catch {
    snapshot = DEFAULT_THEME;
  }
  try {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    mediaQuery = null;
  }
  applyTheme();

  const onSystemChange = () => {
    if (
      snapshot.mode !== 'system' ||
      resolveThemeMode(snapshot.mode) === resolvedMode
    )
      return;
    // Notify appearance subscribers while keeping the stored preference as System.
    snapshot = Object.freeze({ ...snapshot });
    applyTheme();
    listeners.forEach((listener) => listener());
  };
  if (mediaQuery?.addEventListener)
    mediaQuery.addEventListener('change', onSystemChange);
  else mediaQuery?.addListener(onSystemChange);

  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
    } catch {
      /* Some browsers block access to the storage object itself. */
    }
    updatePreference(parsePreference(event.newValue).preference);
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between changes, as required by useSyncExternalStore. */
export function getSnapshot(): Readonly<ThemePreference> {
  return snapshot;
}

export function setThemePreference(preference: ThemePreference): void {
  initializeTheme();
  const next = validPreference(preference) ? preference : DEFAULT_THEME;
  updatePreference(next);
  persistPreference(next);
}
