// Content-Security-Policy violation reports (2026-11-20; ISO 27001 A.8.26/A.8.28, SOC 2 CC6.8, NIST CSF PR.PS).
// nginx sends the policy (report-only first, then enforced); browsers POST what it blocked, or would block, here.
// Only the directive, blocked origin and page path are kept, grouped and counted. Never query strings or bodies.
//   POST /api/csp-report         browsers (application/csp-report or application/reports+json)
//   GET  /api/platform/csp       platform admin: grouped violations, newest first
import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import type { Store } from "./store";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const MAX_GROUPS = 500;
const originOf = (u: unknown) => {
  const s = String(u ?? "");
  if (!s || ["inline", "eval", "self", "data", "blob", "wasm-eval", "trusted-types-policy"].includes(s)) return s || "(none)";
  try { return new URL(s).origin; } catch { return s.slice(0, 80); }
};
const pathOf = (u: unknown) => { try { return new URL(String(u)).pathname.replace(/\/[A-Za-z0-9_-]{20,}/g, "/:id").slice(0, 120); } catch { return "(unknown)"; } };

export function mountCsp(app: Hono<any>, deps: { store: Store; requireAdmin: any; isPlatformAdmin: (c: Context<any>) => boolean; tooMany: (k: string, n: number, ms: number) => boolean }) {
  const { store } = deps;
  app.post("/csp-report", async (c) => {
    if (deps.tooMany(`csp:${c.req.header("x-real-ip") ?? "local"}`, 60, 600_000)) return c.body(null, 204);
    const raw = await c.req.text().catch(() => "");
    if (raw.length > 20_000) return c.body(null, 204);
    let items: any[] = [];
    try {
      const j = JSON.parse(raw);
      items = Array.isArray(j) ? j.map((r) => r?.body ?? r) : [j?.["csp-report"] ?? j];
    } catch { return c.body(null, 204); }
    for (const r of items.slice(0, 20)) {
      const directive = String(r?.["effective-directive"] ?? r?.effectiveDirective ?? r?.["violated-directive"] ?? "").split(" ")[0]!.slice(0, 40);
      const blocked = originOf(r?.["blocked-uri"] ?? r?.blockedURL);
      const page = pathOf(r?.["document-uri"] ?? r?.documentURL);
      if (!directive) continue;
      const id = sha(`${directive}|${blocked}|${page}`);
      const now = new Date().toISOString();
      const cur = await store.getDoc("csp", id);
      if (!cur && (await store.listDocs("csp", "_platform")).length >= MAX_GROUPS) continue;
      const prev = cur ? JSON.parse(cur.data) : { directive, blocked, page, count: 0, first: now, sample: String(r?.["source-file"] ?? r?.sourceFile ?? "").slice(0, 120) };
      await store.putDoc({ coll: "csp", id, tenant_id: "_platform", data: JSON.stringify({ ...prev, count: prev.count + 1, last: now, mode: r?.disposition ?? (r?.["csp-report"] ? undefined : r?.disposition) }), created_at: cur?.created_at ?? now, updated_at: now });
    }
    return c.body(null, 204);
  });
  app.get("/platform/csp", deps.requireAdmin, async (c) => {
    if (!deps.isPlatformAdmin(c)) return c.json({ error: "Not found" }, 404);
    const rows = (await store.listDocs("csp", "_platform")).map((d) => JSON.parse(d.data)).sort((a, b) => String(b.last).localeCompare(String(a.last)));
    return c.json({ groups: rows });
  });
}
