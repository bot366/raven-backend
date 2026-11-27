import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  cacheEncryptionIdentity, clearCachedEncryptionIdentity, createEncryptionIdentity, createTransferEncryptionSession,
  decryptTransferMetadata, decryptTransferStreamToBlob, encodeBase64, getCachedEncryptionIdentity, importShareFileKey,
  encryptTransferChunk, getKeyFingerprint, unlockEncryptionIdentity, unwrapTransferKey,
  verifyAndPinPeerKey,
  type StoredEncryptionKey, type TransferEncryptionSession
} from "./e2ee.js";

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
  recipientName?: string | null;
  recipientUsername?: string | null;
  recipientEmail?: string | null;
  encryptionVersion?: number;
  expiresAt?: string | null;
  viewCount?: number;
  downloadCount?: number;
};
type Page = "overview" | "sent" | "received" | "links" | "settings";
type Health = "checking" | "online" | "offline";
type DeliveryState = "idle" | "preparing" | "flying" | "success" | "error";

const API = (import.meta.env.VITE_API_URL || "https://raven-backend-qg3w.onrender.com").replace(/\/$/, "");
const MAX_MB = Number(import.meta.env.VITE_MAX_FILE_SIZE_MB || 100);

// Share-link secrets are confined to the current tab session. The server never stores the fragment key.
const encryptedShareLinks = new Map<string, string>();
const SHARE_SESSION_PREFIX = "raven:e2ee:share:";

function rememberEncryptedShareLink(transferId: string, shareLink: string): void {
  encryptedShareLinks.set(transferId, shareLink);
  try { window.sessionStorage.setItem(SHARE_SESSION_PREFIX + transferId, shareLink); }
  catch { /* The send confirmation still exposes the link if session storage is unavailable. */ }
}

function getEncryptedShareLink(transferId: string): string | null {
  const inMemory = encryptedShareLinks.get(transferId);
  if (inMemory) return inMemory;
  try {
    const stored = window.sessionStorage.getItem(SHARE_SESSION_PREFIX + transferId);
    if (stored) encryptedShareLinks.set(transferId, stored);
    return stored;
  } catch { return null; }
}

function clearEncryptedShareLinks(): void {
  encryptedShareLinks.clear();
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(SHARE_SESSION_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be disabled by the browser. */ }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(API + path, { ...options, credentials: "include", headers });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || "Request failed (" + response.status + ").");
  return body as T;
}


async function requireUnlockedEncryptionIdentity(userId: string): Promise<{ pair: CryptoKeyPair; keyVersion: number }> {
  const response = await api<{ key: StoredEncryptionKey | null }>("/encryption/keys/me");
  if (!response.key) {
    throw new Error("Set up end-to-end encryption in Settings before sending or opening encrypted files.");
  }
  let pair = getCachedEncryptionIdentity(userId);
  if (!pair) {
    const recoveryCode = window.prompt("Enter your RAVEN encryption recovery code. It is never sent to the server.");
    if (!recoveryCode) throw new Error("Encryption is locked. Open Settings to unlock it with your recovery code.");
    const identity = await unlockEncryptionIdentity(userId, response.key, recoveryCode);
    pair = identity.pair;
  }
  return { pair, keyVersion: Number(response.key.key_version) };
}

async function decryptAndDownloadTransfer(transferId: string, userId: string): Promise<void> {
  const { pair } = await requireUnlockedEncryptionIdentity(userId);
  const envelopeResponse = await api<{ envelope: {
    id: string;
    encryption_version: number;
    encrypted_metadata: string;
    metadata_nonce: string;
    enc: string;
    ciphertext: string;
    sender_user_id: string;
    sender_public_key: string;
  } }>("/transfers/" + encodeURIComponent(transferId) + "/envelope");
  const envelope = envelopeResponse.envelope;
  if (envelope.encryption_version !== 1 || envelope.id !== transferId) throw new Error("This transfer does not use the supported encrypted format.");
  const purpose = envelope.sender_user_id === userId ? "sender" : "recipient";
  if (purpose === "recipient") {
    const senderFingerprint = await verifyAndPinPeerKey(userId, envelope.sender_user_id, envelope.sender_public_key, "the sender");
    void senderFingerprint;
  } else {
    const ownKey = await api<{ key: StoredEncryptionKey | null }>("/encryption/keys/me");
    if (!ownKey.key || ownKey.key.public_key !== envelope.sender_public_key) {
      throw new Error("SECURITY WARNING: your account's published encryption key does not match this transfer. Decryption stopped.");
    }
  }
  const fileKey = await unwrapTransferKey(
    pair, transferId, envelope.sender_user_id, userId, purpose, envelope.enc, envelope.ciphertext, envelope.sender_public_key
  );
  const metadata = await decryptTransferMetadata(fileKey, transferId, envelope.encrypted_metadata, envelope.metadata_nonce);
  const response = await fetch(API + "/transfers/" + encodeURIComponent(transferId) + "/download", { credentials: "include" });
  if (!response.ok) throw new Error("Could not retrieve the encrypted file (" + response.status + ").");
  const fileBlob = await decryptTransferStreamToBlob(
    fileKey, transferId, metadata, response.body,
  );
  const objectUrl = URL.createObjectURL(fileBlob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = metadata.filename.replace(/[\\/\\r\\n]/g, "_").slice(0, 255) || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
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
function PublicEncryptedShare({ token, shareKey }: { token: string; shareKey: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  const decryptAndDownload = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!shareKey) throw new Error("This link is missing its decryption key. Ask the sender for the complete encrypted share link.");
      const envelopeResponse = await fetch(API + "/share/" + encodeURIComponent(token) + "/envelope", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const envelopeBody = await envelopeResponse.json().catch(() => null) as {
        envelope?: { id: string; encryption_version: number; encrypted_metadata: string; metadata_nonce: string };
        error?: string;
      } | null;
      if (!envelopeResponse.ok || !envelopeBody?.envelope) {
        throw new Error(envelopeBody?.error || "This encrypted share is unavailable or has expired.");
      }
      const envelope = envelopeBody.envelope;
      if (envelope.encryption_version !== 1 || !envelope.id || !envelope.encrypted_metadata || !envelope.metadata_nonce) {
        throw new Error("This link does not contain a supported encrypted file.");
      }
      const fileKey = await importShareFileKey(shareKey);
      const metadata = await decryptTransferMetadata(fileKey, envelope.id, envelope.encrypted_metadata, envelope.metadata_nonce);
      const response = await fetch(API + "/share/" + encodeURIComponent(token) + "/download", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not retrieve the encrypted file (" + response.status + ").");
      const fileBlob = await decryptTransferStreamToBlob(
        fileKey, envelope.id, metadata, response.body,
      );
      const objectUrl = URL.createObjectURL(fileBlob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = metadata.filename.replace(/[\\/\\r\\n]/g, "_").slice(0, 255) || "download";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      }
      setComplete(true);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not decrypt this share.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="auth-shell">
    <header className="auth-topbar"><a className="brand" href="/"><span className="brand-mark"><RavenMark /></span>RAVEN</a><span className="auth-top-note">ENCRYPTED FILE SHARE</span></header>
    <main className="auth-main">
      <section className="auth-intro"><div className="eyebrow"><span className="eyebrow-line"/> PRIVATE FILE SHARING</div><h1>Your file.<br/><span>Your key.</span></h1><p>This file is encrypted. It will be decrypted in your browser after you select the button.</p><div className="auth-features"><span>✓ Decryption happens on this device</span><span>✓ The server never receives the link key</span><span>✓ No RAVEN account required</span></div><div className="auth-mascot"><DeliveryRaven/><span>A little bird for your files.</span></div></section>
      <section className="auth-card">
        <div className="auth-card-heading"><p className="section-kicker">PRIVATE SHARE</p><h2>{complete ? "Download started" : "Ready to decrypt"}</h2><p>{complete ? "Your browser received the decrypted file." : "Use the complete link from the sender. Only the encrypted file is downloaded before local decryption."}</p></div>
        {!shareKey && <div className="form-alert" role="alert">This link is missing its decryption key. Ask the sender to copy and send the full link, including everything after the # symbol.</div>}
        {error && <div className="form-alert" role="alert">{error}</div>}
        <button className="primary-button" type="button" onClick={() => void decryptAndDownload()} disabled={busy || !shareKey}>{busy ? "Decrypting file…" : complete ? "Download again" : "Decrypt & download"} <Icon name="download"/></button>
        <div className="auth-card-foot"><Icon name="check"/> The key is kept in this page and is not sent in API requests.</div>
      </section>
    </main>
    <footer className="auth-footer"><span>RAVEN / File sharing, simplified.</span><a href="/">Back to RAVEN</a></footer>
  </div>;
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
  const [fileSearch, setFileSearch] = useState("");
  const [fileStatus, setFileStatus] = useState("all");
  const [fileSort, setFileSort] = useState("newest");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try { return window.localStorage.getItem("raven:theme") === "light" ? "light" : "dark"; }
    catch { return "dark"; }
  });
  const [compact, setCompact] = useState(() => {
    try { return window.localStorage.getItem("raven:compact") === "true"; }
    catch { return false; }
  });

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
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.compact = compact ? "true" : "false";
    try {
      window.localStorage.setItem("raven:theme", theme);
      window.localStorage.setItem("raven:compact", String(compact));
    } catch { /* Preferences remain available for this visit. */ }
  }, [theme, compact]);

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
    if (user) clearCachedEncryptionIdentity(user.id);
    clearEncryptedShareLinks();
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
  const shareToken = new URLSearchParams(window.location.search).get("share");
  const shareKey = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";

  if (shareToken) return <PublicEncryptedShare token={shareToken} shareKey={shareKey}/>;
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
  const sharedLinks = transfers.filter((item) => Boolean(item.shareUrl));
  const activeLinks = sharedLinks.filter((item) => item.status === "completed");
  const pendingTransfers = transfers.filter((item) => item.status === "pending").length;
  const recent = [...transfers, ...received].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 6);
  const filterTransfers = (items: Transfer[]) => {
    const query = fileSearch.trim().toLowerCase();
    const filtered = items.filter((item) => {
      const matchesQuery = !query || [item.filename, item.senderName, item.senderUsername, item.senderEmail, item.recipientName, item.recipientUsername, item.recipientEmail]
        .some((value) => value?.toLowerCase().includes(query));
      return matchesQuery && (fileStatus === "all" || item.status === fileStatus);
    });
    return filtered.sort((a, b) => {
      if (fileSort === "largest") return b.filesize - a.filesize;
      if (fileSort === "smallest") return a.filesize - b.filesize;
      const delta = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      return fileSort === "oldest" ? -delta : delta;
    });
  };
  const displayedSent = filterTransfers(transfers);
  const displayedReceived = filterTransfers(received);
  const displayedLinks = filterTransfers(sharedLinks);
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
              <StatCard icon="sent" label="Files sent" value={String(sentCompleted.length)} note="Latest 100 transfer records"/>
              <StatCard icon="received" label="Files received" value={String(received.length)} note="Latest 100 inbox records"/>
              <StatCard icon="links" label="Active links" value={String(activeLinks.length)} note="Public links still available"/>
              <StatCard icon="file" label="In progress" value={String(pendingTransfers)} note="Pending uploads"/>
            </section>
            <section className="content-card activity-card">
              <div className="section-heading"><div><span className="section-kicker">LATEST UPDATES</span><h2>Recent activity</h2></div><div className="section-actions"><button className="text-button" type="button" onClick={() => void refreshTransfers()} disabled={loadingTransfers}>{loadingTransfers ? "Refreshing…" : "Refresh"}</button><button className="text-button" onClick={() => selectPage("sent")}>View sent files <span>→</span></button></div></div>
              {loadingTransfers ? <LoadingLine/> : recent.length === 0 ? <EmptyState title="No activity yet" text="Your sent and received files will appear here."/> : <div className="activity-list">{recent.map((item) => <TransferRow key={item.id} transfer={item} userId={user.id} kind={received.some((rec) => rec.id === item.id) ? "received" : "sent"} />)}</div>}
            </section>
          </>}

          {page === "sent" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">YOUR OUTGOING FILES</span><h2>Sent files</h2></div><div className="section-actions"><button className="text-button" type="button" onClick={() => void refreshTransfers()} disabled={loadingTransfers}>{loadingTransfers ? "Refreshing…" : "Refresh"}</button><button className="primary-button compact-button" onClick={openSend}><Icon name="upload"/> Send a file</button></div></div><TransferToolbar search={fileSearch} onSearch={setFileSearch} status={fileStatus} onStatus={setFileStatus} sort={fileSort} onSort={setFileSort}/>{loadingTransfers ? <LoadingLine/> : transfers.length === 0 ? <EmptyState title="Nothing sent yet" text="Files you upload will appear here."/> : displayedSent.length === 0 ? <EmptyState title="No matching files" text="Try another search or status filter."/> : <div className="activity-list">{displayedSent.map((item) => <TransferRow key={item.id} transfer={item} userId={user.id} kind="sent" onCopy={setPageError} onRefresh={refreshTransfers}/>)}</div>}</section>}

          {page === "received" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">DELIVERED TO YOU</span><h2>Received files</h2></div><div className="section-actions"><span className="count-pill">{received.length} files</span><button className="text-button" type="button" onClick={() => void refreshTransfers()} disabled={loadingTransfers}>{loadingTransfers ? "Refreshing…" : "Refresh"}</button></div></div><TransferToolbar search={fileSearch} onSearch={setFileSearch} status={fileStatus} onStatus={setFileStatus} sort={fileSort} onSort={setFileSort}/>{loadingTransfers ? <LoadingLine/> : received.length === 0 ? <EmptyState title="Your inbox is empty" text="Files sent directly to your RAVEN username or email will appear here."/> : displayedReceived.length === 0 ? <EmptyState title="No matching files" text="Try another search or status filter."/> : <div className="activity-list">{displayedReceived.map((item) => <TransferRow key={item.id} transfer={item} userId={user.id} kind="received" onCopy={setPageError}/>)}</div>}</section>}

          {page === "links" && <section className="content-card full-list-card"><div className="section-heading"><div><span className="section-kicker">LINK SHARING</span><h2>Shared links</h2></div><div className="section-actions"><span className="count-pill">{sharedLinks.length} links</span><button className="text-button" type="button" onClick={() => void refreshTransfers()} disabled={loadingTransfers}>{loadingTransfers ? "Refreshing…" : "Refresh"}</button></div></div><TransferToolbar search={fileSearch} onSearch={setFileSearch} status={fileStatus} onStatus={setFileStatus} sort={fileSort} onSort={setFileSort}/>{sharedLinks.length === 0 ? <EmptyState title="No shared links yet" text="Upload a file without choosing a recipient to create a share link."/> : displayedLinks.length === 0 ? <EmptyState title="No matching links" text="Try another search or status filter."/> : <div className="activity-list">{displayedLinks.map((item) => <TransferRow key={item.id} transfer={item} userId={user.id} kind="link" onCopy={setPageError} onRefresh={refreshTransfers}/>)}</div>}</section>}

          {page === "settings" && <ProfileSettings user={user} avatarUrl={avatarUrl} setUser={setUser} setAvatarUrl={setAvatarUrl} setError={setPageError} theme={theme} setTheme={setTheme} compact={compact} setCompact={setCompact}/>}
          <footer className="workspace-footer"><span>RAVEN / Your files, in one place.</span><span>Secure account workspace</span></footer>
        </main>
      </div>

      {usernameSetup && <div className="modal-backdrop setup-backdrop"><form className="dialog-card username-dialog" onSubmit={(event) => void finishUsernameSetup(event)}><div className="dialog-icon"><Icon name="user"/></div><span className="section-kicker">ONE LAST STEP</span><h2>Choose your RAVEN username</h2><p>Your account was created before usernames were introduced. Choose a unique username so other people can send files to you.</p><label className="field-label">Username<input name="username" minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" placeholder="e.g. raven_user" required autoFocus/><small>3–20 letters, numbers or underscores. You can change this later in Settings.</small></label>{pageError && <div className="form-alert">{pageError}</div>}<button className="primary-button" type="submit">Save username <Icon name="check"/></button></form></div>}
      {sendOpen && <SendModal userId={user.id} onClose={() => setSendOpen(false)} onComplete={async () => { await refreshTransfers(); }} />}
    </div>
  );
}

function StatCard({ icon, label, value, note }: { icon: string; label: string; value: string; note: string }) {
  return <article className="stat-card"><span className="stat-icon"><Icon name={icon}/></span><span className="stat-label">{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span className="empty-raven"><DeliveryRaven/></span><strong>{title}</strong><span>{text}</span></div>;
}
function TransferToolbar({ search, onSearch, status, onStatus, sort, onSort }: {
  search: string; onSearch: (value: string) => void;
  status: string; onStatus: (value: string) => void;
  sort: string; onSort: (value: string) => void;
}) {
  return <div className="transfer-toolbar">
    <label className="toolbar-search"><Icon name="search"/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search files, senders or recipients"/></label>
    <select aria-label="Filter by status" value={status} onChange={(event) => onStatus(event.target.value)}>
      <option value="all">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="expired">Expired</option><option value="revoked">Revoked</option><option value="cancelled">Cancelled</option><option value="failed">Failed</option>
    </select>
    <select aria-label="Sort files" value={sort} onChange={(event) => onSort(event.target.value)}>
      <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest first</option><option value="smallest">Smallest first</option>
    </select>
  </div>;
}

function LoadingLine() { return <div className="loading-line"><span/> Loading your files…</div>; }

function TransferRow({ transfer, kind, onCopy, onRefresh, userId }: { transfer: Transfer; kind: "sent" | "received" | "link"; onCopy?: (message: string) => void; onRefresh?: () => Promise<void>; userId?: string }) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState("");
  const downloadEncrypted = async () => {
    if (!userId || downloading) return;
    setDownloading(true);
    try { await decryptAndDownloadTransfer(transfer.id, userId); }
    catch (error) { onCopy?.(error instanceof Error ? error.message : "Could not decrypt this file."); }
    finally { setDownloading(false); }
  };
  const received = kind === "received";
  const title = kind === "link" ? "Share link" : received ? "Received file" : "Sent file";
  const downloadUrl = API + "/transfers/" + encodeURIComponent(transfer.id) + "/download";
  const shareLink = transfer.encryptionVersion === 1 ? getEncryptedShareLink(transfer.id) : transfer.shareUrl;
  const copy = async () => {
    if (!shareLink) return;
    try { await navigator.clipboard.writeText(shareLink); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }
    catch { onCopy?.("Clipboard unavailable. Open the share link and copy it manually."); }
  };
  const updateExpiry = async () => {
    setManaging(true);
    try {
      await api("/transfers/" + encodeURIComponent(transfer.id) + "/expiry", { method: "POST", body: JSON.stringify({ expiryHours: Number(expiryChoice) }) });
      onCopy?.("Share-link expiry updated."); await onRefresh?.();
    } catch (error) { onCopy?.(error instanceof Error ? error.message : "Could not update link expiry."); }
    finally { setManaging(false); }
  };
  const revokeLink = async () => {
    if (!window.confirm("Revoke this share link? Anyone using it will lose access.")) return;
    setManaging(true);
    try {
      await api("/transfers/" + encodeURIComponent(transfer.id) + "/revoke-link", { method: "POST", body: "{}" });
      onCopy?.("Share link revoked."); await onRefresh?.();
    } catch (error) { onCopy?.(error instanceof Error ? error.message : "Could not revoke this link."); }
    finally { setManaging(false); }
  };
  return <article className={"transfer-row" + (kind === "link" ? " transfer-row-link" : "")}>
    <span className="transfer-file-icon"><Icon name="file"/></span>
    <div className="transfer-file-meta"><strong>{transfer.filename}</strong><span>{bytes(transfer.filesize)} · {received ? "From " + (transfer.senderUsername ? "@" + transfer.senderUsername : transfer.senderName || transfer.senderEmail || "RAVEN user") : kind !== "link" && (transfer.recipientUsername || transfer.recipientName || transfer.recipientEmail) ? "To " + (transfer.recipientUsername ? "@" + transfer.recipientUsername : transfer.recipientName || transfer.recipientEmail) : transfer.createdAt ? new Date(transfer.createdAt).toLocaleString() : "Recently"}</span>
      {kind === "link" && <small>{transfer.expiresAt ? "Expires " + new Date(transfer.expiresAt).toLocaleString() : "No expiry set"} · {(transfer.viewCount || 0)} access requests · {(transfer.downloadCount || 0)} download requests · counts are not unique visitors</small>}
    </div>
    <span className={"transfer-type type-" + kind}>{title}</span>
    {transfer.status === "completed" && transfer.encryptionVersion === 1 && userId && <button className="outline-button download-button" type="button" disabled={downloading} onClick={() => void downloadEncrypted()}><Icon name="lock"/>{downloading ? "Decrypting…" : "Decrypt & download"}</button>}
    {(received || kind === "sent") && transfer.status === "completed" && transfer.encryptionVersion !== 1 && <a className="outline-button download-button" href={downloadUrl}><Icon name="download"/> Download</a>}
    {kind === "link" && transfer.status === "completed" && shareLink && <button className="outline-button" onClick={() => void copy()}><Icon name="copy"/> {copied ? "Copied" : "Copy link"}</button>}
    {kind === "link" && transfer.encryptionVersion === 1 && transfer.status === "completed" && !shareLink && <span className="transfer-type">Link key only available in the send confirmation</span>}
    {kind === "link" && transfer.status === "completed" && <div className="link-management">
      <select aria-label="Link expiry" value={expiryChoice} onChange={(event) => setExpiryChoice(event.target.value)} disabled={managing}>
        <option value="" disabled>Choose new expiry</option><option value="1">1 hour</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option><option value="720">30 days</option>
      </select>
      <button className="small-text-button" type="button" disabled={managing || !expiryChoice} onClick={() => void updateExpiry()}>{managing ? "Saving…" : "Update expiry"}</button>
      <button className="small-text-button danger-text" type="button" disabled={managing} onClick={() => void revokeLink()}>Revoke</button>
    </div>}
    {!received && kind !== "link" && shareLink && transfer.status === "completed" && <button className="quiet-icon-button" title="Copy share link" onClick={() => void copy()}><Icon name="copy"/></button>}
    {transfer.status !== "completed" && <span className={"status-tag status-" + transfer.status}>{transfer.status}</span>}
  </article>;
}


function EncryptionSettings({ userId }: { userId: string }) {
  const [keyRecord, setKeyRecord] = useState<StoredEncryptionKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const unlocked = Boolean(getCachedEncryptionIdentity(userId));

  const reloadKey = async () => {
    setLoading(true);
    try {
      const result = await api<{ key: StoredEncryptionKey | null }>("/encryption/keys/me");
      setKeyRecord(result.key);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load encryption settings.");
    } finally { setLoading(false); }
  };
  useEffect(() => { void reloadKey(); }, [userId]);
  useEffect(() => {
    let active = true;
    if (!keyRecord) { setFingerprint(""); return; }
    void getKeyFingerprint(keyRecord.public_key)
      .then((value) => { if (active) setFingerprint(value); })
      .catch((fingerprintError) => {
        if (active) setError(fingerprintError instanceof Error ? fingerprintError.message : "Could not calculate your key fingerprint.");
      });
    return () => { active = false; };
  }, [keyRecord]);

  const setup = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const created = await createEncryptionIdentity();
      await api("/encryption/keys/me", { method: "PUT", body: JSON.stringify(created.payload) });
      cacheEncryptionIdentity(userId, created.identity.pair);
      setRecoveryCode(created.recoveryCode);
      setMessage("Encryption key created. Save your recovery code before leaving this screen.");
      await reloadKey();
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : "Could not create your encryption key.");
    } finally { setBusy(false); }
  };
  const unlock = async () => {
    setError(""); setMessage("");
    const code = window.prompt("Enter your RAVEN encryption recovery code. RAVEN cannot recover this code for you.");
    if (!code) return;
    setBusy(true);
    try {
      const result = await api<{ key: StoredEncryptionKey | null }>("/encryption/keys/me");
      if (!result.key) throw new Error("No encryption key has been set up for this account.");
      await unlockEncryptionIdentity(userId, result.key, code);
      setKeyRecord(result.key);
      setMessage("Encryption is unlocked in this browser tab.");
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : "Could not unlock encryption.");
    } finally { setBusy(false); }
  };
  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setMessage("Fingerprint copied. Share it through a separate trusted channel.");
    } catch { setError("Clipboard access is unavailable. Select and copy the fingerprint manually."); }
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setMessage("Recovery code copied. Store it somewhere safe.");
    } catch { setError("Clipboard access is unavailable. Select and copy the code manually."); }
  };

  return <section className="content-card settings-card">
    <div className="section-heading"><div><span className="section-kicker">PRIVATE FILE TRANSFERS</span><h2>End-to-end encryption</h2></div><span className="count-pill">{keyRecord ? "Key created" : "Not configured"}</span></div>
    <p>Files sent directly to another RAVEN account can be encrypted in your browser. RAVEN stores the encrypted file and encrypted key copies, not your readable private key.</p>
    {loading ? <LoadingLine/> : !keyRecord ? <div className="settings-block"><div><h3>Set up your encryption identity</h3><p>You and the person receiving a file must each set this up before encrypted transfers are possible.</p></div><button className="primary-button compact-button" type="button" disabled={busy} onClick={() => void setup()}>{busy ? "Setting up…" : "Set up encryption"}</button></div> : <div className="settings-block"><div><h3>Your encryption identity</h3><p>{unlocked ? "Unlocked in this browser tab." : "Your private key is locked. Enter your recovery code to use encrypted transfers."}</p></div><button className="outline-button" type="button" disabled={busy || unlocked} onClick={() => void unlock()}>{busy ? "Please wait…" : unlocked ? "Unlocked" : "Unlock encryption"}</button></div>}
    {keyRecord && fingerprint && <div className="settings-block"><div><h3>Your public-key fingerprint</h3><p>Share this fingerprint with people who send you files. They should compare it with you through a separate trusted channel before accepting your encryption key.</p></div><div className="username-edit"><textarea className="recovery-code-field" value={fingerprint} readOnly rows={2}/><button className="outline-button" type="button" onClick={() => void copyFingerprint()}>Copy fingerprint</button></div></div>}
    {recoveryCode && <div className="settings-block"><div><h3>Save your recovery code</h3><p>This is the only way to restore your private encryption key on another device. Losing it may make encrypted files permanently unreadable.</p></div><div className="username-edit"><textarea className="recovery-code-field" value={recoveryCode} readOnly rows={2}/><button className="outline-button" type="button" onClick={() => void copyCode()}>Copy recovery code</button><button className="primary-button compact-button" type="button" onClick={() => setRecoveryCode("")}>I've saved it</button></div></div>}
    {message && <div className="success-message"><Icon name="check"/>{message}</div>}
    {error && <div className="form-alert" role="alert">{error}</div>}
    <small className="settings-warning">New direct transfers and public share links are end-to-end encrypted in this experimental build. Older transfers remain legacy and are not retroactively encrypted.</small>
  </section>;
}

function AccountSecuritySettings() {
  const [sessions, setSessions] = useState<{id:string;createdAt:string;expiresAt:string;current:boolean}[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const loadSessions = async () => {
    setLoading(true);
    try {
      const result = await api<{sessions:{id:string;createdAt:string;expiresAt:string;current:boolean}[]}>("/auth/sessions");
      setSessions(result.sessions);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load active sessions."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadSessions(); }, []);
  const revokeOthers = async () => {
    if (!window.confirm("Sign out all other RAVEN sessions? This browser will stay signed in.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{message:string;signedOut:number}>("/auth/sessions/others", { method: "DELETE" });
      setMessage(result.message); await loadSessions();
    } catch (revokeError) { setError(revokeError instanceof Error ? revokeError.message : "Could not sign out other sessions."); }
    finally { setBusy(false); }
  };
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation do not match.");
      setMessage("");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a new password that is different from your current password.");
      setMessage("");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{message:string}>("/auth/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setMessage(result.message); formElement.reset(); await loadSessions();
    } catch (passwordError) { setError(passwordError instanceof Error ? passwordError.message : "Could not change password."); }
    finally { setBusy(false); }
  };
  return <section className="settings-card secondary-settings-card">
    <div className="section-heading"><div><span className="section-kicker">ACCOUNT PROTECTION</span><h2>Password & sessions</h2></div></div>
    <form className="settings-block password-form" onSubmit={(event) => void changePassword(event)}>
      <div><h3>Change password</h3><p>Changing your password signs out other active sessions.</p></div>
      <div className="password-fields"><label className="field-label">Current password<input name="currentPassword" type="password" autoComplete="current-password" minLength={8} maxLength={128} required/></label><label className="field-label">New password<input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><label className="field-label">Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><button className="primary-button compact-button" disabled={busy}>Update password</button></div>
    </form>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Active sessions</h3><p>Review signed-in sessions. The current browser is identified below.</p></div><div className="session-list">{loading ? <LoadingLine/> : sessions.length === 0 ? <small>No active sessions found.</small> : sessions.map((session) => <div className="session-item" key={session.id}><span><strong>{session.current ? "This device" : "Other session"}</strong><small>Signed in {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</small></span>{session.current && <span className="status-tag status-completed">Current</span>}</div>)}<div className="session-actions"><button className="outline-button" type="button" onClick={() => void loadSessions()} disabled={busy || loading}>{loading ? "Refreshing…" : "Refresh sessions"}</button><button className="outline-button" type="button" onClick={() => void revokeOthers()} disabled={busy || loading || sessions.filter((session) => !session.current).length === 0}>{busy ? "Please wait…" : "Sign out other sessions"}</button></div></div></div>
    {message && <div className="success-message"><Icon name="check"/>{message}</div>}
    {error && <div className="form-alert" role="alert">{error}</div>}
  </section>;
}

function ProfileSettings({ user, avatarUrl, setUser, setAvatarUrl, setError, theme, setTheme, compact, setCompact }: {
  user: User; avatarUrl: string; setUser: (user: User) => void; setAvatarUrl: (url: string) => void; setError: (error: string) => void;
  theme: "dark" | "light"; setTheme: (value: "dark" | "light") => void; compact: boolean; setCompact: (value: boolean) => void;
}) {
  const [username, setUsername] = useState(user.username || "");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [displaySaving, setDisplaySaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [message, setMessage] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  useEffect(() => setUsername(user.username || ""), [user.username]);
  const saveDisplayName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setDisplaySaving(true); setMessage(""); setError("");
    try {
      const result = await api<{ user: User }>("/profile/display-name", { method: "PUT", body: JSON.stringify({ displayName }) });
      setUser(result.user); setDisplayName(result.user.displayName); setMessage("Display name updated.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update display name."); }
    finally { setDisplaySaving(false); }
  };
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
  const removeAvatar = async () => {
    if (!window.confirm("Remove your profile picture?")) return;
    setPhotoBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ user: User; message: string }>("/profile/avatar", { method: "DELETE" });
      setUser(result.user);
      setAvatarUrl("");
      setMessage(result.message);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not remove profile photo."); }
    finally { setPhotoBusy(false); }
  };
  return <section className="content-card settings-card"><div className="section-heading"><div><span className="section-kicker">YOUR ACCOUNT</span><h2>Profile settings</h2></div></div>
    <div className="profile-summary"><Avatar user={user} imageUrl={avatarUrl} size="large"/><div><strong>{user.displayName}</strong><span>@{user.username}</span><small>{user.email}</small></div></div>
    <form className="settings-block username-settings" onSubmit={(event) => void saveDisplayName(event)}><div><h3>Display name</h3><p>This name is shown to people receiving files from you.</p></div><div className="username-edit"><label className="field-label">Your name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={60} required/></label><button className="primary-button compact-button" disabled={displaySaving || displayName.trim() === user.displayName}>{displaySaving ? "Saving…" : "Save name"}</button></div></form>
    <EncryptionSettings userId={user.id}/>
    <AccountSecuritySettings/>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Appearance</h3><p>Choose how RAVEN looks on this device.</p></div><div className="appearance-controls"><label>Theme<select value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}><option value="dark">Dark</option><option value="light">Light</option></select></label><label className="toggle-setting"><input type="checkbox" checked={compact} onChange={(event) => setCompact(event.target.checked)}/> Compact file lists</label></div></div>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Profile picture</h3><p>Your initials are used by default. Add a picture whenever you're ready.</p></div><div className="photo-actions"><div className="photo-buttons"><button className="outline-button" type="button" onClick={() => avatarInput.current?.click()} disabled={photoBusy}>{photoBusy ? "Please wait…" : "Change photo"}</button>{avatarUrl && <button className="small-text-button danger-text" type="button" onClick={() => void removeAvatar()} disabled={photoBusy}>Remove photo</button>}</div><input ref={avatarInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void uploadAvatar(event)}/><small>JPG, PNG, WebP or GIF · Max 2 MB</small></div></div>
    <div className="settings-divider"/>
    <form className="settings-block username-settings" onSubmit={(event) => void saveUsername(event)}><div><h3>Username</h3><p>This is how other people can find you when sending files.</p></div><div className="username-edit"><label className="field-label">Your username<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" required/></label><button className="primary-button compact-button" disabled={saving || username === user.username}>{saving ? "Saving…" : "Save username"}</button></div></form>
    <div className="settings-divider"/>
    <div className="settings-block"><div><h3>Email address</h3><p>Your email can also be used to receive files. Email changes will be enabled with email verification.</p></div><strong className="settings-email">{user.email}</strong></div>
    {message && <div className="success-message"><Icon name="check"/>{message}</div>}
  </section>;
}

function SendModal({ userId, onClose, onComplete }: { userId: string; onClose: () => void; onComplete: () => Promise<void> }) {
  const [recipient, setRecipient] = useState("");
  const [recipientMatch, setRecipientMatch] = useState<{ id: string; displayName: string; username: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [transferId, setTransferId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRequests = useRef<Set<XMLHttpRequest>>(new Set());
  const cancelled = useRef(false);
  const encryptionSession = useRef<TransferEncryptionSession | null>(null);
  const CHUNK_SIZE = 8 * 1024 * 1024 - 16;
  const SERVER_CHUNK_SIZE = 8 * 1024 * 1024;
  const CONCURRENT_CHUNKS = 3;
  const MAX_RETRIES = 3;

  const chooseFile = (file?: File) => {
    if (!file) return;
    if (transferId) {
      void api("/transfers/" + encodeURIComponent(transferId) + "/chunks", { method: "DELETE" }).catch(() => undefined);
      setTransferId(null);
      encryptionSession.current = null;
    }
    setError(""); setShareUrl(""); setDelivery("idle"); setProgress(0);
    if (file.size > MAX_MB * 1024 * 1024) { setSelected(null); setError("File exceeds the " + MAX_MB + " MB limit."); return; }
    setSelected(file);
  };
  const lookupRecipient = async (): Promise<{ id: string; displayName: string; username: string | null } | null> => {
    const value = recipient.trim();
    setRecipientError(""); setRecipientMatch(null);
    if (!value) return null;
    try {
      const result = await api<{ user: { id: string; displayName: string; username: string | null } }>("/users/lookup?identifier=" + encodeURIComponent(value));
      setRecipientMatch(result.user);
      return result.user;
    } catch (error) {
      setRecipientError(error instanceof Error ? error.message : "Could not find that RAVEN account.");
      return null;
    }
  };
  const putChunk = (id: string, index: number, blob: Blob, digest: string, onProgress: (loaded: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeRequests.current.add(xhr);
      const finish = () => activeRequests.current.delete(xhr);
      xhr.open("PUT", API + "/transfers/" + encodeURIComponent(id) + "/chunks/" + index);
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-Chunk-Sha256", digest);
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(blob.size, event.loaded)); };
      xhr.onload = () => {
        finish();
        if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
        let message = "Chunk " + (index + 1) + " upload failed (" + xhr.status + ").";
        try { const response = JSON.parse(xhr.responseText) as { error?: string }; if (response.error) message = response.error; } catch { /* keep fallback */ }
        reject(new Error(message));
      };
      xhr.onerror = () => { finish(); reject(new Error("Network error while uploading chunk " + (index + 1) + ".")); };
      xhr.onabort = () => { finish(); reject(new Error("Upload cancelled.")); };
      const form = new FormData();
      form.append("chunk", blob, "chunk-" + index + ".part");
      xhr.send(form);
    });
  const dismiss = () => {
    if (transferId) void api("/transfers/" + encodeURIComponent(transferId) + "/chunks", { method: "DELETE" }).catch(() => undefined);
    encryptionSession.current = null;
    onClose();
  };
  const cancelUpload = async () => {
    cancelled.current = true;
    for (const xhr of activeRequests.current) xhr.abort();
    const id = transferId;
    if (id) await api("/transfers/" + encodeURIComponent(id) + "/chunks", { method: "DELETE" }).catch(() => undefined);
    setTransferId(null);
    encryptionSession.current = null;
    setBusy(false);
    setDelivery("idle");
    setProgress(0);
    setError("Upload cancelled. Temporary chunks have been removed where available.");
  };
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || busy || delivery === "success") return;
    setError(""); setRecipientError(""); setShareUrl("");
    let resolvedRecipient = recipientMatch;
    if (recipient.trim() && !resolvedRecipient) {
      resolvedRecipient = await lookupRecipient();
      if (!resolvedRecipient) return;
    }

    cancelled.current = false;
    setBusy(true); setDelivery("preparing"); setProgress(0);
    let activeId = transferId;
    try {
      const senderIdentity = await requireUnlockedEncryptionIdentity(userId);
      let recipientKey: { user_id: string; key_version: number; public_key: string } | null = null;
      if (resolvedRecipient) {
        const recipientKeyResult = await api<{ key: { user_id: string; key_version: number; public_key: string } }>(
          "/encryption/keys/" + encodeURIComponent(resolvedRecipient.id) + "/public"
        );
        recipientKey = recipientKeyResult.key;
        await verifyAndPinPeerKey(userId, recipientKey.user_id, recipientKey.public_key, "the recipient");
      }

      if (!activeId) {
        const chunkCount = Math.max(1, Math.ceil(selected.size / CHUNK_SIZE));
        const encryptedSize = selected.size + chunkCount * 16;
        if (encryptedSize > MAX_MB * 1024 * 1024) {
          throw new Error("This file is too large after encryption overhead. Choose a slightly smaller file.");
        }
        const created = await api<{ transfer: { id: string } }>("/transfers", {
          method: "POST",
          body: JSON.stringify({
            filename: "Encrypted file",
            filesize: encryptedSize,
            recipientIdentifier: resolvedRecipient ? recipient.trim() : undefined,
            encryptionVersion: 1
          })
        });
        activeId = created.transfer.id;
        setTransferId(activeId);
        if (cancelled.current) {
          await api("/transfers/" + encodeURIComponent(activeId) + "/chunks", { method: "DELETE" }).catch(() => undefined);
          return;
        }
      }

      if (!encryptionSession.current) {
        encryptionSession.current = await createTransferEncryptionSession(
          selected,
          activeId,
          userId,
          senderIdentity.pair,
          senderIdentity.keyVersion,
          recipientKey?.user_id ?? null,
          recipientKey?.public_key ?? null,
          recipientKey ? Number(recipientKey.key_version) : null
        );
      }
      const session = encryptionSession.current;
      await api("/transfers/" + encodeURIComponent(activeId) + "/envelopes", {
        method: "POST",
        body: JSON.stringify({
          encryptedMetadata: session.encryptedMetadata,
          metadataNonce: encodeBase64(session.metadataNonce),
          envelopes: session.envelopes
        })
      });

      const startData = await api<{ receivedChunks: { chunk_index: number; chunk_size: number }[]; receivedBytes: number }>(
        "/transfers/" + encodeURIComponent(activeId) + "/chunks/start",
        { method: "POST", body: JSON.stringify({
          chunkSize: SERVER_CHUNK_SIZE,
          chunkCount: session.chunkCount,
          mimeType: "application/octet-stream"
        }) }
      );
      if (cancelled.current) {
        await api("/transfers/" + encodeURIComponent(activeId) + "/chunks", { method: "DELETE" }).catch(() => undefined);
        return;
      }
      const received = new Set(startData.receivedChunks.map((chunk) => Number(chunk.chunk_index)));
      let completedBytes = startData.receivedBytes;
      setProgress(session.cipherSize ? Math.min(99, Math.round(completedBytes / session.cipherSize * 100)) : 0);
      setDelivery("flying");
      const inFlight = new Map<number, number>();
      let nextIndex = 0;
      const updateProgress = () => {
        const currentBytes = [...inFlight.values()].reduce((total, amount) => total + amount, 0);
        setProgress(session.cipherSize ? Math.min(99, Math.round((completedBytes + currentBytes) / session.cipherSize * 100)) : 0);
      };
      const worker = async () => {
        while (nextIndex < session.chunkCount && !cancelled.current) {
          const index = nextIndex++;
          if (received.has(index)) continue;
          const offset = index * session.plaintextChunkSize;
          const plaintext = selected.slice(offset, Math.min(selected.size, offset + session.plaintextChunkSize));
          const encryptedBytes = await encryptTransferChunk(session, activeId!, index, plaintext);
          const encryptedBlob = new Blob([encryptedBytes.buffer.slice(encryptedBytes.byteOffset, encryptedBytes.byteOffset + encryptedBytes.byteLength) as ArrayBuffer], { type: "application/octet-stream" });
          const digestBytes = await crypto.subtle.digest("SHA-256", await encryptedBlob.arrayBuffer());
          const digest = Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
          let lastError: unknown = null;
          for (let attempt = 1; attempt <= MAX_RETRIES && !cancelled.current; attempt++) {
            try {
              inFlight.set(index, 0);
              await putChunk(activeId!, index, encryptedBlob, digest, (loaded) => { inFlight.set(index, loaded); updateProgress(); });
              completedBytes += encryptedBlob.size;
              inFlight.delete(index);
              updateProgress();
              lastError = null;
              break;
            } catch (uploadError) {
              inFlight.delete(index);
              updateProgress();
              lastError = uploadError;
              if (cancelled.current) return;
              if (attempt < MAX_RETRIES) await new Promise((resolve) => window.setTimeout(resolve, attempt * 600));
            }
          }
          if (lastError) throw lastError instanceof Error ? lastError : new Error("An encrypted chunk could not be uploaded.");
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENT_CHUNKS, session.chunkCount) }, () => worker()));
      if (cancelled.current) return;
      if (completedBytes < session.cipherSize) throw new Error("Some encrypted chunks are still missing. Retry the delivery to continue.");
      const completion = await api<{ shareUrl?: string | null }>("/transfers/" + encodeURIComponent(activeId) + "/chunks/complete", {
        method: "POST", body: "{}"
      });
      let completedShareLink = "";
      if (!resolvedRecipient && completion.shareUrl) {
        const shareTokenFromApi = new URL(completion.shareUrl).pathname.split("/").filter(Boolean).pop();
        if (!shareTokenFromApi) throw new Error("The server completed the encrypted upload but did not return a valid share token.");
        completedShareLink = window.location.origin + "/?share=" + encodeURIComponent(shareTokenFromApi) + "#key=" + encodeURIComponent(session.shareKey);
        rememberEncryptedShareLink(activeId, completedShareLink);
      }
      setShareUrl(completedShareLink);
      setProgress(100); setDelivery("success"); setSelected(null); setTransferId(null);
      encryptionSession.current = null;
      if (fileInput.current) fileInput.current.value = "";
      await onComplete();
    } catch (error) {
      if (!cancelled.current) {
        if (activeId && !encryptionSession.current) {
          await api("/transfers/" + encodeURIComponent(activeId) + "/chunks", { method: "DELETE" }).catch(() => undefined);
          setTransferId(null);
        }
        setDelivery("error");
        setError(error instanceof Error ? error.message : "Could not send this encrypted file.");
      }
    } finally {
      setBusy(false);
      activeRequests.current.clear();
    }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setError("Clipboard unavailable. Copy the link manually."); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) dismiss(); }}>
    <form className="dialog-card send-dialog" onSubmit={(event) => void send(event)}>
      <div className="dialog-heading"><div><span className="section-kicker">ENCRYPTED DELIVERY</span><h2>Send a file</h2><p>Your file is encrypted on this device before upload.</p></div><button className="icon-button close-dialog" type="button" onClick={dismiss} disabled={busy} aria-label="Close"><Icon name="close"/></button></div>
      <label className="field-label">Recipient <span className="optional-label">Optional · leave blank for an encrypted share link</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); setRecipientMatch(null); setRecipientError(""); }} onBlur={() => { if (recipient.trim() && !transferId) void lookupRecipient(); }} placeholder="Email address or @username (optional)" disabled={busy || Boolean(transferId)}/></label>
      {recipientMatch && <div className="recipient-confirm"><Avatar user={{ id: "recipient", displayName: recipientMatch.displayName, username: recipientMatch.username, email: "" }} size="small"/><div><strong>{recipientMatch.displayName}</strong><span>@{recipientMatch.username}</span></div><Icon name="check"/></div>}
      {recipientError && <div className="form-alert">{recipientError}</div>}
      <div className="field-label">File to send
        <div className={"file-drop-zone" + (dragging ? " dragging" : "")} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop} onClick={() => !busy && !transferId && fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy && !transferId) fileInput.current?.click(); }}>
          <input ref={fileInput} className="visually-hidden" type="file" onChange={(event) => chooseFile(event.target.files?.[0])} disabled={busy || Boolean(transferId)}/>
          {selected ? <><span className="file-drop-icon"><Icon name="file"/></span><strong className="chosen-file-name">{selected.name}</strong><span>{bytes(selected.size)} · {transferId ? "Ready to resume" : "Ready to deliver"}</span><button className="remove-selected" type="button" disabled={busy || Boolean(transferId)} onClick={(event) => { event.stopPropagation(); setSelected(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove file</button></> : <><span className="file-drop-icon"><Icon name="upload"/></span><strong>Drop your file here</strong><span>or <b>browse your device</b></span><small>Maximum file size: {MAX_MB} MB</small></>}
        </div>
      </div>
      {delivery !== "idle" && <div className={"delivery-stage delivery-" + delivery}>
        <div className="delivery-track"><span className="delivery-track-start"/><span className="delivery-track-end"/><div className={"raven-flight" + (delivery === "flying" ? " in-flight" : "") + (delivery === "success" ? " landed" : "")}><DeliveryRaven/></div></div>
        <strong>{delivery === "preparing" ? "Preparing your delivery…" : delivery === "flying" ? "Your raven is on its way!" : delivery === "success" ? "Delivery complete!" : "Delivery could not be completed"}</strong>
        <span>{delivery === "flying" ? "Sending verified chunks · " + progress + "%" : delivery === "preparing" ? "Preparing your file chunks." : delivery === "success" ? "All chunks verified and delivered." : "Your accepted chunks are saved for a retry during this session."}</span>
      </div>}
      {error && <div className="form-alert" role="alert">{error}</div>}
      {shareUrl && <div className="share-result"><div><span className="section-kicker">SHARE LINK READY</span><strong>{shareUrl}</strong></div><button className="outline-button" type="button" onClick={() => void copyLink()}><Icon name="copy"/>{copied ? "Copied" : "Copy"}</button></div>}
      <div className="dialog-actions">
        <button className="secondary-action" type="button" onClick={() => busy ? void cancelUpload() : dismiss()}>{busy ? "Cancel upload" : delivery === "success" ? "Done" : "Cancel"}</button>
        <button className="primary-button send-submit" type="submit" disabled={!selected || busy || delivery === "success"}>{busy ? "Sending chunks…" : delivery === "success" ? "Sent successfully" : transferId ? <>Retry delivery <Icon name="send"/></> : <>Send file <Icon name="send"/></>}</button>
      </div>
      <p className="modal-footnote">RAVEN encrypts each file chunk on your device. Direct transfers wrap the decryption key for both accounts. For a public share link, anyone with the complete link (including its key after #) can decrypt the file. Copy and share that link carefully; RAVEN does not store the link key.</p>
    </form>
  </div>;
}
export default App;