// Geo-block: the platform refuses visitors from sanctioned countries, by the country Cloudflare reports for their IP
// (CF-IPCountry). Default list: OFAC comprehensive sanctions (Cuba, Iran, North Korea, Syria), Russia, Belarus,
// FATF call-for-action (Myanmar), and Tor exits (T1, which hide the country). Override with GEO_BLOCKED="CU,IR,…".
// Requests that came through nginx without the header (someone bypassing Cloudflare) are refused too.
// Local calls (scripts, the Temporal worker) reach 127.0.0.1 directly with no proxy headers and pass.
//
//   GET /api/geo   { country, blocked }   (always answers, so the web app can show the blocked page)
import type { Context, Hono } from "hono";

const DEFAULT = ["CU", "IR", "KP", "SY", "RU", "BY", "MM", "T1"];
const blockedList = () => (process.env.GEO_BLOCKED ? process.env.GEO_BLOCKED.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : DEFAULT);
const EXEMPT = new Set(["/api/geo", "/api/kyc/webhook", "/api/kyc/stripe-webhook"]);
export const GEO_MESSAGE = "Diamondz Tokenize isn't available in your region.";

export function geoOf(c: Context) {
  const proxied = !!(c.req.header("x-real-ip") || c.req.header("x-forwarded-for"));
  const country = (c.req.header("cf-ipcountry") ?? "").toUpperCase();
  const blocked = proxied && (!country || blockedList().includes(country));
  return { country: country || null, blocked };
}

export function mountGeo(app: Hono<any>) {
  app.get("/geo", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(geoOf(c));
  });
  app.use("*", async (c, next) => {
    if (!EXEMPT.has(c.req.path) && geoOf(c).blocked) return c.json({ error: GEO_MESSAGE, geoBlocked: true }, 451);
    await next();
  });
}
