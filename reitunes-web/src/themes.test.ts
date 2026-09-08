import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeMediaQuery extends EventTarget {
  matches = false;
  change(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

let media: FakeMediaQuery;
let root: {
  dataset: Record<string, string>;
  style: { colorScheme: string; setProperty: ReturnType<typeof vi.fn> };
};
let browser: EventTarget & {
  localStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
  };
  matchMedia: () => FakeMediaQuery;
};

beforeEach(() => {
  vi.resetModules();
  media = new FakeMediaQuery();
  root = { dataset: {}, style: { colorScheme: '', setProperty: vi.fn() } };
  browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    matchMedia: () => media,
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', { documentElement: root });
});

afterEach(() => vi.unstubAllGlobals());

function storageChange(key: string | null, newValue: string | null) {
  browser.dispatchEvent(
    Object.assign(new Event('storage'), {
      key,
      newValue,
      storageArea: browser.localStorage,
    })
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('theme palettes', () => {
  it('uses complete hex palettes with legible text and accent button labels', async () => {
    const { THEMES } = await import('./themes');
    for (const theme of THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = theme[mode];
        expect(Object.keys(palette)).toHaveLength(19);
        for (const color of Object.values(palette))
          expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        for (const background of [
          'surface',
          'panel',
          'header',
          'selection',
        ] as const) {
          expect
            .soft(
              contrast(palette.text, palette[background]),
              `${theme.id} ${mode} text on ${background}`
            )
            .toBeGreaterThanOrEqual(4.5);
          expect
            .soft(
              contrast(palette.muted, palette[background]),
              `${theme.id} ${mode} muted on ${background}`
            )
            .toBeGreaterThanOrEqual(4.5);
        }
        expect
          .soft(
            contrast(palette.accentText, palette.accent),
            `${theme.id} ${mode} accent label`
          )
          .toBeGreaterThanOrEqual(4.5);
        for (const token of [
          'accent',
          'success',
          'warning',
          'error',
          'cyan',
        ] as const) {
          for (const background of ['surface', 'panel', 'alternate'] as const) {
            expect
              .soft(
                contrast(palette[token], palette[background]),
                `${theme.id} ${mode} ${token} on ${background}`
              )
              .toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
});

describe('theme preferences', () => {
  it('applies the OS mode before rendering and follows changes without persisting an override', async () => {
    media.matches = true;
    const themes = await import('./themes');
    themes.initializeTheme();
    const initial = themes.getSnapshot();
    expect(initial).toEqual({
      lightTheme: 'neutral',
      darkTheme: 'neutral',
      mode: 'system',
    });
    expect(themes.getSnapshot()).toBe(initial);
    expect(root.dataset).toEqual({
      theme: 'neutral',
      themeMode: 'dark',
      themePreference: 'system',
    });
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.setProperty).toHaveBeenCalledWith(
      '--accent-text',
      themes.getPalette('neutral', 'dark').accentText
    );
    const listener = vi.fn();
    const unsubscribe = themes.subscribe(listener);
    themes.initializeTheme();
    media.change(false);
    expect(root.dataset.themeMode).toBe('light');
    expect(themes.getSnapshot()).toEqual(initial);
    expect(themes.getSnapshot()).not.toBe(initial);
    expect(listener).toHaveBeenCalledOnce();
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
    unsubscribe();
    media.change(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('restores explicit preferences and saves both independent choices', async () => {
    browser.localStorage.getItem.mockReturnValue(
      '{"lightTheme":"catppuccin","darkTheme":"gruvbox","mode":"light"}'
    );
    media.matches = true;
    const themes = await import('./themes');
    themes.initializeTheme();
    expect(root.dataset.themeMode).toBe('light');
    expect(root.dataset.theme).toBe('catppuccin');
    themes.setThemePreference({
      lightTheme: 'solarized',
      darkTheme: 'gruvbox',
      mode: 'dark',
    });
    const snapshot = themes.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(browser.localStorage.setItem).toHaveBeenLastCalledWith(
      'reitunes-theme',
      '{"lightTheme":"solarized","darkTheme":"gruvbox","mode":"dark"}'
    );
    media.change(false);
    expect(root.dataset.themeMode).toBe('dark');
    expect(root.dataset.theme).toBe('gruvbox');
    expect(themes.getSnapshot()).toBe(snapshot);
  });

  it('uses each selected family when system mode changes', async () => {
    browser.localStorage.getItem.mockReturnValue(
      '{"lightTheme":"solarized","darkTheme":"dracula","mode":"system"}'
    );
    const themes = await import('./themes');
    themes.initializeTheme();
    expect(root.dataset.theme).toBe('solarized');
    media.change(true);
    expect(root.dataset.theme).toBe('dracula');
    expect(root.style.setProperty).toHaveBeenCalledWith(
      '--surface',
      themes.getPalette('dracula', 'dark').surface
    );
    media.change(false);
    expect(root.dataset.theme).toBe('solarized');
    expect(themes.getSnapshot()).toEqual({
      lightTheme: 'solarized',
      darkTheme: 'dracula',
      mode: 'system',
    });
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('keeps the inactive mode selection independent', async () => {
    const themes = await import('./themes');
    themes.initializeTheme();
    themes.setThemePreference({
      lightTheme: 'catppuccin',
      darkTheme: 'dracula',
      mode: 'light',
    });
    themes.setThemePreference({ ...themes.getSnapshot(), darkTheme: 'nord' });
    expect(root.dataset.theme).toBe('catppuccin');
    themes.setThemePreference({ ...themes.getSnapshot(), mode: 'dark' });
    expect(root.dataset.theme).toBe('nord');
    expect(themes.getSnapshot().lightTheme).toBe('catppuccin');
  });

  it('migrates legacy choices to both modes and persists the new shape', async () => {
    browser.localStorage.getItem.mockReturnValue(
      '{"theme":"gruvbox","mode":"system"}'
    );
    const themes = await import('./themes');
    themes.initializeTheme();
    expect(themes.getSnapshot()).toEqual({
      lightTheme: 'gruvbox',
      darkTheme: 'gruvbox',
      mode: 'system',
    });
    expect(browser.localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      'reitunes-theme',
      '{"lightTheme":"gruvbox","darkTheme":"gruvbox","mode":"system"}'
    );
    media.change(true);
    expect(root.dataset.theme).toBe('gruvbox');
    expect(root.dataset.themeMode).toBe('dark');
    expect(browser.localStorage.setItem).toHaveBeenCalledOnce();
  });

  it('preserves the legacy choice if migration cannot be written', async () => {
    browser.localStorage.getItem.mockReturnValue(
      '{"theme":"rose-pine","mode":"dark"}'
    );
    browser.localStorage.setItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    const themes = await import('./themes');
    themes.initializeTheme();
    expect(root.dataset.theme).toBe('rose-pine');
    expect(themes.getSnapshot()).toEqual({
      lightTheme: 'rose-pine',
      darkTheme: 'rose-pine',
      mode: 'dark',
    });
  });

  it.each([
    'not json',
    'null',
    '{}',
    '{"theme":"missing","mode":"dark"}',
    '{"theme":"nord","mode":"missing"}',
    '{"lightTheme":"nord","darkTheme":"missing","mode":"dark"}',
    '{"lightTheme":"nord","mode":"system"}',
    '{"lightTheme":"missing","darkTheme":"dracula","mode":"system","theme":"nord"}',
  ])('falls back for invalid stored data: %s', async (stored) => {
    browser.localStorage.getItem.mockReturnValue(stored);
    const themes = await import('./themes');
    themes.initializeTheme();
    expect(themes.getSnapshot()).toEqual(themes.DEFAULT_THEME);
    expect(root.dataset.theme).toBe('neutral');
  });

  it('syncs another tab and restores defaults when preferences are removed', async () => {
    const themes = await import('./themes');
    themes.initializeTheme();
    storageChange('other-key', '{"theme":"dracula","mode":"dark"}');
    expect(themes.getSnapshot()).toEqual(themes.DEFAULT_THEME);
    storageChange(
      'reitunes-theme',
      '{"lightTheme":"solarized","darkTheme":"dracula","mode":"system"}'
    );
    expect(root.dataset.theme).toBe('solarized');
    media.change(true);
    expect(root.dataset).toEqual({
      theme: 'dracula',
      themeMode: 'dark',
      themePreference: 'system',
    });
    storageChange('reitunes-theme', null);
    expect(themes.getSnapshot()).toEqual(themes.DEFAULT_THEME);
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('accepts legacy updates from another tab without writing them back', async () => {
    const themes = await import('./themes');
    themes.initializeTheme();
    storageChange('reitunes-theme', '{"theme":"nord","mode":"light"}');
    expect(themes.getSnapshot()).toEqual({
      lightTheme: 'nord',
      darkTheme: 'nord',
      mode: 'light',
    });
    expect(root.dataset.theme).toBe('nord');
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('remains usable when storage and system preference access are blocked', async () => {
    Object.defineProperty(browser, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
    browser.matchMedia = () => {
      throw new Error('blocked');
    };
    const themes = await import('./themes');
    expect(() => themes.initializeTheme()).not.toThrow();
    expect(root.dataset.themeMode).toBe('light');
    expect(() =>
      themes.setThemePreference({
        lightTheme: 'nord',
        darkTheme: 'rose-pine',
        mode: 'dark',
      })
    ).not.toThrow();
    expect(root.dataset.theme).toBe('rose-pine');
    expect(themes.getSnapshot()).toEqual({
      lightTheme: 'nord',
      darkTheme: 'rose-pine',
      mode: 'dark',
    });
  });
});
