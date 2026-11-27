// Small, safe renderer for a white-label customer's legal pages: "## heading", "### subheading", "- item" lists,
// blank-line paragraphs, **bold** and [text](https://… | mailto:…) links. Builds React elements only (no HTML strings).
import { Fragment, type ReactNode } from "react";

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(<Fragment key={i++}>{s.slice(last, m.index)}</Fragment>);
    out.push(m[1] ? <b key={i++}>{m[1]}</b> : <a key={i++} href={m[3]} target={m[3]!.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer">{m[2]}</a>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(<Fragment key={i++}>{s.slice(last)}</Fragment>);
  return out;
}

export default function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [], list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((li, j) => <li key={j}>{inline(li)}</li>)}</ul>);
    para = []; list = [];
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push(h[1] === "##" ? <h2 key={blocks.length}>{inline(h[2]!)}</h2> : <h3 key={blocks.length}>{inline(h[2]!)}</h3>); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>); para = []; } list.push(li[1]!); continue; }
    if (list.length) { blocks.push(<ul key={blocks.length}>{list.map((x, j) => <li key={j}>{inline(x)}</li>)}</ul>); list = []; }
    para.push(line.trim());
  }
  flush();
  return <>{blocks}</>;
}
