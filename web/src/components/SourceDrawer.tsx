import { X } from 'lucide-react';
import type { MemoryItem, Persona, Source, SourceRef } from '../../../shared/types';
import { Avatar, Badge, dom, kindLabel, srcKind } from './ui';

function highlight(text: string, quote: string) {
  const i = quote ? text.indexOf(quote) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + quote.length)}</mark>
      {text.slice(i + quote.length)}
    </>
  );
}

export function SourceDrawer({ target, sources, personas, memory, onClose }: { target: SourceRef | null; sources: Source[]; personas: Persona[]; memory: MemoryItem[]; onClose: () => void }) {
  if (!target) return null;
  const src = sources.find((s) => s.id === target.sourceId);
  const owner = personas.find((p) => p.id === src?.personaId);
  const citing = memory.filter((m) => (m.refs ?? []).some((r) => r.sourceId === target.sourceId));
  return (
    <div className="backdrop backdrop-right" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Πηγή" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn drawer-x" onClick={onClose} aria-label="Κλείσιμο">
          <X size={20} />
        </button>
        {!src ? (
          <p>Η πηγή {target.sourceId} δεν βρέθηκε.</p>
        ) : (
          <>
            <div className="drawer-head">
              {owner && <Avatar persona={owner} size={44} ring />}
              <div>
                <p className="eyebrow">
                  {srcKind(src.kind).emoji} {srcKind(src.kind).label} · {src.id}
                </p>
                <h3>{src.title}</h3>
                <p className="muted small">
                  {owner?.name ?? 'Παρέα'} · {Number.isFinite(Date.parse(src.date)) ? new Date(src.date).toLocaleDateString('el-GR', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}
                  {src.fileName && ` · ${src.fileName}`}
                </p>
              </div>
            </div>
            {src.synthetic && <Badge tone="info">Συνθετικά δεδομένα</Badge>}
            <blockquote className="source-text">{highlight(src.text, target.quote)}</blockquote>
            <h4 className="drawer-sub">Τι έμαθε το Twin από εδώ ({citing.length})</h4>
            <ul className="plain">
              {citing.map((m) => (
                <li key={m.id} className="drawer-mem">
                  <span className="dot" style={{ background: dom(m.domain).color }} />
                  <div>
                    <strong>{m.statement}</strong>
                    <div className="small muted">
                      {kindLabel(m.kind)}
                      {m.hard && ' · υποχρεωτικό'}
                      {m.scope === 'request' && ' · μόνο για ένα αίτημα'} · {m.status === 'confirmed' ? 'επιβεβαιωμένο' : m.status === 'candidate' ? 'προς έλεγχο' : 'ανενεργό'}
                    </div>
                    {m.memory && (
                      <div className="mono tiny muted">
                        OpenSelf · trust {m.memory.sourceTrust} · {m.memory.contentHash.slice(0, 10)}…
                      </div>
                    )}
                  </div>
                </li>
              ))}
              {!citing.length && <li className="muted small">Τίποτα ακόμα.</li>}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
