// /invest/entity — investing as a company, fund or trust (design 3, approved 2026-11-20). Automatic business
// verification needs Sumsub's KYB switched on; until then this page says so plainly and collects the entity's details
// so the team can verify it with them directly. Nothing here pretends the check is automatic yet.
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { SiteHeader } from "../lib/Chrome";

const STEPS = [
  ["Business details", "Legal name, registration number, country and entity type, checked against the company registry."],
  ["Company documents", "Certificate of formation and an ownership chart."],
  ["Owners and controllers", "Everyone who owns 25% or more, plus one person who runs it. Each verifies themselves from their own link; you never see their ID."],
  ["Accreditation as an entity", "Only when the offering requires it: more than $5 million in assets, or every owner accredited."],
  ["The issuer approves the wallet", "The entity's own wallet holds the tokens and receives income. One verification covers all of that issuer's offerings."],
];

export default function EntityInvest() {
  useEffect(() => { document.title = "Investing as a company or fund · Diamondz Tokenize"; window.scrollTo(0, 0); }, []);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState("sending");
    try {
      await api.demoRequest({
        kind: "entity-investor",
        name: String(f.get("name") ?? ""), email: String(f.get("email") ?? ""), company: String(f.get("entity") ?? ""),
        message: `Entity investor request.\nEntity type: ${String(f.get("type") ?? "")}\nCountry: ${String(f.get("country") ?? "")}\nInterested in: ${String(f.get("offering") ?? "") || "not specified"}`,
      });
      setState("sent");
    } catch (x) { setErr((x as Error).message); setState("error"); }
  };
  return (
    <div className="page">
      <SiteHeader />
      <main className="wrap uc" style={{ gap: 40 }}>
        <section className="uc-hero solo">
          <span className="eyebrow">For investors</span>
          <h1>Investing as a company, fund or trust</h1>
          <p className="uc-lead">LLCs, corporations, partnerships, funds, family offices and trusts invest as themselves. The entity is verified, the people who own or control it are checked too, and tokens and income go to the entity's own wallet, never a personal one.</p>
        </section>
        <div className="notice" style={{ background: "var(--warn-bg)", borderColor: "var(--warn-line)", color: "var(--text)", lineHeight: 1.55 }}>
          <b>Automatic business verification is being switched on.</b> Until it is, leave your entity's details below and the team will verify it with you directly before you invest. Investing as yourself already works on every offering page.
        </div>
        <div className="team-grid">
          <section className="panel">
            <h3>How it will work</h3>
            <ol style={{ paddingLeft: 22, margin: 0 }}>
              {STEPS.map(([t, d]) => <li key={t} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}><b>{t}</b><br /><span className="muted" style={{ fontSize: 14 }}>{d}</span></li>)}
            </ol>
            <small className="muted">The person signing in confirms they're authorized to act for the entity.</small>
          </section>
          <form className="panel uc-form" onSubmit={submit}>
            <h3>Tell us about the entity</h3>
            {state === "sent" ? <div className="notice ok">Thanks. We'll contact you within one business day to verify the entity.</div> : <>
              <label className="field">Your name<input className="input" name="name" required maxLength={120} autoComplete="name" /></label>
              <label className="field">Work email<input className="input" name="email" type="email" required maxLength={200} autoComplete="email" /></label>
              <label className="field">Entity's legal name<input className="input" name="entity" required maxLength={200} /></label>
              <label className="field">Type<select className="input" name="type"><option>LLC</option><option>Corporation</option><option>Partnership</option><option>Fund</option><option>Family office</option><option>Trust</option></select></label>
              <label className="field">Country of formation<input className="input" name="country" maxLength={80} placeholder="e.g. United States" /></label>
              <label className="field">Offering you're interested in (optional)<input className="input" name="offering" maxLength={200} /></label>
              {state === "error" && <div className="notice err">{err}</div>}
              <button className="btn primary" disabled={state === "sending"} style={{ justifyContent: "center" }}>{state === "sending" ? "Sending…" : "Send"}</button>
              <small className="muted">Investing as yourself instead? <Link to="/market">Browse offerings</Link>.</small>
            </>}
          </form>
        </div>
      </main>
    </div>
  );
}
