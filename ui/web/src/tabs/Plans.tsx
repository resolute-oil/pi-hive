import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import bashMod from "highlight.js/lib/languages/bash";
import cssMod from "highlight.js/lib/languages/css";
import diffMod from "highlight.js/lib/languages/diff";
import javascriptMod from "highlight.js/lib/languages/javascript";
import jsonMod from "highlight.js/lib/languages/json";
import markdownMod from "highlight.js/lib/languages/markdown";
import pythonMod from "highlight.js/lib/languages/python";
import typescriptMod from "highlight.js/lib/languages/typescript";
import xmlMod from "highlight.js/lib/languages/xml";
import yamlMod from "highlight.js/lib/languages/yaml";
import remarkGfm from "remark-gfm";

// highlight.js ships each language as CommonJS (`module.exports = fn`). ESM
// default imports return the namespace object (`{ default: fn }`) instead of
// the function, which lowlight's `registerLanguage` rejects at module-load
// time with "languageDefinition is not a function". Unwrap to the function
// once at import time so the languages object can hand functions straight to
// rehype-highlight.
const bash = (bashMod as { default?: unknown }).default ?? bashMod;
const css = (cssMod as { default?: unknown }).default ?? cssMod;
const diff = (diffMod as { default?: unknown }).default ?? diffMod;
const javascript = (javascriptMod as { default?: unknown }).default ?? javascriptMod;
const json = (jsonMod as { default?: unknown }).default ?? jsonMod;
const markdownLang = (markdownMod as { default?: unknown }).default ?? markdownMod;
const python = (pythonMod as { default?: unknown }).default ?? pythonMod;
const typescript = (typescriptMod as { default?: unknown }).default ?? typescriptMod;
const xml = (xmlMod as { default?: unknown }).default ?? xmlMod;
const yaml = (yamlMod as { default?: unknown }).default ?? yamlMod;
import {
  bootCwd, createReviewSession, fetchPlanDetail, fetchPlanFile, fetchPlans,
  type ArtifactReview, type ArtifactState, type PlanDetail, type PlanSummary,
} from "../api";
import { useHive } from "../store";
import RelTime from "../hooks/RelTime";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { REVIEW_IFRAME_SANDBOX, safeArtifactHref } from "../security";

// The Plans tab is now a slim two-pane status view over OpenSpec changes. The
// actual review/annotation happens in a self-hosted review-only UI rendered in
// one persistent iframe. The dashboard mints short-lived, content-bound review
// capabilities and switches artifacts with postMessage, without reloading the
// frame or starting per-review processes.

const STATUS_LABEL: Record<string, string> = {
  "no-tasks": "no tasks",
  "in-progress": "in progress",
  complete: "complete",
};

function StatusBadge({ status }: { status: PlanSummary["status"] }) {
  return <span className={`plan-status plan-status-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

function VerdictPill({ verdict }: { verdict: "red" | "yellow" | "green" }) {
  return <span className={`verdict-pill verdict-${verdict}`}>{verdict}</span>;
}

// Map an artifact to the markdown path the review UI should load. Single-file
// artifacts (proposal/design/tasks) are "<id>.md"; specs stays as OpenSpec's
// glob because the server expands it into a bounded combined review document.
function artifactFile(a: ArtifactState, _files: string[]): string {
  if (a.outputPath.includes("*")) return a.outputPath;
  return a.outputPath || `${a.id}.md`;
}
function ridFor(changeId: string, a: ArtifactState, files: string[]): string {
  return `${changeId}#${artifactFile(a, files)}`;
}
function artifactPathFromRid(rid: string): string {
  return rid.includes("#") ? rid.slice(rid.indexOf("#") + 1) : "proposal.md";
}

// A chip for an AUTHORED artifact (exists on disk). Two-stage review state:
// awaiting the reviewer AGENT, ready for the HUMAN, approved, or denied. Only
// authored artifacts are shown; unwritten ones surface as an "up next" hint,
// since OpenSpec "ready" means "cleared to author", not "ready to review".
function reviewState(r?: ArtifactReview): { label: string; cls: string } {
  if (!r) return { label: "", cls: "" };
  if (r.humanVerdict === "green") return { label: "approved", cls: "state-approved" };
  if (r.humanVerdict === "red") return { label: "changes requested", cls: "state-denied" };
  if (r.humanReviewReady) return { label: "review now", cls: "state-review" };
  if (r.authored && !r.agentCleared) return { label: "agent review", cls: "state-agent" };
  return { label: "", cls: "" };
}

function ArtifactChip({
  a, review, changeId, files, selectedRid, onSelect,
}: { a: ArtifactState; review?: ArtifactReview; changeId: string; files: string[]; selectedRid: string; onSelect: (rid: string) => void }) {
  const rid = ridFor(changeId, a, files);
  const st = reviewState(review);
  return (
    <button
      type="button"
      className={`plan-artifact ${st.cls} ${selectedRid === rid ? "active" : ""}`}
      aria-pressed={selectedRid === rid}
      title="Open in the review UI"
      onClick={() => onSelect(rid)}
    >
      <span className="plan-artifact-id" title={a.outputPath}>{a.displayLabel}</span>
      {st.label && <span className="plan-artifact-review">{st.label}</span>}
    </button>
  );
}

// Render artifact markdown through react-markdown with GitHub-Flavored
// Markdown and highlight.js for code-block coloring. react-markdown emits
// React elements (never dangerouslySetInnerHTML), so untrusted text is
// escaped by React. Links still pass through safeArtifactHref to drop
// javascript:, data:, and other executable schemes — same defense the
// regex-based renderer used. The rehype-highlight language list is a
// curated subset of the languages that appear in plan artifacts (TS/JS,
// Python, Bash, JSON, YAML, Markdown, XML/HTML, CSS, diff) — using the
// full highlight.js registry would balloon the bundle by ~150KB.
function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="plan-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { languages: { bash, css, diff, javascript, json, markdown: markdownLang, python, typescript, xml, yaml } }]]}
        components={{
          a: ({ href, children, ...props }) => {
            const safe = safeArtifactHref(href ?? "");
            return safe
              ? <a href={safe} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
              : <span>{children}</span>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

// Render an artifact's raw markdown in a fullscreen modal. Reuses MarkdownView
// (the same renderer the inline approved-artifact panel uses), so the preview
// is consistent with what the reviewer sees after approving. State and fetch
// lifecycle live in the parent Plans component — this modal only renders what
// it is given and reports close intent.
function MarkdownPreviewModal(props: {
  open: boolean;
  artifactPath: string;
  changeId: string;
  status: "loading" | "ready" | "missing" | "error";
  markdown: string | null;
  errorMessage?: string | null;
  onClose: () => void;
}) {
  const { open, onClose, artifactPath, changeId, status, markdown, errorMessage } = props;
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const titleId = `preview-title-${changeId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return createPortal(
    <div className="modal-backdrop-fullscreen" onClick={onClose}>
      <div
        ref={trapRef}
        className="modal-panel-fullscreen"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-none">
          <div className="min-w-0">
            <b id={titleId} className="text-[13px] text-ink">Markdown preview</b>
            <span className="ml-2 mono text-ink-dim text-[12px]" title={artifactPath}>{artifactPath}</span>
          </div>
          <button
            type="button"
            className="plan-review-btn"
            onClick={onClose}
            aria-label="Close markdown preview"
            title="Close (Esc)"
          >
            ✕ Close
          </button>
        </div>
        <div className="modal-body markdown-preview-body">
          {status === "loading" ? (
            <div className="empty">Loading markdown…</div>
          ) : status === "missing" ? (
            <div className="empty">This artifact is not yet authored on disk.</div>
          ) : status === "error" ? (
            <div className="empty" role="alert">{errorMessage || "Unable to load artifact."}</div>
          ) : markdown === null || markdown === "" ? (
            <div className="empty">Artifact is empty.</div>
          ) : (
            <MarkdownView markdown={markdown} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function Plans(props: { search: string }) {
  // The plan store is a per-project OpenSpec tree. Prefer the cwd of the session
  // in scope, but the dashboard is GLOBAL and its "current session" may belong to
  // an unrelated project (or there may be no session at all for a fresh OpenSpec
  // project). Fall back to the server's boot project cwd so the list is stable
  // and doesn't flash-then-vanish when a foreign session becomes "current".
  const scopeCwd = useHive((s) => {
    if (s.scope.level === "session") return s.currentSession?.cwd;
    if (s.scope.level === "project") return s.scopedSessions.find((x) => x.cwd)?.cwd;
    return undefined; // fleet scope: don't pin to an arbitrary project's session
  });
  const [fallbackCwd, setFallbackCwd] = useState<string | undefined>(undefined);
  useEffect(() => { void bootCwd().then((c) => setFallbackCwd(c || undefined)); }, []);
  const cwd = scopeCwd || fallbackCwd;
  // The plan-review iframe is a separate document and cannot read the
  // dashboard's `:root[data-theme]`. We pass the current theme to the
  // server (so the initial iframe URL has the right theme) AND push
  // `pi-hive-theme` postMessages on every toggle (so a running iframe
  // transitions live).
  const theme = useHive((s) => s.theme);

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const [rid, setRid] = useState<string>("");
  const [fullscreen, setFullscreen] = useState(false);
  const [readOnlyMarkdown, setReadOnlyMarkdown] = useState<string | null>(null);
  const [reviewSession, setReviewSession] = useState<{ rid: string; url: string } | null>(null);
  const [reviewSessionPending, setReviewSessionPending] = useState(false);
  const [reviewSessionFailed, setReviewSessionFailed] = useState(false);
  const [reviewRetry, setReviewRetry] = useState(0);
  const [reviewFrameSrc, setReviewFrameSrc] = useState("");
  const [reviewFrameReady, setReviewFrameReady] = useState(false);
  const reviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const fullscreenRef = useFocusTrap<HTMLDivElement>(fullscreen);
  // Markdown preview modal. The preview opens lazily — the markdown is fetched
  // only when the user clicks the button, not on every rid switch — and is
  // cancelled if the modal closes or the artifact changes mid-fetch.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);

  // Esc exits the fullscreen review.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const loadPlans = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await fetchPlans(cwd, signal);
      if (!signal?.aborted) setPlans(list);
    } catch (error: any) {
      if (!signal?.aborted) setListError(error?.message || "Unable to load OpenSpec changes.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cwd]);

  const selectPlan = useCallback(async (changeId: string) => {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setSelected(changeId);
    setDetail(null);
    setDetailError(null);
    try {
      const d = await fetchPlanDetail(changeId, cwd, controller.signal);
      if (controller.signal.aborted) return;
      if (!d) { setDetailError("OpenSpec change not found."); return; }
      setDetail(d);
      // Default the review to the first authored artifact, else the proposal.
      const files = d.files || [];
      const firstDone = d.artifacts.find((a) => a.status === "done");
      setRid(firstDone ? ridFor(changeId, firstDone, files) : `${changeId}#proposal.md`);
    } catch (error: any) {
      if (!controller.signal.aborted) setDetailError(error?.message || "Unable to load OpenSpec change.");
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPlans(controller.signal);
    return () => controller.abort();
  }, [loadPlans]);
  useEffect(() => () => detailAbort.current?.abort(), []);

  const filtered = useMemo(() => {
    const q = props.search.toLowerCase();
    return plans.filter((p) => !q || p.changeId.toLowerCase().includes(q));
  }, [plans, props.search]);

  const selectedArtifact = useMemo(() => (detail?.artifacts || []).find((a) => ridFor(detail!.changeId, a, detail!.files) === rid), [detail, rid]);
  const selectedReview = useMemo(() => detail?.artifactReview.find((r) => r.id === selectedArtifact?.id), [detail, selectedArtifact]);
  // A red human verdict is not final: it means feedback was requested and the
  // same artifact should become reviewable again after the planner revises it.
  // Only green locks the artifact into read-only mode.
  const reviewFinal = selectedReview?.humanVerdict === "green";
  const artifactPath = artifactPathFromRid(rid);
  const reviewSrc = reviewSession?.rid === rid ? reviewSession.url : "";

  useEffect(() => {
    let cancelled = false;
    setReviewSession(null);
    setReviewSessionFailed(false);
    if (!rid || !cwd || !selectedArtifact || reviewFinal) { setReviewSessionPending(false); return; }
    setReviewSessionPending(true);
    void createReviewSession(rid, cwd, theme).then((session) => {
      if (cancelled) return;
      setReviewSessionPending(false);
      if (session) setReviewSession({ rid, url: session.reviewUrl });
      else setReviewSessionFailed(true);
    });
    return () => { cancelled = true; };
    // `theme` is intentionally omitted from deps. The session URL is baked
    // once at mint time; live theme changes are delivered via the
    // `pi-hive-theme` postMessage effect below, not by re-minting the
    // session (which would force the iframe to reload the artifact).
    // `selectedArtifact?.id` (vs the whole object) avoids re-running when
    // unrelated fields on the selected artifact change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, reviewFinal, rid, selectedArtifact?.id, reviewRetry]);

  // Mount the review app once. Subsequent capabilities are delivered to the
  // sandboxed frame rather than assigned to iframe.src, preserving its runtime
  // and avoiding a multi-megabyte reload for every artifact switch.
  useEffect(() => {
    if (!reviewSession) return;
    if (!reviewFrameSrc) { setReviewFrameSrc(reviewSession.url); return; }
    if (reviewFrameReady) reviewFrameRef.current?.contentWindow?.postMessage({ type: "pi-hive-review-context", url: reviewSession.url, theme }, "*");
  }, [reviewFrameReady, reviewFrameSrc, reviewSession, theme]);

  // Push live theme changes to a mounted review iframe. The dashboard's
  // `<html data-theme>` attribute is its own — the iframe is a separate
  // document and has to mirror the change explicitly. Without this the
  // review surface stays dark when the user toggles to light mode.
  useEffect(() => {
    if (!reviewFrameReady) return;
    reviewFrameRef.current?.contentWindow?.postMessage({ type: "pi-hive-theme", theme }, "*");
  }, [theme, reviewFrameReady]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The iframe intentionally has an opaque sandbox origin, so messages from
      // it serialize as "null". The exact WindowProxy is the authority check.
      if (event.origin !== "null" || event.source !== reviewFrameRef.current?.contentWindow) return;
      if (event.data?.type === "pi-hive-review-ready") {
        setReviewFrameReady(true);
        if (reviewSession) reviewFrameRef.current?.contentWindow?.postMessage({ type: "pi-hive-review-context", url: reviewSession.url, theme }, "*");
        return;
      }
      if (event.data?.type !== "pi-hive-review-result" || !selected) return;
      const controller = new AbortController();
      void fetchPlanDetail(selected, cwd, controller.signal).then((next) => { if (next) setDetail(next); }).catch(() => undefined);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [cwd, reviewSession, selected, theme]);

  useEffect(() => {
    let cancelled = false;
    setReadOnlyMarkdown(null);
    if (!detail || !rid || !cwd || !reviewFinal) return;
    void fetchPlanFile(detail.changeId, artifactPath, cwd).then((file) => {
      if (!cancelled) setReadOnlyMarkdown(file.content ?? "_Unable to load reviewed artifact._");
    });
    return () => { cancelled = true; };
  }, [artifactPath, cwd, detail, reviewFinal, rid]);

  // Fetch the artifact markdown when the preview modal opens. Lazy — the
  // button click is what triggers the request, not every rid switch — and
  // aborted on close, artifact change, or unmount so a stale fetch cannot
  // overwrite a fresher one. fetchPlanFile distinguishes missing (content ===
  // null + error) from a genuinely empty artifact (content === ""), so the
  // modal can surface both states cleanly.
  //
  // The deps intentionally reference `detail?.changeId` instead of `detail`.
  // The polling effect for awaiting-human-review replaces `detail` with a
  // fresh object reference every 3s; including `detail` here would re-trigger
  // this effect on every poll, flipping the modal back to "Loading…" each
  // time. `changeId` is the only string we actually read from it, so a stable
  // identity is enough.
  useEffect(() => {
    previewAbort.current?.abort();
    if (!previewOpen || !detail || !rid || !cwd) {
      setPreviewMarkdown(null);
      setPreviewStatus("loading");
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreviewStatus("loading");
    setPreviewError(null);
    void fetchPlanFile(detail.changeId, artifactPath, cwd).then((file) => {
      if (controller.signal.aborted) return;
      if (file.error || file.content === null || file.content === undefined) {
        setPreviewStatus("missing");
        setPreviewMarkdown(null);
        return;
      }
      setPreviewMarkdown(file.content);
      setPreviewStatus("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setPreviewStatus("error");
      setPreviewError(error instanceof Error ? error.message : "Unable to load artifact.");
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOpen, artifactPath, cwd, rid, detail?.changeId]);

  const closePreview = useCallback(() => {
    previewAbort.current?.abort();
    setPreviewOpen(false);
  }, []);

  // The embedded review UI cannot notify this React tree after approve/deny
  // because it is a vendored iframe. Poll while the selected artifact is awaiting
  // human approval, then swap to read-only markdown only once it is approved.
  // A red verdict stays reviewable so the revision loop can reopen the review UI.
  useEffect(() => {
    if (!detail || !selectedReview?.humanReviewReady || selectedReview.humanVerdict === "green" || !selected) return;
    let controller: AbortController | undefined;
    const timer = window.setInterval(() => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void fetchPlanDetail(selected, cwd, request.signal)
        .then((next) => { if (next) setDetail(next); })
        .catch((error: unknown) => {
          if (!request.signal.aborted) setDetailError(error instanceof Error ? error.message : "Unable to refresh OpenSpec change.");
        });
    }, 3000);
    return () => { window.clearInterval(timer); controller?.abort(); };
  }, [cwd, detail, selected, selectedReview]);

  // Only AUTHORED artifacts (on disk) are reviewable; the single next unwritten
  // one is surfaced as an "up next" hint. OpenSpec's "specs" delta is what makes
  // a change validatable, so before it's authored we show "in progress" instead
  // of a red validation error (a fresh change failing validation is expected).
  const authored = useMemo(() => (detail?.artifacts || []).filter((a) => a.status === "done"), [detail]);
  const upNext = useMemo(() => (detail?.artifacts || []).find((a) => a.status === "ready"), [detail]);
  const specsAuthored = useMemo(() => authored.some((a) => a.id === "specs"), [authored]);

  return (
    <div className="plans-layout">
      <div className="plans-list tab-card">
        <div className="plans-list-head">
          <span>OpenSpec changes</span>
          <button type="button" className="plans-refresh" aria-label="Refresh OpenSpec changes" title="Refresh" onClick={() => void loadPlans()}>⟳</button>
        </div>
        {listError ? (
          <div className="empty" role="alert">{listError} <button type="button" className="btn pill" onClick={() => void loadPlans()}>Retry</button></div>
        ) : (!loading || plans.length) ? (
          filtered.length ? filtered.map((p) => (
            <button
              type="button"
              key={p.changeId}
              className={`plan-row ${selected === p.changeId ? "active" : ""}`}
              aria-pressed={selected === p.changeId}
              onClick={() => void selectPlan(p.changeId)}
            >
              <div className="plan-row-main">
                <span className="plan-title mono">{p.changeId}</span>
                {p.totalTasks > 0 && <span className="plan-tasks">{p.completedTasks}/{p.totalTasks} tasks</span>}
              </div>
              <div className="plan-row-meta">
                <StatusBadge status={p.status} />
                {p.latestVerdict && <VerdictPill verdict={p.latestVerdict.verdict} />}
                {p.lastModified && <RelTime ts={p.lastModified} />}
              </div>
            </button>
          )) : <div className="empty">No OpenSpec changes for this project yet.</div>
        ) : <div className="empty">Loading…</div>}
      </div>

      <div className="plans-detail">
        {detailError ? (
          <div className="tab-card empty plans-empty" role="alert">{detailError} {selected && <button type="button" className="btn pill" onClick={() => void selectPlan(selected)}>Retry</button>}</div>
        ) : !detail ? (
          <div className="tab-card empty plans-empty">{selected ? "Loading OpenSpec change…" : "Select a change to review its artifacts."}</div>
        ) : (
          <>
            <div className="tab-card plan-head">
              <div className="plan-head-title">
                <span className="mono">{detail.changeId}</span>
                {/* Validation only reads as an ERROR once specs exist (a change
                    is expected to fail validation until its spec deltas are
                    authored — before that it's simply in progress). */}
                {specsAuthored ? (
                  <span className={`plan-validation ${detail.validation.passed ? "ok" : "fail"}`}>
                    {detail.validation.passed ? "✓ valid" : `✗ ${detail.validation.failed} validation issue(s)`}
                  </span>
                ) : (
                  <span className="plan-validation progress">in progress</span>
                )}
                {(detail.artifactsReady ?? detail.readyToExecute) && (
                  <span
                    className={`plan-ready ${detail.executionReady ? "ready" : "pending"}`}
                    title={detail.executionReady ? "All artifacts approved — the gate is open for coder/tester dispatch." : "Artifacts are ready, but human approval is still pending."}
                  >
                    ready to execute
                  </span>
                )}
                {detail.taskProgress.length > 0 && (
                  <span className="plan-tasks">
                    {detail.taskProgress.filter((task) => task.completed).length}/{detail.taskProgress.length} execution tasks recorded
                  </span>
                )}
              </div>
              <div className="plan-artifacts">
                {authored.length ? authored.map((a) => (
                  <ArtifactChip key={a.id} a={a} review={detail.artifactReview.find((r) => r.id === a.id)} changeId={detail.changeId} files={detail.files} selectedRid={rid} onSelect={setRid} />
                )) : <span className="plan-artifact-none">No artifacts authored yet.</span>}
                {upNext && <span className="plan-artifact-next">up next: {upNext.displayLabel}</span>}
              </div>
              {/* Surface real validation issues only once specs are authored. */}
              {specsAuthored && !detail.validation.passed && detail.validation.issues.length > 0 && (
                <ul className="plan-issues">
                  {detail.validation.issues.slice(0, 5).map((iss, i) => (
                    <li key={i} className={`plan-issue plan-issue-${iss.level.toLowerCase()}`}>{iss.message}</li>
                  ))}
                </ul>
              )}
            </div>

            <div ref={fullscreenRef} className={`tab-card plan-review-frame ${fullscreen ? "fullscreen" : ""}`} role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen ? "true" : undefined} aria-label={fullscreen ? `Review ${artifactPath}` : undefined} tabIndex={fullscreen ? -1 : undefined}>
              {reviewFrameSrc || reviewSrc || reviewFinal ? (
                <>
                  <div className="plan-review-bar">
                    <div className="plan-review-title">
                      <span className="plan-review-rid mono">{artifactPath}</span>
                      {selectedReview?.humanVerdict && (
                        <span className={`plan-review-final verdict-${selectedReview.humanVerdict}`}>
                          {selectedReview.humanVerdict === "green" ? "approved" : "changes requested"}
                        </span>
                      )}
                    </div>
                    <div className="plan-review-actions">
                      {/* Preview is redundant when the inline approved-artifact
                          panel already renders MarkdownView. Hide it once the
                          artifact is final (humanVerdict === "green"). */}
                      {!reviewFinal && (
                        <button
                          type="button"
                          className="plan-review-btn"
                          title="Preview the rendered markdown for this artifact"
                          onClick={() => setPreviewOpen(true)}
                        >
                          👁 Preview
                        </button>
                      )}
                      {!reviewFinal && <a className="plan-review-btn" href={reviewSrc} target="_blank" rel="noreferrer" title="Open in a new tab">↗ New Tab</a>}
                      <button type="button" className="plan-review-btn" title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"} onClick={() => setFullscreen((v) => !v)}>
                        {fullscreen ? "✕ Close" : "⤢ Fullscreen"}
                      </button>
                    </div>
                  </div>
                  {reviewFinal && (
                    <div className="plan-review-readonly">
                      {readOnlyMarkdown === null ? <div className="empty">Loading reviewed artifact…</div> : <MarkdownView markdown={readOnlyMarkdown} />}
                    </div>
                  )}
                  {reviewFrameSrc && (
                    <iframe
                      ref={reviewFrameRef}
                      title="Plan review"
                      src={reviewFrameSrc}
                      className="plan-review-iframe"
                      style={reviewFinal ? { display: "none" } : undefined}
                      sandbox={REVIEW_IFRAME_SANDBOX}
                      referrerPolicy="no-referrer"
                      onLoad={() => setReviewFrameReady(true)}
                    />
                  )}
                </>
              ) : reviewSessionPending ? (
                <div className="empty">Creating secure review session…</div>
              ) : reviewSessionFailed ? (
                <div className="empty" role="alert">Secure review session unavailable. <button type="button" className="btn pill" onClick={() => setReviewRetry((n) => n + 1)}>Retry</button></div>
              ) : <div className="empty">Select an authored artifact to review.</div>}
            </div>
          </>
        )}
      </div>
      <MarkdownPreviewModal
        open={previewOpen}
        artifactPath={artifactPath}
        changeId={detail?.changeId ?? ""}
        status={previewStatus}
        markdown={previewMarkdown}
        errorMessage={previewError}
        onClose={closePreview}
      />
    </div>
  );
}
