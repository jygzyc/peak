/**
 * Peak Graph dashboard — a single Lit web component. All markup and styling
 * live in this TypeScript file; dashboard.html is only a bootstrap shell.
 */
import { LitElement, html, css, type TemplateResult } from "lit";
import { api, formatDate, formatBytes, shortId } from "./lib.js";
import { baseStyles, isDark, toggleTheme } from "./tokens.js";
import {
  buildLayout, clearSavedLayouts, curvedPath, edgeEnd, intentColor,
  intentLabel, intentLabelWidth, nodeAnchor, nodeCenter, nodeColors,
  proofChain, refKey, resolveIntentPosition, saveIntentPosition, saveNodePosition,
  splitRefKey, wrap,
  type ArtifactModel, type GraphModel, type LayoutEdge, type LayoutModel,
  type LayoutNode, type Point, type Ref, type ResolvedFact,
} from "./graph.js";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Selection { type: "fact" | "intent" | "hint"; id: string }

const pageStyles = css`
  :host {
    display: block;
    height: 100vh;
    height: 100dvh;
  }
  .shell {
    height: 100vh;
    height: 100dvh;
    display: grid;
    grid-template-columns: 292px minmax(0, 1fr) 332px;
    grid-template-rows: 58px minmax(0, 1fr);
    background: var(--bg);
  }
  /* Top bar --------------------------------------------------------------- */
  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left));
    background: var(--glass);
    backdrop-filter: blur(14px) saturate(1.4);
    border-bottom: 1px solid var(--line);
    z-index: 5;
    animation: peak-bar-in 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-side-in-l { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes peak-side-in-r { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes peak-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes peak-card-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-pop-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 780;
    letter-spacing: -0.02em;
    font-size: 14.5px;
  }
  .logo {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-2));
    box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 38%, transparent);
  }
  .logo svg { width: 19px; }
  .project-heading { min-width: 0; display: flex; align-items: center; gap: 9px; }
  .project-heading strong { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
  .spacer { flex: 1; }
  .toolbar { display: flex; align-items: center; gap: 7px; }
  .theme-toggle { font-size: 13px; }

  /* Sidebar ---------------------------------------------------------------- */
  .sidebar {
    min-height: 0;
    background: var(--panel);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    animation: peak-side-in-l 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .side-head {
    padding: 17px 16px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .eyebrow {
    font-size: 10px;
    color: var(--faint);
    font-weight: 750;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }
  .count-badge {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 10.5px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }
  .project-list { overflow: auto; padding: 2px 10px 16px; }
  .project-card {
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 13px;
    padding: 12px;
    margin: 3px 0;
    color: var(--ink);
    transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .project-card:hover { background: var(--panel-2); }
  .project-card.active {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .project-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .project-card-title .status { flex: none; }
  .project-line {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .project-line.goal { color: var(--muted); }
  .project-line b {
    flex: none;
    font-size: 8.5px;
    font-weight: 780;
    letter-spacing: 0.09em;
    color: var(--accent-ink);
  }
  .project-line.goal b { color: var(--faint); }
  .project-line span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-card p { margin: 7px 0 0; color: var(--muted); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-card.enter { animation: peak-card-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .project-card code {
    display: block;
    margin-top: 7px;
    color: var(--faint);
    font: 10px/1.3 var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 42px 20px;
    text-align: center;
    color: var(--faint);
    font-size: 12.5px;
  }
  .empty strong { display: block; color: var(--ink-2); margin-bottom: 4px; font-size: 14px; }

  /* Workspace --------------------------------------------------------------- */
  .workspace {
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
    background-color: var(--canvas);
    background-image:
      radial-gradient(circle at 18% 14%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 30%),
      radial-gradient(circle at 82% 76%, color-mix(in srgb, var(--accent-2) 8%, transparent), transparent 32%),
      radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size: auto, auto, 22px 22px;
    transition: background-color 0.25s ease;
    animation: peak-fade-in 0.5s ease both;
  }
  .canvas-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--faint);
    text-align: center;
    padding: 24px;
    font-size: 13px;
  }
  .canvas-empty strong { display: block; color: var(--ink-2); font-size: 16px; margin-bottom: 5px; }
  .canvas-empty .mark {
    width: 74px;
    height: 74px;
    margin: 0 auto 14px;
    border-radius: 22px;
    display: grid;
    place-items: center;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    box-shadow: var(--shadow-md);
  }
  .canvas-empty .mark svg { width: 36px; }
  .graph-tools {
    position: absolute;
    left: 14px;
    top: 14px;
    z-index: 3;
    display: flex;
    gap: 6px;
  }
  .graph-tools .btn {
    background: var(--glass);
    backdrop-filter: blur(8px);
    border-radius: 10px;
  }
  .legend {
    position: absolute;
    left: 14px;
    bottom: 14px;
    z-index: 3;
    display: flex;
    gap: 13px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    background: var(--glass);
    backdrop-filter: blur(8px);
    border-radius: 10px;
    color: var(--muted);
    font-size: 10px;
  }
  .legend span { display: flex; align-items: center; gap: 5px; }
  .dot { width: 8px; height: 8px; border-radius: 3px; background: var(--panel); border: 2px solid var(--accent); }
  .dot.external { border-color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 30%, var(--panel)); box-shadow: inset 3px 0 color-mix(in srgb, var(--accent-2) 80%, transparent); }
  .dot.intent {
    width: 18px;
    height: 8px;
    border: 0;
    border-radius: 0;
    background: linear-gradient(90deg, #7c3aed, #2563eb, #0891b2, #059669, #ca8a04, #ea580c, #e11d48);
    clip-path: polygon(0 35%, 76% 35%, 76% 0, 100% 50%, 76% 100%, 76% 65%, 0 65%);
    opacity: 0.85;
  }
  .dot.hint { border-color: #e9a23b; background: var(--amber-soft); }
  #viewport { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; overscroll-behavior: none; }
  #viewport.dragging { cursor: grabbing; }
  #graph { width: 100%; height: 100%; display: block; }

  /* Graph inside the SVG ------------------------------------------------------ */
  .layout-label { font: 750 10px Inter, system-ui, sans-serif; letter-spacing: 0.14em; fill: var(--faint); }
  .layout-rule { stroke: var(--line); stroke-width: 1; stroke-dasharray: 4 7; }
  .graph-node { cursor: grab; touch-action: none; user-select: none; transition: opacity 0.22s ease, filter 0.22s ease; }
  .graph-node.dragging { cursor: grabbing; }
  .graph-node.context-dimmed { opacity: 0.16; filter: blur(1.7px) saturate(0.45); }
  .graph-node rect {
    filter: drop-shadow(0 5px 8px color-mix(in srgb, var(--ink) 9%, transparent));
    transition: stroke-width 0.15s, filter 0.15s;
  }
  .graph-node:hover rect,
  .graph-node.selected rect {
    stroke-width: 3;
    filter: drop-shadow(0 8px 12px color-mix(in srgb, var(--ink) 16%, transparent));
  }
  /* Selected Intent endpoints (from/to) glow in that Intent's own color. */
  .graph-node.intent-endpoint rect {
    stroke: var(--endpoint-color, var(--accent));
    stroke-width: 3;
    filter: drop-shadow(0 0 9px color-mix(in srgb, var(--endpoint-color, var(--accent)) 48%, transparent));
  }
  /* Facts inside the selected Fact's proof chain. */
  .graph-node.chain-focus rect {
    stroke-width: 3;
    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--ink) 24%, transparent));
  }
  .node-id { font: 700 11px var(--mono); letter-spacing: 0.03em; }
  .node-type { font: 750 9px Inter, system-ui, sans-serif; letter-spacing: 0.11em; }
  .node-text { font: 12px Inter, system-ui, sans-serif; fill: var(--ink-2); }
  .intent-edge { transition: opacity 0.2s ease, filter 0.2s ease; }
  .intent-edge.context-dimmed { opacity: 0.1; filter: blur(1.2px); }
  .edge-casing, .edge, .edge-hit { vector-effect: non-scaling-stroke; }
  .edge-casing {
    fill: none;
    stroke: var(--canvas);
    stroke-width: calc(9px * var(--edge-scale, 1));
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .edge {
    fill: none;
    stroke: var(--edge-color);
    stroke-width: calc(2.6px * var(--edge-scale, 1));
    stroke-linecap: round;
    stroke-linejoin: round;
    marker-end: url(#arrow);
    filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--edge-color) 22%, transparent));
    transition: stroke-width 0.16s, filter 0.16s;
  }
  .intent-edge:hover .edge {
    stroke-width: calc(3.4px * var(--edge-scale, 1));
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 46%, transparent));
  }
  .edge.branch { marker-end: none; stroke: color-mix(in srgb, var(--edge-color) 76%, #94a3b8); }
  /* Open Intents drift slowly: still waiting to be picked up. */
  .edge.open {
    stroke: var(--edge-color);
    stroke-dasharray: 8 6;
    marker-end: url(#arrow);
    opacity: 0.84;
    animation: peak-open-dash 2.6s linear infinite;
  }
  .edge.open.branch { marker-end: none; }
  /* Open Intents with a pinned custom execution profile: still open, but the
   * profile is fixed at creation — a calmer drift than a plain open Intent. */
  .edge.profiled {
    stroke: var(--edge-color);
    stroke-width: calc(3.4px * var(--edge-scale, 1));
    stroke-dasharray: 10 7;
    marker-end: url(#arrow);
    opacity: 1;
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 46%, transparent));
    animation: peak-run-dash 1.4s linear infinite, peak-run-glow 1.8s ease-in-out infinite alternate;
  }
  /* Concluded Intents settle once with a brief glow, then rest solid. */
  .intent-edge.enter .edge:not(.open):not(.profiled) {
    animation: peak-edge-settle 0.9s ease-out;
  }
  /* Chain spotlight: edges inside the selected Fact's proof chain. */
  .intent-edge.chain-focus .edge {
    stroke-width: calc(4px * var(--edge-scale, 1));
    opacity: 1;
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--edge-color) 58%, transparent));
  }
  .intent-edge.chain-focus .edge.open, .intent-edge.chain-focus .edge.profiled { animation-duration: 1.3s; }
  .edge.selected {
    stroke: var(--edge-color);
    stroke-width: calc(4.25px * var(--edge-scale, 1));
    marker-end: url(#arrow);
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--edge-color) 55%, transparent));
  }
  .edge.selected.branch { marker-end: none; }
  .intent-edge.dragging .edge { stroke-width: calc(4.25px * var(--edge-scale, 1)); }
  .edge-junction {
    fill: var(--panel);
    stroke: var(--edge-color);
    stroke-width: 2.4;
    filter: drop-shadow(0 1px 2px color-mix(in srgb, var(--edge-color) 30%, transparent));
  }
  .edge-junction.selected { stroke: var(--edge-color); stroke-width: 3.5; }
  .open-terminal { fill: color-mix(in srgb, var(--edge-color) 12%, var(--panel)); stroke: var(--edge-color); stroke-width: 2.8; }
  /* Waiting open terminal breathes slowly. */
  .open-terminal:not(.profiled) { animation: peak-open-pulse 2.6s ease-in-out infinite; }
  .open-terminal.profiled {
    fill: color-mix(in srgb, var(--edge-color) 18%, var(--panel));
    stroke: var(--edge-color);
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--edge-color) 50%, transparent));
  }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 18; cursor: pointer; }
  .intent-label { cursor: grab; touch-action: none; user-select: none; }
  .intent-label.dragging { cursor: grabbing; }
  .intent-label rect {
    fill: color-mix(in srgb, var(--edge-color) 7%, var(--panel));
    stroke: color-mix(in srgb, var(--edge-color) 58%, var(--line));
    stroke-width: 1.15;
    filter: drop-shadow(0 3px 6px color-mix(in srgb, var(--ink) 12%, transparent));
  }
  .intent-label text {
    font: 780 9px var(--mono);
    letter-spacing: 0.04em;
    fill: color-mix(in srgb, var(--edge-color) 84%, var(--ink));
  }
  .intent-label.open rect {
    fill: color-mix(in srgb, var(--edge-color) 8%, var(--panel));
    stroke: var(--edge-color);
    stroke-dasharray: 3 2;
  }
  .intent-label.open text { fill: var(--edge-color); }
  .intent-label.profiled rect { fill: color-mix(in srgb, var(--edge-color) 13%, var(--panel)); stroke: var(--edge-color); }
  .intent-label.profiled text { fill: var(--edge-color); }
  .intent-label.selected rect {
    fill: color-mix(in srgb, var(--edge-color) 16%, var(--panel));
    stroke: var(--edge-color);
    stroke-width: 2.2;
  }
  .intent-label.selected text { fill: color-mix(in srgb, var(--edge-color) 88%, var(--ink)); }
  .intent-label.profiled rect { animation: peak-run-pulse 1.8s ease-in-out infinite alternate; }
  .open-terminal.profiled { animation: peak-run-pulse 1.8s ease-in-out infinite alternate; }

  @keyframes peak-run-dash { to { stroke-dashoffset: -38; } }
  @keyframes peak-open-dash { to { stroke-dashoffset: -28; } }
  @keyframes peak-open-pulse {
    0%, 100% { opacity: 0.5; filter: none; }
    50% { opacity: 1; filter: drop-shadow(0 0 4px color-mix(in srgb, var(--edge-color) 45%, transparent)); }
  }
  @keyframes peak-edge-settle {
    0% { opacity: 0; filter: drop-shadow(0 0 9px color-mix(in srgb, var(--edge-color) 68%, transparent)); }
    45% { opacity: 1; filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 55%, transparent)); }
    100% { opacity: 1; filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--edge-color) 22%, transparent)); }
  }
  @keyframes peak-run-glow {
    from { filter: drop-shadow(0 0 2px color-mix(in srgb, var(--edge-color) 42%, transparent)); }
    to { filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 76%, transparent)); }
  }
  @keyframes peak-run-pulse {
    from { filter: drop-shadow(0 0 1px color-mix(in srgb, var(--edge-color) 35%, transparent)); }
    to { filter: drop-shadow(0 0 7px color-mix(in srgb, var(--edge-color) 72%, transparent)); }
  }
  @keyframes peak-node-enter { from { opacity: 0; } to { opacity: 1; } }
  @keyframes peak-node-flash {
    0% { stroke-width: 3.5; filter: drop-shadow(0 0 9px color-mix(in srgb, var(--accent) 45%, transparent)); }
    100% { filter: drop-shadow(0 5px 8px color-mix(in srgb, var(--ink) 9%, transparent)); }
  }
  .graph-node.enter { animation: peak-node-enter 0.55s ease both; }
  .graph-node.enter rect { animation: peak-node-flash 1.4s ease-out; }
  .intent-edge.enter { animation: peak-node-enter 0.55s ease both; }

  /* Inspector ---------------------------------------------------------------- */
  .inspector {
    min-height: 0;
    background: var(--panel);
    border-left: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    animation: peak-side-in-r 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line); }
  .tab {
    border: 0;
    background: transparent;
    padding: 13px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 700;
    border-bottom: 2px solid transparent;
    transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  }
  .tab:hover { color: var(--muted); background: var(--panel-2); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab .count {
    display: inline-grid;
    place-items: center;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    margin-left: 4px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--line-2);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }
  .tab.active .count { background: var(--accent-soft); border-color: var(--accent-line); }
  .panel { min-height: 0; overflow: auto; padding: 16px; }
  .placeholder {
    padding: 34px 13px;
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: 13px;
    color: var(--faint);
    font-size: 12.5px;
  }
  .detail-card {
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
    background: var(--panel);
    box-shadow: var(--shadow-sm);
    animation: peak-card-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .detail-head code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-head {
    padding: 11px 13px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--line-2);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .detail-head code { font: 750 11px var(--mono); color: var(--accent-ink); }
  .detail-body { padding: 14px; }
  .detail-body p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); font-size: 13px; }
  .meta { margin: 14px 0 0; padding: 12px 0 0; border-top: 1px solid var(--line-2); display: grid; gap: 8px; }
  .meta div { display: grid; grid-template-columns: 76px 1fr; gap: 8px; font-size: 11px; }
  .meta dt { color: var(--faint); }
  .meta dd { margin: 0; color: var(--muted); text-align: right; overflow-wrap: anywhere; }
  .meta dd.path { font: 10px/1.45 var(--mono); text-align: left; color: var(--accent-ink); word-break: break-all; }
  .artifact {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    color: var(--accent);
    text-decoration: none;
    font-size: 12px;
    font-weight: 650;
  }
  .artifact:hover { text-decoration: underline; }

  /* Hints --------------------------------------------------------------------- */
  .hint-compose {
    border: 1px solid color-mix(in srgb, var(--amber) 28%, var(--line));
    border-radius: 14px;
    padding: 13px;
    background: var(--amber-soft);
  }
  .hint-compose label { display: block; margin-bottom: 6px; font-size: 11px; font-weight: 720; color: var(--amber); }
  .hint-compose textarea, .hint-compose input {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--panel);
    color: var(--ink);
    padding: 9px 10px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .hint-compose textarea { min-height: 90px; resize: vertical; }
  .hint-compose textarea:focus, .hint-compose input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .compose-foot { display: flex; align-items: end; gap: 8px; margin-top: 8px; }
  .compose-foot .actor { flex: 1; }
  .hint-list { display: grid; gap: 9px; margin-top: 13px; }
  .hint-card {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    padding: 11px;
    text-align: left;
    width: 100%;
    color: var(--ink);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
  }
  .hint-card:hover { background: var(--panel-2); border-color: var(--faint); }
  .hint-card.selected {
    border-color: var(--amber);
    background: var(--amber-soft);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--amber) 16%, transparent);
  }
  .hint-card p { margin: 7px 0 0; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
  .hint-meta { display: flex; justify-content: space-between; gap: 7px; color: var(--amber); font-size: 10px; font-weight: 650; }
  .hint-meta strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint-meta span { flex: none; }
  .hint-card.enter { animation: peak-card-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both; }

  /* Toast ----------------------------------------------------------------------- */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%) translateY(0);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 15px;
    background: var(--ink);
    color: var(--bg);
    border-radius: 11px;
    box-shadow: var(--shadow-lg);
    font-size: 12.5px;
    animation: peak-toast-in 0.25s ease;
    max-width: min(480px, 86vw);
  }
  .toast::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--teal);
    flex: none;
  }
  .toast.error::before { background: var(--rose); }
  .toast.leaving { opacity: 0; transform: translateX(-50%) translateY(8px); transition: opacity 0.3s ease, transform 0.3s ease; }
  @keyframes peak-toast-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

  .mobile-projects { display: none; }
  /* Tablet landscape: narrower side rails, keep the three-pane layout. */
  @media (max-width: 1050px) {
    .shell { grid-template-columns: 248px minmax(0, 1fr) 300px; }
    .project-heading strong { max-width: 26vw; }
  }
  /* Tablet portrait / small: stack panes; project switcher moves into the topbar. */
  @media (max-width: 820px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: 58px minmax(0, 1fr) clamp(230px, 36dvh, 320px);
    }
    .sidebar { display: none; }
    .workspace { grid-column: 1; }
    .inspector { grid-column: 1; border-left: 0; border-top: 1px solid var(--line); }
    .mobile-projects {
      display: block;
      max-width: 42vw;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 6px;
    }
    .brand span { display: none; }
    .toolbar .label { display: none; }
    .legend { display: none; }
    .topbar { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    .graph-tools { top: 10px; left: 10px; }
    .tab { padding: 12px 8px; }
    .panel { padding: 12px; }
  }
  /* Phones: tighten chrome further, drop secondary actions, maximize canvas. */
  @media (max-width: 560px) {
    .shell { grid-template-rows: 54px minmax(0, 1fr) clamp(220px, 34dvh, 300px); }
    .topbar { gap: 6px; padding-right: 8px; }
    .project-heading { display: none; }
    .mobile-projects { max-width: 52vw; font-size: 12px; padding: 5px; }
    .toolbar { gap: 5px; }
    .toolbar #export { display: none; }
    .status { padding: 2px 7px; font-size: 9px; }
    .canvas-empty { font-size: 12px; padding: 16px; }
    .toast {
      left: 12px;
      right: 12px;
      bottom: 12px;
      max-width: none;
      transform: translateY(0);
    }
    .toast.leaving { transform: translateY(8px); }
    @keyframes peak-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  }
  /* Coarse pointers: bigger touch targets on the canvas and lists. */
  @media (pointer: coarse) {
    .edge-hit { stroke-width: 24px; }
    .tab { min-height: 44px; }
    .hint-card { padding: 13px 12px; }
    .project-card { padding: 14px 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .topbar, .sidebar, .inspector, .workspace, .project-card.enter, .hint-card.enter, .detail-card,
    .graph-node.enter, .graph-node.enter rect, .intent-edge.enter, .intent-edge.enter .edge,
    .intent-label.profiled rect, .open-terminal, .edge.profiled, .edge.open { animation: none !important; }
  }
`;

export class PeakDashboard extends LitElement {
  static styles = [baseStyles, pageStyles];

  private projects: GraphModel["project"][] = [];
  private graph: GraphModel | null = null;
  private resolved = new Map<string, ResolvedFact>();
  private projectId: string | null = null;
  private selected: Selection | null = null;
  private chainFocus: { nodes: Set<string>; edges: Set<string> } | null = null;
  private summaries = new Map<string, { source: string; goal: string }>();
  private summaryRequested = new Set<string>();
  private listAnimated = false;
  private seenHints = new Set<string>();
  private edgeUpdaters = new Map<string, () => void>();
  private dragRaf = 0;
  private pendingEdgeUpdates: LayoutEdge[] = [];
  private signature = "";
  private camera = { x: 0, y: 0, k: 1 };
  private bounds = { x: 0, y: 0, width: 1, height: 1 };
  private layout: LayoutModel | null = null;
  private layers: { guides: SVGGElement; edges: SVGGElement; nodes: SVGGElement } | null = null;
  private suppressNodeClick: string | null = null;
  private suppressIntentClick: string | null = null;
  private fittedProject: string | null = null;
  private refreshing = false;
  private knownNodes: Set<string> | null = null;
  private knownEdges: Set<string> | null = null;
  private enterNodes = new Set<string>();
  private enterEdges = new Set<string>();
  private pollTimer: number | null = null;
  private toastTimer: number | null = null;

  // Cached element references inside the shadow root.
  private el!: {
    list: HTMLElement; count: HTMLElement; mobile: HTMLSelectElement;
    heading: HTMLElement; title: HTMLElement; status: HTMLElement;
    statusAction: HTMLButtonElement; exportBtn: HTMLButtonElement; exportLabel: HTMLElement;
    empty: HTMLElement; viewport: HTMLElement; scene: SVGGElement; legend: HTMLElement;
    detail: HTMLElement; hints: HTMLElement; hintCount: HTMLElement; hintList: HTMLElement;
    hintForm: HTMLFormElement; content: HTMLTextAreaElement; creator: HTMLInputElement;
    toast: HTMLElement;
  };

  override render(): TemplateResult {
    return html`
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <span class="logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m4 18 5-7 3 4 3-6 5 9"/><path d="M4 20h16"/>
              </svg>
            </span>
            <span>Peak Graph</span>
          </div>
          <select id="mobile-projects" class="mobile-projects" aria-label="Source"></select>
          <div id="project-heading" class="project-heading hidden">
            <strong id="project-title"></strong><span id="project-status" class="status"></span>
          </div>
          <div class="spacer"></div>
          <div class="toolbar">
            <button class="btn icon-btn theme-toggle" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
            <a class="btn" href="/tasks.html" title="Task management">Tasks</a>
            <button id="export" class="btn hidden"><span class="label" id="export-label">Snapshot</span></button>
            <button id="status-action" class="btn warn hidden"></button>
            <button id="refresh" class="btn icon-btn" title="Refresh" aria-label="Refresh">↻</button>
          </div>
        </header>

        <aside class="sidebar">
          <div class="side-head"><span class="eyebrow">Sources</span><span id="project-count" class="count-badge">0</span></div>
          <div id="project-list" class="project-list"></div>
        </aside>

        <main class="workspace">
          <div class="graph-tools">
            <button id="fit" class="btn icon-btn" title="Fit graph" aria-label="Fit graph">⌗</button>
            <button id="arrange" class="btn icon-btn" title="Reset node layout" aria-label="Reset node layout">↦</button>
          </div>
          <div id="canvas-empty" class="canvas-empty">
            <div>
              <div class="mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m3 18 5-7 3 4 3-6 5 9"/><path d="M3 20h18"/>
                </svg>
              </div>
              <strong>Select a Source</strong>Choose a source to inspect its proof graph.
            </div>
          </div>
          <div id="viewport" class="hidden">
            <svg id="graph" role="img" aria-label="Balanced proof DAG, with Facts connected by directed Intent edges">
              <defs>
                <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 z" fill="context-stroke"/>
                </marker>
              </defs>
              <g id="scene"></g>
            </svg>
          </div>
          <div id="legend" class="legend hidden">
            <span><i class="dot"></i>Fact</span>
            <span><i class="dot external"></i>External Fact</span>
            <span><i class="dot intent"></i>Intent · unique color</span>
            <span><i class="dot hint"></i>Hint</span>
          </div>
        </main>

        <aside class="inspector">
          <div class="tabs">
            <button class="tab active" data-tab="detail">Detail</button>
            <button class="tab" data-tab="hints">Hints <span id="hint-count" class="count">0</span></button>
          </div>
          <div id="detail-panel" class="panel"></div>
          <div id="hints-panel" class="panel hidden">
            <form id="hint-form" class="hint-compose">
              <label for="hint-content">Add guidance to this Source project</label>
              <textarea id="hint-content" maxlength="1024" required placeholder="What should the runtime reconsider, verify, or prioritize?"></textarea>
              <div class="compose-foot">
                <div class="actor">
                  <label for="hint-creator">Creator</label>
                  <input id="hint-creator" maxlength="120" value="human:web" required>
                </div>
                <button class="btn primary" type="submit">Add Hint</button>
              </div>
            </form>
            <div id="hint-list" class="hint-list"></div>
          </div>
        </aside>
      </div>
      <div id="toast" class="toast hidden" role="status"></div>
    `;
  }

  override firstUpdated(): void {
    const root = this.shadowRoot!;
    const $ = <T extends Element>(selector: string): T => root.querySelector(selector) as T;
    this.el = {
      list: $("#project-list"), count: $("#project-count"), mobile: $("#mobile-projects"),
      heading: $("#project-heading"), title: $("#project-title"), status: $("#project-status"),
      statusAction: $("#status-action"), exportBtn: $("#export"), exportLabel: $("#export-label"),
      empty: $("#canvas-empty"), viewport: $("#viewport"), scene: $("#scene"), legend: $("#legend"),
      detail: $("#detail-panel"), hints: $("#hints-panel"), hintCount: $("#hint-count"),
      hintList: $("#hint-list"), hintForm: $("#hint-form"), content: $("#hint-content"),
      creator: $("#hint-creator"), toast: $("#toast"),
    };

    this.el.creator.value = localStorage.getItem("peak-hint-creator") ?? "human:web";
    root.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
      button.onclick = () => this.setTab(button.dataset.tab ?? "detail");
    });
    this.el.hintForm.onsubmit = (event) => { void this.submitHint(event); };
    this.el.statusAction.onclick = () => { void this.changeStatus(); };
    this.el.exportBtn.onclick = () => { void this.exportSnapshot(); };
    $<HTMLButtonElement>("#fit").onclick = () => this.fitGraph();
    $<HTMLButtonElement>("#arrange").onclick = () => this.resetNodeLayout();
    $<HTMLButtonElement>("#refresh").onclick = () => { void this.refresh(true); };
    $<HTMLButtonElement>("#theme").onclick = () => { toggleTheme(); this.renderGraph(); };
    this.el.mobile.onchange = () => { if (this.el.mobile.value) void this.selectProject(this.el.mobile.value); };

    window.addEventListener("hashchange", () => {
      const id = location.hash.slice(1);
      if (id && id !== this.projectId) void this.selectProject(id);
    });
    window.addEventListener("resize", () => {
      if (this.graph && this.fittedProject !== this.projectId) this.fitGraph();
    });
    this.setupPanZoom();

    const initial = location.hash.slice(1);
    if (initial) this.projectId = initial;
    void this.refresh(true);
    this.pollTimer = window.setInterval(() => {
      if (!document.hidden) void this.refresh(false);
    }, 2500);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
  }

  /* Data ------------------------------------------------------------------ */
  private async refresh(manual = false): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const projects = await api<GraphModel["project"][]>("/api/projects");
      this.projects = projects;
      this.renderProjectList();
      this.ensureSummaries(projects);
      if (this.projectId && !projects.some((p) => p.id === this.projectId)) {
        this.projectId = null;
        this.graph = null;
        history.replaceState(null, "", location.pathname);
        this.renderEmpty();
      }
      if (this.projectId) await this.loadGraph(manual);
      else if (projects.length === 1) await this.selectProject(projects[0].id);
    } catch (error) {
      this.notify((error as Error).message, true);
    } finally {
      this.refreshing = false;
    }
  }

  private renderProjectList(): void {
    const { el } = this;
    el.count.textContent = String(this.projects.length);
    el.list.replaceChildren();
    el.mobile.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Select source";
    el.mobile.append(option);
    if (!this.projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = "<strong>No Sources</strong>Project sources created by Peak will appear here.";
      el.list.append(empty);
      return;
    }
    const animate = !this.listAnimated;
    this.listAnimated = true;
    this.projects.forEach((project, index) => {
      const summary = this.summaries.get(project.id);
      const source = summary?.source ?? project.title;
      const goal = summary?.goal ?? "";
      const button = document.createElement("button");
      button.className = `project-card${project.id === this.projectId ? " active" : ""}${animate ? " enter" : ""}`;
      if (animate) button.style.animationDelay = `${Math.min(index, 8) * 45}ms`;
      button.type = "button";
      button.title = project.title;
      const row = document.createElement("div");
      row.className = "project-card-title";
      const badge = document.createElement("span");
      badge.className = `status ${project.status}`;
      badge.textContent = project.status;
      row.append(badge);
      const sourceLine = document.createElement("div");
      sourceLine.className = "project-line";
      const sourceTag = document.createElement("b");
      sourceTag.textContent = "SRC";
      const sourceText = document.createElement("span");
      sourceText.textContent = source;
      sourceLine.append(sourceTag, sourceText);
      const goalLine = document.createElement("div");
      goalLine.className = "project-line goal";
      const goalTag = document.createElement("b");
      goalTag.textContent = "GOAL";
      const goalText = document.createElement("span");
      goalText.textContent = goal || "—";
      goalLine.append(goalTag, goalText);
      const date = document.createElement("p");
      date.textContent = `Created ${formatDate(project.createdAt)}`;
      const id = document.createElement("code");
      id.textContent = project.id;
      button.append(row, sourceLine, goalLine, date, id);
      button.onclick = () => { void this.selectProject(project.id); };
      el.list.append(button);
      const item = document.createElement("option");
      item.value = project.id;
      item.textContent = `${source} · ${project.status}`;
      item.selected = project.id === this.projectId;
      el.mobile.append(item);
    });
  }

  /** Lazily fetch each Project's origin (source) and goal Facts once; they
   *  are fixed at creation, so the cache survives polling. */
  private ensureSummaries(projects: GraphModel["project"][]): void {
    const missing = projects.filter((project) => !this.summaries.has(project.id) && !this.summaryRequested.has(project.id));
    if (!missing.length) return;
    for (const project of missing) this.summaryRequested.add(project.id);
    void Promise.all(missing.map(async (project) => {
      let summary = { source: project.title, goal: "" };
      try {
        const graph = await api<GraphModel>(`/api/projects/${encodeURIComponent(project.id)}`);
        summary = {
          source: graph.facts.find((fact) => fact.id === "origin")?.description ?? project.title,
          goal: graph.facts.find((fact) => fact.id === "goal")?.description ?? "",
        };
      } catch { /* fall back to the Project title */ }
      this.summaries.set(project.id, summary);
    })).then(() => this.renderProjectList());
  }

  private async selectProject(id: string): Promise<void> {
    this.projectId = id;
    this.selected = null;
    this.chainFocus = null;
    this.signature = "";
    this.fittedProject = null;
    this.knownNodes = null;
    this.knownEdges = null;
    this.seenHints = new Set();
    location.hash = id;
    this.renderProjectList();
    await this.loadGraph(true);
  }

  private async loadGraph(force = false): Promise<void> {
    if (!this.projectId) return;
    const graph = await api<GraphModel>(`/api/projects/${encodeURIComponent(this.projectId)}`);
    const signature = JSON.stringify(graph);
    const refs = new Set<string>();
    const refList: { projectId: string; id: string; description: string }[] = [];
    for (const intent of graph.intents) {
      for (const ref of intent.from) {
        if (ref.projectId === this.projectId) continue;
        const key = refKey(ref);
        if (!refs.has(key)) {
          refs.add(key);
          refList.push(ref);
        }
      }
    }
    this.resolved = new Map();
    if (refList.length) {
      try {
        const values = await api<{ ref: Ref; fact: ResolvedFact }[]>(
          "/api/fact-refs/resolve",
          { method: "POST", body: { targetProjectId: this.projectId, refs: refList } },
        );
        for (const value of values) this.resolved.set(refKey(value.ref), value.fact);
      } catch { /* resolution is best-effort */ }
    }
    const changed = signature !== this.signature;
    this.graph = graph;
    this.signature = signature;
    if (!this.summaries.has(graph.project.id)) {
      this.summaries.set(graph.project.id, {
        source: graph.facts.find((fact) => fact.id === "origin")?.description ?? graph.project.title,
        goal: graph.facts.find((fact) => fact.id === "goal")?.description ?? "",
      });
      this.renderProjectList();
    }
    this.renderHeader();
    this.renderHints();
    if (changed || force) {
      this.renderGraph();
      this.renderDetail();
    }
  }

  /* Header + sidebar ------------------------------------------------------- */
  private renderHeader(): void {
    const graph = this.graph;
    const { el } = this;
    if (!graph) {
      this.renderEmpty();
      return;
    }
    el.heading.classList.remove("hidden");
    el.exportBtn.classList.remove("hidden");
    el.statusAction.classList.remove("hidden");
    el.title.textContent = graph.project.title;
    el.status.className = `status ${graph.project.status}`;
    el.status.textContent = graph.project.status;
    el.exportLabel.textContent = graph.project.status === "completed" ? "Archive" : "Snapshot";
    if (graph.project.status === "completed") {
      el.statusAction.textContent = "Reopen";
      el.statusAction.className = "btn primary";
    } else {
      el.statusAction.textContent = graph.project.status === "active" ? "Stop" : "Resume";
      el.statusAction.className = graph.project.status === "active" ? "btn warn" : "btn primary";
    }
    el.empty.classList.add("hidden");
    el.viewport.classList.remove("hidden");
    el.legend.classList.remove("hidden");
    el.hintCount.textContent = String(graph.hints.length);
    const submit = el.hintForm.querySelector("button") as HTMLButtonElement;
    submit.disabled = false;
  }

  private renderEmpty(): void {
    this.graph = null;
    const { el } = this;
    el.heading.classList.add("hidden");
    el.exportBtn.classList.add("hidden");
    el.statusAction.classList.add("hidden");
    el.viewport.classList.add("hidden");
    el.legend.classList.add("hidden");
    el.empty.classList.remove("hidden");
    el.hintCount.textContent = "0";
    this.renderDetail();
    this.renderHints();
  }

  /* Graph rendering --------------------------------------------------------- */
  private renderGraph(): void {
    const { el } = this;
    if (this.dragRaf) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
      this.pendingEdgeUpdates = [];
    }
    el.scene.replaceChildren();
    if (!this.graph) return;
    if (this.selected?.type === "fact") this.chainFocus = proofChain(this.graph, this.selected.id);
    const model = buildLayout(this.graph, this.resolved);
    this.layout = model;
    this.layers = {
      guides: this.svg("g", {}),
      edges: this.svg("g", { class: "edge-layer" }),
      nodes: this.svg("g", {}),
    };
    el.scene.append(this.layers.guides, this.layers.edges, this.layers.nodes);
    this.updateLayoutBounds();

    const firstRender = !this.knownNodes;
    this.enterNodes = firstRender
      ? new Set()
      : new Set(model.nodes.map((node) => node.key).filter((key) => !this.knownNodes!.has(key)));
    this.enterEdges = firstRender
      ? new Set()
      : new Set(model.edges.map((edge) => edge.id).filter((id) => !this.knownEdges!.has(id)));
    this.knownNodes = new Set(model.nodes.map((node) => node.key));
    this.knownEdges = new Set(model.edges.map((edge) => edge.id));

    this.drawLayoutGuides(model);
    this.redrawEdges();
    for (const node of model.nodes) this.drawNode(node);
    this.enterNodes = new Set();
    this.enterEdges = new Set();

    this.applyCamera();
    if (this.fittedProject !== this.projectId) {
      requestAnimationFrame(() => this.fitGraph());
      this.fittedProject = this.projectId;
    }
  }

  private svg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number>,
  ): SVGElementTagNameMap[K] {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  private drawLayoutGuides(model: LayoutModel): void {
    if (!this.layers) return;
    const layer = this.layers.guides;
    const proof = this.svg("text", { x: model.pad, y: 34, class: "layout-label" });
    proof.textContent = "PROOF DAG  ·  DRAG FACTS AND INTENTS TO REFINE THE LAYOUT";
    layer.append(proof);
    if (model.hintTop !== null) {
      const y = model.hintTop - 55;
      layer.append(this.svg("line", { x1: model.pad, y1: y, x2: model.width - model.pad, y2: y, class: "layout-rule" }));
      const hints = this.svg("text", { x: model.pad, y: y + 25, class: "layout-label" });
      hints.textContent = "HINTS  ·  INDEPENDENT GRAPH INPUTS";
      layer.append(hints);
    }
  }

  private updateLayoutBounds(): void {
    if (!this.layout) return;
    const nodes = this.layout.nodes;
    const points = this.layout.edges.flatMap((edge) => [edgeEnd(edge), edge.handle]);
    const minX = Math.min(0, ...nodes.map((node) => node.x - 55), ...points.map((point) => point.x - 90));
    const minY = Math.min(0, ...nodes.map((node) => node.y - 55), ...points.map((point) => point.y - 45), -10);
    const maxX = Math.max(this.layout.width, ...nodes.map((node) => node.x + node.w + 55), ...points.map((point) => point.x + 90));
    const maxY = Math.max(this.layout.height, ...nodes.map((node) => node.y + node.h + 55), ...points.map((point) => point.y + 45));
    this.bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private redrawEdges(): void {
    if (!this.layers || !this.layout) return;
    this.edgeUpdaters.clear();
    this.layers.edges.replaceChildren();
    const ordered = [...this.layout.edges].sort((a, b) => {
      const span = (edge: LayoutEdge) =>
        Math.abs(edgeEnd(edge).x - Math.min(...edge.sources.map((node) => node.x)));
      return span(b) - span(a);
    });
    for (const edge of ordered) this.drawEdge(edge);
  }

  private drawEdge(edge: LayoutEdge): void {
    if (!this.layers) return;
    let intentLabelEl: SVGGElement | null = null;
    const selected = this.selected?.type === "intent" && this.selected.id === edge.id;
    const chainHit = this.chainFocus?.edges.has(edge.id) ?? false;
    const dimmed = this.chainFocus ? !chainHit : (this.selected?.type === "intent" && !selected);
    const edgeStyle = `--edge-color:${intentColor(edge.id, isDark())}`;
    const layer = this.svg("g", {
      class: `intent-edge${this.enterEdges.has(edge.id) ? " enter" : ""}${selected ? " selected-edge" : ""}${chainHit ? " chain-focus" : dimmed ? " context-dimmed" : ""}`,
      style: edgeStyle,
    });
    this.layers.edges.append(layer);

    // Every drawn part registers an updater so drags recompute geometry in
    // place instead of rebuilding the whole edge layer per pointermove.
    const parts: Array<() => void> = [];
    const addPath = (computeD: () => string, branch = false): void => {
      const classes = `edge${branch ? " branch" : ""}${edge.profiled ? " profiled" : edge.open ? " open" : ""}${selected ? " selected" : ""}`;
      const d = computeD();
      const casing = this.svg("path", { d, class: "edge-casing" });
      const path = this.svg("path", { d, class: classes, style: edgeStyle });
      const hit = this.svg("path", { d, class: "edge-hit" });
      hit.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectItem("intent", edge.id);
      });
      hit.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (intentLabelEl) this.beginIntentDrag(event as PointerEvent, edge, intentLabelEl);
      });
      layer.append(casing, path, hit);
      parts.push(() => {
        const next = computeD();
        casing.setAttribute("d", next);
        path.setAttribute("d", next);
        hit.setAttribute("d", next);
      });
    };

    const sourceCenter = (): Point => {
      const centers = edge.sources.map(nodeCenter);
      return {
        x: centers.reduce((sum, p) => sum + p.x, 0) / centers.length,
        y: centers.reduce((sum, p) => sum + p.y, 0) / centers.length,
      };
    };

    if (edge.sources.length === 1) {
      const source = edge.sources[0]!;
      addPath(() => curvedPath(nodeAnchor(source, edge.handle), edge.handle), Boolean(edge.target));
    } else {
      const junctionOf = (): Point => {
        const center = sourceCenter();
        const dx = edge.handle.x - center.x;
        const dy = edge.handle.y - center.y;
        const length = Math.hypot(dx, dy) || 1;
        return { x: edge.handle.x - (dx / length) * 58, y: edge.handle.y - (dy / length) * 58 };
      };
      for (const sourceNode of edge.sources) {
        addPath(() => {
          const junction = junctionOf();
          return curvedPath(nodeAnchor(sourceNode, junction), junction);
        }, true);
      }
      addPath(() => curvedPath(junctionOf(), edge.handle), Boolean(edge.target));
      const junction = junctionOf();
      const junctionEl = this.svg("circle", {
        cx: junction.x, cy: junction.y, r: 4,
        class: `edge-junction${edge.open ? " open" : ""}${selected ? " selected" : ""}`,
        style: edgeStyle,
      });
      layer.append(junctionEl);
      parts.push(() => {
        const next = junctionOf();
        junctionEl.setAttribute("cx", String(next.x));
        junctionEl.setAttribute("cy", String(next.y));
      });
    }

    if (edge.target) {
      const target = edge.target;
      addPath(() => curvedPath(edge.handle, nodeAnchor(target, edge.handle)));
    } else {
      const terminal = this.svg("circle", {
        cx: edge.handle.x, cy: edge.handle.y, r: 5,
        class: `open-terminal${edge.profiled ? " profiled" : ""}`,
        style: edgeStyle,
      });
      layer.append(terminal);
      parts.push(() => {
        terminal.setAttribute("cx", String(edge.handle.x));
        terminal.setAttribute("cy", String(edge.handle.y));
      });
    }

    const labelWidth = intentLabelWidth(edge);
    const label = this.svg("g", {
      class: `intent-label${edge.profiled ? " profiled" : edge.open ? " open" : ""}${selected ? " selected" : ""}`,
      transform: `translate(${edge.handle.x} ${edge.handle.y})`,
      tabindex: "0",
      role: "button",
      style: edgeStyle,
    });
    const title = this.svg("title", {});
    title.textContent = `Drag to reroute · ${edge.record.description}`;
    const rect = this.svg("rect", { x: -labelWidth / 2, y: -11, width: labelWidth, height: 22, rx: 11 });
    const text = this.svg("text", { x: 0, y: 3, "text-anchor": "middle" });
    text.textContent = intentLabel(edge);
    const hitRect = this.svg("rect", {
      x: -labelWidth / 2 - 7, y: -17, width: labelWidth + 14, height: 34, rx: 17, fill: "transparent",
    });
    label.append(title, hitRect, rect, text);
    intentLabelEl = label;
    label.addEventListener("pointerdown", (event) => this.beginIntentDrag(event as PointerEvent, edge, label));
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.suppressIntentClick === edge.id) return;
      this.selectItem("intent", edge.id);
    });
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        label.dispatchEvent(new MouseEvent("click"));
      }
    });
    layer.append(label);
    parts.push(() => label.setAttribute("transform", `translate(${edge.handle.x} ${edge.handle.y})`));

    this.edgeUpdaters.set(edge.id, () => {
      for (const update of parts) update();
    });
  }

  private drawNode(node: LayoutNode): void {
    if (!this.layers) return;
    const colors = nodeColors(node, isDark());
    const focusClass = this.chainFocus
      ? (this.chainFocus.nodes.has(node.key) ? " chain-focus" : " context-dimmed")
      : this.intentNodeClass(node);
    const endpointColor = focusClass.includes("intent-endpoint") && this.selected?.type === "intent"
      ? intentColor(this.selected.id, isDark())
      : null;
    const group = this.svg("g", {
      class: `graph-node${this.enterNodes.has(node.key) ? " enter" : ""}${this.isSelectedNode(node) ? " selected" : ""}${focusClass}`,
      transform: `translate(${node.x} ${node.y})`,
      tabindex: "0",
      role: "button",
      ...(endpointColor ? { style: `--endpoint-color:${endpointColor}` } : {}),
    });
    const rect = this.svg("rect", {
      width: node.w, height: node.h, rx: 13,
      fill: colors.fill, stroke: colors.stroke, "stroke-width": 2,
    });
    const type = this.svg("text", { x: 14, y: 20, class: "node-type", fill: colors.accent });
    type.textContent = node.type === "hint" ? "HINT"
      : node.type === "external" ? "FACT · EXTERNAL"
      : node.id === "origin" ? "FACT · SOURCE"
      : node.id === "goal" ? "FACT · GOAL"
      : "FACT";
    const id = this.svg("text", { x: node.w - 14, y: 20, class: "node-id", fill: colors.accent, "text-anchor": "end" });
    id.textContent = node.id;
    group.append(rect);
    if (node.type === "external") {
      group.append(this.svg("rect", {
        x: 0, y: 9, width: 7, height: node.h - 18, rx: 3.5, fill: colors.accent, opacity: 0.82,
      }));
    }
    group.append(type, id);
    const lines = wrap(node.description, node.type === "hint" ? 186 : 206, node.type === "hint" ? 2 : 3);
    lines.forEach((line, index) => {
      const text = this.svg("text", { x: 14, y: 44 + index * 16, class: "node-text" });
      text.textContent = line;
      group.append(text);
    });
    group.addEventListener("pointerdown", (event) => this.beginNodeDrag(event as PointerEvent, node, group));
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.suppressNodeClick === node.key) return;
      this.selectItem(node.type === "hint" ? "hint" : "fact", node.key);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        group.dispatchEvent(new MouseEvent("click"));
      }
    });
    this.layers.nodes.append(group);
  }

  private isSelectedNode(node: LayoutNode): boolean {
    if (!this.selected) return false;
    const target = this.selected.type === "fact" ? this.selected.id
      : this.selected.type === "hint" ? `hint:${this.selected.id}` : null;
    return Boolean(target && target === node.key);
  }

  private intentNodeClass(node: LayoutNode): string {
    if (this.selected?.type !== "intent") return "";
    const intent = this.graph?.intents.find((value) => value.id === this.selected!.id);
    if (!intent) return "";
    const endpoint = intent.from.some((ref) => refKey(ref) === node.key)
      || (intent.to !== null && refKey(intent.to) === node.key);
    if (endpoint) return " intent-endpoint";
    if (node.type === "fact" && (node.id === "origin" || node.id === "goal")) return " intent-anchor";
    return " context-dimmed";
  }

  /* Selection + inspector ---------------------------------------------------- */
  private selectItem(type: Selection["type"], id: string): void {
    this.selected = this.selected?.type === type && this.selected.id === id ? null : { type, id };
    this.chainFocus = this.selected?.type === "fact" && this.graph
      ? proofChain(this.graph, this.selected.id)
      : null;
    this.renderGraph();
    this.renderDetail();
    if (type === "hint") this.setTab("hints");
  }

  private clearSelection(): void {
    if (!this.selected) return;
    this.selected = null;
    this.chainFocus = null;
    this.renderGraph();
    this.renderDetail();
  }

  private renderDetail(): void {
    const { el } = this;
    el.detail.replaceChildren();
    if (!this.graph || !this.selected) {
      const placeholder = document.createElement("div");
      placeholder.className = "placeholder";
      placeholder.textContent = "Select a Fact, Intent edge, or Hint.";
      el.detail.append(placeholder);
      return;
    }
    let title = "";
    let description = "";
    const meta: [string, string][] = [];
    let artifact: ArtifactModel | null = null;
    let artifactProjectId = "";
    const { type, id } = this.selected;

    if (type === "intent") {
      const item = this.graph.intents.find((value) => value.id === id);
      if (!item) return;
      title = `Intent ${item.id}`;
      description = item.description;
      meta.push(
        ["Status", item.to ? "concluded" : "open"],
        ["Custom profile", item.customProfile ?? "—"],
        ["Profile digest", item.customProfileDigest ?? "—"],
        ["Hints", item.hintIds?.join(", ") || "—"],
        ["From", item.from.map((ref) => `${shortId(ref.projectId, this.projectId ?? undefined)}/${ref.id}`).join(", ")],
        ["To", item.to ? item.to.id : "—"],
        ["Created by", item.createdBy],
        ["Created", formatDate(item.createdAt)],
        ["Concluded by", item.concludedBy ?? "—"],
        ["Concluded at", item.concludedAt ? formatDate(item.concludedAt) : "—"],
      );
    } else if (type === "hint") {
      const item = this.graph.hints.find((value) => value.id === id);
      if (!item) return;
      title = `Hint ${item.id}`;
      description = item.content;
      meta.push(
        ["Consumed by", item.consumedByIntentId ?? "—"],
        ["Consumed at", item.consumedAt ? formatDate(item.consumedAt) : "—"],
        ["Creator", item.creator],
        ["Created", formatDate(item.createdAt)],
      );
    } else {
      const [projectId, factId] = splitRefKey(id);
      const local = projectId === this.projectId;
      const ref = local ? null
        : this.graph.intents.flatMap((value) => value.from).find((value) => refKey(value) === id);
      const item = local
        ? this.graph.facts.find((value) => value.id === factId)
        : (this.resolved.get(id) ?? ref);
      title = local ? `Fact ${factId}` : `FactRef ${factId}`;
      description = (item as { description?: string } | undefined)?.description ?? "—";
      meta.push(
        ["Project", local ? "current" : projectId],
        ["Fact", factId],
        ["Created", (item as { createdAt?: string } | undefined)?.createdAt ? formatDate((item as { createdAt: string }).createdAt) : "—"],
      );
      const artifactRef = (item as { artifact?: ArtifactModel | null } | undefined)?.artifact;
      if (artifactRef) {
        artifact = artifactRef;
        artifactProjectId = projectId;
        meta.push(
          ["Path", artifact.path ?? artifact.inputPath ?? "—"],
          ["Media type", artifact.mediaType],
          ["Size", formatBytes(artifact.sizeBytes)],
          ["SHA-256", artifact.sha256],
        );
      } else {
        meta.push(["Artifact", "—"]);
      }
    }

    const card = document.createElement("article");
    card.className = "detail-card";
    const head = document.createElement("div");
    head.className = "detail-head";
    const code = document.createElement("code");
    code.textContent = title;
    head.append(code);
    const body = document.createElement("div");
    body.className = "detail-body";
    const p = document.createElement("p");
    p.textContent = description;
    body.append(p);
    const dl = document.createElement("dl");
    dl.className = "meta";
    for (const [key, value] of meta) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.classList.toggle("path", key === "Path");
      dd.textContent = value;
      row.append(dt, dd);
      dl.append(row);
    }
    body.append(dl);
    if (artifact) {
      const params = new URLSearchParams({ project: artifactProjectId, artifact: artifact.sha256 });
      if (artifact.filename) params.set("filename", artifact.filename);
      const link = document.createElement("a");
      link.className = "artifact";
      link.textContent = "Preview artifact ↗";
      link.href = `/preview.html?${params}`;
      body.append(link);
    }
    card.append(head, body);
    el.detail.append(card);
  }

  private renderHints(): void {
    const { el } = this;
    el.hintList.replaceChildren();
    const hints = this.graph?.hints ?? [];
    el.hintForm.classList.toggle("hidden", !this.graph);
    if (!hints.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "placeholder";
      placeholder.textContent = "No hints yet.";
      el.hintList.append(placeholder);
      return;
    }
    for (const hint of [...hints].reverse()) {
      const fresh = !this.seenHints.has(hint.id);
      this.seenHints.add(hint.id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hint-card${fresh ? " enter" : ""}${this.selected?.type === "hint" && this.selected.id === hint.id ? " selected" : ""}`;
      const meta = document.createElement("div");
      meta.className = "hint-meta";
      const creator = document.createElement("strong");
      creator.textContent = hint.creator;
      const date = document.createElement("span");
      date.textContent = formatDate(hint.createdAt);
      meta.append(creator, date);
      const p = document.createElement("p");
      p.textContent = hint.content;
      button.append(meta, p);
      button.onclick = () => this.selectItem("hint", hint.id);
      el.hintList.append(button);
    }
  }

  private setTab(tab: string): void {
    this.shadowRoot!.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    this.el.detail.classList.toggle("hidden", tab !== "detail");
    this.el.hints.classList.toggle("hidden", tab !== "hints");
    if (tab === "hints") this.renderHints();
  }

  /* Actions ------------------------------------------------------------------ */
  private async submitHint(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.graph || !this.projectId) return;
    const content = this.el.content.value.trim();
    const creator = this.el.creator.value.trim();
    if (!content || !creator) return;
    const submit = this.el.hintForm.querySelector("button") as HTMLButtonElement;
    submit.disabled = true;
    try {
      localStorage.setItem("peak-hint-creator", creator);
      const hint = await api<{ id: string }>(`/api/projects/${this.projectId}/hints`, {
        method: "POST", body: { content, creator },
      });
      this.el.content.value = "";
      this.selected = { type: "hint", id: hint.id };
      await this.loadGraph(true);
      this.notify("Hint added to the Project");
    } catch (error) {
      this.notify((error as Error).message, true);
    } finally {
      submit.disabled = false;
    }
  }

  private async changeStatus(): Promise<void> {
    if (!this.graph || !this.projectId) return;
    try {
      const project = this.graph.project;
      if (project.status === "completed") {
        const description = prompt("Describe why this Project should be reopened:");
        if (!description?.trim()) return;
        await api(`/api/projects/${this.projectId}/reopen`, {
          method: "POST",
          body: { description: description.trim(), creator: this.el.creator.value.trim() || "human:web" },
        });
        this.notify("Project reopened");
      } else {
        const status = project.status === "active" ? "stopped" : "active";
        await api(`/api/projects/${this.projectId}/status`, { method: "PUT", body: { status } });
        this.notify(`Project ${status}`);
      }
      await this.refresh(true);
    } catch (error) {
      this.notify((error as Error).message, true);
    }
  }

  private async exportSnapshot(): Promise<void> {
    if (!this.projectId) return;
    try {
      let blob: Blob;
      let filename: string;
      if (this.graph?.project.status === "completed") {
        const response = await fetch(`/api/projects/${this.projectId}/export?format=archive`);
        if (!response.ok) {
          let message = await response.text();
          try { message = (JSON.parse(message) as { error?: string }).error ?? message; } catch { /* raw */ }
          throw new Error(message);
        }
        blob = await response.blob();
        filename = `peak-${this.projectId}.tar.gz`;
      } else {
        const value = await api<unknown>(`/api/projects/${this.projectId}/export?format=json`);
        blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
        filename = `peak-${this.projectId}.json`;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      this.notify((error as Error).message, true);
    }
  }

  /* Camera + interactions ------------------------------------------------------ */
  private fitGraph(): void {
    if (!this.graph) return;
    const box = this.el.viewport.getBoundingClientRect();
    const pad = 55;
    const k = Math.min(1.25, Math.max(
      0.18,
      Math.min((box.width - pad * 2) / this.bounds.width, (box.height - pad * 2) / this.bounds.height),
    ));
    this.camera = {
      k,
      x: (box.width - this.bounds.width * k) / 2 - this.bounds.x * k,
      y: (box.height - this.bounds.height * k) / 2 - this.bounds.y * k,
    };
    this.applyCamera();
  }

  private applyCamera(): void {
    this.el.scene.setAttribute("transform", `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.k})`);
    this.el.scene.style.setProperty("--edge-scale", String(Math.max(0.2, Math.min(1.15, Math.pow(this.camera.k, 0.78)))));
  }

  private setupPanZoom(): void {
    const { el } = this;
    // Multi-touch: one finger pans, two fingers pinch-zoom around the midpoint.
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    let pinch: { k0: number; d0: number; x0: number; y0: number; px: number; py: number } | null = null;

    const startPinch = (): void => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const rect = el.viewport.getBoundingClientRect();
      pinch = {
        k0: this.camera.k,
        d0: Math.max(24, Math.hypot(b.x - a.x, b.y - a.y)),
        x0: this.camera.x,
        y0: this.camera.y,
        px: (a.x + b.x) / 2 - rect.left,
        py: (a.y + b.y) / 2 - rect.top,
      };
    };

    el.viewport.addEventListener("pointerdown", (event) => {
      const target = event.target as Element;
      if (target.closest?.(".graph-node,.edge-hit,.intent-label")) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      el.viewport.setPointerCapture(event.pointerId);
      el.viewport.classList.add("dragging");
      if (pointers.size === 1) {
        drag = { x: event.clientX, y: event.clientY, cx: this.camera.x, cy: this.camera.y, moved: false };
        pinch = null;
      } else if (pointers.size === 2) {
        drag = null;
        startPinch();
      }
    });
    el.viewport.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const d = Math.max(24, Math.hypot(b.x - a.x, b.y - a.y));
        const k = Math.min(2.5, Math.max(0.16, pinch.k0 * (d / pinch.d0)));
        this.camera.k = k;
        this.camera.x = pinch.px - (pinch.px - pinch.x0) * (k / pinch.k0);
        this.camera.y = pinch.py - (pinch.py - pinch.y0) * (k / pinch.k0);
        this.applyCamera();
        return;
      }
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      this.camera.x = drag.cx + dx;
      this.camera.y = drag.cy + dy;
      this.applyCamera();
    });
    const end = (event: PointerEvent, cancelled = false): void => {
      pointers.delete(event.pointerId);
      if (pinch && pointers.size < 2) {
        pinch = null;
        // Keep panning with the finger that remains on the canvas.
        const remaining = [...pointers.values()][0];
        if (remaining && !cancelled) {
          drag = { x: remaining.x, y: remaining.y, cx: this.camera.x, cy: this.camera.y, moved: true };
        } else {
          drag = null;
        }
      }
      if (pointers.size === 0) {
        const clearFocus = !cancelled && Boolean(drag && !drag.moved && this.selected);
        drag = null;
        pinch = null;
        el.viewport.classList.remove("dragging");
        if (clearFocus) this.clearSelection();
      }
    };
    el.viewport.addEventListener("pointerup", (event) => end(event, false));
    el.viewport.addEventListener("pointercancel", (event) => end(event, true));
    el.viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = el.viewport.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const old = this.camera.k;
      const next = Math.min(2.5, Math.max(0.16, old * Math.exp(-event.deltaY * 0.001)));
      this.camera.x = px - (px - this.camera.x) * (next / old);
      this.camera.y = py - (py - this.camera.y) * (next / old);
      this.camera.k = next;
      this.applyCamera();
    }, { passive: false });
  }

  /* Drag rendering: recompute only the touched edges, coalesced per frame. ----- */
  private scheduleEdgeUpdates(edges: LayoutEdge[]): void {
    for (const edge of edges) {
      if (!this.pendingEdgeUpdates.includes(edge)) this.pendingEdgeUpdates.push(edge);
    }
    if (this.dragRaf) return;
    this.dragRaf = requestAnimationFrame(() => this.flushEdgeUpdates());
  }

  private flushEdgeUpdates(): void {
    if (this.dragRaf) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
    const pending = this.pendingEdgeUpdates;
    this.pendingEdgeUpdates = [];
    for (const edge of pending) this.edgeUpdaters.get(edge.id)?.();
  }

  private beginNodeDrag(event: PointerEvent, node: LayoutNode, group: SVGGElement): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    const touched = this.layout?.edges.filter((edge) => edge.sources.includes(node) || edge.target === node) ?? [];
    let moved = false;
    group.setPointerCapture(event.pointerId);
    group.classList.add("dragging");
    const move = (next: PointerEvent): void => {
      const dx = (next.clientX - start.x) / this.camera.k;
      const dy = (next.clientY - start.y) / this.camera.k;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      node.x = start.nodeX + dx;
      node.y = start.nodeY + dy;
      group.setAttribute("transform", `translate(${node.x} ${node.y})`);
      this.scheduleEdgeUpdates(touched);
    };
    const end = (): void => {
      group.classList.remove("dragging");
      group.removeEventListener("pointermove", move);
      group.removeEventListener("pointerup", end);
      group.removeEventListener("pointercancel", end);
      this.flushEdgeUpdates();
      this.updateLayoutBounds();
      if (moved) {
        saveNodePosition(this.projectId!, node);
        this.suppressNodeClick = node.key;
        setTimeout(() => {
          if (this.suppressNodeClick === node.key) this.suppressNodeClick = null;
        }, 120);
      }
    };
    group.addEventListener("pointermove", move);
    group.addEventListener("pointerup", end);
    group.addEventListener("pointercancel", end);
  }

  private beginIntentDrag(event: PointerEvent, edge: LayoutEdge, label: SVGGElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, handleX: edge.handle.x, handleY: edge.handle.y };
    const previous = { ...edge.handle };
    const layer = label.parentElement as SVGGElement | null;
    let moved = false;
    label.classList.add("dragging");
    const move = (next: PointerEvent): void => {
      const dx = (next.clientX - start.x) / this.camera.k;
      const dy = (next.clientY - start.y) / this.camera.k;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      layer?.classList.add("dragging");
      const position = resolveIntentPosition(
        edge, start.handleX + dx, start.handleY + dy,
        this.layout?.nodes ?? [], this.layout?.edges.filter((other) => other !== edge) ?? [],
        previous,
      );
      edge.handle = position;
      previous.x = position.x;
      previous.y = position.y;
      edge.manual = true;
      this.scheduleEdgeUpdates([edge]);
    };
    const end = (): void => {
      label.classList.remove("dragging");
      layer?.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this.flushEdgeUpdates();
      this.updateLayoutBounds();
      if (moved) {
        saveIntentPosition(this.projectId!, edge);
        this.suppressIntentClick = edge.id;
        setTimeout(() => {
          if (this.suppressIntentClick === edge.id) this.suppressIntentClick = null;
        }, 150);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  private resetNodeLayout(): void {
    if (!this.graph || !this.projectId) return;
    clearSavedLayouts(this.projectId);
    this.fittedProject = null;
    this.renderGraph();
    this.notify("Graph layout reset");
  }

  private notify(message: string, error = false): void {
    const { el } = this;
    el.toast.textContent = message;
    el.toast.className = `toast${error ? " error" : ""}`;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.toast.classList.add("leaving");
      window.setTimeout(() => el.toast.classList.add("hidden"), 320);
    }, 2600);
  }
}

customElements.define("peak-dashboard", PeakDashboard);
