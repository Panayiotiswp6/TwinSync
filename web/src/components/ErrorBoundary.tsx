import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Shows what went wrong instead of a blank page when a view fails to render,
 * so the user can go back and report the exact error. Data is never touched.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TwinSync] view crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card crash">
        <div className="empty-emoji">🛠️</div>
        <h3>Κάτι πήγε στραβά σε αυτή την οθόνη</h3>
        <p className="muted small">Τα δεδομένα σας είναι ασφαλή — δεν χάθηκε τίποτα. Στείλτε στην ομάδα ένα screenshot αυτού του μηνύματος.</p>
        <pre className="crash-msg">{`${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}`}</pre>
        <div className="btn-row">
          <button className="btn btn-brand" onClick={() => this.setState({ error: null })}>
            Δοκιμή ξανά
          </button>
          <button
            className="btn"
            onClick={() => {
              window.location.hash = '/';
              this.setState({ error: null });
            }}
          >
            Επιστροφή στην αρχική
          </button>
        </div>
      </div>
    );
  }
}
