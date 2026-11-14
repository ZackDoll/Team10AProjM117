import { Fragment } from 'react';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Renders `text` with the canary and the marker phrase wrapped in <mark>.
 *  React escapes everything, so attacker-written HTML in a log is shown as plain text. */
export function Highlight({ text, canary, marker }: { text: unknown; canary?: string | null; marker?: string }) {
  const str = String(text ?? '');
  const m = (marker ?? '').trim();
  const terms = [canary, m].filter((t): t is string => !!t).map(escapeRe);
  if (!terms.length) return <>{str}</>;

  const re = new RegExp(terms.join('|'), 'gi');
  const parts: React.ReactNode[] = [];
  let last = 0, hit: RegExpExecArray | null, n = 0;
  while ((hit = re.exec(str))) {
    if (hit[0].length === 0) { re.lastIndex++; continue; }
    if (hit.index > last) parts.push(<Fragment key={n++}>{str.slice(last, hit.index)}</Fragment>);
    const isCanary = !!canary && hit[0].toLowerCase() === canary.toLowerCase();
    parts.push(<mark key={n++} className={isCanary ? 'canary' : 'marker'}>{hit[0]}</mark>);
    last = hit.index + hit[0].length;
  }
  if (last < str.length) parts.push(<Fragment key={n++}>{str.slice(last)}</Fragment>);
  return <>{parts}</>;
}
