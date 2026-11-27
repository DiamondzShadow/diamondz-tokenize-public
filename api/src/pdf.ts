// Minimal text-only PDF writer (Helvetica, US Letter) for the letters we send to Adobe Acrobat Sign.
// No dependency: a letter is a title plus paragraphs. Adobe reads `{{…_es_:signer1…}}` text tags from the text layer
// and turns them into signing fields, so the text must stay real text (never images).

export interface LetterPara { text: string; bold?: boolean; size?: number; gapBefore?: number }

const W = 612, H = 792, MARGIN = 72, MAX_W = W - 2 * MARGIN;
// Helvetica average glyph width ≈ 0.5 em; wrap conservatively at 0.52 em so lines never run past the margin.
const charsPerLine = (size: number) => Math.floor(MAX_W / (size * 0.52));

/** PDF string literal: escape \ ( ) and drop anything outside printable Latin-1 (Helvetica's WinAnsi range). */
function pdfStr(s: string) {
  const clean = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
  return `(${clean.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

function wrap(text: string, size: number): string[] {
  const max = charsPerLine(size);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Text tags must never be split across lines: treat each {{…}} as one word.
    const words = raw.match(/\{\{[^}]*\}\}|\S+/g) ?? [""];
    let line = "";
    for (const w of words) {
      if (!line) line = w;
      else if ((line + " " + w).length <= max) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

export function letterPdf(paras: LetterPara[]): Uint8Array {
  type Line = { text: string; bold: boolean; size: number; y: number; page: number };
  const lines: Line[] = [];
  let page = 0, y = H - MARGIN;
  for (const p of paras) {
    const size = p.size ?? 11, lead = size * 1.45;
    y -= p.gapBefore ?? size * 0.9;
    for (const t of wrap(p.text, size)) {
      if (y - lead < MARGIN) { page++; y = H - MARGIN; }
      y -= lead;
      lines.push({ text: t, bold: !!p.bold, size, y, page });
    }
  }
  const pages = page + 1;
  const objs: string[] = [];
  // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then per page: page obj + content stream
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  for (let i = 0; i < pages; i++) {
    const body = lines.filter((l) => l.page === i)
      .map((l) => `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf ${MARGIN} ${l.y.toFixed(2)} Td ${pdfStr(l.text)} Tj ET`).join("\n");
    const stream = Buffer.from(body, "latin1");
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${body}\nendstream`;
  }
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
