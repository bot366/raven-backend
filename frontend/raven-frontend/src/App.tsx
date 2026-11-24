import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

type HealthState = "checking" | "online" | "offline";

type TransferRecord = {
  id: string;
  filename: string;
  filesize: number;
  status: string;
  createdAt?: string;
  uploadedAt?: string | null;
  expiresAt?: string | null;
  downloadUrl?: string | null;
};

type UploadResult = {
  message?: string;
  transfer: TransferRecord;
  shareUrl?: string;
};

type RecentUpload = {
  id: string;
  filename: string;
  filesize: number;
  shareUrl: string;
  downloadUrl: string;
  uploadedAt: string;
};

const API_BASE = (import.meta.env.VITE_API_URL || "https://raven-backend-qg3w.onrender.com").replace(/\/$/, "");
const MAX_FILE_SIZE_MB = Number(import.meta.env.VITE_MAX_FILE_SIZE_MB || 100);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function App() {
  const [health, setHealth] = useState<HealthState>("checking");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const checkHealth = useCallback(async () => {
    setHealth("checking");
    try {
      const response = await fetch(`${API_BASE}/health`, { method: "GET" });
      if (!response.ok) throw new Error(`Health check returned ${response.status}`);
      const data: unknown = await response.json();
      if (
        data &&
        typeof data === "object" &&
        "status" in data &&
        (data as { status?: unknown }).status === "ok"
      ) {
        setHealth("online");
      } else {
        setHealth("offline");
      }
    } catch {
      setHealth("offline");
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const chooseFile = (file?: File) => {
    if (!file) return;
    setError("");
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setSelectedFile(null);
      setError(`This file is larger than the ${MAX_FILE_SIZE_MB} MB upload limit.`);
      return;
    }
    setSelectedFile(file);
    setProgress(0);
  };

  const uploadFile = async () => {
    if (!selectedFile || uploading) return;
    setError("");
    setUploading(true);
    setProgress(0);

    try {
      // First create a pending transfer record in Neon.
      const createResponse = await fetch(`${API_BASE}/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: selectedFile.name,
          filesize: selectedFile.size,
        }),
      });

      const createPayload: unknown = await createResponse.json().catch(() => null);
      if (!createResponse.ok) {
        throw new Error(errorMessage(createPayload, `Could not create transfer (${createResponse.status}).`));
      }

      const createdTransfer =
        createPayload && typeof createPayload === "object" && "transfer" in createPayload
          ? (createPayload as { transfer?: { id?: string } }).transfer
          : undefined;
      const transferId = createdTransfer?.id;
      if (!transferId) throw new Error("The API did not return a transfer ID.");

      // Then upload the selected file as multipart form data.
      const uploadPayload = await new Promise<UploadResult>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", `${API_BASE}/transfers/${encodeURIComponent(transferId)}/upload`);
        request.responseType = "text";
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
          }
        };
        request.onload = () => {
          let body: unknown = null;
          try {
            body = request.responseText ? JSON.parse(request.responseText) : null;
          } catch {
            body = null;
          }
          if (request.status < 200 || request.status >= 300) {
            reject(new Error(errorMessage(body, `Upload failed (${request.status}).`)));
            return;
          }
          if (!body || typeof body !== "object" || !("transfer" in body)) {
            reject(new Error("The upload succeeded but returned an unexpected response."));
            return;
          }
          resolve(body as UploadResult);
        };
        request.onerror = () => reject(new Error("Network error while uploading. Check your connection and try again."));
        request.onabort = () => reject(new Error("Upload was cancelled."));
        const form = new FormData();
        form.append("file", selectedFile, selectedFile.name);
        request.send(form);
      });

      const completed = uploadPayload.transfer;
      const shareUrl = uploadPayload.shareUrl || `${API_BASE}/share/`;
      const downloadUrl = completed.downloadUrl || `${API_BASE}/transfers/${encodeURIComponent(transferId)}/download`;
      setProgress(100);
      setRecentUploads((items) => [
        {
          id: completed.id || transferId,
          filename: completed.filename || selectedFile.name,
          filesize: Number(completed.filesize ?? selectedFile.size),
          shareUrl,
          downloadUrl,
          uploadedAt: new Date().toISOString(),
        },
        ...items,
      ]);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong while uploading.");
    } finally {
      setUploading(false);
    }
  };

  const copyValue = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
    } catch {
      setError("Clipboard access was blocked by your browser. You can copy the link from the address field instead.");
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RAVEN home">
          <span className="brand-mark" aria-hidden="true"><RavenMark /></span>
          <span>RAVEN</span>
        </a>
        <div className="topbar-right">
          <span className={`status-pill status-${health}`}>
            <span className="status-dot" />
            {health === "checking" ? "Checking API" : health === "online" ? "API connected" : "API unreachable"}
          </span>
          <button className="icon-button" type="button" onClick={() => void checkHealth()} title="Check backend status" aria-label="Refresh backend status">
            <RefreshIcon />
          </button>
        </div>
      </header>

      <main id="top" className="main-content">
        <section className="hero">
          <div className="eyebrow"><span className="eyebrow-line" /> SIMPLE FILE SHARING</div>
          <h1>Send files.<br /><span>Not complications.</span></h1>
          <p className="hero-copy">Drop a file, upload it, and share a direct link. Your files move through the RAVEN API.</p>
        </section>

        <section className="workspace" aria-label="File upload">
          <div className="upload-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">NEW TRANSFER</p>
                <h2>Upload a file</h2>
              </div>
              <span className="secure-note"><ShieldIcon /> API powered</span>
            </div>

            <div
              className={`drop-zone${dragging ? " is-dragging" : ""}${selectedFile ? " has-file" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={onDrop}
              onClick={() => !uploading && fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !uploading) fileInputRef.current?.click(); }}
              aria-label="Choose a file or drop it here"
            >
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                onChange={(event) => chooseFile(event.target.files?.[0])}
                disabled={uploading}
              />
              {selectedFile ? (
                <>
                  <div className="file-icon"><FileIcon /></div>
                  <div className="selected-file-name">{selectedFile.name}</div>
                  <div className="drop-hint">{formatBytes(selectedFile.size)} <span>·</span> Ready to upload</div>
                  <button
                    className="remove-file"
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setSelectedFile(null); setProgress(0); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    disabled={uploading}
                  >Remove file</button>
                </>
              ) : (
                <>
                  <div className="upload-icon"><UploadIcon /></div>
                  <div className="drop-title">Drop your file here</div>
                  <div className="drop-hint">or <span className="browse-text">browse files</span> on your device</div>
                  <div className="file-limit">Maximum file size: {MAX_FILE_SIZE_MB} MB</div>
                </>
              )}
            </div>

            {uploading && (
              <div className="progress-wrap" aria-live="polite">
                <div className="progress-label"><span>Uploading to RAVEN</span><strong>{progress}%</strong></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
              </div>
            )}

            {error && <div className="error-message" role="alert"><AlertIcon /> <span>{error}</span></div>}

            <button className="upload-button" type="button" disabled={!selectedFile || uploading || health === "offline"} onClick={() => void uploadFile()}>
              {uploading ? <><span className="button-spinner" /> Uploading…</> : <>Upload file <ArrowIcon /></>}
            </button>
            {health === "offline" && <p className="offline-hint">The backend is not responding. Check the API status and try again.</p>}
            <p className="privacy-note"><LockIcon /> Your file is sent directly to the RAVEN backend.</p>
          </div>

          <aside className="side-panel">
            <div className="side-card connection-card">
              <div className="side-card-icon"><PulseIcon /></div>
              <div className="side-card-content">
                <p className="section-kicker">BACKEND STATUS</p>
                <h3>{health === "online" ? "Everything is connected" : health === "checking" ? "Checking connection" : "Connection unavailable"}</h3>
                <p>{health === "online" ? "RAVEN can reach the API and database health endpoint." : health === "checking" ? "Contacting your hosted RAVEN API." : "The API health check did not succeed."}</p>
                <span className={`connection-state state-${health}`}><span className="status-dot" />{health === "online" ? "Operational" : health === "checking" ? "Checking" : "Offline"}</span>
              </div>
            </div>
            <div className="side-card how-card">
              <p className="section-kicker">HOW IT WORKS</p>
              <ol className="steps-list">
                <li><span className="step-number">01</span><div><strong>Create a transfer</strong><p>RAVEN records the transfer in the database.</p></div></li>
                <li><span className="step-number">02</span><div><strong>Upload your file</strong><p>The backend receives and stores the file.</p></div></li>
                <li><span className="step-number">03</span><div><strong>Share the link</strong><p>Copy the generated link to let someone download it.</p></div></li>
              </ol>
            </div>
            <div className="api-address"><span className="api-address-label">CONNECTED API</span><span className="api-address-value">{API_BASE.replace(/^https?:\/\//, "")}</span><span className="api-lock"><LockIcon /></span></div>
          </aside>
        </section>

        {recentUploads.length > 0 && (
          <section className="recent-section">
            <div className="recent-heading"><div><p className="section-kicker">THIS SESSION</p><h2>Recent uploads</h2></div><span className="recent-count">{recentUploads.length} {recentUploads.length === 1 ? "file" : "files"}</span></div>
            <div className="recent-list">
              {recentUploads.map((item) => (
                <article className="recent-item" key={item.id}>
                  <div className="recent-file-icon"><FileIcon /></div>
                  <div className="recent-file-info"><strong title={item.filename}>{item.filename}</strong><span>{formatBytes(item.filesize)} <span className="meta-dot">·</span> Uploaded just now</span></div>
                  <div className="recent-actions">
                    <button type="button" className="secondary-button" onClick={() => window.open(item.downloadUrl, "_blank", "noopener,noreferrer")}><DownloadIcon /> Download</button>
                    <button type="button" className="copy-button" onClick={() => void copyValue(item.shareUrl, item.id)}>{copied === item.id ? <CheckIcon /> : <CopyIcon />}{copied === item.id ? "Copied" : "Copy link"}</button>
                  </div>
                </article>
              ))}
            </div>
            <p className="session-note">Recent uploads are shown in this browser session only. The backend does not currently provide a list-all-transfers endpoint.</p>
          </section>
        )}

        <footer className="footer">
          <span>RAVEN <span className="footer-divider">/</span> File sharing in progress.</span>
          <span>Early test build</span>
        </footer>
      </main>
    </div>
  );
}

function RavenMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 8.5 28.5 5 36 13.5 25 35l-5-10-8 6 3-11L7 8.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="m9 9 14 10 12-5M23 19l-3 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="27.5" cy="11.5" r="1.5" fill="currentColor"/></svg>;
}
function UploadIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function FileIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.75h6.2L19 9.6v10.65H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M13 4v6h5.5M8.5 14h7M8.5 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>; }
function ArrowIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.2 8A6.4 6.4 0 0 0 5 5.2L3.7 6.5M3.7 6.5V3.8m0 2.7h2.7M3.8 12a6.4 6.4 0 0 0 11.2 2.8l1.3-1.3m0 0v2.7m0-2.7h-2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2 14.5 4v4.2c0 3.6-2.3 6.1-5.5 7.8-3.2-1.7-5.5-4.2-5.5-7.8V4L9 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="m6.5 8.8 1.7 1.7 3.4-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function LockIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3.5" y="7.5" width="11" height="8" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M5.8 7.5V5.7a3.2 3.2 0 1 1 6.4 0v1.8M9 10.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function PulseIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12h4l2.4-6 4.2 12 2.4-6H21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function AlertIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3 18 17H2L10 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M10 8v4m0 2.3v.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function DownloadIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2.5v8m0 0 3-3m-3 3-3-3M3 12.5v2A1.5 1.5 0 0 0 4.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function CopyIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="6" y="5" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M12 5V3.8A1.8 1.8 0 0 0 10.2 2H4.8A1.8 1.8 0 0 0 3 3.8v7.4A1.8 1.8 0 0 0 4.8 13H6" stroke="currentColor" strokeWidth="1.4"/></svg>; }
function CheckIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m3.5 9.2 3.6 3.6 7.4-7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

export default App;
