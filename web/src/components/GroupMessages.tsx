import { useState } from 'react';
import type { Decision, Owner } from '../../../shared/types';
import { api, type AppState } from '../api';
import { Avatar, Badge, Details, Section, type OpenSource } from './ui';

export function GroupMessages({ decision, state, onState, onOpen }: { decision: Decision; state: AppState; onState: (s: AppState) => void; onOpen: OpenSource }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const owners = state.owners.filter((o) => decision.request.participants.includes(o.id));
  const owner = (id: string) => owners.find((o) => o.id === id) as Owner;
  const live = state.status.aiMode === 'live';

  const run = async (fn: () => Promise<AppState>) => {
    setBusy(true);
    setErr(null);
    try {
      onState(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      step={6}
      id="messages"
      title="Τα Twins γράφουν στο group"
      subtitle="Κάθε Twin γράφει ένα προσχέδιο μηνύματος με το ύφος του κατόχου του, μαθημένο από τα δικά του κείμενα. Γράφει μόνο ό,τι υπάρχει στην απόφαση και δεν στέλνει τίποτα χωρίς έγκριση."
    >
      <div className="card chat">
        {!decision.messages ? (
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.messages(decision.id))}>
              {busy ? (live ? 'Το AI γράφει…' : 'Γράφει…') : 'Γράψε τα μηνύματα των Twins'}
            </button>
            <Badge tone={live ? 'ai' : 'warn'}>{live ? `Live AI · ${state.status.model}` : 'Demo mode · πρότυπα, χωρίς μίμηση ύφους'}</Badge>
          </div>
        ) : (
          <>
            <div className="chat-head">
              <span className="small muted">Group «ΣΚ Νοεμβρίου» · προσχέδια για {decision.id}</span>
              <button className="btn btn-ghost btn-sm" disabled={busy || !live} onClick={() => run(() => api.messages(decision.id, true))} title={live ? 'Νέα προσχέδια (νέα κλήση AI)' : 'Διαθέσιμο με live AI'}>
                ↻ Ξαναγράψε
              </button>
            </div>
            {decision.messagesNote && <p className="warn-box small">{decision.messagesNote}</p>}
            <ul className="plain bubbles">
              {decision.messages.map((m) => {
                const o = owner(m.ownerId);
                const isEditing = editing[m.ownerId] !== undefined;
                return (
                  <li key={m.ownerId} className="bubble-row">
                    <Avatar owner={o} size={32} />
                    <div className="bubble-wrap">
                      <div className="bubble-meta">
                        <strong>{o.name}</strong>
                        <span className="muted small">· το Twin προτείνει</span>
                        {m.mode === 'live' ? <Badge tone="ai">AI · ύφος κατόχου</Badge> : <Badge tone="neutral">πρότυπο</Badge>}
                        {m.status === 'approved' ? <Badge tone="good">Εγκρίθηκε από τον {o.name}</Badge> : <Badge tone="warn">προσχέδιο</Badge>}
                      </div>
                      {isEditing ? (
                        <textarea rows={2} value={editing[m.ownerId]} onChange={(e) => setEditing({ ...editing, [m.ownerId]: e.target.value })} aria-label="Κείμενο μηνύματος" />
                      ) : (
                        <p className="bubble" style={{ borderColor: o.color }}>
                          {m.text}
                        </p>
                      )}
                      {m.guardNote && <p className="small warn-text">⚠ {m.guardNote}</p>}
                      <div className="bubble-actions">
                        {m.status !== 'approved' && (
                          <>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  const s = await api.approveMessage(decision.id, m.ownerId, editing[m.ownerId]);
                                  setEditing(({ [m.ownerId]: _, ...rest }) => rest);
                                  return s;
                                })
                              }
                            >
                              {isEditing ? 'Αποθήκευση & έγκριση' : 'Εγκρίνω αποστολή'}
                            </button>
                            {!isEditing && (
                              <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...editing, [m.ownerId]: m.text })}>
                                Αλλαγή κειμένου
                              </button>
                            )}
                          </>
                        )}
                        <Details summary="Πού βασίστηκε">
                          <p className="small">
                            <strong>Ύφος από:</strong>{' '}
                            {m.styleSourceIds.map((id) => (
                              <button key={id} type="button" className="cite" onClick={() => onOpen({ sourceId: id, quote: '' })}>
                                {id}
                              </button>
                            ))}
                          </p>
                          <p className="small">
                            <strong>Επιτρεπόμενα γεγονότα</strong> (το μήνυμα δεν μπορεί να γράψει τίποτα άλλο — αριθμός εκτός λίστας = απόρριψη):
                          </p>
                          <ul className="small muted">
                            {m.facts.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        </Details>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </Section>
  );
}
