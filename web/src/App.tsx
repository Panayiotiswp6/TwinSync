import { useCallback, useEffect, useState } from 'react';
import type { Decision, SourceRef } from '../../shared/types';
import { api, type AppState } from './api';
import { DecisionView, Positions } from './components/DecisionView';
import { EvalPanel } from './components/EvalPanel';
import { GroupMessages } from './components/GroupMessages';
import { SourceDrawer } from './components/SourceDrawer';
import { TwinBuilder } from './components/TwinBuilder';
import { TwinCards } from './components/TwinCards';
import { Avatar, Badge, Details, Section } from './components/ui';

const STEPS = [
  ['twins', 'Twins & πηγές'],
  ['request', 'Αίτημα'],
  ['positions', 'Θέσεις'],
  ['decision', 'Κοινή απόφαση'],
  ['correct', 'Διόρθωση & έγκριση'],
  ['messages', 'Μηνύματα στο group'],
] as const;

const PROVIDER_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic', demo: '' } as const;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [source, setSource] = useState<SourceRef | null>(null);
  const [builder, setBuilder] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((s: AppState) => {
    setState(s);
    const latest = s.decisions[s.decisions.length - 1] ?? null;
    setDecision(latest);
  }, []);

  useEffect(() => {
    api
      .state()
      .then((s) => {
        adopt(s);
        setText(s.request.text);
        setParticipants(s.request.participants);
      })
      .catch((e) => setError(e.message));
  }, [adopt]);

  const onDecision = (r: { decision: Decision; state: AppState }) => {
    adopt(r.state);
    setTimeout(() => document.getElementById('decision')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const plan = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.plan(text, participants);
      adopt(r.state);
      setTimeout(() => document.getElementById('positions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const s = await api.reset();
    adopt(s);
    setText(s.request.text);
    setParticipants(s.request.participants);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!state) {
    return <div className="loading">{error ? `Σφάλμα: ${error}` : 'Φόρτωση TwinSync…'}</div>;
  }

  const builderOwner = state.owners.find((o) => o.id === builder);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <span />
            <span />
          </span>
          <div>
            <strong>TwinSync</strong>
            <span className="muted small"> · τα Twins της παρέας συμφωνούν, εσείς εγκρίνετε</span>
          </div>
        </div>
        <div className="topbar-right">
          <Badge tone="info">Συνθετικά δεδομένα</Badge>
          {state.status.aiMode === 'live' ? (
            <Badge tone="ai">
              Live AI · {PROVIDER_LABEL[state.status.provider]} {state.status.model}
            </Badge>
          ) : (
            <Badge tone="warn">Demo mode · χωρίς κλειδί AI</Badge>
          )}
          <button className="btn btn-ghost btn-sm" onClick={reset}>
            Reset demo
          </button>
        </div>
      </header>

      <nav className="stepper" aria-label="Βήματα">
        {STEPS.map(([id, label], i) => (
          <a key={id} href={`#${id}`} className={(id === 'positions' || id === 'decision' || id === 'correct' || id === 'messages') && !decision ? 'disabled' : ''}>
            <span>{i + 1}</span>
            {label}
          </a>
        ))}
      </nav>

      <main>
        <section className="hero">
          <h1>Βρείτε διήμερο σε 60 δευτερόλεπτα — χωρίς 200 μηνύματα στο group.</h1>
          <p>
            Κάθε φίλος έχει ένα <strong>Twin</strong> που έμαθε από τις δικές του σημειώσεις, παλιές αποφάσεις και μηνύματα. Τα Twins ψηφίζουν, οι υποχρεωτικοί περιορισμοί
            ελέγχονται σε κώδικα, κάθε «γιατί» δείχνει την πηγή του, και η τελική πρόταση περνά από ανθρώπινη έγκριση.
          </p>
        </section>

        <Section
          step={1}
          id="twins"
          title="Τα Twins της παρέας"
          subtitle="Κάθε στοιχείο του προφίλ έχει πηγή — πατήστε src-… για να δείτε το απόσπασμα. Με «Μάθε από νέο κείμενο» φαίνεται πώς δημιουργείται ένα Twin."
        >
          <TwinCards owners={state.owners} preferences={state.preferences} onOpen={setSource} onBuild={setBuilder} />
        </Section>

        <Section step={2} id="request" title="Το αίτημα" subtitle="Επεξεργάσιμο. Ένα όριο μέσα στο αίτημα (π.χ. «μέχρι 100€») ισχύει μόνο για αυτό το διήμερο.">
          <div className="card request">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label="Αίτημα" />
            <div className="request-row">
              <div className="participants">
                {state.owners.map((o) => (
                  <label key={o.id} className="participant">
                    <input
                      type="checkbox"
                      checked={participants.includes(o.id)}
                      onChange={(e) => setParticipants((ps) => (e.target.checked ? [...ps, o.id] : ps.filter((x) => x !== o.id)))}
                    />
                    <Avatar owner={o} size={24} /> {o.name}
                  </label>
                ))}
              </div>
              <button className="btn btn-primary btn-lg" onClick={plan} disabled={busy || participants.length < 2}>
                {busy ? 'Τα Twins συζητούν…' : decision ? 'Ξανατρέξε τη ροή' : 'Βρες μας ένα διήμερο αυτό το ΣΚ'}
              </button>
            </div>
            {error && <p className="error">{error}</p>}
          </div>
        </Section>

        {decision && (
          <>
            <Section step={3} id="positions" title="Τι προτείνει κάθε Twin" subtitle="Κάθε Twin ψηφίζει μόνο με τα δεδομένα του κατόχου του και τους δικούς του περιορισμούς.">
              <Positions d={decision} owners={state.owners.filter((o) => decision.request.participants.includes(o.id))} trips={state.trips} onOpen={setSource} />
            </Section>
            <DecisionView decision={decision} state={state} onOpen={setSource} onDecision={onDecision} onState={adopt} />
            <GroupMessages key={decision.id} decision={decision} state={state} onState={adopt} onOpen={setSource} />
          </>
        )}

        <section className="section" id="eval">
          <Details summary={<strong>Αξιολόγηση: προβλέπει το Twin αποφάσεις που δεν έχει δει;</strong>}>
            <EvalPanel owners={state.owners} />
          </Details>
        </section>

        <footer className="footer muted small">
          TwinSync · Netcompany Hackathon Athens 2026 — Challenge 1: AI: Your digital self. Όλα τα πρόσωπα, οι πηγές και οι τιμές είναι συνθετικά. Χρησιμοποιεί το schema μνήμης του
          OpenSelf (MIT).
        </footer>
      </main>

      <SourceDrawer target={source} sources={state.sources} owners={state.owners} preferences={state.preferences} onClose={() => setSource(null)} />
      {builderOwner && <TwinBuilder owner={builderOwner} state={state} sample={state.samples[builderOwner.id] ?? ''} onState={adopt} onClose={() => setBuilder(null)} />}
    </div>
  );
}
