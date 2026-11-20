import { useCallback, useEffect, useState } from 'react';
import type { SourceRef } from '../../shared/types';
import { api, type AppState, type StartGroup } from './api';
import { Composer } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Shell, parseRoute, type Route } from './components/Shell';
import { SourceDrawer } from './components/SourceDrawer';
import { Eval } from './views/Eval';
import { Home } from './views/Home';
import { Onboard } from './views/Onboard';
import { Profile, TwinsList } from './views/Profile';
import { Thread } from './views/Thread';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [route, setRoute] = useState<Route>(parseRoute(window.location.hash));
  const [source, setSource] = useState<SourceRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.state().then(setState).catch((e) => setError(e.message));
  }, []);
  // A file dropped outside a drop zone must never make the browser open/download it and leave the app.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refresh]);

  if (!state) return <div className="boot">{error ? `Σφάλμα: ${error}` : <span className="spinner" />}</div>;

  const reset = async (kind: StartGroup) => {
    const msg =
      kind === 'empty'
        ? 'Διαγραφή ΟΛΩΝ των Twins, πηγών, αναμνήσεων και αποφάσεων; Η εφαρμογή θα ξεκινήσει άδεια για να φτιάξετε τα δικά σας Twins. Δεν αναιρείται.'
        : kind === 'team'
          ? 'Επαναφορά στην παρέα της ομάδας (όπως είναι στην εφαρμογή); Τα Twins και τα αιτήματα που προσθέσατε εδώ θα χαθούν — η ομάδα μένει.'
          : 'Αντικατάσταση όλων των δεδομένων με τη συνθετική demo παρέα; Ό,τι προσθέσατε θα χαθεί.';
    if (!window.confirm(msg)) return;
    setState(await api.reset(kind));
    window.location.hash = '/';
  };

  return (
    <Shell route={route} state={state} onReset={reset}>
      <ErrorBoundary resetKey={JSON.stringify(route)}>
      {route.name === 'home' && <Home state={state} onState={setState} />}
      {route.name === 'new' && (
        <div className="narrow">
          <h2>Νέο αίτημα για την παρέα</h2>
          <Composer state={state} onState={setState} />
        </div>
      )}
      {route.name === 'onboard' && <Onboard state={state} onState={setState} />}
      {route.name === 'twins' && <TwinsList state={state} onState={setState} />}
      {route.name === 'twin' && <Profile key={route.id} id={route.id} state={state} onState={setState} onOpen={setSource} />}
      {route.name === 'request' && <Thread key={route.id} id={route.id} state={state} onState={setState} onOpen={setSource} />}
      {route.name === 'eval' && <Eval state={state} onState={refresh} />}
      </ErrorBoundary>
      <ErrorBoundary resetKey={source?.sourceId ?? ''}>
        <SourceDrawer target={source} sources={state.sources} personas={state.personas} memory={state.memory} onClose={() => setSource(null)} />
      </ErrorBoundary>
    </Shell>
  );
}
