/** Directorio de usuarios: TODOS los registrados, con búsqueda, filtro por estado y
 *  columnas de rol/fechas. A esta escala el filtrado es en el cliente. */
import { useEffect, useMemo, useState } from 'react';
import { adminApi, type PanelUser } from '../api';

const STATE_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'pending_review', label: 'En revisión' },
  { value: 'pending_verification', label: 'Sin verificar' },
  { value: 'rejected', label: 'Rechazados' },
] as const;

const STATE_LABELS: Record<string, { label: string; cls: string }> = {
  approved: { label: 'Aprobado', cls: 'ok' },
  pending_review: { label: 'En revisión', cls: 'warn' },
  pending_verification: { label: 'Sin verificar', cls: 'off' },
  rejected: { label: 'Rechazado', cls: 'bad' },
  suspended: { label: 'Suspendido', cls: 'bad' },
};

const stateBadge = (state: string | null) =>
  STATE_LABELS[state || ''] || { label: 'Sin verificar', cls: 'off' };

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
};

export function UsersPage() {
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listUsers();
      setUsers(res.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando usuarios');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (state !== 'all') {
        const s = u.state || 'pending_verification';
        if (s !== state) return false;
      }
      if (!q) return true;
      return `${u.name || ''} ${u.email || ''}`.toLowerCase().includes(q);
    });
  }, [users, query, state]);

  const countFor = (value: string) =>
    value === 'all'
      ? users.length
      : users.filter((u) => (u.state || 'pending_verification') === value).length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Usuarios</h2>
          <p className="page-sub">Todas las cuentas registradas, con su estado y su rol.</p>
        </div>
        <button onClick={() => void load()} aria-label="Actualizar la lista">
          Actualizar
        </button>
      </header>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Buscar por nombre o email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar usuarios"
        />
        <div className="chips" role="tablist">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              aria-selected={state === f.value}
              className={`chip ${state === f.value ? 'active' : ''}`}
              onClick={() => setState(f.value)}
            >
              {f.label} <span className="chip-count">{countFor(f.value)}</span>
            </button>
          ))}
        </div>
      </div>

      {loading && <p>Cargando…</p>}
      {error && (
        <p className="error">
          {error}{' '}
          <button onClick={() => void load()} aria-label="Reintentar la carga">
            Reintentar
          </button>
        </p>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="empty">No hay usuarios que coincidan con la búsqueda.</div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Estado</th>
                <th>Rol</th>
                <th>Registro</th>
                <th>Último ingreso</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const b = stateBadge(u.state);
                return (
                  <tr key={u.uid}>
                    <td>
                      <div className="cell-user">
                        <strong>{u.name || '(sin nombre)'}</strong>
                        <span className="cell-sub">{u.email || u.uid}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${b.cls}`}>{b.label}</span>
                    </td>
                    <td>
                      {u.role ? (
                        <span className={`pill ${u.role === 'superadmin' ? 'warn' : 'off'}`}>{u.role}</span>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                    <td className="cell-sub">{fmtDate(u.createdAt)}</td>
                    <td className="cell-sub">{fmtDate(u.lastLoginAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
