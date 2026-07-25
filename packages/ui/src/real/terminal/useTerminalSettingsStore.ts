import type { ITheme } from '@xterm/xterm';
import { create } from 'zustand';

const STORAGE_TERMINAL_FONT_KEY = 'agents-ui-terminal-font-id-v1';
const STORAGE_TERMINAL_FONT_SIZE_KEY = 'agents-ui-terminal-font-size-v1';
const STORAGE_TERMINAL_SETTINGS_KEY = 'agents-ui-terminal-settings-v2';

export interface TerminalFontPreset {
  id: string;
  label: string;
  stack: string;
}

export const TERMINAL_FONT_PRESETS: TerminalFontPreset[] = [
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    stack:
      '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    id: 'system',
    label: 'System Mono (SF Mono)',
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  { id: 'menlo', label: 'Menlo', stack: 'Menlo, Monaco, "Courier New", monospace' },
  { id: 'monaco', label: 'Monaco', stack: 'Monaco, Menlo, "Courier New", monospace' },
  { id: 'courier', label: 'Courier', stack: '"Courier New", Courier, monospace' },
];

export const DEFAULT_TERMINAL_FONT_ID = 'jetbrains';
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 22;

export function terminalFontStack(id: string): string {
  return (
    TERMINAL_FONT_PRESETS.find((preset) => preset.id === id) ?? TERMINAL_FONT_PRESETS[0]!
  ).stack;
}

export interface TerminalColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalColorPreset {
  id: string;
  label: string;
  colors: TerminalColors;
}

const WARM_ATELIER_COLORS: TerminalColors = {
  foreground: '#D9D2C4',
  cursor: '#E0A45A',
  selectionBackground: 'rgba(224,164,90,0.22)',
  selectionForeground: '#F3EEE2',
  black: '#322D24',
  red: '#CB7059',
  green: '#74B083',
  yellow: '#D2A24C',
  blue: '#6E9BC4',
  magenta: '#B98BC0',
  cyan: '#6FB2A8',
  white: '#CFC8BA',
  brightBlack: '#6B6453',
  brightRed: '#DC8B73',
  brightGreen: '#8FC79C',
  brightYellow: '#E6B968',
  brightBlue: '#88B0D6',
  brightMagenta: '#CCA0D2',
  brightCyan: '#86C4BA',
  brightWhite: '#EFE9DB',
};

const CLASSIC_DARK_COLORS: TerminalColors = {
  background: '#1A1A1A', foreground: '#F0F0F0', cursor: '#FFFFFF', cursorAccent: '#1A1A1A',
  selectionBackground: 'rgba(255,255,255,0.2)', selectionForeground: '#FFFFFF', black: '#2E2E2E',
  red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', magenta: '#C678DD',
  cyan: '#56B6C2', white: '#DCDFE4', brightBlack: '#636D83', brightRed: '#F16079',
  brightGreen: '#A8D89C', brightYellow: '#F0CC8A', brightBlue: '#74BFFF',
  brightMagenta: '#D48CF0', brightCyan: '#6CC7D2', brightWhite: '#FFFFFF',
};

const LIGHT_TERMINAL_COLORS: TerminalColors = {
  background: '#FAF6F0', foreground: '#2C2620', cursor: '#7A5C2A', cursorAccent: '#FAF6F0',
  selectionBackground: 'rgba(122,92,42,0.18)', selectionForeground: '#2C2620', black: '#3C3530',
  red: '#8B2D20', green: '#2D6B3A', yellow: '#7A5C2A', blue: '#2A5080', magenta: '#6A3878',
  cyan: '#2A6060', white: '#BFBAB2', brightBlack: '#7A7268', brightRed: '#B04030',
  brightGreen: '#3A8A4A', brightYellow: '#9A7838', brightBlue: '#3A6A9A',
  brightMagenta: '#864898', brightCyan: '#3A7A7A', brightWhite: '#F5F0E8',
};

export const TERMINAL_COLOR_PRESETS: TerminalColorPreset[] = [
  { id: 'warm-atelier', label: 'Warm Atelier (Default)', colors: WARM_ATELIER_COLORS },
  { id: 'classic-dark', label: 'Classic Dark', colors: CLASSIC_DARK_COLORS },
  { id: 'light', label: 'Light Terminal', colors: LIGHT_TERMINAL_COLORS },
];

export type CursorStyle = 'block' | 'underline' | 'bar';
export type CursorInactiveStyle = 'outline' | 'block' | 'bar' | 'underline' | 'none';

const DEFAULT_CURSOR_STYLE: CursorStyle = 'block';
const DEFAULT_CURSOR_BLINK = true;
const DEFAULT_CURSOR_INACTIVE_STYLE: CursorInactiveStyle = 'outline';
const DEFAULT_FONT_WEIGHT = 400;
const DEFAULT_FONT_WEIGHT_BOLD = 700;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_LETTER_SPACING = 0;
const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_COLOR_PRESET_ID = 'warm-atelier';
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;
const LINE_HEIGHT_STEP = 0.05;
const LETTER_SPACING_MIN = -2;
const LETTER_SPACING_MAX = 6;

export interface TerminalSettingsState {
  fontId: string;
  fontSize: number;
  fontStack: string;
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorInactiveStyle: CursorInactiveStyle;
  scrollback: number;
  colorPresetId: string;
  colors: TerminalColors;
  setFontId(id: string): void;
  setFontSize(size: number): void;
  setFontWeight(weight: number): void;
  setFontWeightBold(weight: number): void;
  setLineHeight(height: number): void;
  setLetterSpacing(spacing: number): void;
  setCursorStyle(style: CursorStyle): void;
  setCursorBlink(blink: boolean): void;
  setCursorInactiveStyle(style: CursorInactiveStyle): void;
  setScrollback(scrollback: number): void;
  applyColorPreset(presetId: string): void;
  setColor(key: keyof TerminalColors, value: string | undefined): void;
  reset(): void;
}

interface PersistedSettings {
  fontId?: string;
  fontSize?: number;
  fontWeight?: number;
  fontWeightBold?: number;
  lineHeight?: number;
  letterSpacing?: number;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  cursorInactiveStyle?: CursorInactiveStyle;
  scrollback?: number;
  colorPresetId?: string;
  colors?: TerminalColors;
}

function readSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_TERMINAL_SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as PersistedSettings;
  } catch {
    // best effort
  }
  const legacy: PersistedSettings = {};
  try {
    const fontId = localStorage.getItem(STORAGE_TERMINAL_FONT_KEY);
    if (fontId && TERMINAL_FONT_PRESETS.some((preset) => preset.id === fontId)) legacy.fontId = fontId;
    const rawSize = localStorage.getItem(STORAGE_TERMINAL_FONT_SIZE_KEY);
    const size = rawSize ? Number.parseInt(rawSize, 10) : Number.NaN;
    if (Number.isFinite(size) && size >= TERMINAL_FONT_SIZE_MIN && size <= TERMINAL_FONT_SIZE_MAX) {
      legacy.fontSize = size;
    }
  } catch {
    // best effort
  }
  return legacy;
}

function snapshot(state: TerminalSettingsState): PersistedSettings {
  return {
    fontId: state.fontId, fontSize: state.fontSize, fontWeight: state.fontWeight,
    fontWeightBold: state.fontWeightBold, lineHeight: state.lineHeight,
    letterSpacing: state.letterSpacing, cursorStyle: state.cursorStyle,
    cursorBlink: state.cursorBlink, cursorInactiveStyle: state.cursorInactiveStyle,
    scrollback: state.scrollback, colorPresetId: state.colorPresetId, colors: state.colors,
  };
}

function persist(state: TerminalSettingsState): void {
  try {
    localStorage.setItem(STORAGE_TERMINAL_SETTINGS_KEY, JSON.stringify(snapshot(state)));
  } catch {
    // best effort
  }
}

export function buildITheme(colors: TerminalColors, autoBg: string): ITheme {
  const background = colors.background ?? autoBg;
  return {
    background,
    foreground: colors.foreground ?? '#D9D2C4',
    cursor: colors.cursor ?? '#E0A45A',
    cursorAccent: colors.cursorAccent ?? background,
    selectionBackground: colors.selectionBackground ?? 'rgba(224,164,90,0.22)',
    selectionForeground: colors.selectionForeground ?? '#F3EEE2',
    black: colors.black ?? '#322D24', red: colors.red ?? '#CB7059',
    green: colors.green ?? '#74B083', yellow: colors.yellow ?? '#D2A24C',
    blue: colors.blue ?? '#6E9BC4', magenta: colors.magenta ?? '#B98BC0',
    cyan: colors.cyan ?? '#6FB2A8', white: colors.white ?? '#CFC8BA',
    brightBlack: colors.brightBlack ?? '#6B6453', brightRed: colors.brightRed ?? '#DC8B73',
    brightGreen: colors.brightGreen ?? '#8FC79C', brightYellow: colors.brightYellow ?? '#E6B968',
    brightBlue: colors.brightBlue ?? '#88B0D6', brightMagenta: colors.brightMagenta ?? '#CCA0D2',
    brightCyan: colors.brightCyan ?? '#86C4BA', brightWhite: colors.brightWhite ?? '#EFE9DB',
  };
}

const saved = readSettings();
const defaultState = {
  fontId: DEFAULT_TERMINAL_FONT_ID,
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  fontStack: terminalFontStack(DEFAULT_TERMINAL_FONT_ID),
  fontWeight: DEFAULT_FONT_WEIGHT,
  fontWeightBold: DEFAULT_FONT_WEIGHT_BOLD,
  lineHeight: DEFAULT_LINE_HEIGHT,
  letterSpacing: DEFAULT_LETTER_SPACING,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  cursorBlink: DEFAULT_CURSOR_BLINK,
  cursorInactiveStyle: DEFAULT_CURSOR_INACTIVE_STYLE,
  scrollback: DEFAULT_SCROLLBACK,
  colorPresetId: DEFAULT_COLOR_PRESET_ID,
  colors: { ...WARM_ATELIER_COLORS },
};

const fontId = saved.fontId && TERMINAL_FONT_PRESETS.some((preset) => preset.id === saved.fontId)
  ? saved.fontId : DEFAULT_TERMINAL_FONT_ID;
const colorPresetId = saved.colorPresetId ?? DEFAULT_COLOR_PRESET_ID;
const presetColors = (TERMINAL_COLOR_PRESETS.find((preset) => preset.id === colorPresetId)
  ?? TERMINAL_COLOR_PRESETS[0]!).colors;
const initial = {
  ...defaultState,
  ...saved,
  fontId,
  fontStack: terminalFontStack(fontId),
  colorPresetId,
  colors: { ...presetColors, ...(saved.colors ?? {}) },
};

export const useTerminalSettingsStore = create<TerminalSettingsState>((set, get) => {
  const update = (patch: Partial<TerminalSettingsState>) => {
    set(patch);
    persist(get());
  };
  return {
    ...initial,
    setFontId: (id) => update({ fontId: id, fontStack: terminalFontStack(id) }),
    setFontSize: (size) => update({
      fontSize: Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size))),
    }),
    setFontWeight: (fontWeight) => update({ fontWeight }),
    setFontWeightBold: (fontWeightBold) => update({ fontWeightBold }),
    setLineHeight: (height) => {
      const clamped = Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, height));
      update({ lineHeight: Math.round(clamped / LINE_HEIGHT_STEP) * LINE_HEIGHT_STEP });
    },
    setLetterSpacing: (letterSpacing) => update({
      letterSpacing: Math.min(LETTER_SPACING_MAX, Math.max(LETTER_SPACING_MIN, letterSpacing)),
    }),
    setCursorStyle: (cursorStyle) => update({ cursorStyle }),
    setCursorBlink: (cursorBlink) => update({ cursorBlink }),
    setCursorInactiveStyle: (cursorInactiveStyle) => update({ cursorInactiveStyle }),
    setScrollback: (scrollback) => update({
      scrollback: Math.min(100000, Math.max(0, Math.round(scrollback))),
    }),
    applyColorPreset: (nextPresetId) => {
      const preset = TERMINAL_COLOR_PRESETS.find((candidate) => candidate.id === nextPresetId);
      if (preset) update({ colorPresetId: nextPresetId, colors: { ...preset.colors } });
    },
    setColor: (key, value) => update({ colors: { ...get().colors, [key]: value } }),
    reset: () => update({ ...defaultState }),
  };
});
