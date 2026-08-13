/**
 * Peak Artifact Preview page — a single Lit web component; preview.html is
 * only a shell.
 */
import { LitElement, html, css, type TemplateResult } from "lit";
import { baseStyles, toggleTheme } from "./tokens.js";

const pageStyles = css`
  :host { display: block; min-height: 100vh; min-height: 100dvh; background: var(--bg); }
  .shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: 58px minmax(0, 1fr); }
  @keyframes peak-bar-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes peak-stage-in { from { opacity: 0; transform: translateY(12px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes peak-content-in { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: scale(1); } }
  @keyframes peak-pop-in { from { opacity: 0; transform: translateY(4px) scale(0.94); } to { opacity: 1; transform: translateY(0) scale(1); } }
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
  header .mark svg { width: 15px; }
  header strong { font-size: 14.5px; letter-spacing: -0.01em; }
  header .meta {
    min-width: 0;
    color: var(--muted);
    font: 11px var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #download:not([hidden]) { animation: peak-pop-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .spacer { flex: 1; }

  .stage { min-height: 0; padding: 18px; display: grid; place-items: center; }
  .preview {
    width: 100%;
    height: 100%;
    min-height: calc(100vh - 94px);
    min-height: calc(100dvh - 94px);
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    overflow: auto;
    box-shadow: var(--shadow-md);
    animation: peak-stage-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both;
  }
  .preview > * { animation: peak-content-in 0.4s ease both; }
  .preview img, .preview video { display: block; max-width: 100%; max-height: calc(100vh - 96px); max-height: calc(100dvh - 96px); }
  .preview audio { width: min(720px, 90%); }
  .preview iframe { width: 100%; height: 100%; min-height: calc(100vh - 94px); min-height: calc(100dvh - 94px); border: 0; }
  .preview pre {
    align-self: stretch;
    justify-self: stretch;
    margin: 0;
    padding: 20px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 12px/1.55 var(--mono);
    color: var(--ink-2);
  }
  @media (max-width: 640px) {
    header { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: 10px; }
    header strong { font-size: 13.5px; }
    header .meta { display: none; }
    .stage { padding: 8px; }
    .preview { border-radius: 12px; }
    .preview audio { width: 96%; }
    .preview pre { padding: 12px; font-size: 11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    header, .preview, .preview > *, #download:not([hidden]) { animation: none !important; }
  }
`;

export class PeakPreview extends LitElement {
  static styles = [baseStyles, pageStyles];

  private meta = "";
  private error = false;
  private message = "Loading artifact…";
  private messageDetail = "";
  private kind: "text" | "image" | "audio" | "video" | "pdf" | "html" | "none" | "loading" = "loading";
  private textBody = "";
  private objectUrl = "";
  private filename = "";

  private get params(): URLSearchParams {
    return new URLSearchParams(location.search);
  }

  override render(): TemplateResult {
    return html`
      <div class="shell">
        <header>
          <span class="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/>
            </svg>
          </span>
          <strong>Artifact preview</strong>
          <span class="meta">${this.meta}</span>
          <span class="spacer"></span>
          <button class="btn icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
          <a class="btn" href="/">Graph</a>
          <a id="download" class="btn primary" hidden>Download</a>
        </header>
        <main class="stage">
          <section class="preview">${this.renderContent()}</section>
        </main>
      </div>
    `;
  }

  private renderContent(): TemplateResult {
    switch (this.kind) {
      case "loading": return html`<div class="message"><strong>${this.message}</strong></div>`;
      case "none": return html`<div class="message${this.error ? " error" : ""}"><strong>${this.message}</strong>${this.messageDetail}</div>`;
      case "image": return html`<img alt=${this.filename} src=${this.objectUrl}>`;
      case "audio": return html`<audio controls src=${this.objectUrl}></audio>`;
      case "video": return html`<video controls src=${this.objectUrl}></video>`;
      case "pdf": return html`<iframe title=${this.filename} src=${this.objectUrl}></iframe>`;
      case "html": return html`<iframe title=${this.filename} sandbox=""></iframe>`;
      case "text": return html`<pre>${this.textBody}</pre>`;
    }
  }

  override firstUpdated(): void {
    const root = this.shadowRoot!;
    root.querySelector("#theme")!.addEventListener("click", () => toggleTheme());
    void this.load();
    window.addEventListener("pagehide", () => {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    });
  }

  private showMessage(title: string, detail = "", error = false): void {
    this.kind = "none";
    this.message = title;
    this.messageDetail = detail;
    this.error = error;
    this.requestUpdate();
  }

  private textual(type: string): boolean {
    return type.startsWith("text/") || type.includes("json") || type.includes("xml")
      || type.includes("javascript") || type.includes("yaml") || type.includes("toml")
      || type.includes("markdown");
  }

  private async load(): Promise<void> {
    const project = this.params.get("project") ?? "";
    const sha256 = this.params.get("artifact") ?? "";
    const filename = this.params.get("filename") ?? sha256;
    this.filename = filename;
    if (!project || !sha256) {
      this.showMessage("Invalid preview link", "Project and artifact identifiers are required.", true);
      return;
    }
    this.meta = sha256;
    this.kind = "loading";
    this.requestUpdate();
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/artifacts/${encodeURIComponent(sha256)}`);
      if (!response.ok) {
        let detail = await response.text();
        try { detail = (JSON.parse(detail) as { error?: string }).error ?? detail; } catch { /* raw */ }
        this.showMessage("Unable to preview artifact", detail || `HTTP ${response.status}`, true);
        return;
      }
      const blob = await response.blob();
      const type = (response.headers.get("content-type") || blob.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(blob);
      const download = this.shadowRoot!.querySelector("#download") as HTMLAnchorElement;
      download.href = this.objectUrl;
      download.download = filename;
      download.hidden = false;
      this.meta = `${filename} · ${type} · ${blob.size.toLocaleString()} bytes`;

      if (type.startsWith("image/")) { this.kind = "image"; }
      else if (type.startsWith("audio/")) { this.kind = "audio"; }
      else if (type.startsWith("video/")) { this.kind = "video"; }
      else if (type === "application/pdf") { this.kind = "pdf"; }
      else if (type === "text/html" || type === "application/xhtml+xml") { this.kind = "html"; }
      else if (this.textual(type)) {
        let content = await blob.text();
        if (type.includes("json")) {
          try { content = JSON.stringify(JSON.parse(content) as unknown, null, 2); } catch { /* keep raw */ }
        }
        this.textBody = content;
        this.kind = "text";
      } else {
        this.showMessage("Preview is not available", `Use Download to open ${type} in a compatible application.`);
        return;
      }
      this.requestUpdate();
      if (this.kind === "html") {
        // Sandboxed iframe with a strict CSP for rendered HTML artifacts.
        const frame = this.shadowRoot!.querySelector("iframe") as HTMLIFrameElement;
        const content = await blob.text();
        frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">${content}`;
      }
    } catch (error) {
      this.showMessage("Unable to preview artifact", (error as Error).message, true);
    }
  }
}

customElements.define("peak-preview", PeakPreview);
