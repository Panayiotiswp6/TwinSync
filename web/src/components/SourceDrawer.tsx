import type { Owner, Preference, Source, SourceRef } from '../../../shared/types';
import { describePref } from '../../../shared/prefs';
import { Badge } from './ui';

const KIND_LABEL: Record<Source['kind'], string> = {
  note: 'Σημείωση',
  past_decision: 'Παλιά απόφαση με αιτιολόγηση',
  chat: 'Μήνυμα σε chat',
  owner_input: 'Κείμενο που πρόσθεσε ο κάτοχος',
  owner_correction: 'Διόρθωση κατόχου',
  trip_request: 'Αίτημα παρέας',
};

function highlight(text: string, quote: string) {
  const i = text.indexOf(quote);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + quote.length)}</mark>
      {text.slice(i + quote.length)}
    </>
  );
}

export function SourceDrawer({
  target,
  sources,
  owners,
  preferences,
  onClose,
}: {
  target: SourceRef | null;
  sources: Source[];
  owners: Owner[];
  preferences: Preference[];
  onClose: () => void;
}) {
  if (!target) return null;
  const src = sources.find((s) => s.id === target.sourceId);
  const owner = owners.find((o) => o.id === src?.ownerId);
  const citing = preferences.filter((p) => p.sourceRefs.some((r) => r.sourceId === target.sourceId) && p.status !== 'rejected');
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Πηγή" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose} aria-label="Κλείσιμο">
          ×
        </button>
        {!src ? (
          <p>Η πηγή {target.sourceId} δεν βρέθηκε.</p>
        ) : (
          <>
            <p className="eyebrow">
              {src.id} · {KIND_LABEL[src.kind]}
            </p>
            <h3>{src.title}</h3>
            <p className="muted small">
              {owner ? owner.name : 'Παρέα'} · {new Date(src.date).toLocaleDateString('el-GR', { day: 'numeric', month: 'long', year: 'numeric' })}{' '}
              {src.synthetic && <Badge tone="info">Συνθετικά δεδομένα</Badge>}
            </p>
            <blockquote className="source-text">{highlight(src.text, target.quote)}</blockquote>
            <h4>Στοιχεία προφίλ που στηρίζονται εδώ</h4>
            <ul className="plain">
              {citing.map((p) => (
                <li key={p.id} className="memory-row">
                  <strong>{describePref(p)}</strong>{' '}
                  <Badge tone={p.status === 'confirmed' ? 'good' : p.status === 'candidate' ? 'warn' : 'neutral'}>
                    {p.status === 'confirmed' ? 'επιβεβαιωμένο' : p.status === 'candidate' ? 'προς επιβεβαίωση' : 'αντικαταστάθηκε'}
                  </Badge>
                  {p.memory && (
                    <div className="mono small muted">
                      OpenSelf memory · trust: {p.memory.sourceTrust} · scope: {p.memory.scope} · hash {p.memory.contentHash.slice(0, 12)}…
                    </div>
                  )}
                </li>
              ))}
              {!citing.length && <li className="muted">Κανένα.</li>}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}
