/**
 * Peak UI design system — tokens and document-level styles live in
 * TypeScript so the dashboard ships without separate CSS files. The token
 * sheet is injected into <head> once (custom properties must live on the
 * document for shadow DOM to inherit them); component styles stay scoped to
 * each web component.
 */
import { css } from "lit";

export const THEME_KEY = "peak-theme";
const STYLE_ID = "peak-ui-tokens";

/** Document-level tokens + reset. Light by default; `.dark` on <html> flips it. */
const GLOBAL_CSS = `
:root {
  --bg: #f5f6fa;
  --panel: #ffffff;
  --panel-2: #f8f9fd;
  --ink: #161d2e;
  --ink-2: #3b465d;
  --muted: #68738b;
  --faint: #98a2b8;
  --line: #e2e6f0;
  --line-2: #edf0f7;
  --accent: #4f46e5;
  --accent-2: #7c3aed;
  --accent-ink: #4338ca;
  --accent-soft: #eef0ff;
  --accent-line: #cfd4ff;
  --teal: #0d9488;
  --teal-soft: #e4f7f3;
  --amber: #b45309;
  --amber-soft: #fbf0dd;
  --rose: #be123c;
  --rose-soft: #fdebee;
  --canvas: #fafbfe;
  --canvas-dot: #dfe4ef;
  --glass: rgba(255, 255, 255, 0.82);
  --shadow-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --shadow-md: 0 8px 24px rgb(30 41 59 / 0.08);
  --shadow-lg: 0 18px 46px rgb(30 41 59 / 0.15);
  --radius: 12px;
  --radius-lg: 16px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
:root.dark {
  --bg: #0a0d16;
  --panel: #121624;
  --panel-2: #161b2c;
  --ink: #e7eaf3;
  --ink-2: #c3c9da;
  --muted: #8d96ad;
  --faint: #5d667d;
  --line: #232a3e;
  --line-2: #1b2133;
  --accent: #818cf8;
  --accent-2: #a78bfa;
  --accent-ink: #a5b4fc;
  --accent-soft: #1a2038;
  --accent-line: #2e3760;
  --teal: #2dd4bf;
  --teal-soft: #0e2a27;
  --amber: #f0b45c;
  --amber-soft: #2c2113;
  --rose: #fb7185;
  --rose-soft: #2c1218;
  --canvas: #0d1019;
  --canvas-dot: #1b2133;
  --glass: rgba(13, 16, 25, 0.78);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.35);
  --shadow-md: 0 8px 24px rgb(0 0 0 / 0.4);
  --shadow-lg: 0 18px 46px rgb(0 0 0 / 0.55);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.25s ease, color 0.25s ease;
}
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
::selection { background: color-mix(in srgb, var(--accent) 24%, transparent); }

/* Touch: kill double-tap zoom delay + iOS highlight flash on interactive elements. */
button, a, select, [role="button"] {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function applySavedTheme(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = GLOBAL_CSS;
    document.head.append(style);
  }
  const saved = localStorage.getItem(THEME_KEY);
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
}

export function toggleTheme(): void {
  const dark = !isDark();
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
}

/** Shared component styles (shadow-scoped) for every page. */
export const baseStyles = css`
  :host { display: block; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--panel);
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 650;
    color: var(--ink-2);
    text-decoration: none;
    box-shadow: var(--shadow-sm);
    transition: background-color 0.15s ease, border-color 0.15s ease,
      transform 0.12s ease, box-shadow 0.15s ease;
    white-space: nowrap;
  }
  .btn:hover { background: var(--panel-2); border-color: var(--faint); }
  .btn:active { transform: translateY(1px) scale(0.985); }
  .btn.primary {
    color: var(--accent-ink);
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  .btn.primary:hover { border-color: var(--accent); }
  .btn.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 35%, var(--line)); background: var(--amber-soft); }
  .btn.danger { color: var(--rose); border-color: color-mix(in srgb, var(--rose) 32%, var(--line)); background: var(--rose-soft); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
  .icon-btn { width: 32px; height: 32px; padding: 0; justify-content: center; }
  /* Enlarge touch targets on coarse pointers (phones / tablets). */
  @media (pointer: coarse) {
    .btn { min-height: 40px; padding: 9px 14px; }
    .icon-btn { width: 40px; height: 40px; }
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--line-2);
    white-space: nowrap;
  }
  .status::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  .status.active { background: var(--teal-soft); color: var(--teal); border-color: transparent; }
  .status.stopped { background: var(--amber-soft); color: var(--amber); border-color: transparent; }
  .status.completed { background: var(--panel-2); color: var(--faint); }
  .status.active::before,
  .status.running::before {
    animation: peak-pulse 1.6s ease-in-out infinite;
  }
  @keyframes peak-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
    50% { opacity: 0.55; box-shadow: 0 0 0 4px transparent; }
  }

  .message {
    color: var(--muted);
    padding: 26px 18px;
    text-align: center;
    font-size: 12.5px;
  }
  .message strong { display: block; margin-bottom: 5px; color: var(--ink-2); font-size: 15px; font-weight: 680; }
  .message.error { color: var(--rose); }
  .message.error strong { color: var(--rose); }

  .hidden { display: none !important; }
`;
