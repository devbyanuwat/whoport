import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  RefreshCw,
  Search,
  Skull,
  FolderOpen,
  Copy,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import "./App.css";

type PortEntry = {
  port: number;
  protocol: string;
  ip_version: string;
  address: string;
  pid: number;
  command: string;
  name: string;
  path: string;
  user: string;
  system: boolean;
};

type SortKey = "port" | "name" | "pid" | "user";

function App() {
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("port");
  const [sortAsc, setSortAsc] = useState(true);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [toasts, setToasts] = useState<
    { id: number; msg: string; kind: "success" | "error" | "warn" }[]
  >([]);

  const showToast = useCallback(
    (msg: string, kind: "success" | "error" | "warn") => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, msg, kind }]);
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, 5000);
    },
    []
  );

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PortEntry[]>("list_ports");
      setPorts(result);
      setScannedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    scan();
    const unlisten = listen("refresh-ports", () => scan());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [scan]);

  const kill = useCallback(
    async (entry: PortEntry, force: boolean) => {
      const label = force ? "Force kill (SIGKILL)" : "Kill (SIGTERM)";
      const app = entry.name || entry.command;
      const warning = entry.system
        ? "\n\nWARNING: this looks like a macOS system / daemon process. Killing it can destabilize your Mac or be restarted automatically by the OS."
        : "";
      const ok = await ask(
        `${label} ${app} (PID ${entry.pid}) on port ${entry.port}?${warning}`,
        { title: "Confirm kill", kind: entry.system ? "warning" : "info" }
      );
      if (!ok) return;

      setKillingPid(entry.pid);
      try {
        await invoke("kill_process", { pid: entry.pid, force });
        // Signal sent. Give the OS a moment, then re-scan and verify it is gone.
        await new Promise((r) => setTimeout(r, 450));
        const fresh = await invoke<PortEntry[]>("list_ports");
        setPorts(fresh);
        setScannedAt(new Date());
        const stillAlive = fresh.some((p) => p.pid === entry.pid);
        if (stillAlive) {
          showToast(
            `Signal sent, but ${app} (PID ${entry.pid}) is still running. Try Alt+click to force kill.`,
            "warn"
          );
        } else {
          showToast(`Killed ${app} (PID ${entry.pid}) on port ${entry.port}.`, "success");
        }
      } catch (e) {
        showToast(`Failed to kill ${app} (PID ${entry.pid}): ${e}`, "error");
      } finally {
        setKillingPid(null);
      }
    },
    [showToast]
  );

  const reveal = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        await revealItemInDir(path);
      } catch (e) {
        // Fall back to opening the containing folder, then report if that fails too.
        try {
          const dir = path.replace(/\/[^/]*$/, "");
          await openPath(dir);
        } catch (e2) {
          showToast(`Could not reveal ${path}: ${e2}`, "error");
        }
      }
    },
    [showToast]
  );

  const copy = useCallback((text: string) => {
    if (text) navigator.clipboard.writeText(text);
  }, []);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? ports.filter((p) =>
          [p.port.toString(), p.name, p.command, p.path, p.user, p.address]
            .join(" ")
            .toLowerCase()
            .includes(q)
        )
      : ports;

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "port":
          cmp = a.port - b.port;
          break;
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "name":
          cmp = (a.name || a.command).localeCompare(b.name || b.command);
          break;
        case "user":
          cmp = a.user.localeCompare(b.user);
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [ports, query, sortKey, sortAsc]);

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  return (
    <main className="app">
      <header className="toolbar">
        <div className="title">
          <span className="title-main">Port Scanner</span>
          <span className="count">
            {visible.length}
            {query ? ` / ${ports.length}` : ""} listening
          </span>
        </div>

        <div className="search">
          <Search size={15} className="search-icon" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by port, app, path, user..."
            spellCheck={false}
          />
        </div>

        <button className="btn" onClick={scan} disabled={loading}>
          {loading ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          Refresh
        </button>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="th-sort" onClick={() => toggleSort("port")}>
                Port{sortIndicator("port")}
              </th>
              <th>Proto</th>
              <th className="th-sort" onClick={() => toggleSort("name")}>
                Application{sortIndicator("name")}
              </th>
              <th className="th-sort" onClick={() => toggleSort("pid")}>
                PID{sortIndicator("pid")}
              </th>
              <th className="th-sort" onClick={() => toggleSort("user")}>
                User{sortIndicator("user")}
              </th>
              <th>Path</th>
              <th className="th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => (
              <tr key={`${p.pid}-${p.port}-${p.address}-${i}`}>
                <td className="mono port">{p.port}</td>
                <td className="proto">
                  {p.protocol}
                  <span className="ipv">{p.ip_version}</span>
                </td>
                <td className="app-cell">
                  <span className="app-name" title={p.command}>
                    {p.name || p.command}
                  </span>
                  <span
                    className={`badge ${p.system ? "badge-system" : "badge-user"}`}
                    title={
                      p.system
                        ? "macOS system / daemon process — avoid killing"
                        : "User application — safe to kill"
                    }
                  >
                    {p.system ? "system" : "user"}
                  </span>
                </td>
                <td className="mono">{p.pid}</td>
                <td>{p.user}</td>
                <td className="path mono" title={p.path}>
                  {p.path || "—"}
                </td>
                <td className="actions">
                  <button
                    className="icon-btn"
                    title="Copy path"
                    onClick={() => copy(p.path)}
                    disabled={!p.path}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Reveal in Finder"
                    onClick={() => reveal(p.path)}
                    disabled={!p.path}
                  >
                    <FolderOpen size={14} />
                  </button>
                  <button
                    className={`kill-btn ${p.system ? "kill-system" : ""}`}
                    title={
                      p.system
                        ? "System process — kill with caution (Alt+click = SIGKILL)"
                        : "Kill process (Alt+click = SIGKILL)"
                    }
                    onClick={(e) => kill(p, e.altKey)}
                    disabled={killingPid === p.pid}
                  >
                    {killingPid === p.pid ? (
                      <>
                        <Loader2 size={13} className="spin" />
                        Killing
                      </>
                    ) : (
                      <>
                        <Skull size={13} />
                        Kill
                      </>
                    )}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {query ? "No matching ports." : "No listening ports found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="status">
        <span>
          {scannedAt
            ? `Last scan ${scannedAt.toLocaleTimeString()}`
            : "Scanning..."}
        </span>
        <span className="hint">
          "system" = macOS process, avoid killing · Alt+click Kill = SIGKILL
        </span>
      </footer>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "success" && <CheckCircle2 size={16} />}
            {t.kind === "warn" && <AlertTriangle size={16} />}
            {t.kind === "error" && <XCircle size={16} />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;
