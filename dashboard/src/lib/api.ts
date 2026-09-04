/**
 * Active vault store (simple, no zustand needed).
 *
 * Vault identity is stored in localStorage so refresh keeps the choice.
 * Components read this through `useActiveVault()` and refresh when needed.
 */
import type { TreeNode } from "../types";

// ─── TTL cache + in-flight dedup (P1-b) ─────────────────────
// fetchVaults/fetchPages/fetchTree가 여러 컴포넌트에서 중복 호출되는 문제.
// 짧은 TTL로 중복 제거 + mutation 시 invalidateCache()로 신선도 보장.
interface CacheEntry<T> {
  data: T;
  ts: number;
}
const _cache = new Map<string, CacheEntry<unknown>>();
const _inflight = new Map<string, Promise<unknown>>();

function cachedFetch<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data as T);
  const pending = _inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().then((data) => {
    _cache.set(key, { data, ts: Date.now() });
    _inflight.delete(key);
    return data;
  }).catch((err) => {
    _inflight.delete(key);
    throw err;
  });
  _inflight.set(key, p);
  return p;
}

/** mutation 후 호출 — 해당 key 또는 전체 캐시 무효화. */
export function invalidateCache(keyPrefix?: string): void {
  if (!keyPrefix) { _cache.clear(); return; }
  for (const k of _cache.keys()) {
    if (k.startsWith(keyPrefix)) _cache.delete(k);
  }
}

export const ACTIVE_VAULT_KEY = "raven:active_vault";

export function getActiveVault(): string {
  return localStorage.getItem(ACTIVE_VAULT_KEY) || "";
}

export function setActiveVault(name: string): void {
  localStorage.setItem(ACTIVE_VAULT_KEY, name);
}

// ─── Host Connection Store (Multi-Host v0.8.0+) ─────────────────────
export interface HostConnection {
  id: string;
  name: string;
  endpoint: string; // e.g. "http://192.168.0.15:8765" or "" for local
  isLocal: boolean;
}

export const HOSTS_STORE_KEY = "raven:hosts";
export const ACTIVE_HOST_KEY = "raven:active_host";

export const LOCAL_HOST: HostConnection = {
  id: "local",
  name: "로컬 (Localhost)",
  endpoint: "",
  isLocal: true,
};

export function getHosts(): HostConnection[] {
  if (typeof window === "undefined") return [LOCAL_HOST];
  try {
    const raw = localStorage.getItem(HOSTS_STORE_KEY);
    if (!raw) return [LOCAL_HOST];
    const list: HostConnection[] = JSON.parse(raw);
    if (!list.some((h) => h.id === "local")) {
      list.unshift(LOCAL_HOST);
    }
    return list;
  } catch {
    return [LOCAL_HOST];
  }
}

export function saveHosts(hosts: HostConnection[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(HOSTS_STORE_KEY, JSON.stringify(hosts));
}

export function normalizeEndpoint(input: string): string {
  let endpoint = input.trim();
  if (!endpoint) return "";
  if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    endpoint = `http://${endpoint}`;
  }
  endpoint = endpoint.replace(/\/+$/, "");
  try {
    const parsed = new URL(endpoint);
    if (!parsed.port) {
      parsed.port = "8765";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // fallback
  }
  return endpoint;
}

export function addHost(host: Omit<HostConnection, "id">): HostConnection {
  const hosts = getHosts();
  const id = `host_${Date.now()}`;
  const endpoint = normalizeEndpoint(host.endpoint);

  const newHost: HostConnection = {
    id,
    name: host.name.trim() || endpoint,
    endpoint,
    isLocal: host.isLocal,
  };
  hosts.push(newHost);
  saveHosts(hosts);
  return newHost;
}

export function removeHost(id: string): void {
  if (id === "local") return;
  const hosts = getHosts().filter((h) => h.id !== id);
  saveHosts(hosts);
  if (getActiveHostId() === id) {
    setActiveHostId("local");
  }
}

export function getActiveHostId(): string {
  if (typeof window === "undefined") return "local";
  return localStorage.getItem(ACTIVE_HOST_KEY) || "local";
}

export function getActiveHost(): HostConnection {
  const hosts = getHosts();
  const activeId = getActiveHostId();
  return hosts.find((h) => h.id === activeId) || hosts[0] || LOCAL_HOST;
}

export function setActiveHostId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_HOST_KEY, id);
  invalidateCache();
}

export function getActiveHostUrl(): string {
  const host = getActiveHost();
  if (!host || host.isLocal || !host.endpoint) return "";
  return host.endpoint.replace(/\/+$/, "");
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = getActiveHostUrl();
  const fullUrl = baseUrl ? `${baseUrl}${path.startsWith("/") ? path : "/" + path}` : path;
  return fetch(fullUrl, init);
}

export function formatApiError(err: unknown): string {
  if (!err) return "알 수 없는 오류";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    if (err.message.includes("Failed to fetch") || err.name === "TypeError") {
      return `${err.message} (네트워크/CORS 연결 실패: IP·포트 오타, 타겟 백엔드 미실행, 또는 CORS 블록 확인 필요)`;
    }
    return err.message;
  }
  if (typeof err === "object") {
    const obj = err as Record<string, any>;
    if (obj.detail) {
      if (typeof obj.detail === "string") return obj.detail;
      if (typeof obj.detail === "object") {
        return obj.detail.reason || obj.detail.hint || obj.detail.message || JSON.stringify(obj.detail);
      }
    }
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
    return JSON.stringify(err);
  }
  return String(err);
}

export async function testHostConnection(endpoint: string): Promise<{ ok: boolean; vaultsCount: number; error?: string }> {
  const normalized = normalizeEndpoint(endpoint);
  const targetUrl = `${normalized}/api/vaults`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const errJson = await r.json().catch(() => ({}));
      return { ok: false, vaultsCount: 0, error: formatApiError(errJson) || `HTTP ${r.status}` };
    }
    const d = await r.json();
    return { ok: true, vaultsCount: d.vaults?.length || 0 };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ok: false, vaultsCount: 0, error: `요청 시간 초과 (5초) - ${targetUrl} 의 IP/네트워크 연결 상태를 확인하세요.` };
    }
    return { ok: false, vaultsCount: 0, error: formatApiError(e) };
  }
}

export interface SystemInfo {
  ok: boolean;
  tailscale_ip: string | null;
  lan_ip: string | null;
  local_api: string;
  local_mcp: string;
  lan_api: string | null;
  tailscale_api: string | null;
  tailscale_mcp: string | null;
  bind_host: string;
  allow_all_cors: boolean;
  port: number;
}

export async function fetchSystemInfo(): Promise<SystemInfo | null> {
  try {
    const r = await apiFetch("/api/system/info");
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── debug logger (Raven-Debug v0.6.10+) ─────────────────────
// fetch throw / React error 등을 tmp/dashboard.log에 자동 기록.
// 브라우저 console에서 못 봐도 사용자가 cat으로 직접 확인 가능.
let _logInited = false;
function _ensureLogInited() {
  if (_logInited || typeof window === "undefined") return;
  _logInited = true;
  // unhandled error / promise rejection 자동 캡처
  window.addEventListener("error", (e) => {
    _writeLog(
      `[error] ${e.message}\n  file=${e.filename}:${e.lineno}\n  stack=${(e.error && e.error.stack) || ""}`
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    _writeLog(
      `[unhandledrejection] ${r && r.message ? r.message : String(r)}\n  stack=${r && r.stack ? r.stack : ""}`
    );
  });
}

function _writeLog(line: string) {
  if (typeof window === "undefined") return;
  try {
    const key = "raven:debug:log";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.push({ t: new Date().toISOString(), line });
    // 최대 200줄만 유지
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    // localStorage 실패해도 silent
  }
}

export function debugLog(line: string) {
  _ensureLogInited();
  // eslint-disable-next-line no-console
  console.log("[Raven-Debug]", line);
  _writeLog(line);
}

export function fetchDebugLog(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const arr = JSON.parse(localStorage.getItem("raven:debug:log") || "[]");
    return arr.map((e: { t: string; line: string }) => `${e.t} ${e.line}`);
  } catch {
    return [];
  }
}

export function clearDebugLog() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("raven:debug:log");
}

export interface VaultInfo {
  name: string;
  path: string;
  mode: string;
  owner: string;
  default: boolean;
}

export async function fetchVaults(): Promise<VaultInfo[]> {
  return cachedFetch("vaults", 30_000, async () => {
    const r = await apiFetch("/api/vaults");
    if (!r.ok) return [];
    const d = await r.json();
    return d.vaults || [];
  });
}

export async function fetchVaultInfo(name: string): Promise<any> {
  const r = await apiFetch(`/api/vaults/${name}`);
  if (!r.ok) throw new Error(`vault ${name} not found`);
  const d = await r.json();
  return d.vault;
}

export async function fetchPages(vault: string, opts: { type?: string; tag?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.tag) params.set("tag", opts.tag);
  const qs = params.toString();
  const key = `pages:${vault}${qs ? ":" + qs : ""}`;
  return cachedFetch(key, 15_000, async () => {
    const r = await apiFetch(`/api/vaults/${vault}/pages${qs ? "?" + qs : ""}`);
    if (!r.ok) return [];
    const d = await r.json();
    return d.pages || [];
  });
}

export async function fetchTree(vault: string): Promise<TreeNode | null> {
  return cachedFetch(`tree:${vault}`, 15_000, async () => {
    const r = await apiFetch(`/api/vaults/${vault}/tree`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.tree || null;
  });
}

export async function createFolder(
  vault: string,
  payload: { path: string },
): Promise<{ ok: boolean; path: string; existed: boolean }> {
  const r = await apiFetch(`/api/vaults/${vault}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `create folder failed: ${r.status}`;
    throw new Error(detail);
  }
  invalidateCache(`tree:${vault}`);
  return r.json();
}

export async function fetchPage(vault: string, slug: string) {
  const r = await apiFetch(`/api/vaults/${vault}/pages/${slug}?_=${Date.now()}`);
  if (!r.ok) throw new Error(`page ${slug} not found in vault ${vault}`);
  return r.json();
}

export async function createPage(
  vault: string,
  payload: { slug: string; title: string; content: string; type: string; tags: string[]; extra_meta?: Record<string, any> },
) {
  const r = await apiFetch(`/api/vaults/${vault}/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status}`);
  invalidateCache(`pages:${vault}`);
  invalidateCache(`tree:${vault}`);
  return r.json();
}

export async function updatePage(
  vault: string,
  slug: string,
  payload: { content: string; title?: string; type?: string; tags?: string[]; extra_meta?: Record<string, any>; precondition?: string }
) {
  const r = await apiFetch(`/api/vaults/${vault}/pages/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    // 409 = stale precondition (v0.7.178): 사람이 읽을 문장이 detail에 담게다
    // — 상태코드만 던지면 누가 썼는지를 사용자가 알 수 없다.
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `update failed: ${r.status}`);
  }
  invalidateCache(`pages:${vault}`);
  return r.json();
}

export async function deletePage(vault: string, slug: string) {
  const r = await apiFetch(`/api/vaults/${vault}/pages/${slug}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed: ${r.status}`);
  invalidateCache(`pages:${vault}`);
  invalidateCache(`tree:${vault}`);
  return r.json();
}

// ────────────────────────── log (v0.5.0+) ──────────────────────────

export interface LogEntry {
  date: string;
  action: string;
  subject: string;
  details: string[];
}

export interface LogStatus {
  vault: string;
  log_path: string;
  exists: boolean;
  total_entries: number;
  last_entry: LogEntry | null;
  needs_rotate: boolean;
  rotate_threshold: number;
}

export async function fetchLog(
  vault: string,
  opts: { tail?: number; action?: string; raw?: boolean } = {},
): Promise<{ total: number; shown: number; entries: LogEntry[]; raw?: string }> {
  const params = new URLSearchParams();
  if (opts.tail !== undefined) params.set("tail", String(opts.tail));
  if (opts.action) params.set("action", opts.action);
  if (opts.raw) params.set("raw", "true");
  const qs = params.toString();
  const r = await apiFetch(`/api/vaults/${vault}/log${qs ? "?" + qs : ""}`);
  if (!r.ok) return { total: 0, shown: 0, entries: [] };
  const d = await r.json();
  return { total: d.total || 0, shown: d.shown || 0, entries: d.entries || [], raw: d.raw };
}

export async function fetchLogStatus(vault: string): Promise<LogStatus | null> {
  const r = await apiFetch(`/api/vaults/${vault}/log/status`);
  if (!r.ok) return null;
  return r.json();
}

export async function appendLog(
  vault: string,
  payload: { action: string; subject: string; files?: string[]; note?: string },
) {
  const r = await apiFetch(`/api/vaults/${vault}/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`log append failed: ${r.status}`);
  return r.json();
}

export async function rotateLog(vault: string, opts: { year?: number; force?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.year !== undefined) params.set("year", String(opts.year));
  if (opts.force) params.set("force", "true");
  const qs = params.toString();
  const r = await apiFetch(`/api/vaults/${vault}/log/rotate${qs ? "?" + qs : ""}`, { method: "POST" });
  if (!r.ok) throw new Error(`log rotate failed: ${r.status}`);
  return r.json();
}

// ────────────────────────── lint (v0.5.1+) ──────────────────────────

export type LintSeverity = "critical" | "warning" | "info";

export interface LintIssue {
  id: string; // "#1" - "#12"
  severity: LintSeverity;
  slug: string;
  message: string;
  target?: string;
}

export interface LintResult {
  ok: boolean;
  vault: string;
  counts: Record<LintSeverity | "total", number>;
  by_check: Record<string, number>;
  checks: Record<string, string>;
  issues: LintIssue[];
}

export interface LintSummary {
  ok: boolean;
  vault: string;
  counts: Record<LintSeverity | "total", number>;
  by_check: Record<string, number>;
  checks: Record<string, string>;
}

export async function fetchLint(
  vault: string,
  opts: { check?: string; severity?: LintSeverity; write_log?: boolean } = {},
): Promise<LintResult | null> {
  const params = new URLSearchParams();
  if (opts.check) params.set("check", opts.check);
  if (opts.severity) params.set("severity", opts.severity);
  if (opts.write_log) params.set("write_log", "true");
  const qs = params.toString();
  const r = await apiFetch(`/api/vaults/${vault}/lint${qs ? "?" + qs : ""}`);
  if (!r.ok) return null;
  return r.json();
}

export async function fetchLintSummary(vault: string): Promise<LintSummary | null> {
  const r = await apiFetch(`/api/vaults/${vault}/lint/summary`);
  if (!r.ok) return null;
  return r.json();
}

export interface BuildResult {
  ok: boolean;
  build: {
    ok: boolean;
    vault: string;
    db_path: string;
    pages: number;
    returncode: number;
    lint?: LintResult | null;
  };
  lint: LintResult | null;
}

export async function fetchBuild(vault: string): Promise<BuildResult | null> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/build`, {
    method: "POST",
  });
  if (!r.ok) return null;
  return r.json() as Promise<BuildResult>;
}


// ────────────────────────── garden (v0.7.27) ──────────────────────────

export interface StalePage {
  slug: string;
  updated: string;
  age_days: number;
}

export type GardenLinkCandidate =
  | string
  | {
      slug: string;
      title?: string;
      reason?: string;
      score?: number;
    };

export interface OrphanPage {
  slug: string;
  title: string;
  type: string;
  link_candidates: GardenLinkCandidate[];
}

export interface GardenResult {
  ok: boolean;
  vault: string;
  stale: StalePage[];
  orphan: OrphanPage[];
}

export async function fetchGarden(vault: string): Promise<GardenResult | null> {
  const r = await apiFetch(`/api/vaults/${vault}/garden`);
  if (!r.ok) return null;
  return r.json();
}


// ────────────────────────── raw/ folder (v0.7.50+, ADR-2026-07-02) ──────────────────────────
//
// 사람 1차 운영 영역. 에이전트는 MCP wiki_read로만 read.
// Dashboard raw panel + Sidebar raw/ 노드용 client.

export interface RawItem {
  path: string;
  name: string;
  type: "file" | "dir";
  kind: "raw";
  size?: number | null;
  modified?: string | null;
}

export interface RawList {
  ok: boolean;
  vault: string;
  root: "raw";
  items: RawItem[];
}

export interface RawContent {
  ok: boolean;
  vault: string;
  path: string;
  content: string;
  size?: number | null;
  modified?: string | null;
}

/** raw/ 트리 + 메타. vault에 raw/ 없으면 null (404 silent). */
export async function fetchRawList(vault: string): Promise<RawList | null> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/raw`);
  if (!r.ok) return null;
  return r.json();
}

/** raw/ 파일 내용. 없으면 null. */
export async function fetchRawContent(vault: string, relPath: string): Promise<RawContent | null> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/raw/${relPath}`);
  if (!r.ok) return null;
  return r.json();
}

/** raw/ 파일 작성/갱신. content 전체 overwrite. */
export async function writeRaw(
  vault: string,
  relPath: string,
  content: string,
): Promise<{ ok: boolean; path: string; size: number | null; existed: boolean }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/raw/${relPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Actor": "user" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    let detail: string;
    try {
      const d = await r.json();
      detail = d.detail || JSON.stringify(d);
    } catch {
      detail = `HTTP ${r.status}`;
    }
    throw new Error(`write raw failed: ${detail}`);
  }
  return r.json();
}

/** raw/ 파일/빈 dir 삭제. */
export async function deleteRaw(
  vault: string,
  relPath: string,
): Promise<{ ok: boolean; path: string; deleted: boolean }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/raw/${relPath}`, {
    method: "DELETE",
    headers: { "X-Actor": "user" },
  });
  if (!r.ok) {
    let detail: string;
    try {
      const d = await r.json();
      detail = d.detail || JSON.stringify(d);
    } catch {
      detail = `HTTP ${r.status}`;
    }
    throw new Error(`delete raw failed: ${detail}`);
  }
  return r.json();
}

// ────────────────────────── workspace & git (v0.7.54) ──────────────────────────

export interface GitChange {
  file: string;
  status: string;
}

export interface GitStatusResult {
  ok: boolean;
  has_workspace: boolean;
  workspace_path?: string;
  is_git: boolean;
  branch?: string;
  commit?: string;
  changes?: GitChange[];
  error?: string;
}

export interface GitDiffResult {
  ok: boolean;
  workspace_path: string;
  file?: string;
  diff: string;
  error?: string;
}

async function gitFailure(r: Response, label: string): Promise<never> {
  const detail = (await r.json().catch(() => ({}))).detail;
  throw new Error(detail ? String(detail) : `${label} failed: ${r.status}`);
}

export async function fetchGitStatus(vault: string): Promise<GitStatusResult | null> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/git/status`);
  if (r.status >= 500) await gitFailure(r, "git status");
  if (!r.ok) return null;
  return r.json();
}

export async function fetchGitDiff(vault: string, file?: string): Promise<GitDiffResult | null> {
  const params = new URLSearchParams();
  if (file) params.set("file", file);
  const qs = params.toString();
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/git/diff${qs ? "?" + qs : ""}`);
  if (r.status >= 500) await gitFailure(r, "git diff");
  if (!r.ok) return null;
  return r.json();
}

export async function updateWorkspace(
  vault: string,
  payload: { workspace_path: string; unlink?: boolean }
): Promise<{ ok: boolean; workspace_path: string }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `workspace update failed: ${r.status}`;
    throw new Error(detail);
  }
  return r.json();
}

// ────────────────────────── workspace OS tree (v0.7.61+, read-only) ──────────────────────────
// WorkspacePage에 OS 파일 트리 노출. READ-ONLY: raven은 절대 워크스페이스 파일을 수정 안 함.
// 사용자가 외부에서 편집한 파일을 dashboard에서 바로 보고 .md는 인라인 미리보기.

export interface WorkspaceTreeNode {
  name: string;
  path: string;          // workspace-relative, POSIX separator
  type: "dir" | "file";
  size: number | null;
  mtime: number;
  is_hidden: boolean;
  depth: number;
  has_children: boolean; // dir + 자식 depth 여유 있으면 true (UI expand 마커)
}

export interface WorkspaceTreeResult {
  ok: boolean;
  workspace_path: string;
  path: string;
  nodes: WorkspaceTreeNode[];
  total: number;
  depth: number;
}

export async function fetchWorkspaceTree(
  vault: string,
  options: { path?: string; depth?: number; hidden?: boolean } = {}
): Promise<WorkspaceTreeResult | null> {
  const params = new URLSearchParams();
  if (options.path) params.set("path", options.path);
  if (options.depth != null) params.set("depth", String(options.depth));
  if (options.hidden) params.set("hidden", "true");
  const qs = params.toString();
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/workspace/tree${qs ? "?" + qs : ""}`
  );
  if (!r.ok) return null;
  return r.json();
}

export interface WorkspaceFileResult {
  ok: boolean;
  workspace_path: string;
  path: string;
  size: number;
  truncated: boolean;
  is_binary: boolean;  // v0.7.61+: binary 감지 결과 (NUL byte / printable 비율 기반)
  content: string;
}

export async function fetchWorkspaceFile(
  vault: string,
  path: string
): Promise<WorkspaceFileResult | null> {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/workspace/file?path=${encodeURIComponent(path)}`
  );
  if (!r.ok) return null;
  return r.json();
}

export async function sendPageFeedback(
  vault: string,
  slug: string,
  payload: { feedback: string; actor?: string; precondition?: string }
) {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/pages/${encodeURIComponent(slug)}/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `send feedback failed: ${r.status}`);
  }
  return r.json();
}

export async function deletePageFeedback(
  vault: string,
  slug: string,
  index: number,
  precondition?: string,
) {
  const q = precondition ? `&precondition=${encodeURIComponent(precondition)}` : "";
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/feedback/${index}?slug=${encodeURIComponent(slug)}${q}`,
    { method: "DELETE" }
  );
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `delete feedback failed: ${r.status}`);
  }
  return r.json();
}

export async function updatePageFeedback(
  vault: string,
  slug: string,
  index: number,
  payload: { feedback: string; precondition?: string }
) {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/feedback/${index}?slug=${encodeURIComponent(slug)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(detail ? String(detail) : `update feedback failed: ${r.status}`);
  }
  return r.json();
}

export interface Advice {
  id: string;
  type: string; // "bridge" | "bloated" | "orphan" | "underlinked"
  title: string;
  message: string;
  ai_message?: string; // v0.7.163+
  severity: "info" | "warning" | "success";
  slug?: string;
}

export async function fetchRecommendations(
  vault: string,
  slug: string,
  limit: number = 5
) {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/pages/${encodeURIComponent(slug)}/recommendations?limit=${limit}`
  );
  if (!r.ok) throw new Error(`failed to fetch recommendations: ${r.status}`);
  return r.json();
}

export async function fetchAdvice(vault: string): Promise<Advice[]> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/advice`);
  if (!r.ok) return [];
  return r.json();
}

export async function fetchAIAdvice(vault: string): Promise<Advice[]> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/ai-advice`);
  if (!r.ok) return [];
  return r.json();
}

export interface RelationAddPayload {
  source_slug: string;
  target_slug: string;
  relation_type: string;
  evidence?: string | string[];
  reason?: string;
  actor?: string;
  precondition?: string;
}

export async function addRelation(vault: string, payload: RelationAddPayload): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/relations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `add relation failed: ${r.status}`;
    throw new Error(detail);
  }
  return r.json();
}


export interface HybridSearchResult {
  slug: string;
  title: string;
  type: string;
  score: number;
  bm25_score: number;
  distance: number;
  method: string;
}

export async function fetchHybridSearch(
  vault: string,
  query: string,
  limit: number = 20,
  opts: { signal?: AbortSignal } = {}
): Promise<HybridSearchResult[]> {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/hybrid-search?query=${encodeURIComponent(query)}&limit=${limit}`,
    { signal: opts.signal }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return d.results || [];
}

export interface RAGCitation {
  slug: string;
  title: string;
  path: string;
  file_url: string;
  score: number;
  method: string;
}

export interface RAGQueryResult {
  ok: boolean;
  query: string;
  answer: string;
  citations: RAGCitation[];
  used_llm: boolean;
}

export async function fetchRAGQuery(
  vault: string,
  query: string
): Promise<RAGQueryResult | null> {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/rag/query?query=${encodeURIComponent(query)}`
  );
  if (!r.ok) return null;
  return r.json();
}

export async function suggestTags(
  vault: string,
  payload: { content: string; title?: string }
): Promise<{ ok: boolean; tags: string[]; used_llm: boolean }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/suggest-tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`suggest tags failed: ${r.status}`);
  return r.json();
}

export interface Contradiction {
  source_slug: string;
  target_slug: string;
  relation_type: string;
  description: string;
  proposed_action: "update_relation" | "add_backlink";
  proposed_data: {
    source_slug: string;
    target_slug: string;
    relation_type: string;
    evidence: string;
    reason: string;
  };
  source_title?: string;
  target_title?: string;
}

export async function fetchContradictions(
  vault: string
): Promise<{ ok: boolean; contradictions: Contradiction[]; used_llm: boolean }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/lint/contradictions`);
  if (!r.ok) throw new Error(`fetch contradictions failed: ${r.status}`);
  return r.json();
}

export async function resolveContradiction(
  vault: string,
  payload: {
    source_slug: string;
    target_slug: string;
    relation_type: string;
    action: "update_relation" | "add_backlink";
    evidence?: string;
    reason?: string;
  }
): Promise<{ ok: boolean; message?: string }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/lint/contradictions/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `resolve failed: ${r.status}`;
    throw new Error(detail);
  }
  return r.json();
}



// ─── Drafts (사이드바 초안 섹션용: 읽기/커밋/삭제만, 생성은 MCP 전용) ──────────

export interface DraftListItem {
  slug: string;
  filename: string;
  title: string;
  type: string;
  updated: string | null;
  size: number;
}

export interface DraftConflictResult {
  ok: false;
  conflict: true;
  error: string;
  existing_content: string;
  draft_content: string;
}

export async function fetchDraftsList(vault: string): Promise<DraftListItem[]> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/drafts`);
  if (!r.ok) return [];
  const d = await r.json();
  return d.drafts || [];
}

export async function commitDraft(
  vault: string,
  payload: { draft_slug: string; content?: string; overwrite?: boolean }
): Promise<{ ok: boolean; slug: string; path: string; db_rebuild: any } | DraftConflictResult> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/drafts/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) return r.json();
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `commit draft failed: ${r.status}`;
    throw new Error(detail);
  }
  return r.json();
}

export async function deleteDraft(
  vault: string,
  draftName: string
): Promise<{ ok: boolean; deleted?: string }> {
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/drafts/${encodeURIComponent(draftName)}`,
    { method: "DELETE" }
  );
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `delete draft failed: ${r.status}`;
    throw new Error(detail);
  }
  return r.json();
}

// ─── archive (P0-1: 삭제 페이지 열람/복원/정리) ─────────────────────

export interface ArchiveEntry {
  rel_path: string;
  original_slug: string;
  timestamp: string | null;
  age_days: number | null;
}

export async function fetchArchive(
  vault: string,
  olderThan = 0
): Promise<{ ok: boolean; count: number; entries: ArchiveEntry[] }> {
  const params = new URLSearchParams();
  if (olderThan > 0) params.set("older_than", String(olderThan));
  const qs = params.toString();
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/archive${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw new Error(`archive list failed: ${r.status}`);
  return r.json();
}

export async function restoreArchive(
  vault: string,
  archivePath: string
): Promise<{ ok: boolean; original_slug: string; restored_to: string }> {
  const params = new URLSearchParams({ archive_path: archivePath });
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/archive/restore?${params}`,
    { method: "POST" }
  );
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `restore failed: ${r.status}`;
    throw new Error(detail);
  }
  invalidateCache(`pages:${vault}`);
  invalidateCache(`tree:${vault}`);
  return r.json();
}

export async function cleanArchive(
  vault: string,
  olderThan: number,
  apply: boolean
): Promise<{
  ok: boolean;
  dry_run: boolean;
  would_delete_count: number;
  deleted_count: number;
  would_delete: ArchiveEntry[];
  deleted: ArchiveEntry[];
  errors: { path: string; error: string }[];
}> {
  const params = new URLSearchParams({ older_than: String(olderThan), apply: String(apply) });
  const r = await apiFetch(
    `/api/vaults/${encodeURIComponent(vault)}/archive/clean?${params}`,
    { method: "POST" }
  );
  if (!r.ok) throw new Error(`archive clean failed: ${r.status}`);
  invalidateCache(`pages:${vault}`);
  invalidateCache(`tree:${vault}`);
  return r.json();
}

// ─── P2: vault 도구 (link-check / export / repair / clone / locks) ───

export interface LinkCheckResult {
  ok: boolean;
  vault: string;
  broken: { slug: string; target: string; line?: number }[];
  missing: { slug: string; target: string }[];
}

export async function fetchLinkCheck(vault: string, slug?: string): Promise<LinkCheckResult> {
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/link-check${qs}`);
  if (!r.ok) throw new Error(`link-check failed: ${r.status}`);
  return r.json();
}

export async function runExport(vault: string, outDir?: string): Promise<{ ok: boolean; export: Record<string, unknown> }> {
  const qs = outDir ? `?out_dir=${encodeURIComponent(outDir)}` : "";
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/export${qs}`, { method: "POST" });
  if (!r.ok) throw new Error(`export failed: ${r.status}`);
  return r.json();
}

export async function repairVault(vault: string, path: string): Promise<{ ok: boolean; vault: string; path: string }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `repair failed: ${r.status}`;
    throw new Error(detail);
  }
  invalidateCache("vaults");
  return r.json();
}

export async function cloneVault(payload: {
  src: string; name: string; path: string; mode?: string; owner?: string; copy_meta?: boolean;
}): Promise<{ ok: boolean; vault: string; path: string }> {
  const { src, ...body } = payload;
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(src)}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail || `clone failed: ${r.status}`;
    throw new Error(detail);
  }
  invalidateCache("vaults");
  return r.json();
}

export interface LockEntry {
  holder: string;
  acquired_at: string;
  ttl_seconds: number;
}

export async function fetchLocks(vault: string): Promise<{ ok: boolean; vault: string; locks: Record<string, LockEntry> }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/locks`);
  if (!r.ok) throw new Error(`locks failed: ${r.status}`);
  return r.json();
}

export async function releaseLock(vault: string, slug: string): Promise<{ ok: boolean }> {
  const r = await apiFetch(`/api/vaults/${encodeURIComponent(vault)}/locks`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) throw new Error(`release lock failed: ${r.status}`);
  return r.json();
}