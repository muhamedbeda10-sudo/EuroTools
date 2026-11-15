import { Fragment, type ReactNode } from "react";

/** A small, safe renderer for the assistant's replies: paragraphs, lists, small tables, bold, code and links.
 *  It builds React elements only (no HTML is ever injected), and every block sets `dir="auto"` so Arabic
 *  reads right to left while symbols and numbers keep their order. */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) out.push(<strong key={`${key}-${n++}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={`${key}-${n++}`}>{token.slice(1, -1)}</code>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      out.push(<a key={`${key}-${n++}`} href={href} target="_blank" rel="noopener noreferrer">{label}</a>);
    }
    last = m.index! + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  const key = () => `b${blocks.length}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key()} dir="ltr"><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key()} dir="auto" className="md-h">{inline(heading[2], key())}</p>);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      const k = key();
      blocks.push(
        <div key={k} className="md-table">
          <table dir="auto">
            <thead><tr>{head.map((h, c) => <th key={c}>{inline(h, `${k}h${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, c) => <td key={c}>{inline(r[c] ?? "", `${k}r${ri}c${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*([-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (bullet.test(lines[i])) items.push(lines[i].replace(bullet, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const k = key();
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={k} dir="auto">{items.map((t, n) => <li key={n}>{inline(t, `${k}i${n}`)}</li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("```") && !/^(#{1,4})\s+/.test(lines[i])
           && !bullet.test(lines[i]) && !(lines[i].trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    const k = key();
    blocks.push(
      <p key={k} dir="auto">
        {para.map((t, n) => <Fragment key={n}>{n > 0 && <br />}{inline(t, `${k}l${n}`)}</Fragment>)}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
