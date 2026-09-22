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
  | 'rose-pine'
  | 'guava'
  | 'papaya'
  | 'blueberry'
  | 'dragonfruit'
  | 'forest-palace';

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

// Named upstream palettes use ReiTunes-specific semantic mappings.
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
  // Tropical palettes keep fruit accents on near-neutral dark surfaces.
  {
    id: 'guava',
    name: 'Guava',
    light: {
      surface: '#f6efef',
      panel: '#ede3e5',
      text: '#493c42',
      muted: '#6b5962',
      line: '#dbccd1',
      accent: '#91405f',
      accentText: '#fff4f5',
      accentSoft: '#eddae2',
      hover: '#eadde2',
      alternate: '#f1e8eb',
      header: '#ede3e5',
      input: '#faf4f5',
      borderStrong: '#ab8e9b',
      selection: '#e6d3dc',
      success: '#476a51',
      warning: '#745221',
      error: '#a13f4f',
      cyan: '#30635f',
      scrollThumb: '#bca3ad',
    },
    dark: {
      surface: '#171719',
      panel: '#1e1d20',
      text: '#d9ccd2',
      muted: '#b5a1ad',
      line: '#303034',
      accent: '#d997af',
      accentText: '#30232d',
      accentSoft: '#342a30',
      hover: '#272629',
      alternate: '#1b1b1d',
      header: '#222124',
      input: '#141416',
      borderStrong: '#555158',
      selection: '#30282e',
      success: '#a6bd92',
      warning: '#d5b080',
      error: '#df939c',
      cyan: '#87beb5',
      scrollThumb: '#48454c',
    },
  },
  {
    id: 'papaya',
    name: 'Papaya',
    light: {
      surface: '#f6f0e7',
      panel: '#eae3d8',
      text: '#473f36',
      muted: '#675d50',
      line: '#d8cebd',
      accent: '#864927',
      accentText: '#fff6e9',
      accentSoft: '#edddca',
      hover: '#eae0d3',
      alternate: '#f0eade',
      header: '#eae3d8',
      input: '#faf5ec',
      borderStrong: '#a99a81',
      selection: '#e4d6c2',
      success: '#485f3b',
      warning: '#805b26',
      error: '#a04747',
      cyan: '#35605e',
      scrollThumb: '#b7a88f',
    },
    dark: {
      surface: '#181817',
      panel: '#1f1f1d',
      text: '#d8d1c3',
      muted: '#b2aa99',
      line: '#32322f',
      accent: '#d7a27c',
      accentText: '#30281f',
      accentSoft: '#332d26',
      hover: '#282825',
      alternate: '#1c1c1a',
      header: '#232321',
      input: '#151513',
      borderStrong: '#55554e',
      selection: '#302d26',
      success: '#a9bb8d',
      warning: '#d2b878',
      error: '#d9958e',
      cyan: '#8cbcb0',
      scrollThumb: '#494942',
    },
  },
  {
    id: 'blueberry',
    name: 'Blueberry',
    light: {
      surface: '#f1f2f5',
      panel: '#e5e7ed',
      text: '#3c414c',
      muted: '#555e6d',
      line: '#cfd3dd',
      accent: '#3e5d88',
      accentText: '#f6f8ff',
      accentSoft: '#dce3ef',
      hover: '#e0e4ec',
      alternate: '#eceef2',
      header: '#e5e7ed',
      input: '#f7f8fb',
      borderStrong: '#939eaf',
      selection: '#d8dee9',
      success: '#45634f',
      warning: '#805126',
      error: '#91444e',
      cyan: '#6c4f87',
      scrollThumb: '#a6afbf',
    },
    dark: {
      surface: '#16181b',
      panel: '#1d1f23',
      text: '#cdd2dd',
      muted: '#a2acbb',
      line: '#303339',
      accent: '#93add6',
      accentText: '#202935',
      accentSoft: '#29303e',
      hover: '#26292e',
      alternate: '#1a1c20',
      header: '#21242a',
      input: '#131518',
      borderStrong: '#505965',
      selection: '#272e3a',
      success: '#98b69e',
      warning: '#d8ae83',
      error: '#d4959e',
      cyan: '#b5a0cf',
      scrollThumb: '#444c58',
    },
  },
  {
    id: 'dragonfruit',
    name: 'Dragonfruit',
    light: {
      surface: '#f4f0f3',
      panel: '#eae3e8',
      text: '#493d47',
      muted: '#665862',
      line: '#d9ced6',
      accent: '#894366',
      accentText: '#fff5fa',
      accentSoft: '#ebdae4',
      hover: '#e7dde4',
      alternate: '#eee9ed',
      header: '#eae3e8',
      input: '#faf6f9',
      borderStrong: '#aa929f',
      selection: '#e1d5de',
      success: '#53622f',
      warning: '#755422',
      error: '#963d48',
      cyan: '#355f75',
      scrollThumb: '#b8a3ae',
    },
    dark: {
      surface: '#191719',
      panel: '#201d20',
      text: '#d8cdd5',
      muted: '#b3a4af',
      line: '#343034',
      accent: '#d391b8',
      accentText: '#30232c',
      accentSoft: '#352a32',
      hover: '#292629',
      alternate: '#1d1b1d',
      header: '#242124',
      input: '#161416',
      borderStrong: '#59515a',
      selection: '#31282e',
      success: '#aabb84',
      warning: '#cfb280',
      error: '#d48e97',
      cyan: '#90b9ca',
      scrollThumb: '#4c454d',
    },
  },
  // Forest palettes give the dark surfaces more green, with quiet metallic accents.
  {
    id: 'forest-palace',
    name: 'Forest Palace',
    light: {
      surface: '#f0f2e9',
      panel: '#e3e8db',
      text: '#394738',
      muted: '#56634e',
      line: '#cbd5c1',
      accent: '#6c5b29',
      accentText: '#fcf9ec',
      accentSoft: '#e5e2cc',
      hover: '#dde5d5',
      alternate: '#eaf0e2',
      header: '#e3e8db',
      input: '#f7f8f1',
      borderStrong: '#96a68b',
      selection: '#d6dfcb',
      success: '#3f6348',
      warning: '#765326',
      error: '#934651',
      cyan: '#695180',
      scrollThumb: '#a5b29b',
    },
    dark: {
      surface: '#15251f',
      panel: '#1c2e26',
      text: '#d2d8c7',
      muted: '#a7b69f',
      line: '#304437',
      accent: '#c8b883',
      accentText: '#252b1d',
      accentSoft: '#35412d',
      hover: '#263a2e',
      alternate: '#192a22',
      header: '#203329',
      input: '#112019',
      borderStrong: '#596f56',
      selection: '#2b4032',
      success: '#9dbb9e',
      warning: '#ccb080',
      error: '#d39a9e',
      cyan: '#b4a1c7',
      scrollThumb: '#4c6049',
    },
  },
];

export const DEFAULT_THEME: Readonly<ThemePreference> = Object.freeze({
  lightTheme: 'neutral',
  darkTheme: 'forest-palace',
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
  const palette = getPalette(themeId, resolvedMode);
  // Match the browser's title bar to the player bar.
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = palette.panel;
  for (const [token, value] of Object.entries(palette)) {
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
