import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import type { Category, Domain, MemoryKind, Persona, SourceKind, SourceRef } from '../../../shared/types';

export type OpenSource = (ref: SourceRef) => void;

export const CATEGORY: Record<Category, { label: string; emoji: string; grad: string }> = {
  trip: { label: 'Ταξίδι', emoji: '🧳', grad: 'linear-gradient(135deg,#43cea2,#185a9d)' },
  food: { label: 'Φαγητό', emoji: '🍽️', grad: 'linear-gradient(135deg,#f7971e,#ff5e62)' },
  entertainment: { label: 'Έξοδος', emoji: '🎉', grad: 'linear-gradient(135deg,#8e2de2,#e44fc4)' },
  activity: { label: 'Δραστηριότητα', emoji: '⚡', grad: 'linear-gradient(135deg,#00b4db,#7f5af0)' },
  gift: { label: 'Δώρο', emoji: '🎁', grad: 'linear-gradient(135deg,#ff6a88,#ff99ac)' },
  other: { label: 'Άλλο', emoji: '✨', grad: 'linear-gradient(135deg,#7f5af0,#ff8a3d)' },
};

export const DOMAIN: Record<Domain, { label: string; emoji: string; color: string }> = {
  travel: { label: 'Ταξίδια', emoji: '🧭', color: '#0ea5e9' },
  food: { label: 'Φαγητό', emoji: '🍝', color: '#f97316' },
  money: { label: 'Χρήματα', emoji: '💶', color: '#16a34a' },
  schedule: { label: 'Πρόγραμμα', emoji: '⏰', color: '#eab308' },
  social: { label: 'Κοινωνικά', emoji: '🫶', color: '#ec4899' },
  activities: { label: 'Δραστηριότητες', emoji: '🥾', color: '#14b8a6' },
  comfort: { label: 'Άνεση', emoji: '🛏️', color: '#8b5cf6' },
  style: { label: 'Ύφος', emoji: '✍️', color: '#64748b' },
  other: { label: 'Άλλα', emoji: '📌', color: '#94a3b8' },
};

export const KIND: Record<MemoryKind, string> = {
  preference: 'Προτίμηση',
  constraint: 'Περιορισμός',
  fact: 'Γεγονός',
  decision_pattern: 'Μοτίβο απόφασης',
  style: 'Ύφος',
};

export const SOURCE_KIND: Record<SourceKind, { label: string; emoji: string }> = {
  document: { label: 'Έγγραφο', emoji: '📄' },
  note: { label: 'Σημείωση', emoji: '🗒️' },
  chat: { label: 'Chat', emoji: '💬' },
  email: { label: 'Email', emoji: '✉️' },
  past_decision: { label: 'Παλιά απόφαση', emoji: '⚖️' },
  wish: { label: 'Επιθυμία', emoji: '🌟' },
  correction: { label: 'Διόρθωση', emoji: '✏️' },
  request: { label: 'Αίτημα', emoji: '📣' },
};

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'μόλις τώρα';
  if (s < 3600) return `πριν ${Math.round(s / 60)} λ.`;
  if (s < 86400) return `πριν ${Math.round(s / 3600)} ώ.`;
  return new Date(iso).toLocaleDateString('el-GR', { day: 'numeric', month: 'short' });
}

export function Avatar({ persona, size = 40, ring = false, onClick }: { persona: Persona; size?: number; ring?: boolean; onClick?: () => void }) {
  const inner = (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `linear-gradient(135deg, ${persona.colors[0]}, ${persona.colors[1]})` }}
      aria-label={persona.name}
      title={persona.name}
    >
      {persona.emoji || persona.initials}
    </span>
  );
  const body = ring ? <span className="ring" style={{ padding: Math.max(2, size * 0.06) }}>{inner}</span> : inner;
  return onClick ? (
    <button type="button" className="avatar-btn" onClick={onClick} aria-label={`Προφίλ ${persona.name}`}>
      {body}
    </button>
  ) : (
    body
  );
}

export function AvatarStack({ personas, size = 26 }: { personas: Persona[]; size?: number }) {
  return (
    <span className="stack">
      {personas.map((p) => (
        <Avatar key={p.id} persona={p} size={size} />
      ))}
    </span>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'ai' | 'brand'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Cite({ refs, onOpen }: { refs: SourceRef[]; onOpen: OpenSource }) {
  if (!refs.length) return null;
  return (
    <span className="cites">
      {refs.map((r, i) => (
        <button key={r.sourceId + i} type="button" className="cite" title={r.quote ? `«${r.quote}»` : r.sourceId} onClick={() => onOpen(r)}>
          {r.sourceId.replace(/^src-/, '')}
        </button>
      ))}
    </span>
  );
}

export function ScoreRing({ value, size = 44, label }: { value: number; size?: number; label?: string }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = value >= 65 ? 'var(--good)' : value >= 40 ? 'var(--warn)' : 'var(--bad)';
  return (
    <span className="score-ring" style={{ width: size, height: size }} title={label ?? `${value}/100`}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line)" strokeWidth="5" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="5" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b style={{ fontSize: size * 0.3 }}>{value}</b>
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Κλείσιμο">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-emoji">{emoji}</div>
      <h4>{title}</h4>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
