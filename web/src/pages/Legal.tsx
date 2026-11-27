// /legal/privacy · /legal/terms · /legal/risk — the platform's legal pages (text in ../legal/content.ts).
// Counsel notes in the drafts ([COUNSEL: …]) are hidden unless the URL has ?review=1.
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { Fragment, useEffect } from "react";
import { SiteHeader } from "../lib/Chrome";
import { useTenant } from "../lib/tenant";
import { COMPANY, LEGAL_DOCS, UPDATED, type Block, type LegalDoc } from "../legal/content";

export default function Legal() {
  const { doc: slug } = useParams();
  const { tenant } = useTenant();
  const { search, hash } = useLocation();
  const review = new URLSearchParams(search).get("review") === "1";
  const doc: LegalDoc | undefined = LEGAL_DOCS[slug as LegalDoc["slug"]];
  const email = tenant?.legal?.contactEmail ?? null;
  const site = tenant?.name ?? "Diamondz Tokenize";

  useEffect(() => { if (!hash) window.scrollTo(0, 0); }, [slug, hash]);
  useEffect(() => { if (doc) document.title = `${doc.title} · ${site}`; }, [doc, site]);

  // Fill {{EMAIL}} with a mailto link (or the contact form when no address is configured) and {{SITE}} with the brand.
  const text = (s: string) => s.split(/(\{\{EMAIL\}\}|\{\{SITE\}\})/).map((part, i) =>
    part === "{{EMAIL}}" ? (email ? <a key={i} href={`mailto:${email}`}>{email}</a> : <Link key={i} to="/#contact">our contact form</Link>)
      : part === "{{SITE}}" ? <Fragment key={i}>{site}</Fragment> : <Fragment key={i}>{part}</Fragment>);
  const block = (b: Block, i: number) =>
    typeof b === "string" ? <p key={i}>{text(b)}</p>
      : "list" in b ? <ul key={i}>{b.list.map((li, j) => <li key={j}>{text(li)}</li>)}</ul>
        : review ? <p key={i} className="legal-note">{b.note}</p> : null;

  return (
    <div className="page">
      <SiteHeader />
      <section className="wrap legal">
        <nav className="legal-tabs" aria-label="Legal documents">
          {Object.values(LEGAL_DOCS).map((d) => <NavLink key={d.slug} to={`/legal/${d.slug}${review ? "?review=1" : ""}`} className={({ isActive }) => (isActive ? "on" : "")}>{d.title}</NavLink>)}
        </nav>
        {!doc ? (
          <p className="muted">That page doesn't exist. Choose a document above.</p>
        ) : (
          <div className="legal-grid">
            <aside className="legal-toc" aria-label="On this page">
              <span className="eyebrow">On this page</span>
              {doc.sections.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
            </aside>
            <article className="legal-doc">
              <header>
                <h1>{doc.title}</h1>
                <p className="legal-sum">{doc.summary}</p>
                <p className="muted legal-meta">{COMPANY} · Last updated {UPDATED}</p>
                {review && <p className="legal-note">Review mode: counsel notes are shown. Visitors don't see them.</p>}
              </header>
              {doc.sections.map((s) => (
                <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
                  <h2 id={`${s.id}-h`}>{s.title}</h2>
                  {s.body.map(block)}
                </section>
              ))}
            </article>
          </div>
        )}
      </section>
    </div>
  );
}
