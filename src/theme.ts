import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const STORAGE_KEY = "gpt-bot-theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

let preference: ThemePreference = readStoredPreference();
let mediaQuery: MediaQueryList | undefined;
let initialized = false;

function canUseDOM(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function getMediaQuery(): MediaQueryList | undefined {
  if (!canUseDOM() || typeof window.matchMedia !== "function") return undefined;
  mediaQuery ??= window.matchMedia(DARK_MEDIA_QUERY);
  return mediaQuery;
}

export function resolveTheme(value: ThemePreference = preference): ResolvedTheme {
  if (value !== "system") return value;
  return getMediaQuery()?.matches ? "dark" : "light";
}

function syncThemeColorMeta(resolved: ResolvedTheme): void {
  if (!canUseDOM()) return;
  const color = resolved === "dark" ? "#000000" : "#f2f2f7";
  for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
    meta.setAttribute("content", color);
  }
}

function applyTheme(): void {
  if (!canUseDOM()) return;

  const resolved = resolveTheme();
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  syncThemeColorMeta(resolved);
}

function notify(): void {
  applyTheme();
  listeners.forEach((listener) => listener());
}

function handleSystemThemeChange(): void {
  if (preference === "system") notify();
}

/**
 * Installs the live system-theme listener and applies the current theme.
 * Safe to call more than once. Calling this before React mounts minimizes flash.
 */
export function initializeTheme(): () => void {
  if (!canUseDOM()) return () => undefined;

  if (!initialized) {
    getMediaQuery()?.addEventListener("change", handleSystemThemeChange);
    initialized = true;
  }
  applyTheme();

  return disposeTheme;
}

export function disposeTheme(): void {
  if (!initialized) return;
  mediaQuery?.removeEventListener("change", handleSystemThemeChange);
  initialized = false;
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(preference);
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference) {
    applyTheme();
    return;
  }

  preference = next;
  if (canUseDOM()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }
  notify();
}

export function cycleThemePreference(): ThemePreference {
  const order: readonly ThemePreference[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(preference) + 1) % order.length];
  setThemePreference(next);
  return next;
}

export function subscribeToTheme(listener: () => void): () => void {
  initializeTheme();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: typeof setThemePreference;
  cyclePreference: typeof cycleThemePreference;
}

const getThemeSnapshot = (): string => `${preference}:${resolveTheme()}`;
const getServerSnapshot = (): string => "system:light";

/** React binding for a theme selector or settings panel. */
export function useTheme(): ThemeState {
  useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getServerSnapshot);

  return {
    preference,
    resolved: resolveTheme(),
    setPreference: setThemePreference,
    cyclePreference: cycleThemePreference,
  };
}
