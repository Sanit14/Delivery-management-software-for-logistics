import { Component, type ReactNode, type ErrorInfo } from 'react';

/**
 * ErrorBoundary — catches any rendering crash anywhere in the app and shows a
 * friendly, recoverable screen instead of a blank white page.
 * Designed for non-technical operators: clear message + a reload button.
 */

interface Props { children: ReactNode; }
interface State { hasError: boolean; message: string; }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Unknown error' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log for debugging; in production this stays in the console / devtools.
    console.error('[ErrorBoundary] caught:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, message: '' });
    window.location.reload();
  };

  handleHome = () => {
    this.setState({ hasError: false, message: '' });
    window.location.hash = '#/';
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg, #f0f8f7)', padding: 24 }}>
        <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 8px 30px rgba(20,77,82,0.15)', padding: '36px 32px', maxWidth: 460, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#144D52', marginBottom: 8, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 14, color: '#4a5f5b', lineHeight: 1.6, marginBottom: 6 }}>
            An error occurred in the app. Your data is safe. Press the button below to restart the app.
          </div>
          <div style={{ fontSize: 12, color: '#9aabA7', marginBottom: 22, wordBreak: 'break-word' }}>
            ({this.state.message})
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              onClick={this.handleReload}
              style={{ background: '#E66C32', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
            >
              Restart App
            </button>
            <button
              onClick={this.handleHome}
              style={{ background: 'transparent', color: '#144D52', border: '1.5px solid #144D52', borderRadius: 8, padding: '11px 22px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              Go to Home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
