import { BarChart3, Home, PlusSquare, RotateCcw, Sparkles, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppState } from '../api';
import { Avatar } from './ui';

export type Route = { name: 'home' } | { name: 'new' } | { name: 'twin'; id: string } | { name: 'request'; id: string } | { name: 'eval' } | { name: 'twins' };

export function parseRoute(hash: string): Route {
  let h = hash.replace(/^#/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    /* keep raw */
  }
  const [, a, b] = h.split('/');
  if (a === 'new') return { name: 'new' };
  if (a === 'twin' && b) return { name: 'twin', id: b };
  if (a === 'twins') return { name: 'twins' };
  if (a === 'req' && b) return { name: 'request', id: b };
  if (a === 'eval') return { name: 'eval' };
  return { name: 'home' };
}
export const go = (path: string) => {
  window.location.hash = path;
  window.scrollTo({ top: 0 });
};

export function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark" aria-hidden>
        <span />
        <span />
      </span>
      <span className="logo-word">TwinSync</span>
    </span>
  );
}

export function AiPill({ state }: { state: AppState }) {
  const s = state.status;
  return s.aiMode === 'live' ? (
    <span className="ai-pill live" title={`${s.provider} · ${s.model}${s.embeddings ? ' · embeddings' : ''}`}>
      <Sparkles size={14} /> Live AI · {s.model}
    </span>
  ) : (
    <span className="ai-pill demo" title="Χωρίς κλειδί AI: κανόνες, κατάλογος, πρότυπα">
      Demo mode
    </span>
  );
}

export function Shell({ route, state, children, onReset }: { route: Route; state: AppState; children: ReactNode; onReset: () => void }) {
  const nav = [
    { key: 'home', path: '/', label: 'Αρχική', icon: <Home size={22} /> },
    { key: 'new', path: '/new', label: 'Νέο αίτημα', icon: <PlusSquare size={22} /> },
    { key: 'twins', path: '/twins', label: 'Twins', icon: <Users size={22} /> },
    { key: 'eval', path: '/eval', label: 'Αξιολόγηση', icon: <BarChart3 size={22} /> },
  ];
  const active = route.name === 'twin' ? 'twins' : route.name === 'request' ? 'home' : route.name;
  const u = state.status.usage;
  return (
    <div className="shell">
      <aside className="sidebar">
        <button className="logo-btn" onClick={() => go('/')}>
          <Logo />
        </button>
        <nav>
          {nav.map((n) => (
            <a key={n.key} href={`#${n.path}`} className={active === n.key ? 'active' : ''}>
              {n.icon}
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="side-twins">
          <p className="eyebrow">Η παρέα</p>
          {state.personas.map((p) => (
            <a key={p.id} href={`#/twin/${p.id}`} className={route.name === 'twin' && route.id === p.id ? 'active' : ''}>
              <Avatar persona={p} size={28} />
              <span>{p.name}</span>
            </a>
          ))}
        </div>
        <div className="side-foot">
          <AiPill state={state} />
          {state.status.aiMode === 'live' && (
            <p className="tiny muted">
              {u.calls} κλήσεις · {Math.round((u.inputTokens + u.outputTokens) / 1000)}k tokens
            </p>
          )}
          <p className="tiny muted">Όλα τα δεδομένα είναι συνθετικά.</p>
          <button className="link-btn tiny" onClick={onReset}>
            <RotateCcw size={12} /> Reset demo
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button className="logo-btn" onClick={() => go('/')}>
          <Logo />
        </button>
        <AiPill state={state} />
      </header>

      <main className="main">{children}</main>

      <nav className="bottom-nav">
        {nav.map((n) => (
          <a key={n.key} href={`#${n.path}`} className={active === n.key ? 'active' : ''} aria-label={n.label}>
            {n.icon}
          </a>
        ))}
      </nav>
    </div>
  );
}
