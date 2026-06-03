/** Cola de verificaciones con tabs por estado (pendientes/aprobados/rechazados); abre el detalle. */
import { useEffect, useState } from 'react';
import { adminApi, type Verification } from '../api';
import { VerificationDetail } from './VerificationDetail';

const TABS = [
  { value: 'pending_review', label: 'Pendientes' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'rejected', label: 'Rechazados' },
] as const;

export function VerificationsPage() {
  const [status, setStatus] = useState<string>('pending_review');
  const [items, setItems] = useState<Verification[]>([]);
  const [selected, setSelected] = useState<Verification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (st: string = status) => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listVerifications(st);
      setItems(res.verifications || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando la lista');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const onReviewed = () => {
    setSelected(null);
    void load(status);
  };

  if (selected) {
    return (
      <VerificationDetail
        verification={selected}
        onBack={() => setSelected(null)}
        onReviewed={onReviewed}
      />
    );
  }

  return (
    <div className="queue">
      <header>
        <h2>Verificaciones ({items.length})</h2>
        <button onClick={() => void load(status)}>Actualizar</button>
      </header>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.value}
            className={`tab ${status === t.value ? 'active' : ''}`}
            onClick={() => setStatus(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p>Cargando…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && items.length === 0 && <p>No hay verificaciones en esta categoría.</p>}

      <ul className="list">
        {items.map((v) => (
          <li key={v.uid} onClick={() => setSelected(v)}>
            <span className={`badge ${v.accountType}`}>{v.accountType}</span>
            <strong>{v.fullName || v.uid}</strong>
            <span className="doc">{v.documentNumber}</span>
            {v.flags && v.flags.length > 0 && <span className="flag">⚠ {v.flags.length}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
