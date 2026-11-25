import { useCallback, useEffect, useRef, useState, type FormEvent, type DragEvent } from "react";

type User = { id: string; displayName: string; email: string };
type Transfer = { id: string; filename: string; filesize: number; status: string; createdAt?: string; downloadUrl?: string | null };
type Health = "checking" | "online" | "offline";
const API = (import.meta.env.VITE_API_URL || "https://raven-backend-qg3w.onrender.com").replace(/\/$/, "");
const MAX_MB = Number(import.meta.env.VITE_MAX_FILE_SIZE_MB || 100);

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(API + path, {
    ...options,
    credentials: "include",
    headers
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || "Request failed (" + response.status + ").");
  return body as T;
}
function bytes(n: number) {
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"]; let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 ? 1 : 2) + " " + units[i];
}
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [health, setHealth] = useState<Health>("checking");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [selected, setSelected] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refreshHealth = useCallback(async () => {
    setHealth("checking");
    try { const r = await fetch(API + "/health"); if (!r.ok) throw new Error(); setHealth("online"); }
    catch { setHealth("offline"); }
  }, []);
  const refreshTransfers = useCallback(async () => {
    if (!user) return;
    try { const data = await api<{ transfers: Transfer[] }>("/transfers"); setTransfers(data.transfers); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load transfers."); }
  }, [user]);
  useEffect(() => {
    void refreshHealth();
    api<{ user: User }>("/auth/me").then((d) => setUser(d.user)).catch(() => setUser(null)).finally(() => setChecking(false));
  }, [refreshHealth]);
  useEffect(() => { if (user) void refreshTransfers(); else setTransfers([]); }, [user, refreshTransfers]);

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setAuthError(""); setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      displayName: String(form.get("displayName") || ""),
      email: String(form.get("email") || ""),
      password: String(form.get("password") || "")
    };
    try {
      const result = await api<{ user: User }>(mode === "register" ? "/auth/register" : "/auth/login", {
        method: "POST", body: JSON.stringify(payload)
      });
      setUser(result.user);
    } catch (e) { setAuthError(e instanceof Error ? e.message : "Unable to sign in."); }
    finally { setAuthBusy(false); }
  };
  const logout = async () => {
    try { await api("/auth/logout", { method: "POST", body: "{}" }); }
    finally { setUser(null); setSelected(null); setTransfers([]); setShareUrl(""); }
  };
  const choose = (file?: File) => {
    if (!file) return;
    setError(""); setShareUrl("");
    if (file.size > MAX_MB * 1024 * 1024) { setSelected(null); setError("File exceeds the " + MAX_MB + " MB limit."); return; }
    setSelected(file); setProgress(0);
  };
  const upload = async () => {
    if (!selected || uploading) return;
    setUploading(true); setError(""); setShareUrl(""); setProgress(0);
    try {
      const created = await api<{ transfer: { id: string } }>("/transfers", {
        method: "POST", body: JSON.stringify({ filename: selected.name, filesize: selected.size })
      });
      const result = await new Promise<{ shareUrl: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", API + "/transfers/" + encodeURIComponent(created.transfer.id) + "/upload");
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.min(99, Math.round(e.loaded / e.total * 100))); };
        xhr.onload = () => {
          let data: { shareUrl?: string; error?: string } = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* invalid response */ }
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.error || "Upload failed (" + xhr.status + ").")); return; }
          if (!data.shareUrl) { reject(new Error("Upload response did not include a share link.")); return; }
          resolve({ shareUrl: data.shareUrl });
        };
        xhr.onerror = () => reject(new Error("Network error while uploading."));
        const form = new FormData(); form.append("file", selected, selected.name); xhr.send(form);
      });
      setShareUrl(result.shareUrl); setProgress(100); setSelected(null);
      if (input.current) input.current.value = "";
      await refreshTransfers();
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setUploading(false); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setError("Clipboard unavailable. Copy the link manually."); }
  };
  const drop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); };

  if (checking) return <div className="loading-screen"><div className="brand-mark"><RavenMark /></div><span>Preparing your workspace…</span></div>;
  if (!user) return (
    <div className="auth-shell">
      <header className="auth-topbar"><a className="brand" href="#"><span className="brand-mark"><RavenMark /></span>RAVEN</a><span className="auth-top-note">PRIVATE FILE SHARING</span></header>
      <main className="auth-main">
        <section className="auth-intro"><div className="eyebrow"><span className="eyebrow-line" /> YOUR FILES, YOUR SPACE</div><h1>Share freely.<br /><span>Stay in control.</span></h1><p>One secure place to send, manage and share your files. Sign in to continue to your RAVEN workspace.</p><div className="auth-features"><span>✓ Your transfers in one place</span><span>✓ Simple links for sharing</span><span>✓ Private account sessions</span></div></section>
        <section className="auth-card">
          <div className="auth-tabs"><button className={mode === "login" ? "active" : ""} type="button" onClick={() => { setMode("login"); setAuthError(""); }}>Log in</button><button className={mode === "register" ? "active" : ""} type="button" onClick={() => { setMode("register"); setAuthError(""); }}>Create account</button></div>
          <div className="auth-card-heading"><p className="section-kicker">{mode === "login" ? "WELCOME BACK" : "GET STARTED"}</p><h2>{mode === "login" ? "Sign in to RAVEN" : "Create your account"}</h2><p>{mode === "login" ? "Enter your details to access your files." : "A few details and your workspace is ready."}</p></div>
          <form className="auth-form" onSubmit={(e) => void submitAuth(e)}>
            {mode === "register" && <label>Your name<input name="displayName" type="text" minLength={2} maxLength={60} autoComplete="name" placeholder="Your name" required /></label>}
            <label>Email address<input name="email" type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" required /></label>
            <label>Password<input name="password" type="password" minLength={8} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="At least 8 characters" required /></label>
            {authError && <div className="form-alert" role="alert">{authError}</div>}
            <button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : mode === "login" ? "Log in to RAVEN" : "Create account"} <ArrowIcon /></button>
          </form>
          <p className="auth-switch">{mode === "login" ? "New to RAVEN?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setAuthError(""); }}>{mode === "login" ? "Create an account" : "Log in"}</button></p>
          <div className="auth-card-foot"><LockIcon /> Protected account sessions</div>
        </section>
      </main>
      <footer className="auth-footer"><span>RAVEN / File sharing, simplified.</span><span className={"api-indicator api-" + health}><i />{health === "online" ? "API operational" : health === "checking" ? "Checking API" : "API unavailable"}</span></footer>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="topbar"><a className="brand" href="#"><span className="brand-mark"><RavenMark /></span>RAVEN</a><div className="topbar-right"><span className={"status-pill"}><i className={"status-dot status-dot-" + health} />{health === "online" ? "API connected" : "API status: " + health}</span><span className="user-name">{user.displayName}</span><button className="logout-button" type="button" onClick={() => void logout()}>Log out</button></div></header>
      <main className="main-content dashboard-main">
        <section className="dashboard-welcome"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR RAVEN WORKSPACE</div><h1>Good to have you<br /><span>back, {user.displayName.split(" ")[0]}.</span></h1><p className="hero-copy">Upload something new or pick up where you left off.</p></div><div className="dashboard-stat"><span>YOUR TRANSFERS</span><strong>{transfers.length}</strong><small>Latest 100 shown</small></div></section>
        <section className="workspace">
          <div className="upload-panel"><div className="panel-heading"><div><p className="section-kicker">NEW TRANSFER</p><h2>Upload a file</h2></div><span className="secure-note"><ShieldIcon /> Private workspace</span></div>
            <div className={"drop-zone" + (dragging ? " is-dragging" : "")} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { e.preventDefault(); if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop} onClick={() => !uploading && input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !uploading) input.current?.click(); }}>
              <input ref={input} className="visually-hidden" type="file" onChange={(e) => choose(e.target.files?.[0])} disabled={uploading} />
              {selected ? <><div className="file-icon"><FileIcon /></div><strong className="selected-file-name">{selected.name}</strong><span className="drop-hint">{bytes(selected.size)} · Ready to upload</span><button className="remove-file" type="button" onClick={(e) => { e.stopPropagation(); setSelected(null); if (input.current) input.current.value = ""; }}>Remove file</button></> : <><div className="upload-icon"><UploadIcon /></div><strong className="drop-title">Drop your file here</strong><span className="drop-hint">or <b className="browse-text">browse files</b> on your device</span><span className="file-limit">Maximum file size: {MAX_MB} MB</span></>}
            </div>
            {uploading && <div className="progress-wrap"><div className="progress-label"><span>Uploading to RAVEN</span><strong>{progress}%</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: progress + "%" }} /></div></div>}
            {error && <div className="error-message" role="alert">{error}</div>}
            {shareUrl && <div className="share-result"><div><span className="section-kicker">SHARE LINK READY</span><strong>{shareUrl}</strong></div><button className="copy-button" type="button" onClick={() => void copyLink()}>{copied ? "Copied" : "Copy link"}</button></div>}
            <button className="upload-button" type="button" disabled={!selected || uploading || health === "offline"} onClick={() => void upload()}>{uploading ? "Uploading…" : <>Upload file <ArrowIcon /></>}</button><p className="privacy-note"><LockIcon /> Your transfers belong to your RAVEN account.</p>
          </div>
          <aside className="side-panel"><div className="side-card"><p className="section-kicker">ACCOUNT</p><h3>{user.email}</h3><p>Your transfer history is private. Anyone with a share link can download that file until it expires.</p><button className="refresh-button" type="button" onClick={() => void refreshTransfers()}>Refresh transfers</button></div><div className="api-address"><span className="api-address-label">CONNECTED API</span><span className="api-address-value">{API.replace(/^https?:\/\//, "")}</span></div></aside>
        </section>
        <section className="recent-section"><div className="recent-heading"><div><p className="section-kicker">YOUR FILES</p><h2>Transfer history</h2></div><span className="recent-count">{transfers.length} transfers</span></div>
          {transfers.length === 0 ? <div className="empty-state"><strong>No transfers yet</strong><span>Your uploaded files will appear here.</span></div> : <div className="recent-list">{transfers.map((t) => <article className="recent-item" key={t.id}><div className="recent-file-icon"><FileIcon /></div><div className="recent-file-info"><strong>{t.filename}</strong><span>{bytes(t.filesize)} · {t.createdAt ? new Date(t.createdAt).toLocaleString() : "Recently"}</span></div><span className={"transfer-status transfer-" + t.status}>{t.status}</span>{t.status === "completed" && t.downloadUrl && <a className="secondary-button" href={t.downloadUrl}>Download</a>}</article>)}</div>}
        </section>
        <footer className="footer"><span>RAVEN / Your files, in one place.</span><span>Secure account workspace</span></footer>
      </main>
    </div>
  );
}
function RavenMark() { return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 8.5 28.5 5 36 13.5 25 35l-5-10-8 6 3-11L7 8.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="m9 9 14 10 12-5M23 19l-3 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="27.5" cy="11.5" r="1.5" fill="currentColor"/></svg>; }
function UploadIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function FileIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.75h6.2L19 9.6v10.65H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M13 4v6h5.5M8.5 14h7M8.5 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>; }
function ArrowIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2 14.5 4v4.2c0 3.6-2.3 6.1-5.5 7.8-3.2-1.7-5.5-4.2-5.5-7.8V4L9 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>; }
function LockIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3.5" y="7.5" width="11" height="8" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M5.8 7.5V5.7a3.2 3.2 0 1 1 6.4 0v1.8" stroke="currentColor" strokeWidth="1.4"/></svg>; }
export default App;
