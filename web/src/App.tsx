import { useCallback, useEffect, useState } from 'react';
import type { SourceRef } from '../../shared/types';
import { api, type AppState } from './api';
import { Composer } from './components/Composer';
import { Shell, parseRoute, type Route } from './components/Shell';
import { SourceDrawer } from './components/SourceDrawer';
import { Eval } from './views/Eval';
import { Home } from './views/Home';
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

  const reset = async () => {
    if (!window.confirm('Επαναφορά όλων των δεδομένων στο αρχικό συνθετικό demo; Οι πηγές και οι αποφάσεις που προσθέσατε θα χαθούν.')) return;
    setState(await api.reset());
    window.location.hash = '/';
  };

  return (
    <Shell route={route} state={state} onReset={reset}>
      {route.name === 'home' && <Home state={state} onState={setState} />}
      {route.name === 'new' && (
        <div className="narrow">
          <h2>Νέο αίτημα για την παρέα</h2>
          <Composer state={state} onState={setState} />
        </div>
      )}
      {route.name === 'twins' && <TwinsList state={state} />}
      {route.name === 'twin' && <Profile key={route.id} id={route.id} state={state} onState={setState} onOpen={setSource} />}
      {route.name === 'request' && <Thread key={route.id} id={route.id} state={state} onState={setState} onOpen={setSource} />}
      {route.name === 'eval' && <Eval state={state} onState={refresh} />}
      <SourceDrawer target={source} sources={state.sources} personas={state.personas} memory={state.memory} onClose={() => setSource(null)} />
    </Shell>
  );
}
