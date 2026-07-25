import React, { useState, useContext } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useBackNavigation } from '../hooks/useBackNavigation';
import { PageLockContext } from './PageGuard';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  showBack?: boolean;
  backBlocked?: boolean;
  backFallback?: string;
  /** If provided, a refresh button appears top-right that re-runs this page's
   *  data load. Should reload just this page's data (not the whole app). */
  onRefresh?: () => void | Promise<void>;
}

export default function PageHeader({ title, subtitle, right, showBack, backBlocked, backFallback, onRefresh }: PageHeaderProps) {
  const { goBack } = useBackNavigation({ blocked: backBlocked, fallback: backFallback });
  const [spinning, setSpinning] = useState(false);
  const { relock } = useContext(PageLockContext);

  const doRefresh = async () => {
    if (!onRefresh || spinning) return;
    setSpinning(true);
    try {
      await onRefresh();
      relock();
    } finally {
      // brief spin so the user sees it happened, even if the reload is instant
      setTimeout(() => setSpinning(false), 400);
    }
  };

  return (
    <div className="page-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {showBack && (
          <button
            type="button"
            className="btn-icon"
            aria-label="Back (Esc)"
            title="Back (Esc)"
            onClick={goBack}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="page-title">{title}</div>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {right}
        {onRefresh && (
          <button
            type="button"
            className="btn-icon"
            aria-label="Refresh this page"
            title="Refresh this page"
            onClick={doRefresh}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <RefreshCw size={17} style={{ transition: 'transform 0.4s', transform: spinning ? 'rotate(360deg)' : 'none' }} />
          </button>
        )}
      </div>
    </div>
  );
}
