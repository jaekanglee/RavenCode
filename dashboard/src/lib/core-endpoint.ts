/**
 * Issue #44: the desktop Core's API port is 8765 when free, otherwise OS-assigned,
 * so a backend restart can move it. The dashboard reads the endpoint once at load
 * (main.tsx → setApiBase), so after a restart it compares and reloads if it moved.
 */
export function coreEndpointMoved(current: string, next: unknown): boolean {
  if (typeof next !== "string" || !next.trim()) return false;
  const norm = (s: string) => s.trim().replace(/\/+$/, "");
  return norm(next) !== norm(current);
}
