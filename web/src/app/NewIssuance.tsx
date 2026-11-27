// Console › New issuance — the beginner-friendly wizard.
// v1 (designs W1–W6, approved 2026-11-18): plain-English steps, helper rail, "What's this?", recommended token type,
// live preview, raise calculator, exemption choice, one-sentence summary.
// v2 (designs W7–W12, approved 2026-11-19): step 2 asks questions specific to the asset class (lib/questions.ts) and
// step 5 sets the rules the token enforces on chain (lib/rules.ts → OfferingRules / OfferingRulesModule).
// Continue saves the draft from the token step on (the API needs a name, symbol and supply); deploying happens on the
// offering's page.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssetClassIcon } from "../lib/Icons";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type Asset } from "../lib/api";
import { NETWORKS, DEFAULT_CHAIN_ID, networkById, STELLAR_NETWORKS, isStellarChain, anyNetworkName, stellarById } from "../lib/chains";
import { ASSET_CLASSES, assetClassById, standardById, type AssetClassId, type StandardId } from "../lib/catalog";
import { useTenant } from "../lib/tenant";
import { QUESTIONS, aboutLabel, type Details, type Field, type Tag } from "../lib/questions";
import {
  COUNTRIES, LOCKUP_CHOICES, countryName, fingerprint, lockupLabel, suggestedRules, type DocFingerprint, type Exemption, type Rules,
} from "../lib/rules";
import { decodeBuild, effective, exemptionFor, toRules } from "../lib/builder";

const MINUTES_LEFT = [7, 6, 4, 3, 2, 1];

const EXAMPLES: Record<AssetClassId, string> = {
  "real-estate": "a 12-unit apartment building in Miami",
  energy: "royalties from 3 oil wells in Texas",
  "private-equity": "shares in a growing local business",
  "private-credit": "a pool of small-business loans",
  funds: "a treasury-bill fund",
  "music-ip": "streaming royalties from an album",
  film: "a feature film's share of net revenue",
  sports: "a share of an athlete's prize money and endorsements for five years",
  collectibles: "a painting split into 1,000 shares",
  carbon: "verified carbon credits from a forest project",
};
/** Plain names for token standards; the technical name is shown second. */
const PLAIN: Record<StandardId, string> = {
  erc7943: "Permissioned token", erc4626: "Fund shares", erc3643: "Institutional security token",
  erc721: "One token per item", erc1155: "Fractions of one item",
  "stellar-rwa": "Regulated security token (Stellar)",
} as Record<StandardId, string>;

const TERMS: Record<string, string> = {
  name: "What investors see on the listing. Usually the property, fund or project name.",
  symbol: "A short code, like a stock ticker (for example HARB). 2 to 6 capital letters is typical.",
  supply: "The total number of tokens (shares). More tokens means each one is cheaper.",
  network: "The blockchain that records the token. A test network works the same way with play money, so you can practice safely.",
  type: "The kind of smart contract behind your token. We recommend one for your asset; most issuers never need to change it.",
  schedule: "How often you plan to send income (rent, royalties, interest) to token holders. You send each payout yourself from the Payouts page.",
  exemption: "The legal rule that lets you sell without a full SEC registration. Your lawyer chooses it.",
};

const SCHEDULES: [string, string][] = [["Monthly", "Monthly"], ["Quarterly", "Quarterly"], ["Annually", "Yearly"], ["On event", "When something happens"], ["None", "No income"]];
const EXEMPTIONS: [Exemption, string][] = [["506c", "Reg D 506(c): US, accredited investors, can advertise"], ["regs", "Reg S: investors outside the US"], ["unsure", "Not sure yet"]];
const TAG_LABEL: Record<Tag, string> = { listing: "Listing", onchain: "On chain", rule: "Rule", document: "Document" };

type Draft = Partial<Asset> & { assetClass?: AssetClassId; standard?: StandardId };
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** "What's this?" — a one-sentence explanation that opens in place. */
function What({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="what" aria-expanded={open} onClick={() => setOpen((o) => !o)}>What's this?</button>
      {open && <span className="what-say">{text}</span>}
    </>
  );
}
const TagChip = ({ tag }: { tag: Tag }) => <span className={`wz-tag ${tag}`}>{TAG_LABEL[tag]}</span>;

/** One step-2 question, by type. Answers are kept as typed (strings), numbers are parsed where they're used. */
function FieldInput({ f, value, onChange }: { f: Field; value: Details[string] | undefined; onChange: (v: Details[string]) => void }) {
  const id = `q-${f.id}`;
  const label = (
    <>
      <label htmlFor={f.type === "chips" || f.type === "yesno" ? undefined : id}>{f.label}</label>
      {f.tag && <TagChip tag={f.tag} />}
      {f.what && <What text={f.what} />}
    </>
  );
  if (f.type === "chips" || f.type === "yesno") {
    const opts: [string, string][] = f.type === "yesno" ? [["yes", "Yes"], ["no", "No"]] : f.options ?? [];
    const cur = f.type === "yesno" ? (value === true ? "yes" : value === false ? "no" : "") : String(value ?? "");
    return (
      <fieldset className="q">
        <legend>{f.label} {f.tag && <TagChip tag={f.tag} />} {f.what && <What text={f.what} />}</legend>
        <div className="chips">
          {opts.map(([v, l]) => (
            <button type="button" key={v} className={`chip ${cur === v ? "on" : ""}`} aria-pressed={cur === v}
              onClick={() => onChange(f.type === "yesno" ? v === "yes" : v)}>{l}</button>
          ))}
        </div>
        {f.hint && <span className="hint">{f.hint}</span>}
      </fieldset>
    );
  }
  const common = { id, className: "input", value: String(value ?? ""), placeholder: f.placeholder };
  let input: ReactNode;
  if (f.type === "select") {
    input = (
      <select {...common} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(f.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  } else if (f.type === "date") {
    input = <input {...common} type="date" style={{ maxWidth: 220 }} onChange={(e) => onChange(e.target.value)} />;
  } else if (f.type === "money" || f.type === "number" || f.type === "percent") {
    input = (
      <input {...common} inputMode="decimal" style={{ maxWidth: f.type === "percent" ? 160 : 260 }}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
    );
  } else {
    input = <input {...common} maxLength={500} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="q">
      {label}
      {f.type === "money" || f.type === "percent"
        ? <span className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "center" }}>{f.type === "money" && <span className="muted">$</span>}{input}{f.type === "percent" && <span className="muted">%</span>}</span>
        : input}
      {f.hint && <span className="hint">{f.hint}</span>}
    </div>
  );
}

/** A W11 rule row: title, plain-English description, control on the right. */
function RuleRow({ title, isNew, desc, children }: { title: string; isNew?: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div className="wz-rule">
      <div className="t"><b>{title}{isNew && <span className="wz-tag new">{isNew}</span>}</b><span>{desc}</span></div>
      <div className="s">{children}</div>
    </div>
  );
}
const Toggle = ({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) => (
  <button type="button" className={`tog ${on ? "on" : ""}`} aria-pressed={on} aria-label={label} onClick={() => onChange(!on)}>{on ? "On" : "Off"}</button>
);

export default function NewIssuance() {
  const { tenant } = useTenant();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>({ chainId: DEFAULT_CHAIN_ID, schedule: "Quarterly", exemption: "unsure", details: {}, documents: [] });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [otherTypes, setOtherTypes] = useState(false);
  const [kycOn, setKycOn] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  // Rules follow the asset class and exemption until the issuer changes one by hand.
  const [rulesTouched, setRulesTouched] = useState(false);

  const id = params.get("id");
  // Load a draft opened from elsewhere. The first save also puts the new id in the URL; that must NOT reload the
  // draft (it used to send people back to step 2 right after they pressed Continue).
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!id || id === loaded.current) return;
    loaded.current = id;
    api.asset(id).then((a) => { setD({ details: {}, documents: [], ...a }); setRulesTouched(!!a.rules); setStep(1); }, (e) => setMsg({ kind: "err", text: e.message }));
  }, [id]);
  // Opened from the Contract Builder (/builder): start a new draft with its token, network, exemption and rules. The
  // issuer still picks the asset class; picking one keeps the builder's token type when the class offers it.
  const fromBuilder = useRef(false);
  useEffect(() => {
    const b = !id ? decodeBuild(params.get("builder")) : undefined;
    if (!b || fromBuilder.current || b.route === "cf") return;
    fromBuilder.current = true;
    const e = effective(b);
    setD((x) => ({ ...x, name: e.name, symbol: e.symbol, chainId: e.chainId, standard: e.std, exemption: exemptionFor(e.route), rules: toRules(e) }));
    setRulesTouched(true);
  }, [id, params]);
  useEffect(() => { api.kycConfig().then((c) => setKycOn(c.enabled), () => setKycOn(false)); }, []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [step]);

  // The workspace's picks (from sign-up or Branding) come first; every other class stays one click away, because
  // those picks are defaults, not limits. A draft already using an unpicked class opens with all of them shown.
  const picked = ASSET_CLASSES.filter((c) => !tenant || tenant.offerings.includes(c.id));
  const others = ASSET_CLASSES.filter((c) => !picked.includes(c));
  const [allClasses, setAllClasses] = useState(false);
  const showAll = allClasses || !picked.length || (!!d.assetClass && !picked.some((c) => c.id === d.assetClass));
  const classes = showAll ? [...picked, ...others] : picked;
  const cls = d.assetClass ? assetClassById(d.assetClass) : undefined;
  const Q = d.assetClass ? QUESTIONS[d.assetClass] : undefined;
  const recommended = cls?.standards.find((s) => standardById(s).available);
  const set = (patch: Draft) => setD((x) => ({ ...x, ...patch }));
  // Stellar (design X1): only security-token classes; the token type follows the network.
  const onStellar = isStellarChain(d.chainId);
  const stellarOk = !!cls && cls.standards.some((s) => s === "erc3643" || s === "erc7943");
  const pickNetwork = (id: number) => {
    const toStellar = isStellarChain(id);
    set({ chainId: id, standard: toStellar ? "stellar-rwa" : (d.standard === "stellar-rwa" ? recommended : d.standard) });
    if (toStellar) setOtherTypes(false);
  };
  const details: Details = (d.details as Details) ?? {};
  const setDetail = (k: string, v: Details[string]) => setD((x) => {
    const nd = { ...((x.details as Details) ?? {}), [k]: v };
    const patch: Draft = { details: nd };
    // Carbon: one token is one tonne.
    if (x.assetClass === "carbon" && k === "tonnes") patch.totalSupply = String(v).replace(/[^0-9]/g, "").replace(/^0+/, "");
    // Credit: the payout schedule follows "interest paid".
    if (x.assetClass === "private-credit" && k === "payEvery") patch.schedule = v === "At maturity" ? "On event" : String(v);
    return { ...x, ...patch };
  });
  const rules: Rules = d.rules ?? suggestedRules(d.assetClass, d.exemption, details);
  const setRules = (patch: Partial<Rules>) => { setRulesTouched(true); setD((x) => ({ ...x, rules: { ...(x.rules ?? suggestedRules(x.assetClass, x.exemption, (x.details as Details) ?? {})), ...patch } })); };
  const net = networkById(d.chainId);
  /** EVM or Stellar, for labels. */
  const netLabel = { name: anyNetworkName(d.chainId), testnet: net?.testnet ?? stellarById(d.chainId)?.testnet };
  const price = Number(d.pricePerToken || 0), supply = Number(d.totalSupply || 0);
  const raise = price * supply;
  const docs = (d.documents ?? []) as DocFingerprint[];

  const STEPS = ["Your asset", aboutLabel(d.assetClass), "The token", "Price & income", "Buyers & rules", "Review"];
  const TITLES = ["What are you tokenizing?", Q?.title ?? "About your asset", "Name your token", "Price and income", "Who can buy, and the rules your token enforces", "Review your offering"];

  const canNext = useMemo(() => {
    if (step === 0) return !!d.assetClass;
    if (step === 2) return !!(d.standard && d.name && d.symbol && d.totalSupply);
    if (step === 4) return rules.countryMode === "none" || rules.countries.length > 0;
    return true;
  }, [step, d, rules]);

  async function save(): Promise<Asset | null> {
    setSaving(true);
    setMsg(null);
    try {
      // Rules are saved once the issuer reaches step 5 (or opened a draft that has them); the legacy "lockup" text
      // mirrors the holding period for older screens.
      const r = d.rules ?? (step >= 4 ? rules : undefined);
      const body: Draft = { ...d, ...(r ? { rules: r, lockup: lockupLabel(r.lockupDays) } : {}) };
      const saved = d.id ? await api.updateAsset(d.id, body) : await api.createAsset(body);
      setD({ details: {}, documents: [], ...saved });
      loaded.current = saved.id;
      if (!d.id) nav(`/app/new?id=${saved.id}`, { replace: true });
      return saved;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      return null;
    } finally {
      setSaving(false);
    }
  }
  const next = async () => {
    if (step === 3 && !d.rules) setD((x) => ({ ...x, rules: suggestedRules(x.assetClass, x.exemption, (x.details as Details) ?? {}) }));
    if (step >= 2 && !(await save())) return;
    setStep((s) => s + 1);
  };

  async function addDoc(kind: string, file: File | undefined) {
    if (!file) return;
    const sha256 = await fingerprint(file);
    const rest = docs.filter((x) => x.kind !== kind);
    set({ documents: [...rest, { kind, name: file.name.slice(0, 120), sha256, size: file.size, addedAt: new Date().toISOString() }] });
  }

  const exemptionText = EXEMPTIONS.find(([v]) => v === (d.exemption ?? "unsure"))![1];
  const who = rules.accreditedOnly ? "verified, accredited investors" : "verified investors";
  const where = rules.countryMode === "allow" ? ` in ${rules.countries.map(countryName).join(", ")}` : rules.countryMode === "block" ? ` outside ${rules.countries.map(countryName).join(", ")}` : "";
  const ruleBits = [
    rules.lockupDays ? `a ${lockupLabel(rules.lockupDays).replace(/ \(.*\)/, "")} holding period enforced by the token` : "no holding period",
    rules.maxHolders ? `at most ${rules.maxHolders.toLocaleString()} holders` : "",
    rules.maxHolderPct ? `${rules.maxHolderPct}% per investor` : "",
    rules.resaleApproval ? "resales approved by you" : "",
    rules.maturity ? `maturing ${rules.maturity}` : "",
  ].filter(Boolean);
  const summary = cls && d.name
    ? `${d.name}${d.symbol ? ` (${d.symbol})` : ""} offers ${supply ? supply.toLocaleString() : "?"} tokens of ${cls.name.toLowerCase()}${price ? ` at ${usd(price)} each` : ""}${d.minInvestment ? ` (${usd(Number(d.minInvestment))} minimum)` : ""} to ${who}${where}${d.exemption === "506c" ? " under Reg D 506(c)" : d.exemption === "regs" ? " under Reg S" : ""}, ${d.schedule === "None" ? "with no regular income" : `paying income ${(SCHEDULES.find(([v]) => v === d.schedule)?.[1] ?? d.schedule ?? "").toLowerCase()}`}, with ${ruleBits.join(", ")}${rules.saleStartsAt ? `, selling from ${rules.saleStartsAt}${rules.saleEndsAt ? ` to ${rules.saleEndsAt}` : ""}` : ""}, on ${netLabel.name ?? "a test network"}${netLabel.testnet ? " (test network)" : ""}.`
    : "";

  // ---------------------------------------------------------------- helper rail per step
  const helper: { title: string; body: ReactNode }[][] = [
    [
      { title: "In plain English", body: <p>Tokenizing means creating digital shares of something real. Each share is a "token" on a blockchain, so ownership and payments are recorded publicly and automatically.</p> },
      { title: "You'll need, later", body: <ul><li>A company that owns the asset (often an SPV or LLC)</li><li>Your offering documents from your lawyer</li><li>About 7 minutes for this wizard</li></ul> },
      { title: "Nothing is public yet", body: <p>This creates a private draft. You'll practice on a test network with play money before anything goes live.</p> },
    ],
    [
      ...(Q?.help ?? []).map((h) => ({ title: h.title, body: typeof h.body === "string" ? <p>{h.body}</p> : <ul>{h.body.map((b) => <li key={b}>{b}</li>)}</ul> })),
      { title: "Where each answer goes", body: <ul><li><b>Listing</b>: shown to investors</li><li><b>On chain</b>: written into your token</li><li><b>Rule</b>: pre-sets a rule in step 5</li><li><b>Document</b>: fingerprint on chain, the file stays with you</li></ul> },
    ],
    [
      { title: "Common mistakes", body: <ul><li>A symbol already used by a well-known token</li><li>Too few tokens, so each one costs more than small investors can afford</li><li>Starting on a real network before practicing</li></ul> },
      { title: "Stuck on a word?", body: <p>Every "What's this?" explains a term in one sentence. The <Link to="/app/guide">Guide</Link> has the full glossary.</p> },
    ],
    [
      { title: "Example", body: <p>A $1M building, 100,000 tokens at $10, $500 minimum, rent paid quarterly. An investor buying 50 tokens ($500) gets 0.05% of each quarter's rent.</p> },
      { title: "Ask your lawyer", body: <ul><li>Is my minimum investment consistent with my exemption?</li><li>How often must I report to holders?</li></ul> },
    ],
    [
      { title: "In plain English", body: <p>These rules live inside the token. If someone tries a transfer that breaks one, it simply fails. Nobody, including us, can quietly skip them.</p> },
      { title: "Can I change them later?", body: <ul><li><b>Yes</b>: limits, countries, resale approval and maturity, from your admin wallet. Each change is public.</li><li><b>Loosening waits</b>: shortening a holding period takes effect 7 days after you schedule it.</li></ul> },
      { title: "Why some say \"New\"", body: <p>Before this update, the holding period and accreditation were recorded but not checked by the token. They are now.</p> },
    ],
    [
      { title: "Fixed after deploy", body: <ul><li>Name, symbol, total tokens</li><li>Document fingerprints (you can add new versions; old ones stay on record)</li></ul> },
      { title: "Changeable after deploy", body: <ul><li>Limits, countries, resale approval, maturity</li><li>Each change is public; loosening a holding period waits 7 days</li></ul> },
    ],
  ];
  const preview = step === 2 && (
    <div className="panel wz-preview">
      <div className="wz-ph">{cls && <AssetClassIcon id={cls.id} size={34} />}</div>
      <span className="muted" style={{ fontSize: 12 }}>How investors will see it</span>
      <b>{d.name || "Your token name"}</b>
      <span className="muted" style={{ fontSize: 13 }}>{[d.symbol || "SYMBOL", cls?.name, netLabel.name ? `${netLabel.name}${netLabel.testnet && !onStellar ? " (test)" : ""}` : ""].filter(Boolean).join(" · ")}</span>
    </div>
  );
  const helpBlocks = [
    ...helper[step]!.map((h) => <div className="panel wz-help" key={h.title}><h4>{h.title}</h4>{h.body}</div>),
    ...(step === 1 && Q ? [<div className="wz-tip" key="lawyer"><b>Ask your lawyer:</b> {Q.askLawyer}</div>] : []),
  ];

  // ---------------------------------------------------------------- review rows for step-2 answers
  const factRows = (Q?.sections ?? []).map((s) => ({
    title: s.title,
    rows: s.fields.flatMap((f) => {
      const v = details[f.id];
      if (v === undefined || v === "") return [];
      const shown = f.type === "yesno" ? (v ? "Yes" : "No")
        : f.type === "money" ? usd(Number(v))
        : f.type === "percent" ? `${v}%`
        : f.options ? f.options.find(([k]) => k === v)?.[1] ?? String(v) : String(v);
      return [[f.label, shown] as [string, string]];
    }),
  })).filter((s) => s.rows.length);

  const isCredit = d.assetClass === "private-credit";
  const isFund = d.assetClass === "funds";
  const isCarbon = d.assetClass === "carbon";
  const isTrex = d.standard === "erc3643";

  return (
    <>
      <div className="topbar">
        <h1>{d.id ? d.name || "Issuance" : "New issuance"}</h1>
        <span className="muted" style={{ fontSize: 13 }}>{d.updatedAt ? `Saved ${new Date(d.updatedAt).toLocaleString()}` : "Not saved yet"}</span>
      </div>
      <div className="content wz-content">
        <div className="wz-prog">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <b>Step {step + 1} of {STEPS.length} · {STEPS[step]}</b>
            <span className="muted" style={{ fontSize: 13 }}>About {MINUTES_LEFT[step]} {MINUTES_LEFT[step] === 1 ? "minute" : "minutes"} left · {step < 2 ? "saved after you name the token" : "saved when you continue"}</span>
          </div>
          <div className="wz-bar" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label="Wizard progress"><i style={{ width: `${[8, 28, 44, 60, 78, 96][step]}%` }} /></div>
          <div className="wz-chips">
            {STEPS.map((s, i) => (
              <button key={i} type="button" disabled={i >= step} className={i === step ? "on" : i < step ? "done" : ""} onClick={() => i < step && setStep(i)}>
                {i < step ? "✓ " : `${i + 1} · `}{s}
              </button>
            ))}
          </div>
        </div>

        <div className="wz">
          <div className="wz-main">
            <div><h2 className="wz-h">{TITLES[step]}</h2>
              {step === 0 && <p className="muted">Pick the closest match. It sets sensible defaults and the questions in the next step; you can change everything later.</p>}
              {step === 1 && Q && <p className="muted">{cls?.name} · {Q.intro}</p>}
              {step === 2 && cls && <p className="muted">{cls.name}</p>}
              {step === 3 && <p className="muted">What one token costs, the smallest purchase you'll accept, and how often holders get paid.</p>}
              {step === 4 && <p className="muted">Your token checks these rules itself on every transfer, so they still apply if it's traded on another marketplace or sent wallet to wallet.</p>}
            </div>

            {/* ------------------------------------------------ 1 · asset class */}
            {step === 0 && (
              <div className="wz-cards">
                {classes.map((c) => (
                  <button key={c.id} type="button" className={`wz-card ${d.assetClass === c.id ? "sel" : ""}`} aria-pressed={d.assetClass === c.id}
                    onClick={() => set({ assetClass: c.id, standard: fromBuilder.current && d.standard && (d.standard === "stellar-rwa" ? c.standards.some((s) => s === "erc3643" || s === "erc7943") : c.standards.includes(d.standard)) ? d.standard : c.standards.find((s) => standardById(s).available),...(c.id === "carbon" || c.id === "collectibles" ? { schedule: "None" } : {}) })}>
                    <b className="row" style={{ gap: 8, flexWrap: "nowrap" }}><span className="ico-inline"><AssetClassIcon id={c.id} size={18} /></span>{c.name}</b>
                    <span>{c.blurb}</span>
                    <span className="ex">Example: {EXAMPLES[c.id]}</span>
                  </button>
                ))}
              </div>
            )}
            {step === 0 && others.length > 0 && !showAll && (
              <button type="button" className="what-link" onClick={() => setAllClasses(true)}>
                Show all {ASSET_CLASSES.length} asset types ({others.map((c) => c.name.toLowerCase()).join(", ")})
              </button>
            )}

            {/* ------------------------------------------------ 2 · about your asset (W7–W10) */}
            {step === 1 && Q && (
              <>
                {Q.sections.map((s) => {
                  const calc = s.calc?.(details) ?? [];
                  return (
                    <div className="panel wz-sec" key={s.title}>
                      <div className="wz-sec-h"><h3>{s.title}</h3><TagChip tag={s.tag} /></div>
                      {s.intro && <p>{s.intro}</p>}
                      <div className="wz-two">
                        {s.fields.map((f) => (
                          <div key={f.id} style={f.type === "chips" || f.type === "yesno" || (f.type === "text" && (f.placeholder?.length ?? 0) > 24) ? { gridColumn: "1 / -1" } : undefined}>
                            <FieldInput f={f} value={details[f.id]} onChange={(v) => setDetail(f.id, v)} />
                          </div>
                        ))}
                      </div>
                      {calc.length > 0 && <div className="wz-calc">{calc.map(([k, v]) => <span key={k}>{k}<b>{v}</b></span>)}</div>}
                    </div>
                  );
                })}
                <div className="panel wz-sec">
                  <div className="wz-sec-h"><h3>Documents</h3><TagChip tag="document" /></div>
                  <p>Each file's fingerprint is written into the token, so anyone you share the file with can check it wasn't changed. The file itself never leaves your computer.</p>
                  {Q.documents.map((slot) => {
                    const have = docs.find((x) => x.kind === slot.kind);
                    return (
                      <label key={slot.kind} className={`wz-doc ${have ? "ok" : ""}`}>
                        <span><b>{slot.label}</b> · {have ? have.name : slot.hint}</span>
                        {have ? <span className="addr">sha256 {have.sha256.slice(0, 4)}…{have.sha256.slice(-4)} ✓ <span className="what-link">Replace</span></span> : <span className="btn ghost sm">Choose file</span>}
                        <input type="file" onChange={(e) => addDoc(slot.kind, e.target.files?.[0])} />
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            {/* ------------------------------------------------ 3 · the token */}
            {step === 2 && cls && (
              <>
                {recommended && !onStellar && (
                  <div className="wz-tip">
                    <b>Recommended for {cls.name.toLowerCase()}: {PLAIN[recommended] ?? standardById(recommended).name} ({standardById(recommended).name}).</b>{" "}
                    {cls.why} {d.standard !== recommended && <span>You've chosen {PLAIN[d.standard as StandardId] ?? d.standard}. </span>}
                    <button type="button" className="what-link" aria-expanded={otherTypes} onClick={() => setOtherTypes((o) => !o)}>{otherTypes ? "Hide other types" : "Choose a different type"}</button>
                    <What text={TERMS.type!} />
                  </div>
                )}
                {otherTypes && !onStellar && (
                  <div className="wz-cards">
                    {cls.standards.map((sid) => {
                      const s = standardById(sid);
                      return (
                        <button key={sid} type="button" disabled={!s.available} className={`wz-card ${d.standard === sid ? "sel" : ""}`} onClick={() => set({ standard: sid })} style={{ opacity: s.available ? 1 : 0.55 }}>
                          <b>{PLAIN[sid] ?? s.name}</b>
                          <span>{s.what}</span>
                          <span className="ex">{s.name}{sid === recommended ? " · Recommended" : ""}{!s.available ? " · Coming soon" : ""}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="q"><label htmlFor="wz-name">Token name</label> <What text={TERMS.name!} />
                  <input id="wz-name" className="input" value={d.name ?? ""} maxLength={64} placeholder="e.g. Harbor Lofts" onChange={(e) => set({ name: e.target.value })} /></div>
                <div className="q"><label htmlFor="wz-sym">Symbol</label> <What text={TERMS.symbol!} />
                  <input id="wz-sym" className="input" style={{ maxWidth: 220 }} value={d.symbol ?? ""} maxLength={11} placeholder="e.g. HARB" onChange={(e) => set({ symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} /></div>
                <div className="q"><label htmlFor="wz-supply">How many tokens?</label> <What text={TERMS.supply!} />
                  <input id="wz-supply" className="input" style={{ maxWidth: 260 }} inputMode="numeric" value={d.totalSupply ?? ""} readOnly={isCarbon && !!details.tonnes} placeholder="e.g. 100000" onChange={(e) => set({ totalSupply: e.target.value.replace(/[^0-9]/g, "") })} />
                  <span className="hint">{isCarbon && details.tonnes ? "Set from your tonnes: 1 token = 1 tonne CO2e." : "Example: a $1,000,000 building split into 100,000 tokens at $10 each."}</span></div>
                <fieldset className="q wz-nets">
                  <legend>Network <What text={TERMS.network!} /></legend>
                  <span className="hint">The blockchain that records the token. Practice on a test network first; it works the same way with play money.</span>
                  <div className="wz-cards">
                    {NETWORKS.filter((n) => n.testnet).map((n) => (
                      <label key={n.id} className={`wz-card wz-net ${d.chainId === n.id ? "sel" : ""}`}>
                        <input type="radio" name="wz-net" checked={d.chainId === n.id} onChange={() => pickNetwork(n.id)} />
                        <span><b>{n.name}</b><span>Test network · Ethereum-style wallets</span></span>
                      </label>
                    ))}
                    {STELLAR_NETWORKS.filter((n) => n.testnet).map((n) => (
                      <label key={n.id} className={`wz-card wz-net ${d.chainId === n.id ? "sel" : ""} ${stellarOk ? "" : "off"}`}>
                        <input type="radio" name="wz-net" checked={d.chainId === n.id} disabled={!stellarOk} onChange={() => pickNetwork(n.id)} />
                        <span><b>{n.name} <i className="new-tag">NEW</i></b><span>{stellarOk ? "Test network · Stellar wallet (Freighter)" : `Not available for ${cls?.name.toLowerCase() ?? "this asset"} yet`}</span></span>
                      </label>
                    ))}
                  </div>
                  {(
                    <div className="q" style={{ marginTop: 8 }}><label htmlFor="wz-net">Or a real network</label>
                      <select id="wz-net" className="input" style={{ maxWidth: 380 }} value={(networkById(d.chainId) ?? stellarById(d.chainId))?.testnet === false ? d.chainId : ""} onChange={(e) => e.target.value && pickNetwork(Number(e.target.value))}>
                        <option value="">{tenant?.plan.testnetOnly ? "Real networks · upgrade to go live" : "Choose a real network (real money)"}</option>
                        {/* Free plan: real networks show locked (design S4); the server refuses them at deploy too. */}
                        {NETWORKS.filter((n) => !n.testnet).map((n) => <option key={n.id} value={n.id} disabled={!!tenant?.plan.testnetOnly}>{tenant?.plan.testnetOnly ? "🔒 " : ""}{n.name}{n.stable ? ` · ${n.stable.symbol}` : ""}</option>)}
                        {stellarOk && STELLAR_NETWORKS.filter((n) => !n.testnet).map((n) => <option key={n.id} value={n.id} disabled={!!tenant?.plan.testnetOnly}>{tenant?.plan.testnetOnly ? "🔒 " : ""}{n.name} · {n.payToken.code} (multisig admin)</option>)}
                      </select>
                      {tenant?.plan.testnetOnly && <span className="hint">Real networks unlock when you <Link to="/app/billing">upgrade</Link>; nothing you build is lost.</span>}
                    </div>
                  )}
                </fieldset>
                {onStellar && (
                  <div className="wz-tip wz-stellar">
                    <b>What changes on Stellar</b>
                    <ul>
                      <li>Token type is fixed to a <b>regulated security token</b> (the Stellar version of ERC-3643). Your investor checks and the rules from step 5 are enforced by the token itself, as on the other networks.</li>
                      <li>You and your investors use a <b>Stellar wallet</b> (Freighter). Addresses start with G (people) or C (contracts).</li>
                      <li>Amounts use <b>7 decimal places</b>, Stellar's standard.</li>
                      <li><b>Chainlink</b> still checks this offering: it reads the token straight from the Stellar ledger and records supply and proof checks on Base, next to your other offerings.</li>
                    </ul>
                    <span className="hint">Stellar mainnet opens after testnet. Fund vaults, collectible sets and one-of-a-kind NFTs stay on the Ethereum-style networks.</span>
                  </div>
                )}
              </>
            )}

            {/* ------------------------------------------------ 4 · price & income */}
            {step === 3 && (
              <>
                <div className="wz-two">
                  <div className="q"><label htmlFor="wz-price">Price per token (USD)</label>
                    <input id="wz-price" className="input" inputMode="decimal" value={d.pricePerToken ?? ""} placeholder="e.g. 10" onChange={(e) => set({ pricePerToken: e.target.value.replace(/[^0-9.]/g, "") })} />
                    <span className="hint">What an investor pays for one token, in USDC.</span></div>
                  <div className="q"><label htmlFor="wz-min">Minimum investment (USD)</label>
                    <input id="wz-min" className="input" inputMode="decimal" value={d.minInvestment ?? ""} placeholder="e.g. 500" onChange={(e) => set({ minInvestment: e.target.value.replace(/[^0-9.]/g, "") })} />
                    <span className="hint">The smallest purchase allowed. Many issuers use $500 to $5,000.</span></div>
                </div>
                <div className="wz-tip wz-raise"><span>If every token sells, you raise</span><b>{raise > 0 ? usd(raise) : "—"}</b></div>
                <fieldset className="q"><legend>How often do holders get paid? <What text={TERMS.schedule!} /></legend>
                  <div className="chips">{SCHEDULES.map(([v, l]) => <button type="button" key={v} className={`chip ${d.schedule === v ? "on" : ""}`} aria-pressed={d.schedule === v} onClick={() => set({ schedule: v })}>{l}</button>)}</div>
                  <span className="hint">{isCredit ? "Set from \"interest paid\" in step 2; change it here if needed." : "Rent or royalties you'll send to token holders. You send each payout from the Payouts page; nothing pays automatically without you."}</span></fieldset>
                <div className="hint">The holding period before resale is now a rule the token enforces: you'll set it in step 5.</div>
              </>
            )}

            {/* ------------------------------------------------ 5 · buyers & rules (W11) */}
            {step === 4 && (
              <>
                <fieldset className="q"><legend>Your offering exemption <What text={TERMS.exemption!} /></legend>
                  <div className="chips">{EXEMPTIONS.map(([v, l]) => (
                    <button type="button" key={v} className={`chip ${(d.exemption ?? "unsure") === v ? "on" : ""}`} aria-pressed={(d.exemption ?? "unsure") === v}
                      onClick={() => setD((x) => ({ ...x, exemption: v, ...(rulesTouched ? {} : { rules: suggestedRules(x.assetClass, v, (x.details as Details) ?? {}) }) }))}>{l}</button>
                  ))}</div>
                  <span className="hint">"Not sure yet" is fine for practicing. Changing it updates the suggested rules below until you edit one.</span></fieldset>

                <div className="wz-tip row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <span><b>Pre-set for {cls?.name.toLowerCase()}{d.exemption === "506c" ? " · Reg D 506(c)" : d.exemption === "regs" ? " · Reg S" : ""}.</b> Change anything; your lawyer confirms the final settings.</span>
                  <button type="button" className="what-link" onClick={() => { setRulesTouched(false); set({ rules: suggestedRules(d.assetClass, d.exemption, details) }); }}>Reset to suggested</button>
                </div>

                <div className="panel wz-checks">
                  <div className="li"><span>1. Sanctions screening</span><span className="wz-st ok">Automatic</span></div>
                  <div className="li"><span>2. Identity check (photo ID + selfie, by Sumsub)</span><span className={`wz-st ${kycOn ? "ok" : "warn"}`}>{kycOn ? "Included" : "Switching on soon"}</span></div>
                  <div className="li"><span>3. Accredited investor check (bank-verified, by Mastercard)</span><span className="wz-st ok">{rules.accreditedOnly ? "Required" : "Optional"}</span></div>
                  <div className="li"><span>4. You approve the wallet</span><span className="wz-st no">Your decision</span></div>
                </div>

                <div className="panel wz-rules">
                  <div className="wz-sec-h"><h3>Who may hold the token</h3><span className="wz-tag onchain">Enforced on chain</span></div>
                  <RuleRow title="Verified investors only" desc="Wallets that haven't passed the checks above can't receive the token, from you or from anyone else.">
                    <button type="button" className="tog lock" aria-pressed="true" aria-label="Verified investors only: always on">Always</button>
                  </RuleRow>
                  <RuleRow title="Accredited investors only" isNew="New" desc={<>Required for Reg D 506(c). The token checks accreditation on every transfer, not just at purchase.{isTrex && " On this token type it's an extra claim you sign for each investor."}</>}>
                    <Toggle on={rules.accreditedOnly} label="Accredited investors only" onChange={(v) => setRules({ accreditedOnly: v })} />
                  </RuleRow>
                  <RuleRow title="Approval expires" isNew="New" desc="An investor's approval lapses after this time and they re-verify before buying more. Holding stays allowed.">
                    <select className="input" aria-label="Approval expires after" value={rules.approvalDays} onChange={(e) => setRules({ approvalDays: Number(e.target.value) })}>
                      <option value={90}>90 days</option><option value={365}>12 months</option><option value={730}>2 years</option><option value={0}>Never</option>
                    </select>
                  </RuleRow>
                  <RuleRow title="Countries" isNew="New: per offering" desc={<>Allow or block buyers by country for this offering only. Your other offerings keep their own lists.
                    {rules.countryMode !== "none" && (
                      <span className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {rules.countries.map((c) => <span className="wz-country" key={c}>{countryName(c)}<button type="button" aria-label={`Remove ${countryName(c)}`} onClick={() => setRules({ countries: rules.countries.filter((x) => x !== c) })}>×</button></span>)}
                        <select className="input" style={{ width: 200 }} aria-label="Add a country" value="" onChange={(e) => e.target.value && setRules({ countries: [...new Set([...rules.countries, Number(e.target.value)])] })}>
                          <option value="">Add a country…</option>
                          {COUNTRIES.filter(([c]) => !rules.countries.includes(c)).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                        </select>
                      </span>
                    )}</>}>
                    <select className="input" aria-label="Country rule" value={rules.countryMode} onChange={(e) => setRules({ countryMode: e.target.value as Rules["countryMode"] })}>
                      <option value="none">Everywhere</option><option value="allow">Only these countries</option><option value="block">Everywhere except</option>
                    </select>
                  </RuleRow>
                </div>

                <div className="panel wz-rules">
                  <div className="wz-sec-h"><h3>{isFund ? "Redemptions and limits" : "Resale limits"}</h3><span className="wz-tag onchain">Enforced on chain</span></div>
                  <RuleRow title={isFund ? "Lock-up on new shares" : "Holding period"} isNew="Now enforced" desc={isFund
                    ? "Shares can't be transferred or cashed out until this long after each deposit."
                    : "Tokens can't be resold until this long after each purchase. Counted per purchase, so later buys have later dates. You can still move tokens if a court orders it."}>
                    <select className="input" aria-label="Holding period" value={rules.lockupDays} onChange={(e) => setRules({ lockupDays: Number(e.target.value) })}>
                      {[...LOCKUP_CHOICES, ...(LOCKUP_CHOICES.some(([v]) => v === rules.lockupDays) ? [] : [[rules.lockupDays, `${rules.lockupDays} days`] as [number, string]])].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </RuleRow>
                  {(isFund || isCarbon) && (
                    <RuleRow title={isFund ? "Lock-up also blocks redemptions" : "Retiring waits for the holding period"} desc={isFund ? "On: shares can't be cashed out during the lock-up either." : "On: holders can only retire credits after the holding period."}>
                      <Toggle on={rules.lockBurns} label="Lock covers burns" onChange={(v) => setRules({ lockBurns: v })} />
                    </RuleRow>
                  )}
                  <RuleRow title="Maximum number of holders" isNew="New" desc={isFund ? "99 keeps a 3(c)(1) fund within its limit; 3(c)(7) funds can go higher. New buyers are blocked at the limit." : "Staying under 2,000 holders keeps most private companies from having to register with the SEC (Section 12(g)). New buyers are blocked at the limit; existing holders can still trade with each other."}>
                    <input className="input" aria-label="Maximum holders" inputMode="numeric" value={rules.maxHolders || ""} placeholder="No limit" onChange={(e) => setRules({ maxHolders: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} />
                  </RuleRow>
                  {!isFund && (
                    <RuleRow title="Most one investor can hold" isNew="New" desc="Keeps any single wallet below this share of all tokens.">
                      <input className="input" aria-label="Maximum share per investor, percent" inputMode="decimal" value={rules.maxHolderPct || ""} placeholder="No limit" onChange={(e) => setRules({ maxHolderPct: Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0) })} /><span className="muted">%</span>
                    </RuleRow>
                  )}
                  <RuleRow title="You approve each resale" isNew="New" desc="Investor-to-investor transfers wait for your OK (matches a right of first refusal). Off means approved buyers trade freely.">
                    <Toggle on={rules.resaleApproval} label="Approve each resale" onChange={(v) => setRules({ resaleApproval: v })} />
                  </RuleRow>
                  {(isCredit || rules.maturity) && (
                    <RuleRow title="Maturity" isNew="New" desc="From this date nothing can be issued or traded; you repay holders and burn the tokens.">
                      <input className="input" type="date" aria-label="Maturity date" value={rules.maturity} onChange={(e) => setRules({ maturity: e.target.value })} />
                    </RuleRow>
                  )}
                </div>

                <div className="panel wz-rules">
                  <div className="wz-sec-h"><h3>The sale</h3><span className="wz-tag onchain">Enforced on chain</span></div>
                  <RuleRow title="Sale dates" isNew="New" desc="Purchases open and close on these dates. Leave the end empty to keep it open until sold out.">
                    <input className="input" type="date" aria-label="Sale opens" value={rules.saleStartsAt} onChange={(e) => setRules({ saleStartsAt: e.target.value })} />
                    <input className="input" type="date" aria-label="Sale closes" value={rules.saleEndsAt} onChange={(e) => setRules({ saleEndsAt: e.target.value })} />
                  </RuleRow>
                </div>

                <div className="panel wz-rules">
                  <div className="wz-sec-h"><h3>Your emergency controls</h3><span className="wz-tag listing">Always included</span></div>
                  <RuleRow title="Pause, freeze, forced transfer" desc="Stop all transfers, freeze one wallet, or move tokens when a court or regulator requires it. Every use is recorded on chain.">
                    <button type="button" className="tog lock" aria-pressed="true" aria-label="Emergency controls: always on">Always</button>
                  </RuleRow>
                </div>
              </>
            )}

            {/* ------------------------------------------------ 6 · review (W12) */}
            {step === 5 && cls && d.standard && (
              <>
                <div className="wz-tip wz-sum"><b>In one sentence:</b> {summary}</div>
                {factRows.map((s) => (
                  <div className="panel" key={s.title}>
                    <div className="row" style={{ justifyContent: "space-between" }}><h3>{s.title}</h3><button type="button" className="what-link" onClick={() => setStep(1)}>Edit</button></div>
                    {s.rows.map(([k, v]) => <div className="li" key={k}><span className="muted">{k}</span><span>{v}</span></div>)}
                  </div>
                ))}
                <div className="panel">
                  <div className="row" style={{ justifyContent: "space-between" }}><h3>Token and price</h3><button type="button" className="what-link" onClick={() => setStep(2)}>Edit</button></div>
                  <div className="li"><span className="muted">Token</span><span>{d.name} ({d.symbol}) · {PLAIN[d.standard] ?? ""} ({standardById(d.standard).name}) · {supply.toLocaleString()} tokens</span></div>
                  <div className="li"><span className="muted">Network</span><span>{netLabel.name ?? "—"}{netLabel.testnet ? " (test network)" : ""}</span></div>
                  <div className="li"><span className="muted">Price</span><span>{price ? usd(price) : "—"} per token · {d.minInvestment ? `${usd(Number(d.minInvestment))} minimum` : "no minimum"}{raise ? ` · raises up to ${usd(raise)}` : ""}</span></div>
                  <div className="li"><span className="muted">Income</span><span>{SCHEDULES.find(([v]) => v === d.schedule)?.[1] ?? d.schedule}{d.schedule !== "None" ? " · you send each payout from Payouts" : ""}</span></div>
                </div>
                <div className="panel">
                  <div className="row" style={{ justifyContent: "space-between" }}><h3>Rules the token enforces <span className="wz-tag onchain">On chain</span></h3><button type="button" className="what-link" onClick={() => setStep(4)}>Edit</button></div>
                  <div className="li"><span className="muted">Who may hold</span><span>{rules.accreditedOnly ? "Verified + accredited" : "Verified investors"}{rules.countryMode === "allow" ? ` · only ${rules.countries.map(countryName).join(", ")}` : rules.countryMode === "block" ? ` · not ${rules.countries.map(countryName).join(", ")}` : ""} · approvals {rules.approvalDays ? `renew every ${({ 90: "90 days", 365: "12 months", 730: "2 years" } as Record<number, string>)[rules.approvalDays] ?? `${rules.approvalDays} days`}` : "never expire"}</span></div>
                  <div className="li"><span className="muted">Holding period</span><span>{rules.lockupDays ? `${lockupLabel(rules.lockupDays)} from each purchase${rules.lockBurns ? ", redemptions included" : ""}` : "None"}</span></div>
                  <div className="li"><span className="muted">Limits</span><span>{[rules.maxHolders ? `${rules.maxHolders.toLocaleString()} holders max` : "", rules.maxHolderPct ? `${rules.maxHolderPct}% per investor max` : ""].filter(Boolean).join(" · ") || "None"}</span></div>
                  <div className="li"><span className="muted">Resale approval</span><span>{rules.resaleApproval ? "On (you approve each resale)" : "Off (approved investors trade freely)"}</span></div>
                  {rules.maturity && <div className="li"><span className="muted">Maturity</span><span>{rules.maturity}</span></div>}
                  <div className="li"><span className="muted">Sale dates</span><span>{rules.saleStartsAt || rules.saleEndsAt ? `${rules.saleStartsAt || "on deploy"} – ${rules.saleEndsAt || "until sold out"}` : "Open on deploy, until sold out"}</span></div>
                  <div className="li"><span className="muted">Exemption</span><span>{exemptionText}</span></div>
                  <div className="li"><span className="muted">Emergency controls</span><span>Pause · freeze a wallet · forced transfer (court order)</span></div>
                </div>
                <div className="panel">
                  <div className="row" style={{ justifyContent: "space-between" }}><h3>Documents written into the token</h3><button type="button" className="what-link" onClick={() => setStep(1)}>Edit</button></div>
                  {docs.length ? docs.map((x) => <div className="li" key={x.kind}><span className="muted">{x.name}</span><span className="addr">sha256 {x.sha256.slice(0, 4)}…{x.sha256.slice(-4)}</span></div>)
                    : <p className="muted" style={{ fontSize: 14 }}>None yet. You can deploy without them for practice; add them before you go live.</p>}
                </div>
                {d.id && (
                  <div className="panel">
                    <h3>What happens next</h3>
                    <div className="li"><span>1. Deploy to the test network: token, rules, sale (about 3 minutes, your wallet confirms each step)</span><span className="wz-st warn">Next</span></div>
                    <div className="li"><span>2. Test it: a practice purchase{rules.lockupDays ? ", then try a resale and see it blocked by the holding period" : ""}</span><span className="wz-st no">Then</span></div>
                    <div className="li"><span>3. Send the summary to your lawyer and tick legal sign-off on your dashboard</span><span className="wz-st no">Then</span></div>
                    <div className="li"><span>4. {tenant?.plan.testnetOnly ? "Upgrade and deploy" : "Deploy"} to a real network when you're ready</span><span className="wz-st no">Later</span></div>
                  </div>
                )}
              </>
            )}

            {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

            <details className="wz-help-m"><summary>Help for this step</summary>{preview}{helpBlocks}</details>

            <div className="actions">
              <button className="btn ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>← Back</button>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {step === 5 && summary && (
                  <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(summary).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); })}>{copied ? "Copied" : "Copy summary for my lawyer"}</button>
                )}
                {step < STEPS.length - 1 ? (
                  <button className="btn primary" disabled={!canNext || saving} onClick={next}>{saving ? "Saving…" : `Continue: ${STEPS[step + 1]!.toLowerCase()} →`}</button>
                ) : d.id ? (
                  <Link className="btn primary" to={`/app/assets/${d.id}`}>Deploy to {netLabel.testnet ? "test network" : netLabel.name ?? "network"} →</Link>
                ) : null}
              </div>
            </div>
          </div>

          <aside className="wz-rail">{preview}{helpBlocks}</aside>
        </div>
      </div>
    </>
  );
}
