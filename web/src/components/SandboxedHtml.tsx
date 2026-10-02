import { useEffect, useMemo, useRef, type CSSProperties } from "react";

/** Injected into artifact bodies so they can report their content height. */
const HEIGHT_REPORTER = `<script>(function(){
  var last=-1;
  function send(){
    var h=Math.max(document.documentElement.scrollHeight, document.body?document.body.scrollHeight:0);
    if(h!==last){last=h;parent.postMessage({type:"aegis:height",height:h},"*");}
  }
  window.addEventListener("load",send);
  if(window.ResizeObserver&&document.body){new ResizeObserver(send).observe(document.body);}
  setTimeout(send,30);setTimeout(send,400);
})();<\/script>`;

function csp(allowScripts: boolean): string {
  const base =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;";
  return allowScripts ? `${base} script-src 'unsafe-inline';` : base;
}

const RESET =
  "*{box-sizing:border-box}html,body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b}";

/**
 * Document theme for full-page reports. Base element styles make plain
 * agent-authored markup (headings, tables, prose) look intentional, and the
 * `.kpis/.kpi/.card/.callout/.grid-2` kit gives a consistent, on-theme look.
 * Exposed to the agent in the `write_report` tool description.
 */
const REPORT_STYLES = `:root{
  --rp-accent:#6366f1; --rp-accent-soft:#eef2ff; --rp-text:#18181b;
  --rp-muted:#71717a; --rp-border:#e4e4e7; --rp-surface:#fafafa;
}
body{background:#fff;color:var(--rp-text);line-height:1.6;-webkit-font-smoothing:antialiased}
.report{max-width:920px;margin:0 auto;padding:52px 44px 80px}
.report>:first-child{margin-top:0}
h1{font-size:2rem;line-height:1.2;letter-spacing:-0.02em;margin:0 0 10px}
h2{font-size:1.35rem;margin:44px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--rp-border)}
h3{font-size:1.08rem;margin:28px 0 8px}
p{margin:0 0 14px}
a{color:var(--rp-accent)}
ul,ol{margin:0 0 14px;padding-left:22px}
li{margin:4px 0}
strong{font-weight:650}
code{background:var(--rp-surface);padding:1px 5px;border-radius:4px;font-size:.9em}
hr{border:0;border-top:1px solid var(--rp-border);margin:32px 0}
blockquote{margin:18px 0;padding:10px 18px;border-left:3px solid var(--rp-accent);background:var(--rp-accent-soft)}
table{border-collapse:collapse;width:100%;font-size:.875rem;margin:16px 0 28px}
th{text-align:left;font-weight:600;color:var(--rp-muted);text-transform:uppercase;font-size:.7rem;letter-spacing:.04em;border-bottom:1px solid var(--rp-border);padding:8px 10px}
td{padding:8px 10px;border-bottom:1px solid var(--rp-border)}
tbody tr:hover td{background:var(--rp-surface)}
svg,img{max-width:100%;height:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0 28px}
.kpi{border:1px solid var(--rp-border);border-radius:12px;padding:14px 16px;background:var(--rp-surface)}
.kpi-value{font-size:1.6rem;font-weight:700;letter-spacing:-0.02em}
.kpi-label{font-size:.75rem;color:var(--rp-muted);margin-top:2px}
.card{border:1px solid var(--rp-border);border-radius:12px;padding:16px 18px;margin:16px 0}
.callout{border-radius:12px;padding:12px 16px;background:var(--rp-accent-soft);border:1px solid var(--rp-border);margin:16px 0}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.muted{color:var(--rp-muted)}
.chart{margin:8px 0 20px}`;

/** Wrap an HTML body fragment in a complete, CSP-locked document. */
export function buildSandboxDoc(
  html: string,
  allowScripts: boolean,
  theme = false,
): string {
  const reporter = allowScripts ? HEIGHT_REPORTER : "";
  const styles = theme ? `${RESET}${REPORT_STYLES}` : RESET;
  const body = theme ? `<main class="report">${html}</main>` : html;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp(allowScripts)}">` +
    `<style>${styles}</style></head><body>${body}${reporter}</body></html>`
  );
}

/**
 * Render untrusted, agent-authored HTML/SVG in a locked-down iframe.
 *
 * Security model (ADR 0004): the frame never gets `allow-same-origin`, so it
 * runs in an opaque origin and cannot touch the app, its storage, or cookies.
 * `allowScripts` is granted only for the tiny height reporter; the CSP still
 * blocks all network access. Reports run fully scriptless.
 *
 * `theme` applies the report document styles (used by the report surface).
 */
export function SandboxedHtml({
  html,
  title,
  allowScripts = false,
  theme = false,
  frameHeight = "100%",
  onContentHeight,
  style,
}: {
  html: string;
  title: string;
  allowScripts?: boolean;
  theme?: boolean;
  frameHeight?: number | string;
  onContentHeight?: (px: number) => void;
  style?: CSSProperties;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(
    () => buildSandboxDoc(html, allowScripts, theme),
    [html, allowScripts, theme],
  );

  useEffect(() => {
    if (!allowScripts || !onContentHeight) return;
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: number } | null;
      if (data?.type !== "aegis:height" || typeof data.height !== "number") return;
      onContentHeight?.(data.height);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [allowScripts, onContentHeight]);

  return (
    <iframe
      ref={iframeRef}
      style={{
        height: frameHeight,
        width: "100%",
        border: 0,
        background: "#fff",
        display: "block",
        ...style,
      }}
      title={title}
      sandbox={allowScripts ? "allow-scripts" : ""}
      srcDoc={srcDoc}
    />
  );
}
