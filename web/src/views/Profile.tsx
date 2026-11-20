import { Check, FilePlus2, Grid3x3, Inbox, Lock, MessageCircle, PenLine, RefreshCw, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Domain, MemoryItem } from '../../../shared/types';
import { describeDeadline } from '../../../shared/time';
import { api, type AnalyzeResult, type AppState } from '../api';
import { go } from '../components/Shell';
import { UploadModal } from '../components/UploadModal';
import { Avatar, Badge, Cite, DOMAIN, Empty, Spinner, dom, kindLabel, srcKind, timeAgo, type OpenSource } from '../components/ui';

type Tab = 'memory' | 'sources' | 'review' | 'style';

/** Asks for confirmation, then deletes the twin and everything that belongs to it. */
export async function deleteTwin(state: AppState, id: string, onState: (s: AppState) => void) {
  const p = state.personas.find((x) => x.id === id);
  if (!p) return;
  const sources = state.sources.filter((s) => s.personaId === id).length;
  const memories = state.memory.filter((m) => m.personaId === id && m.scope === 'profile').length;
  const requests = state.requests.filter((r) => r.participants.includes(id)).length;
  const ok = window.confirm(
    `Οριστική διαγραφή του Twin «${p.name}» (@${p.handle});\n\n` +
      `Θα σβηστούν: ${sources} πηγές, ${memories} αναμνήσεις, το ύφος, οι αποφάσεις-τεστ` +
      (requests ? ` και ${requests} αιτήματα της παρέας στα οποία συμμετείχε.` : '.') +
      `\n\nΔεν αναιρείται (το «Reset demo» επαναφέρει μόνο τα αρχικά συνθετικά Twins).`,
  );
  if (!ok) return;
  try {
    const r = await api.deletePersona(id);
    onState(r.state);
    go('/');
  } catch (e) {
    window.alert(`Η διαγραφή απέτυχε: ${(e as Error).message}`);
  }
}

function MemoryCard({ m, onOpen, onState, review }: { m: MemoryItem; onOpen: OpenSource; onState: (s: AppState) => void; review?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.statement);
  const run = async (p: Parameters<typeof api.updateMemory>[1]) => onState(await api.updateMemory(m.id, p));
  return (
    <div className="mem-card" style={{ ['--dom' as string]: dom(m.domain).color }}>
      <div className="mem-top">
        <span className="mem-dom">
          {dom(m.domain).emoji} {dom(m.domain).label}
        </span>
        <span className="mem-kind">{kindLabel(m.kind)}</span>
      </div>
      {editing ? (
        <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="mem-statement">
          {m.polarity === 'avoids' && '🚫 '}
          {m.statement}
        </p>
      )}
      <div className="mem-tags">
        {m.hard && <Badge tone="bad">Υποχρεωτικό</Badge>}
        {m.rule && <Badge tone="info">{m.rule.metric === 'avoid_place' ? `όχι ξανά: ${m.rule.value.split('|').join(', ')}` : m.rule.metric === 'max_cost' ? `${m.hard ? '≤' : '~'} ${m.rule.value}€` : `έως ${describeDeadline(m.rule.value)}`}</Badge>}
        {m.context && (m.context.where !== 'any' || m.context.days > 0) && (
          <Badge tone="neutral" title="Ισχύει μόνο σε αυτό το πλαίσιο· αλλού μόνο ως ένδειξη">
            {[{ local: '📍 πόλη', domestic: '🇬🇷 Ελλάδα', abroad: '✈️ εξωτερικό', any: '' }[m.context.where], m.context.days ? `${m.context.days} ${m.context.days === 1 ? 'μέρα' : 'μέρες'}` : ''].filter(Boolean).join(' · ')}
          </Badge>
        )}
        {!m.hard && (
          <span className="strength" title="Σημασία">
            {[0.3, 0.6, 0.9].map((t) => (
              <i key={t} className={m.strength >= t - 0.05 ? 'on' : ''} />
            ))}
          </span>
        )}
        {m.origin === 'ai' && <Badge tone="ai">AI</Badge>}
        {m.origin === 'rules' && <Badge tone="neutral">κανόνες</Badge>}
        {m.origin === 'owner' && <Badge tone="brand">κάτοχος</Badge>}
      </div>
      <div className="mem-foot">
        <Cite refs={m.refs ?? []} onOpen={onOpen} />
        <span className="mem-actions">
          {editing ? (
            <>
              <button className="icon-btn sm" title="Αποθήκευση" onClick={() => run({ statement: text, status: 'confirmed' }).then(() => setEditing(false))}>
                <Check size={16} />
              </button>
              <button className="icon-btn sm" title="Ακύρωση" onClick={() => setEditing(false)}>
                <X size={16} />
              </button>
            </>
          ) : (
            <>
              {review && (
                <button className="btn btn-sm btn-brand" onClick={() => run({ status: 'confirmed' })}>
                  <Check size={14} /> Σωστό
                </button>
              )}
              <button className="icon-btn sm" title="Διόρθωση" onClick={() => setEditing(true)}>
                <PenLine size={15} />
              </button>
              <button className="icon-btn sm" title="Απόρριψη" onClick={() => run({ status: 'rejected' })}>
                <Trash2 size={15} />
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function Profile({ id, state, onState, onOpen }: { id: string; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const persona = state.personas.find((p) => p.id === id);
  const [tab, setTab] = useState<Tab>('memory');
  const [domain, setDomain] = useState<Domain | null>(null);
  const [upload, setUpload] = useState(false);
  const [lastRun, setLastRun] = useState<AnalyzeResult[] | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mem = useMemo(() => state.memory.filter((m) => m.personaId === id && m.scope === 'profile'), [state.memory, id]);
  const confirmed = mem.filter((m) => m.status === 'confirmed' && m.kind !== 'style');
  const candidates = mem.filter((m) => m.status === 'candidate');
  const sources = state.sources.filter((s) => s.personaId === id).reverse();
  const decisions = state.requests.filter((r) => r.participants.includes(id)).length;
  if (!persona) return <Empty emoji="🔎" title="Το Twin δεν βρέθηκε" />;

  const domains = (Object.keys(DOMAIN) as Domain[]).map((d) => ({ d, n: confirmed.filter((m) => m.domain === d).length })).filter((x) => x.n > 0);
  const shown = confirmed.filter((m) => !domain || m.domain === domain).sort((a, b) => Number(b.hard) - Number(a.hard) || b.strength - a.strength);

  const refreshStyle = async () => {
    setStyleBusy(true);
    setErr(null);
    try {
      onState((await api.refreshStyle(id)).state);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStyleBusy(false);
    }
  };

  return (
    <div className="profile">
      <header className="profile-head">
        <Avatar persona={persona} size={132} ring />
        <div className="profile-info">
          <div className="profile-title">
            <h1>{persona.handle}</h1>
            <button className="btn btn-brand" onClick={() => setUpload(true)}>
              <FilePlus2 size={16} /> Πρόσθεσε πηγές
            </button>
            <button className="btn" onClick={() => go('/new')}>
              Νέο αίτημα
            </button>
            <button className="btn" onClick={() => go(`/chat/${persona.id}`)} title="Ιδιωτική συζήτηση με αυτό το Twin">
              <MessageCircle size={16} /> Chat
            </button>
            {persona.locked ? (
              <span className="badge badge-ai" title="Μέλος της ομάδας — έρχεται με την εφαρμογή και δεν διαγράφεται">
                <Lock size={12} /> Μέλος ομάδας
              </span>
            ) : (
              <button className="btn btn-danger" onClick={() => deleteTwin(state, persona.id, onState)} title="Οριστική διαγραφή του Twin">
                <Trash2 size={16} /> Διαγραφή Twin
              </button>
            )}
          </div>
          <ul className="stats">
            <li>
              <b>{sources.length}</b> πηγές
            </li>
            <li>
              <b>{confirmed.length}</b> αναμνήσεις
            </li>
            <li>
              <b>{decisions}</b> αποφάσεις
            </li>
          </ul>
          <p className="profile-name">
            {persona.name} {persona.synthetic && <Badge tone="info">Συνθετικό προφίλ</Badge>}
          </p>
          <p className="profile-bio">{persona.bio}</p>
        </div>
      </header>

      {domains.length > 0 && (
        <div className="highlights">
          {domains.map(({ d, n }) => (
            <button key={d} className={`highlight ${domain === d ? 'on' : ''}`} onClick={() => (setDomain(domain === d ? null : d), setTab('memory'))}>
              <span className="hl-circle" style={{ borderColor: DOMAIN[d].color }}>
                {DOMAIN[d].emoji}
              </span>
              <span className="tiny">
                {DOMAIN[d].label} · {n}
              </span>
            </button>
          ))}
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>
          <Grid3x3 size={14} /> ΜΝΗΜΗ
        </button>
        <button className={tab === 'sources' ? 'on' : ''} onClick={() => setTab('sources')}>
          <FilePlus2 size={14} /> ΠΗΓΕΣ
        </button>
        <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>
          <Inbox size={14} /> ΠΡΟΣ ΕΛΕΓΧΟ {candidates.length > 0 && <span className="count">{candidates.length}</span>}
        </button>
        <button className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
          <PenLine size={14} /> ΥΦΟΣ
        </button>
      </nav>

      {lastRun && (
        <div className="notice">
          <b>Ανάλυση ολοκληρώθηκε:</b> {lastRun.reduce((a, r) => a + r.created.length, 0)} νέες αναμνήσεις από {lastRun.length} πηγές ({lastRun[0].mode === 'live' ? `AI · ${lastRun[0].model}` : 'κανόνες demo'}).
          {lastRun.some((r) => r.dropped) && ` ${lastRun.reduce((a, r) => a + r.dropped, 0)} απορρίφθηκαν γιατί το απόσπασμά τους δεν υπήρχε αυτούσιο στο κείμενο.`}
          {lastRun.map((r) => r.note).filter(Boolean).join(' ')}
          {candidates.length > 0 && (
            <button className="link-btn" onClick={() => setTab('review')}>
              Έλεγχος →
            </button>
          )}
        </div>
      )}

      {tab === 'memory' && (
        <div className="mem-grid">
          {shown.map((m) => (
            <MemoryCard key={m.id} m={m} onOpen={onOpen} onState={onState} />
          ))}
          {!shown.length && (
            <Empty emoji="🧠" title="Η μνήμη είναι άδεια">
              Προσθέστε πηγές — σημειώσεις, chats, emails, παλιές αποφάσεις. Χωρίς δεδομένα το Twin δηλώνει αβεβαιότητα αντί να μαντεύει.
            </Empty>
          )}
        </div>
      )}

      {tab === 'sources' && (
        <div className="src-grid">
          <button className="src-tile add" onClick={() => setUpload(true)}>
            <FilePlus2 size={30} />
            <span>Νέες πηγές</span>
          </button>
          {sources.map((s) => {
            const n = state.memory.filter((m) => (m.refs ?? []).some((r) => r.sourceId === s.id) && m.status !== 'rejected').length;
            return (
              <div key={s.id} className="src-tile" onClick={() => onOpen({ sourceId: s.id, quote: '' })} role="button" tabIndex={0}>
                <span className="src-kind">
                  {srcKind(s.kind).emoji} {srcKind(s.kind).label}
                </span>
                <b className="src-title">{s.title}</b>
                <p className="src-snippet">{s.text}</p>
                <span className="src-meta tiny">
                  {timeAgo(s.date)} · {n} αναμνήσεις
                  {!s.synthetic && (
                    <button
                      className="icon-btn sm"
                      title="Διαγραφή πηγής"
                      onClick={async (e) => {
                        e.stopPropagation();
                        onState(await api.deleteSource(s.id));
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'review' && (
        <div>
          {candidates.length > 0 && (
            <div className="review-bar">
              <span className="small muted">Το Twin πρότεινε {candidates.length} αναμνήσεις. Ελέγξτε τες με την πηγή τους πριν μπουν στο προφίλ.</span>
              <button className="btn btn-brand btn-sm" onClick={async () => onState(await api.confirmAll(id))}>
                <Check size={14} /> Επιβεβαίωση όλων
              </button>
            </div>
          )}
          <div className="mem-grid">
            {candidates.map((m) => (
              <MemoryCard key={m.id} m={m} onOpen={onOpen} onState={onState} review />
            ))}
            {!candidates.length && <Empty emoji="✅" title="Τίποτα προς έλεγχο" />}
          </div>
        </div>
      )}

      {tab === 'style' && (
        <div className="card style-card">
          {persona.style ? (
            <>
              <p className="style-summary">“{persona.style.summary}”</p>
              <div className="traits">
                {persona.style.traits.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
                <span className="chip">{persona.style.usesEmoji ? '😊 χρησιμοποιεί emoji' : 'χωρίς emoji'}</span>
              </div>
              {persona.style.phrases.length > 0 && (
                <>
                  <p className="eyebrow">Χαρακτηριστικές φράσεις</p>
                  <ul className="plain phrases">
                    {persona.style.phrases.map((p) => (
                      <li key={p.quote}>
                        «{p.quote}» <Cite refs={[p]} onOpen={onOpen} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <Empty emoji="✍️" title="Δεν έχει αναλυθεί ακόμα το ύφος" />
          )}
          <button className="btn" onClick={refreshStyle} disabled={styleBusy}>
            {styleBusy ? <Spinner label="Ανάλυση…" /> : <><RefreshCw size={14} /> Ανάλυση ύφους από τα κείμενα</>}
          </button>
          <p className="tiny muted">Το ύφος χρησιμοποιείται όταν το Twin γράφει μηνύματα στην παρέα.</p>
          {err && <p className="error">{err}</p>}
        </div>
      )}

      {upload && (
        <UploadModal
          persona={persona}
          live={state.status.aiMode === 'live'}
          onClose={() => setUpload(false)}
          onState={onState}
          onResult={(r) => {
            setLastRun(r);
            setTab(r.some((x) => x.created.length) ? 'review' : 'sources');
          }}
        />
      )}
    </div>
  );
}

export function TwinsList({ state, onState }: { state: AppState; onState: (s: AppState) => void }) {
  return (
    <div className="twins-list">
      <h2>Τα Twins της παρέας</h2>
      <div className="twin-cards">
        {state.personas.map((p) => {
          const n = state.memory.filter((m) => m.personaId === p.id && m.scope === 'profile' && m.status === 'confirmed').length;
          const s = state.sources.filter((x) => x.personaId === p.id).length;
          return (
            <div key={p.id} className="card twin-card" role="button" tabIndex={0} onClick={() => go(`/twin/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && go(`/twin/${p.id}`)}>
              {!p.locked && (
              <button
                className="icon-btn twin-del"
                title={`Διαγραφή του Twin «${p.name}»`}
                aria-label={`Διαγραφή του Twin ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTwin(state, p.id, onState);
                }}
              >
                <Trash2 size={16} />
              </button>
              )}
              <Avatar persona={p} size={72} ring />
              <b>{p.name}</b>
              <span className="tiny muted">@{p.handle}</span>
              <span className="small">{p.bio}</span>
              <span className="tiny muted">
                {s} πηγές · {n} αναμνήσεις
              </span>
            </div>
          );
        })}
        <div className="card twin-card twin-new" role="button" tabIndex={0} onClick={() => go('/onboard')} onKeyDown={(e) => e.key === 'Enter' && go('/onboard')}>
          <span className="story-add big">+</span>
          <b>Νέο Twin</b>
          <span className="small muted">Σύντομη συνέντευξη μέσα στην εφαρμογή</span>
        </div>
      </div>
    </div>
  );
}
