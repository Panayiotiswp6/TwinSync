import type { ReactNode } from 'react';
import type { Owner, SourceRef } from '../../../shared/types';

export type OpenSource = (ref: SourceRef) => void;

export function Avatar({ owner, size = 36 }: { owner: Owner; size?: number }) {
  return (
    <span className="avatar" style={{ background: owner.color, width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {owner.initials}
    </span>
  );
}

/** Citation chips: each opens the exact source with the quoted span highlighted. */
export function Cite({ refs, onOpen }: { refs: SourceRef[]; onOpen: OpenSource }) {
  if (!refs.length) return null;
  return (
    <span className="cites">
      {refs.map((r) => (
        <button key={r.sourceId + r.quote} type="button" className="cite" title={`«${r.quote}»`} onClick={() => onOpen(r)}>
          {r.sourceId}
        </button>
      ))}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'ai'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Section({ step, title, subtitle, id, children, aside }: { step: number; title: string; subtitle?: string; id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section" id={id}>
      <header className="section-head">
        <span className="step">{step}</span>
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {aside && <div className="section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Details({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="more" open={open}>
      <summary>{summary}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}
