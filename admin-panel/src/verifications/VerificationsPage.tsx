/** Cola de verificaciones con tabs por estado (pendientes/aprobados/rechazados); abre el detalle.
 *  Paginada (G2): trae de a PAGE_SIZE con "Cargar más" — no se descarga la cola entera. */
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
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Verification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (st: string = status) => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listVerifications(st, 0);
      setItems(res.verifications || []);
      setHasMore(!!res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando la lista');
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listVerifications(status, items.length);
      setItems((prev) => [...prev, ...(res.verifications || [])]);
      setHasMore(!!res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando más resultados');
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
        <h2>
          Verificaciones ({items.length}
          {hasMore ? '+' : ''})
        </h2>
        <button onClick={() => void load(status)} aria-label="Actualizar la lista">
          Actualizar
        </button>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
            className={`tab ${status === t.value ? 'active' : ''}`}
            onClick={() => setStatus(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p>Cargando…</p>}
      {error && (
        <p className="error">
          {error}{' '}
          <button onClick={() => void load(status)} aria-label="Reintentar la carga">
            Reintentar
          </button>
        </p>
      )}
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

      {hasMore && !loading && (
        <button className="load-more" onClick={() => void loadMore()}>
          Cargar más
        </button>
      )}
    </div>
  );
}
