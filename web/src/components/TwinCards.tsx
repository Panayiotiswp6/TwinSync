import type { Owner, Preference } from '../../../shared/types';
import { PREF_META, describePref, importanceLabel } from '../../../shared/prefs';
import { Avatar, Badge, Cite, type OpenSource } from './ui';

export function PrefChip({ p, onOpen }: { p: Preference; onOpen: OpenSource }) {
  const meta = PREF_META[p.key];
  return (
    <li className={`pref pref-${meta.kind}`}>
      <div className="pref-main">
        <span className="pref-kind">{meta.kind === 'constraint' ? 'Περιορισμός' : 'Προτίμηση'}</span>
        <span className="pref-label">{describePref(p)}</span>
        {meta.kind === 'preference' && <span className="muted small">σημασία {importanceLabel(p.weight)}</span>}
        {p.scope === 'trip' && <Badge tone="warn">μόνο αυτό το ΣΚ</Badge>}
        {p.origin === 'owner' && <Badge tone="info">διόρθωση κατόχου</Badge>}
        {p.origin === 'ai' && <Badge tone="ai">AI → επιβεβαιώθηκε</Badge>}
        {p.origin === 'rules' && p.scope === 'profile' && <Badge tone="neutral">κανόνες → επιβεβαιώθηκε</Badge>}
      </div>
      <Cite refs={p.sourceRefs} onOpen={onOpen} />
    </li>
  );
}

export function TwinCards({
  owners,
  preferences,
  onOpen,
  onBuild,
}: {
  owners: Owner[];
  preferences: Preference[];
  onOpen: OpenSource;
  onBuild: (ownerId: string) => void;
}) {
  return (
    <div className="twin-grid">
      {owners.map((o) => {
        const prefs = preferences.filter((p) => p.ownerId === o.id && p.status === 'confirmed' && p.scope === 'profile');
        const pending = preferences.filter((p) => p.ownerId === o.id && p.status === 'candidate').length;
        const constraints = prefs.filter((p) => PREF_META[p.key].kind === 'constraint');
        const soft = prefs.filter((p) => PREF_META[p.key].kind === 'preference');
        return (
          <article className="card twin-card" key={o.id}>
            <header className="twin-head">
              <Avatar owner={o} size={44} />
              <div>
                <p className="eyebrow">Twin</p>
                <h3>{o.name}</h3>
                <p className="muted small">{o.tagline}</p>
              </div>
              <Badge tone="info">Συνθετικό προφίλ</Badge>
            </header>
            <ul className="plain prefs">
              {[...constraints, ...soft].map((p) => (
                <PrefChip key={p.id} p={p} onOpen={onOpen} />
              ))}
            </ul>
            <footer className="twin-foot">
              <button className="btn btn-ghost" onClick={() => onBuild(o.id)}>
                + Μάθε από νέο κείμενο
              </button>
              {pending > 0 && <Badge tone="warn">{pending} προς επιβεβαίωση</Badge>}
            </footer>
          </article>
        );
      })}
    </div>
  );
}
