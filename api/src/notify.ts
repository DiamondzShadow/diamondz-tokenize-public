// Email alerts for new contact-form messages.
//
// Provider: Resend (https://resend.com) over its HTTP API, configured with RESEND_API_KEY + NOTIFY_FROM
// (a sender on a domain verified in Resend, e.g. `Diamondz Tokenize <alerts@yourdomain>`).
// Recipients: the tenant's `notifyEmails` (set by its admins in the console). The platform tenant falls back to
// LEADS_NOTIFY_TO (comma-separated) from the server env when it has none.
// Without a key nothing is sent and nothing fails: messages are always stored first and the console inbox is the
// source of truth; the alert is only a heads-up. Alert failures are logged (without the message body), never thrown.
// RESEND_API_URL exists only so tests can point at a mock.
const RESEND_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";

export const emailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);

export interface LeadAlert {
  tenantName: string;
  consoleUrl: string; // where to read it, e.g. https://tokenize.diamondz.one/app/messages
  recipients: string[];
  lead: { name: string; email: string; company?: string; message?: string; kind: string };
  receivedAt: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
// Header-safe: no CR/LF so a visitor can't inject headers through their name.
const oneLine = (s: string, max = 120) => s.replace(/[\r\n]+/g, " ").slice(0, max);

export async function sendLeadAlert(a: LeadAlert): Promise<"sent" | "skipped" | "failed"> {
  if (!emailConfigured() || !a.recipients.length) return "skipped";
  const { name, email, company, message } = a.lead;
  const subject = oneLine(`New message from ${name}${company ? ` (${company})` : ""} · ${a.tenantName}`, 180);
  const rows: [string, string][] = [["Name", name], ["Email", email], ...(company ? [["Company", company] as [string, string]] : []), ["Received", a.receivedAt]];
  const html = `<div style="font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px">
<p style="margin:0 0 12px">Someone sent a message through the <b>${esc(a.tenantName)}</b> contact form.</p>
<table style="border-collapse:collapse;margin:0 0 12px">${rows.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#666">${k}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join("")}</table>
${message ? `<div style="white-space:pre-wrap;padding:12px 14px;background:#f5f5f2;border-radius:8px;margin:0 0 16px">${esc(message)}</div>` : ""}
<p style="margin:0"><a href="${esc(a.consoleUrl)}">Open Messages in the console</a> · reply directly to this email to answer ${esc(name)}.</p></div>`;
  const text = `Someone sent a message through the ${a.tenantName} contact form.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${message ?? ""}\n\nMessages: ${a.consoleUrl}`;
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: a.recipients, reply_to: email, subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.error(`[notify] lead alert failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return "failed"; }
    return "sent";
  } catch (e) {
    console.error(`[notify] lead alert failed: ${(e as Error).message}`);
    return "failed";
  }
}

/** A one-off transactional email (team invites, owner links). Same provider and rules as lead alerts. */
export async function sendEmail(m: { to: string[]; subject: string; html: string; text: string }): Promise<"sent" | "skipped" | "failed"> {
  if (!emailConfigured() || !m.to.length) return "skipped";
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: m.to, subject: oneLine(m.subject, 180), html: m.html, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.error(`[notify] email failed: HTTP ${res.status}`); return "failed"; }
    return "sent";
  } catch (e) {
    console.error(`[notify] email failed: ${(e as Error).message}`);
    return "failed";
  }
}
export const escHtml = esc;
