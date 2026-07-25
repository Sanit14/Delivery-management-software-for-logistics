import React from 'react';
import { X } from 'lucide-react';

interface ViewAllModalProps {
  title: string;
  search: { value: string; onChange: (v: string) => void; placeholder?: string };
  filter?: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] };
  onClose: () => void;
  children: React.ReactNode; // the caller renders the (filtered) rows/table
}

/**
 * Generic full-list overlay — reuses .modal-overlay from index.css for the
 * backdrop, matching ConfirmModal's pattern. The caller owns filtering and row
 * shape; this modal only owns the chrome (backdrop, header, controls, scroll).
 */
export default function ViewAllModal({
  title,
  search,
  filter,
  onClose,
  children,
}: ViewAllModalProps) {
  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-xl)',
          maxWidth: 640,
          width: '96vw',
          maxHeight: '78vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeIn 0.2s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            background: '#0F6E56',
            color: '#fff',
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
          <button
            className="btn-icon"
            onClick={onClose}
            aria-label="Close"
            style={{ color: '#fff', opacity: 0.85 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Controls row */}
        <div
          style={{
            padding: '10px 14px',
            display: 'flex',
            gap: 8,
            borderBottom: '0.5px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <input
            className="form-input"
            style={{ flex: 1 }}
            placeholder={search.placeholder ?? 'Search…'}
            value={search.value}
            onChange={e => search.onChange(e.target.value)}
            autoFocus
          />
          {filter && (
            <select
              className="form-select"
              style={{ width: 140 }}
              value={filter.value}
              onChange={e => filter.onChange(e.target.value)}
              aria-label="Filter"
            >
              {filter.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Scrollable body — caller renders the already-filtered content */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
