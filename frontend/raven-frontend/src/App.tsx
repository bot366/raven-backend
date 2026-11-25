import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";

type User = {
  id: string;
  displayName: string;
  username: string | null;
  email: string;
  hasAvatar?: boolean;
};
type Transfer = {
  id: string;
  filename: string;
  filesize: number;
  status: string;
  createdAt?: string;
  downloadUrl?: string | null;
  shareUrl?: string | null;
  senderName?: string;
  senderUsername?: string | null;
  senderEmail?: string;
};
type Page = "overview" | "sent" | "received" | "links" | "settings";
type Health = "checking" | "online" | "offline";
type DeliveryState = "idle" | "preparing" | "flying" | "success" | "error";

const API = (import.meta.env.VITE_API_URL || "https://raven-backend-qg3w.onrender.com").replace(/\/$/, "");
const MAX_MB = Number(import.meta.env.VITE_MAX_FILE_SIZE_MB || 100);

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(API + path, { ...options, credentials: "include", headers });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || "Request failed (" + response.status + ").");
  return body as T;
}
function bytes(value: number): string {
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return amount.toFixed(amount >= 10 ? 1 : 2) + " " + units[index];
}
function initials(value: string): string {
  const parts = value.trim().split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || "R").slice(0, 2)).toUpperCase();
}
function Avatar({ user, imageUrl, size = "medium" }: { user: User; imageUrl?: string; size?: "small" | "medium" | "large" }) {
  return <span className={"avatar avatar-" + size}>{imageUrl ? <img src={imageUrl} alt="" /> : initials(user.username || user.displayName)}</span>;
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    overview: "M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z",
    send: "M22 2 11 13 M22 2l-7 20-4-9-9-4 20-7Z",
    sent: "M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5",
    received: "M12 3v12 M7 10l5 5 5-5 M4 20h16",
    links: "M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1 M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 2.9-.2-.1a1.7 1.7 0 0 0-1.9.1 1.7 1.7 0 0 0-.8 1.5v.2H8.8v-.2a1.7 1.7 0 0 0-.9-1.5 1.7 1.7 0 0 0-1.8-.1l-.2.1-1.7-2.9.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-.9H3v-3.4h.2a1.7 1.7 0 0 0 1.5-.9 1.7 1.7 0 0 0-.3-1.9l-.1-.1L6 4.9l.2.1a1.7 1.7 0 0 0 1.8-.1 1.7 1.7 0 0 0 .9-1.5v-.2h6.4v.2a1.7 1.7 0 0 0 .8 1.5 1.7 1.7 0 0 0 1.9.1l.2-.1 1.7 2.9-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5.9h.2v3.4h-.2a1.7 1.7 0 0 0-1.6.9Z",
    menu: "M4 6h16 M4 12h16 M4 18h16",
    close: "M6 6l12 12 M18 6 6 18",
    upload: "M12 16V4m0 0L7 9m5-5 5 5M4 16v3h16v-3",
    download: "M12 4v12m0 0 5-5m-5 5-5-5M4 20h16",
    file: "M7 3h7l5 5v13H7z M14 3v6h5 M10 13h6 M10 17h6",
    search: "M20 20l-4.5-4.5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
    copy: "M8 8h11v13H8z M5 16H4V3h11v2",
    logout: "M10 17l5-5-5-5 M15 12H3 M21 19V5a2 2 0 0 0-2-2h-6",
    check: "M5 12l4 4L19 6",
    user: "M20 21a8 8 0 0 0-16 0 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.file} /></svg>;
}
function RavenMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 8.5 28.5 5 36 13.5 25 35l-5-10-8 6 3-11L7 8.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="m9 9 14 10 12-5M23 19l-3 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="27.5" cy="11.5" r="1.5" fill="currentColor"/></svg>;
}
function DeliveryRaven() {
  return <svg className="delivery-raven" viewBox="0 0 120 82" role="img" aria-label="Cartoon raven carrying a file"><g className="raven-body"><path d="M18 48c2-18 17-31 36-31 16 0 27 8 32 21l19 4-15 8c-5 14-18 22-36 22-16 0-29-8-36-24Z" fill="#171923" stroke="#aaa0d7" strokeWidth="2.4"/><path className="raven-wing" d="M31 43c9-18 25-25 42-18 11 5 15 15 12 24-12-7-25-4-36 9-7-4-13-9-18-15Z" fill="#343348" stroke="#aaa0d7" strokeWidth="2"/><circle cx="81" cy="34" r="3" fill="#f5d98a"/><path d="m101 42 16 4-16 5" fill="#d8a85d"/><path d="M49 68l-2 8m22-8 2 8" stroke="#d8a85d" strokeWidth="2.5" strokeLinecap="round"/><path d="M43 49h24v17H43z" fill="#b9a8f3" stroke="#e4dcff" strokeWidth="1.5"/><path d="M49 54h12m-12 4h9" stroke="#4a406e" strokeWidth="1.5" strokeLinecap="round"/></g></svg>;
}
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [health, setHealth] = useState<Health>("checking");
  const [page, setPage] = useState<Page>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [received, setReceived] = useState<Transfer[]>([]);
  const [loadingTransfers, setLoadingTransfers] = useState(false);
  const [pageError, setPageError] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [usernameSetup, setUsernameSetup] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch(API + "/health");
      if (!response.ok) throw new Error();
      setHealth("online");
    } catch { setHealth("offline"); }
  }, []);
  const refreshTransfers = useCallback(async () => {
    if (!user) return;
    setLoadingTransfers(true);
    try {
      const [sentData, receivedData] = await Promise.all([
        api<{ transfers: Transfer[] }>("/transfers"),
        api<{ transfers: Transfer[] }>("/transfers/received")
      ]);
      setTransfers(sentData.transfers);
      setReceived(receivedData.transfers);
      setPageError("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not load your files.");
    } finally { setLoadingTransfers(false); }
  }, [user]);

  useEffect(() => {
    void refreshHealth();
    api<{ user: User }>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, [refreshHealth]);
  useEffect(() => {
    if (user) {
      setUsernameSetup(!user.username);
      void refreshTransfers();
      void (async () => {
        try {
          const response = await fetch(API + "/profile/avatar", { credentials: "include" });
          if (!response.ok) { setAvatarUrl(""); return; }
          const blob = await response.blob();
          setAvatarUrl(URL.createObjectURL(blob));
        } catch { setAvatarUrl(""); }
      })();
    } else {
      setTransfers([]);
      setReceived([]);
      setAvatarUrl("");
    }
  }, [user, refreshTransfers]);
  useEffect(() => () => { if (avatarUrl) URL.revokeObjectURL(avatarUrl); }, [avatarUrl]);

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      displayName: String(form.get("displayName") || ""),
      username: String(form.get("username") || "").trim().replace(/^@/, ""),
      identifier: String(form.get("identifier") || "").trim(),
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || "")
    };
    try {
      const result = await api<{ user: User }>(mode === "register" ? "/auth/register" : "/auth/login", {
        method: "POST", body: JSON.stringify(mode === "register" ? payload : { identifier: payload.identifier, password: payload.password })
      });
      setUser(result.user);
      setPage("overview");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to sign in.");
    } finally { setAuthBusy(false); }
  };
  const logout = async () => {
    try { await api("/auth/logout", { method: "POST", body: "{}" }); }
    finally {
      setUser(null); setPage("overview"); setSendOpen(false); setMenuOpen(false);
      setTransfers([]); setReceived([]); setAvatarUrl("");
    }
  };
  const finishUsernameSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "").trim().replace(/^@/, "");
    try {
      const result = await api<{ user: User }>("/profile/username", { method: "PUT", body: JSON.stringify({ username }) });
      setUser(result.user);
      setUsernameSetup(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save your username.");
    }
  };
  const selectPage = (next: Page) => { setPage(next); setMenuOpen(false); setPageError(""); };
  const openSend = () => { setSendOpen(true); setMenuOpen(false); };

  if (checking) return <div className="loading-screen"><span className="brand-mark"><RavenMark /></span><span>Preparing your workspace…</span></div>;

  if (!user) return (
    <div className="auth-shell">
      <header className="auth-topbar"><a className="brand" href="#"><span className="brand-mark"><RavenMark /></span>RAVEN</a><span className="auth-top-note">PRIVATE FILE SHARING</span></header>
      <main className="auth-main">
        <section className="auth-intro">
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR FILES, YOUR SPACE</div>
          <h1>Share freely.<br/><span>Stay in control.</span></h1>
          <p>One secure place to send, manage and receive your files. Your RAVEN workspace keeps everything together.</p>
          <div className="auth-features"><span>✓ Your transfers in one place</span><span>✓ Send by username or email</span><span>✓ Download files when you're ready</span></div>
          <div className="auth-mascot"><DeliveryRaven/><span>A little bird for your files.</span></div>
        </section>
        <section className="auth-card">
          <div className="auth-tabs">
            <button className={mode === "login" ? "active" : ""} type="button" onClick={() => { setMode("login"); setAuthError(""); }}>Log in</button>
            <button className={mode === "register" ? "active" : ""} type="button" onClick={() => { setMode("register"); setAuthError(""); }}>Create account</button>
          </div>
          <div className="auth-card-heading"><p className="section-kicker">{mode === "login" ? "WELCOME BACK" : "GET STARTED"}</p><h2>{mode === "login" ? "Sign in to RAVEN" : "Create your account"}</h2><p>{mode === "login" ? "Use your email or username to continue." : "Set up your name, username and account."}</p></div>
          <form className="auth-form" onSubmit={(event) => void submitAuth(event)}>
            {mode === "register" ? <>
              <label>Display name<input name="displayName" type="text" minLength={2} maxLength={60} autoComplete="name" placeholder="Your name" required /></label>
              <label>Choose a username<input name="username" type="text" minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" autoComplete="username" placeholder="e.g. raven_user" required /><small>3–20 letters, numbers or underscores. You can update it later.</small></label>
              <label>Email address<input name="email" type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" required /></label>
            </> : <label>Email or username<input name="identifier" type="text" maxLength={254} autoComplete="username" placeholder="you@example.com or @username" required /></label>}
            <label>Password<input name="password" type="password" minLength={8} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="At least 8 characters" required /></label>
            {authError && <div className="form-alert" role="alert">{authError}</div>}
            <button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : mode === "login" ? "Log in to RAVEN" : "Create account"} <Icon name="send"/></button>
          </form>
          <p className="auth-switch">{mode === "login" ? "New to RAVEN?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setAuthError(""); }}>{mode === "login" ? "Create an account" : "Log in"}</button></p>
          <div className="auth-card-foot"> <Icon name="check"/> Protected account sessions</div>
        </section>
      </main>
      <footer className="auth-footer"><span>RAVEN / File sharing, simplified.</span><span className={"api-indicator api-" + health}><i/>{health === "online" ? "API operational" : health === "checking" ? "Checking API" : "API unavailable"}</span></footer>
    </div>
  );

  const sentCompleted = transfers.filter((item) => item.status === "completed");
  const sharedLinks = sentCompleted.filter((item) => item.shareUrl);
  const recent = [...sentCompleted, ...received].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 6);
  const navItems: { id: Page | "send"; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "overview" },
    { id: "send", label: "Send files", icon: "send" },
    { id: "received", label: "Received files", icon: "received" },
    { id: "sent", label: "Sent files", icon: "sent" },
    { id: "links", label: "Shared links", icon: "links" }
  ];
  const pageTitles: Record<Page, { title: string; subtitle: string }> = {
    overview: { title: "Overview", subtitle: "A quick look at your RAVEN workspace." },
    sent: { title: "Sent files", subtitle: "Files you've uploaded and sent from RAVEN." },
    received: { title: "Received files", subtitle: "Files other RAVEN users have delivered to you." },
    links: { title: "Shared links", subtitle: "Manage the public links you've created." },
    settings: { title: "Settings", subtitle: "Manage your RAVEN profile." }
  };

  return (
    <div className="app-shell">
      {menuOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <aside className={"sidebar" + (menuOpen ? " sidebar-open" : "")}>
        <a className="brand sidebar-brand" href="#" onClick={(event) => { event.preventDefault(); selectPage("overview"); }}><span className="brand-mark"><RavenMark /></span>RAVEN</a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav">
          {navItems.map((item) => <button key={item.id} className={"nav-item" + (page === item.id ? " active" : "")} type="button" onClick={() => item.id === "send" ? openSend() : selectPage(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.id === "received" && received.length > 0 && <small>{received.length}</small>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-label">PREFERENCES</div>
          <button className={"nav-item" + (page === "settings" ? " active" : "")} type="button" onClick={() => selectPage("settings")}><Icon name="settings"/><span>Settings</span></button>
          <div className="sidebar-user">
            <Avatar user={user} imageUrl={avatarUrl} size="small"/>
            <div className="sidebar-user-info"><strong>{user.displayName}</strong><span>@{user.username || "username-needed"}</span></div>
            <button className="icon-button logout-icon" title="Log out" onClick={() => void logout()}><Icon name="logout"/></button>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="workspace-topbar">
          <button className="mobile-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Icon name="menu"/></button>
          <div className="topbar-page"><span className="topbar-eyebrow">RAVEN WORKSPACE</span><strong>{pageTitles[page].title}</strong></div>
          <div className="topbar-actions"><span className={"api-status api-" + health}><i/>{health === "online" ? "Connected" : health === "checking" ? "Connecting" : "Offline"}</span><button className="topbar-avatar" onClick={() => selectPage("settings")} title="Open profile settings"><Avatar user={user} imageUrl={avatarUrl} size="small"/></button></div>
        </header>

        <main className="page-content">
          {pageError && <div className="inline-error" role="alert">{pageError}<button onClick={() => setPageError("")}>Dismiss</button></div>}
          {page === "overview" && <>
            <section className="welcome-panel">
              <div className="welcome-copy"><div className="eyebrow"><span className="eyebrow-line"/> YOUR RAVEN WORKSPACE</div><h1>Good to have you<br/><span>back, {user.displayName.split(" ")[0]}.</span></h1><p>Your files, transfers and deliveries — all in one place.</p><button className="primary-button welcome-send" onClick={openSend}><Icon name="upload"/> Send a file</button></div>
              <div className="welcome-art"><div className="art-glow"/><DeliveryRaven/><span>YOUR NEXT DELIVERY STARTS HERE</span></div>
            </section>
            <section className="stats-grid">
              <StatCard icon="sent" label="Files sent" value={String(sentCompleted.length)} note="Successful uploads"/>
              <StatCard icon="received" label="Files received" value={String(received.length)} note="In your inbox"/>
              <StatCard icon="links" label="Shared links" value={String(sharedLinks.length)} note="Links you've created"/>
              <StatCard icon="file" label="Total transfers" value={String(sentCompleted.length + received.length)} note="Sent and received"/>
            </section>
            <section className="content-card activity-card">
              <div className="section-heading"><div><span className="section-kicker">LATEST UPDATES</span><h2>Recent activity</h2></div><button className="text-button" onClick={() => selectPage("sent")}>View sent files <span>→</span></button></div>
              {loadingTransfers ? <LoadingLine/> : recent.length === 0 ? <EmptyState title="No activity yet" text="Your sent and received files will appear here."/> : <div className="activity-list">{recent.map((item) => <TransferRow key={item.id} transfer={item} kind={received.some((rec) => rec.id === item.id) ? "received" : "sent"} />)}</div>}
            </section>
          </>}

          {page === "sent" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">YOUR OUTGOING FILES</span><h2>Sent files</h2></div><button className="primary-button compact-button" onClick={openSend}><Icon name="upload"/> Send a file</button></div>{loadingTransfers ? <LoadingLine/> : transfers.length === 0 ? <EmptyState title="Nothing sent yet" text="Files you upload will appear here."/> : <div className="activity-list">{transfers.map((item) => <TransferRow key={item.id} transfer={item} kind="sent" onCopy={setPageError}/>)}</div>}</section>}

          {page === "received" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">DELIVERED TO YOU</span><h2>Received files</h2></div><span className="count-pill">{received.length} files</span></div>{loadingTransfers ? <LoadingLine/> : received.length === 0 ? <EmptyState title="Your inbox is empty" text="Files sent directly to your RAVEN username or email will appear here."/> : <div className="activity-list">{received.map((item) => <TransferRow key={item.id} transfer={item} kind="received"/>)}</div>}</section>}

          {page === "links" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">LINK SHARING</span><h2>Shared links</h2></div><span className="count-pill">{sharedLinks.length} links</span></div>{sharedLinks.length === 0 ? <EmptyState title="No shared links yet" text="Upload a file without choosing a recipient to create a share link."/> : <div className="activity-list">{sharedLinks.map((item) => <TransferRow key={item.id} transfer={item} kind="link" onCopy={setPageError}/>)}</div>}</section>}

          {page === "settings" && <ProfileSettings user={user} avatarUrl={avatarUrl} setUser={setUser} setAvatarUrl={setAvatarUrl} setError={setPageError}/>}
          <footer className="workspace-footer"><span>RAVEN / Your files, in one place.</span><span>Secure account workspace</span></footer>
        </main>
      </div>

      {usernameSetup && <div className="modal-backdrop setup-backdrop"><form className="dialog-card username-dialog" onSubmit={(event) => void finishUsernameSetup(event)}><div className="dialog-icon"><Icon name="user"/></div><span className="section-kicker">ONE LAST STEP</span><h2>Choose your RAVEN username</h2><p>Your account was created before usernames were introduced. Choose a unique username so other people can send files to you.</p><label className="field-label">Username<input name="username" minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" placeholder="e.g. raven_user" required autoFocus/><small>3–20 letters, numbers or underscores. You can change this later in Settings.</small></label>{pageError && <div className="form-alert">{pageError}</div>}<button className="primary-button" type="submit">Save username <Icon name="check"/></button></form></div>}
      {sendOpen && <SendModal onClose={() => setSendOpen(false)} onComplete={async () => { await refreshTransfers(); }} />}
    </div>
  );
}

function StatCard({ icon, label, value, note }: { icon: string; label: string; value: string; note: string }) {
  return <article className="stat-card"><span className="stat-icon"><Icon name={icon}/></span><span className="stat-label">{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span className="empty-raven"><DeliveryRaven/></span><strong>{title}</strong><span>{text}</span></div>;
}
function LoadingLine() { return <div className="loading-line"><span/> Loading your files…</div>; }

function TransferRow({ transfer, kind, onCopy }: { transfer: Transfer; kind: "sent" | "received" | "link"; onCopy?: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const received = kind === "received";
  const title = kind === "link" ? "Share link" : received ? "Received file" : "Sent file";
  const downloadUrl = API + "/transfers/" + encodeURIComponent(transfer.id) + "/download";
  const copy = async () => {
    if (!transfer.shareUrl) return;
    try {
      await navigator.clipboard.writeText(transfer.shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { onCopy?.("Clipboard unavailable. Open the share link and copy it manually."); }
  };
  return <article className="transfer-row">
    <span className="transfer-file-icon"><Icon name="file"/></span>
    <div className="transfer-file-meta"><strong>{transfer.filename}</strong><span>{bytes(transfer.filesize)} · {received ? "From " + (transfer.senderUsername ? "@" + transfer.senderUsername : transfer.senderName || transfer.senderEmail || "RAVEN user") : transfer.createdAt ? new Date(transfer.createdAt).toLocaleString() : "Recently"}</span></div>
    <span className={"transfer-type type-" + kind}>{title}</span>
    {received && transfer.status === "completed" && <a className="outline-button download-button" href={downloadUrl}><Icon name="download"/> Download</a>}
    {kind === "link" && transfer.shareUrl && <button className="outline-button" onClick={() => void copy()}><Icon name="copy"/> {copied ? "Copied" : "Copy link"}</button>}
    {!received && kind !== "link" && transfer.shareUrl && <button className="quiet-icon-button" title="Copy share link" onClick={() => void copy()}><Icon name="copy"/></button>}
    {transfer.status !== "completed" && <span className={"status-tag status-" + transfer.status}>{transfer.status}</span>}
  </article>;
}

function ProfileSettings({ user, avatarUrl, setUser, setAvatarUrl, setError }: {
  user: User; avatarUrl: string; setUser: (user: User) => void; setAvatarUrl: (url: string) => void; setError: (error: string) => void;
}) {
  const [username, setUsername] = useState(user.username || "");
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [message, setMessage] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  useEffect(() => setUsername(user.username || ""), [user.username]);
  const saveUsername = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage(""); setError("");
    try {
      const result = await api<{ user: User }>("/profile/username", { method: "PUT", body: JSON.stringify({ username }) });
      setUser(result.user); setUsername(result.user.username || ""); setMessage("Username updated.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update username."); }
    finally { setSaving(false); }
  };
  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Profile photos must be 2 MB or smaller."); return; }
    setPhotoBusy(true); setError(""); setMessage("");
    try {
      const form = new FormData(); form.append("file", file, file.name);
      await api<{ user: User }>("/profile/avatar", { method: "PUT", body: form });
      const response = await fetch(API + "/profile/avatar", { credentials: "include" });
      if (!response.ok) throw new Error("Photo saved, but could not reload it.");
      const blob = await response.blob();
      setAvatarUrl(URL.createObjectURL(blob));
      setUser({ ...user, hasAvatar: true });
      setMessage("Profile photo updated.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not upload profile photo."); }
    finally { setPhotoBusy(false); if (avatarInput.current) avatarInput.current.value = ""; }
  };
  return <section className="content-card settings-card"><div className="section-heading"><div><span className="section-kicker">YOUR ACCOUNT</span><h2>Profile settings</h2></div></div>
    <div className="profile-summary"><Avatar user={user} imageUrl={avatarUrl} size="large"/><div><strong>{user.displayName}</strong><span>@{user.username}</span><small>{user.email}</small></div></div>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Profile picture</h3><p>Your initials are used by default. Add a picture whenever you're ready.</p></div><div className="photo-actions"><button className="outline-button" onClick={() => avatarInput.current?.click()} disabled={photoBusy}>{photoBusy ? "Uploading…" : "Change photo"}</button><input ref={avatarInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void uploadAvatar(event)}/><small>JPG, PNG, WebP or GIF · Max 2 MB</small></div></div>
    <div className="settings-divider"/>
    <form className="settings-block username-settings" onSubmit={(event) => void saveUsername(event)}><div><h3>Username</h3><p>This is how other people can find you when sending files.</p></div><div className="username-edit"><label className="field-label">Your username<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" required/></label><button className="primary-button compact-button" disabled={saving || username === user.username}>{saving ? "Saving…" : "Save username"}</button></div></form>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Email address</h3><p>Your email can also be used to receive files.</p></div><strong className="settings-email">{user.email}</strong></div>
    {message && <div className="success-message"><Icon name="check"/>{message}</div>}
  </section>;
}

function SendModal({ onClose, onComplete }: { onClose: () => void; onComplete: () => Promise<void> }) {
  const [recipient, setRecipient] = useState("");
  const [recipientMatch, setRecipientMatch] = useState<{ displayName: string; username: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const chooseFile = (file?: File) => {
    if (!file) return;
    setError(""); setShareUrl("");
    if (file.size > MAX_MB * 1024 * 1024) { setSelected(null); setError("File exceeds the " + MAX_MB + " MB limit."); return; }
    setSelected(file); setDelivery("idle"); setProgress(0);
  };
  const lookupRecipient = async () => {
    const value = recipient.trim();
    setRecipientError(""); setRecipientMatch(null);
    if (!value) return true;
    try {
      const result = await api<{ user: { displayName: string; username: string | null } }>("/users/lookup?identifier=" + encodeURIComponent(value));
      setRecipientMatch(result.user);
      return true;
    } catch (error) {
      setRecipientError(error instanceof Error ? error.message : "Could not find that RAVEN account.");
      return false;
    }
  };
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected || busy) return;
    setError(""); setRecipientError(""); setShareUrl("");
    if (recipient.trim()) {
      const matched = await lookupRecipient();
      if (!matched) return;
    }
    setBusy(true); setDelivery("preparing"); setProgress(0);
    try {
      const created = await api<{ transfer: { id: string } }>("/transfers", {
        method: "POST",
        body: JSON.stringify({ filename: selected.name, filesize: selected.size, recipientIdentifier: recipient.trim() || undefined })
      });
      setDelivery("flying");
      const result = await new Promise<{ shareUrl: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", API + "/transfers/" + encodeURIComponent(created.transfer.id) + "/upload");
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => { if (event.lengthComputable) setProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
        xhr.onload = () => {
          let data: { shareUrl?: string; error?: string } = {};
          try { data = JSON.parse(xhr.responseText); } catch { /* malformed response */ }
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.error || "Upload failed (" + xhr.status + ").")); return; }
          if (!data.shareUrl) { reject(new Error("Upload response did not include a share link.")); return; }
          resolve({ shareUrl: data.shareUrl });
        };
        xhr.onerror = () => reject(new Error("Network error while sending the file."));
        xhr.onabort = () => reject(new Error("Upload was cancelled."));
        const form = new FormData(); form.append("file", selected, selected.name); xhr.send(form);
      });
      setShareUrl(result.shareUrl); setProgress(100); setDelivery("success"); setSelected(null);
      if (fileInput.current) fileInput.current.value = "";
      await onComplete();
    } catch (error) {
      setDelivery("error");
      setError(error instanceof Error ? error.message : "Could not send this file.");
    } finally { setBusy(false); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setError("Clipboard unavailable. Copy the link manually."); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="dialog-card send-dialog" onSubmit={(event) => void send(event)}>
      <div className="dialog-heading"><div><span className="section-kicker">NEW DELIVERY</span><h2>Send a file</h2><p>Choose who should receive your file.</p></div><button className="icon-button close-dialog" type="button" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close"/></button></div>
      <label className="field-label">Recipient <span className="optional-label">Optional for a share link</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); setRecipientMatch(null); setRecipientError(""); }} onBlur={() => { if (recipient.trim()) void lookupRecipient(); }} placeholder="Email address or @username" disabled={busy}/></label>
      {recipientMatch && <div className="recipient-confirm"><Avatar user={{ id: "recipient", displayName: recipientMatch.displayName, username: recipientMatch.username, email: "" }} size="small"/><div><strong>{recipientMatch.displayName}</strong><span>@{recipientMatch.username}</span></div><Icon name="check"/></div>}
      {recipientError && <div className="form-alert">{recipientError}</div>}
      <div className="field-label">File to send
        <div className={"file-drop-zone" + (dragging ? " dragging" : "")} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop} onClick={() => !busy && fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy) fileInput.current?.click(); }}>
          <input ref={fileInput} className="visually-hidden" type="file" onChange={(event) => chooseFile(event.target.files?.[0])} disabled={busy}/>
          {selected ? <><span className="file-drop-icon"><Icon name="file"/></span><strong className="chosen-file-name">{selected.name}</strong><span>{bytes(selected.size)} · Ready to deliver</span><button className="remove-selected" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); setSelected(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove file</button></> : <><span className="file-drop-icon"><Icon name="upload"/></span><strong>Drop your file here</strong><span>or <b>browse your device</b></span><small>Maximum file size: {MAX_MB} MB</small></>}
        </div>
      </div>
      {delivery !== "idle" && <div className={"delivery-stage delivery-" + delivery}>
        <div className="delivery-track"><span className="delivery-track-start"/><span className="delivery-track-end"/><div className={"raven-flight" + (delivery === "flying" ? " in-flight" : "") + (delivery === "success" ? " landed" : "")}><DeliveryRaven/></div></div>
        <strong>{delivery === "preparing" ? "Preparing your delivery…" : delivery === "flying" ? "Your raven is on its way!" : delivery === "success" ? "Delivery complete!" : "Delivery could not be completed"}</strong>
        <span>{delivery === "flying" ? "Sending your file · " + progress + "%" : delivery === "preparing" ? "Getting your file ready." : delivery === "success" ? "Your file has been uploaded successfully." : "Check the error below and try again."}</span>
      </div>}
      {error && <div className="form-alert" role="alert">{error}</div>}
      {shareUrl && <div className="share-result"><div><span className="section-kicker">SHARE LINK READY</span><strong>{shareUrl}</strong></div><button className="outline-button" type="button" onClick={() => void copyLink()}><Icon name="copy"/>{copied ? "Copied" : "Copy"}</button></div>}
      <div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose} disabled={busy}>{delivery === "success" ? "Done" : "Cancel"}</button><button className="primary-button send-submit" type="submit" disabled={!selected || busy || delivery === "success"}>{busy ? "Sending…" : delivery === "success" ? "Sent successfully" : <>Send file <Icon name="send"/></>}</button></div>
      <p className="modal-footnote">The recipient can find this file in Received Files. Files are never downloaded automatically.</p>
    </form>
  </div>;
}
export default App;