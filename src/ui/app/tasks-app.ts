/**
 * Peak Tasks page — a single Lit web component; tasks.html is only a shell.
 */
import { LitElement, html, css, type TemplateResult } from "lit";
import { api, esc } from "./lib.js";
import { baseStyles, toggleTheme } from "./tokens.js";

interface TaskProject { id: string; title: string; status: string }
interface Task {
  name: string;
  status: string;
  boardDir: string;
  projects: TaskProject[];
  runtime: { mode: string; container?: string; pid?: number; startedAt?: string } | null;
}
interface TaskList { tasks: Task[] }

const pageStyles = css`
  :host { display: block; min-height: 100vh; min-height: 100dvh; background: var(--bg); }
  .shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: 58px minmax(0, 1fr); }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-panel-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-card-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left));
    background: var(--glass);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 5;
    backdrop-filter: blur(14px) saturate(1.4);
    animation: peak-bar-in 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  header .mark {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-2));
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  header .mark svg { width: 16px; }
  header strong { font-size: 14.5px; letter-spacing: -0.01em; }
  header .meta { min-width: 0; color: var(--muted); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }

  main { padding: 22px; max-width: 1320px; margin: 0 auto; width: 100%; min-height: 0; }
  .workspace { display: grid; grid-template-columns: minmax(320px, 0.92fr) minmax(430px, 1.08fr); gap: 18px; align-items: start; }
  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-md);
    overflow: hidden;
    animation: peak-panel-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .workspace .panel:nth-child(2) { animation-delay: 0.08s; }
  .panel-head { padding: 17px 18px 13px; border-bottom: 1px solid var(--line-2); }
  .panel-head h2 { margin: 0; font-size: 15px; letter-spacing: -0.01em; }
  .panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

  .browser { min-height: calc(100vh - 102px); display: grid; grid-template-rows: auto minmax(150px, 1fr) auto; }
  .task-list { padding: 9px; display: grid; align-content: start; gap: 5px; max-height: calc(100vh - 350px); overflow: auto; }
  .task-option {
    width: 100%;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    padding: 12px;
    text-align: left;
    color: inherit;
    transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .task-option:hover { background: var(--panel-2); }
  .task-option.enter { animation: peak-card-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .task-option.selected {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .task-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .task-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .task-head .badge { flex: none; }
  .task-summary { margin-top: 7px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-summary code {
    font: 10px/1.35 var(--mono);
    display: block;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--faint);
  }
  .badge {
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 10px;
    font-weight: 750;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .badge.running { color: var(--teal); border-color: color-mix(in srgb, var(--teal) 40%, transparent); background: var(--teal-soft); }
  .selection { border-top: 1px solid var(--line-2); padding: 15px 18px; background: var(--panel-2); }
  .selection h3 { margin: 0 0 4px; font-size: 14px; overflow-wrap: anywhere; }
  .selection .swap { animation: peak-card-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .meta { color: var(--muted); font: 11px/1.45 var(--mono); overflow-wrap: anywhere; }
  .projects { display: flex; gap: 6px; flex-wrap: wrap; margin: 11px 0; }
  .projects .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .create-body { padding: 18px; }
  .grid { display: grid; gap: 12px; }
  .grid.two { grid-template-columns: 1fr 1fr; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); font-weight: 650; }
  input, textarea, select {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 9px 11px;
    font: 13px/1.45 var(--mono);
    color: var(--ink);
    background: var(--panel);
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  textarea { min-height: 142px; resize: vertical; }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .form-note { color: var(--faint); font-size: 11px; margin: 0; align-self: center; }

  @media (max-width: 860px) {
    main { padding: 14px; }
    .workspace { grid-template-columns: 1fr; }
    .browser { min-height: auto; }
    .task-list { max-height: 420px; }
    .grid.two { grid-template-columns: 1fr; }
  }
  /* Phones: single-column chrome, roomier touch rows, fewer decorations. */
  @media (max-width: 640px) {
    header { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    header .meta { display: none; }
    header strong { font-size: 13.5px; }
    main { padding: 10px; }
    .workspace { gap: 12px; }
    .panel-head { padding: 13px 14px 10px; }
    .panel-head h2 { font-size: 14px; }
    .task-option { padding: 13px 11px; }
    .task-head strong { font-size: 13px; }
    .selection { padding: 13px 14px; }
    .create-body { padding: 14px; }
    .form-actions { flex-direction: column; }
    .form-actions .btn { width: 100%; }
    .form-note { align-self: stretch; }
    .actions .btn { flex: 1; justify-content: center; }
  }
  @media (pointer: coarse) {
    .task-option { min-height: 52px; }
  }
  @media (prefers-reduced-motion: reduce) {
    header, .panel, .task-option.enter, .selection .swap { animation: none !important; }
  }
`;

export class PeakTasks extends LitElement {
  static styles = [baseStyles, pageStyles];

  private tasks: Task[] = [];
  private selectedName: string | null = null;
  private note = "";
  private listError = "";
  private pollTimer: number | null = null;
  private seenTasks = new Set<string>();
  private selectionShownFor: string | null = null;

  override render(): TemplateResult {
    const task = this.tasks.find((value) => value.name === this.selectedName) ?? null;
    return html`
      <div class="shell">
        <header>
          <span class="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 5h16M4 12h16M4 19h10"/>
            </svg>
          </span>
          <strong>Peak Tasks</strong>
          <span class="meta">${this.note}</span>
          <span class="spacer"></span>
          <button class="btn icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
          <a class="btn" href="/">Graph</a>
          <button class="btn" id="refresh">Refresh</button>
        </header>
        <main>
          <div class="workspace">
            <section class="panel browser" aria-labelledby="existing-title">
              <div class="panel-head"><h2 id="existing-title">Existing tasks</h2><p>Select a task to inspect and control its runtime.</p></div>
              <div id="list" class="task-list">${this.renderTaskList()}</div>
              <div id="selection" class="selection">${task ? this.renderSelection(task) : html`<div class="message">${this.listError ? "Task details unavailable." : "Select a task from the list."}</div>`}</div>
            </section>
            <section class="panel" aria-labelledby="create-title">
              <div class="panel-head"><h2 id="create-title">Create task</h2><p>Define a new board without leaving the task browser.</p></div>
              <div class="create-body">
                <div class="grid two">
                  <label>Task name<input id="name" placeholder="my-board" pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label>
                  <label>Skills (comma-separated, optional)<input id="skills" placeholder="review, security"></label>
                  <label>Execution mode<select id="execution-mode"><option value="local">local</option><option value="docker">docker</option></select></label>
                  <label>Docker network mode (optional)<input id="network-mode" placeholder="bridge or host"></label>
                </div>
                <div class="grid" style="margin-top:12px">
                  <label>Projects (JSON array of {source, goal})<textarea id="projects" spellcheck="false" placeholder='[{"source":"Research inputs","goal":"research result"}]'></textarea></label>
                  <label>Workers (JSON array)<textarea id="workers" spellcheck="false" placeholder='[{"type":"pi","taskTypes":["plan","supervise","execute"],"maxRunning":1,"priority":1,"env":{}}]'></textarea></label>
                </div>
                <div class="form-actions">
                  <p class="form-note" id="form-note"></p>
                  <button id="create" class="btn primary">Create task</button>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    `;
  }

  private renderTaskList(): TemplateResult {
    if (this.listError) {
      return html`<div class="message error">${esc(this.listError)}</div>`;
    }
    if (!this.tasks.length) {
      return html`<div class="message">No managed tasks yet.</div>`;
    }
    return html`
      ${this.tasks.map((task, index) => {
        const fresh = !this.seenTasks.has(task.name);
        this.seenTasks.add(task.name);
        return html`
        <button
          type="button"
          class="task-option${fresh ? " enter" : ""}${task.name === this.selectedName ? " selected" : ""}"
          style=${fresh ? `animation-delay:${Math.min(index, 8) * 45}ms` : ""}
          aria-pressed="${task.name === this.selectedName}"
          @click=${() => this.select(task.name)}
        >
          <div class="task-head"><strong>${esc(task.name)}</strong><span class="badge ${task.status === "running" ? "running" : ""}">${esc(task.status)}</span></div>
          <div class="task-summary">${task.projects.length} project${task.projects.length === 1 ? "" : "s"}<code>${esc(task.boardDir)}</code></div>
        </button>
      `;
      })}
    `;
  }

  private renderSelection(task: Task): TemplateResult {
    const runtime = task.runtime
      ? `${task.runtime.mode}${task.runtime.container ? ` · container ${task.runtime.container}` : task.runtime.pid ? ` · pid ${task.runtime.pid}` : ""} · since ${task.runtime.startedAt ?? "?"}`
      : "not running";
    const swap = this.selectionShownFor !== task.name;
    this.selectionShownFor = task.name;
    return html`
      <div class=${swap ? "swap" : ""}>
      <h3>${esc(task.name)}</h3>
      <div class="meta">${esc(task.boardDir)} · ${esc(runtime)}</div>
      <div class="projects">
        ${task.projects.length
          ? task.projects.map((project) => html`<span class="badge" title=${esc(`${project.title} · ${project.status}`)}>${esc(`${project.title} · ${project.status}`)}</span>`)
          : html`<span class="meta">No projects created yet</span>`}
      </div>
      <div class="actions">
        <a class="btn" href=${task.projects[0] ? `/#${encodeURIComponent(task.projects[0].id)}` : "/"}>Graph view</a>
        <button class="btn" ?disabled=${task.status === "running"} @click=${() => void this.start(task.name)}>Start</button>
        <button class="btn" ?disabled=${task.status !== "running"} @click=${() => void this.act(`${task.name}/stop`, "POST")}>Stop</button>
        <button class="btn danger" @click=${() => void this.removeTask(task.name)}>Delete</button>
      </div>
      </div>
    `;
  }

  override firstUpdated(): void {
    const root = this.shadowRoot!;
    root.querySelector("#theme")!.addEventListener("click", () => toggleTheme());
    root.querySelector("#refresh")!.addEventListener("click", () => { void this.load(); });
    root.querySelector("#create")!.addEventListener("click", () => { void this.create(); });
    void this.load();
    this.pollTimer = window.setInterval(() => {
      if (!document.hidden) void this.load();
    }, 5000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
  }

  private select(name: string): void {
    this.selectedName = name;
    this.requestUpdate();
  }

  private async load(): Promise<void> {
    try {
      const data = await api<TaskList>("/api/tasks");
      this.tasks = data.tasks ?? [];
      if (!this.tasks.some((task) => task.name === this.selectedName)) {
        this.selectedName = this.tasks[0]?.name ?? null;
      }
      this.note = `${this.tasks.length} task${this.tasks.length === 1 ? "" : "s"}`;
      this.listError = "";
    } catch (error) {
      this.listError = (error as Error).message;
    }
    this.requestUpdate();
  }

  private async start(name: string): Promise<void> {
    await this.act(`${name}/start`, "POST");
  }

  private async act(suffix: string, method: string, body?: unknown): Promise<void> {
    try {
      await api(`/api/tasks/${suffix}`, { method, body });
      await this.load();
    } catch (error) {
      this.showFormNote((error as Error).message, true);
    }
  }

  private async removeTask(name: string): Promise<void> {
    if (!confirm(`Stop and delete task "${name}"? Project data is kept by default.`)) return;
    const purge = confirm(`Also permanently delete this task's Project data (UUID directories)? This cannot be undone.`);
    if (purge && !confirm(`Really purge ALL Project data of "${name}"?`)) return;
    await this.act(`${name}${purge ? "?purge=true" : ""}`, "DELETE");
  }

  private async create(): Promise<void> {
    const root = this.shadowRoot!;
    const $ = <T extends Element>(selector: string): T => root.querySelector(selector) as T;
    const submit = $("#create") as HTMLButtonElement;
    try {
      submit.disabled = true;
      const name = $<HTMLInputElement>("#name").value.trim();
      const projects = JSON.parse($<HTMLTextAreaElement>("#projects").value) as unknown;
      const workers = JSON.parse($<HTMLTextAreaElement>("#workers").value) as unknown;
      const skills = $<HTMLInputElement>("#skills").value.split(",").map((value) => value.trim()).filter(Boolean);
      const mode = $<HTMLSelectElement>("#execution-mode").value;
      const networkMode = $<HTMLInputElement>("#network-mode").value.trim();
      const execution: Record<string, string> = { mode, ...(networkMode ? { networkMode } : {}) };
      await api("/api/tasks", {
        method: "POST",
        body: { name, projects, workers, execution, ...(skills.length ? { skills } : {}) },
      });
      this.selectedName = name;
      ($("#name") as HTMLInputElement).value = "";
      await this.load();
      this.showFormNote(`Task "${name}" created`);
    } catch (error) {
      this.showFormNote((error as Error).message, true);
    } finally {
      submit.disabled = false;
    }
  }

  private formNoteTimer: number | null = null;
  private showFormNote(message: string, error = false): void {
    const note = this.shadowRoot!.querySelector("#form-note") as HTMLElement;
    note.textContent = message;
    note.style.color = error ? "var(--rose)" : "var(--teal)";
    if (this.formNoteTimer !== null) window.clearTimeout(this.formNoteTimer);
    this.formNoteTimer = window.setTimeout(() => {
      note.textContent = "";
    }, 3500);
  }
}

customElements.define("peak-tasks", PeakTasks);
