/** Resumen: métricas rápidas del sistema (pendientes, aprobados, usuarios, admins) con
 *  acceso directo a lo que requiere acción. */
import { useEffect, useState } from 'react';
import { adminApi, type PanelUser } from '../api';

interface Props {
  onGoTo: (section: 'verifications' | 'users') => void;
}

export function DashboardPage({ onGoTo }: Props) {
  const [users, setUsers] = useState<PanelUser[] | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi
      .listUsers()
      .then((r) => setUsers(r.users || []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error cargando datos'));
    adminApi
      .listVerifications('pending_review', 0)
      .then((r) => setPending(r.total ?? r.verifications.length))
      .catch(() => setPending(null));
  }, []);

  const count = (fn: (u: PanelUser) => boolean) => (users ? users.filter(fn).length : '…');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Resumen</h2>
          <p className="page-sub">El estado del sistema de un vistazo.</p>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <button className={`stat ${typeof pending === 'number' && pending > 0 ? 'stat-attention' : ''}`} onClick={() => onGoTo('verifications')}>
          <span className="stat-n">{pending ?? '…'}</span>
          <span className="stat-l">Esperando revisión</span>
          {typeof pending === 'number' && pending > 0 && <span className="stat-hint">requiere acción →</span>}
        </button>
        <button className="stat" onClick={() => onGoTo('users')}>
          <span className="stat-n">{count((u) => u.state === 'approved')}</span>
          <span className="stat-l">Aprobados</span>
        </button>
        <button className="stat" onClick={() => onGoTo('users')}>
          <span className="stat-n">{users ? users.length : '…'}</span>
          <span className="stat-l">Usuarios totales</span>
        </button>
        <button className="stat" onClick={() => onGoTo('users')}>
          <span className="stat-n">{count((u) => !!u.role)}</span>
          <span className="stat-l">Administradores</span>
        </button>
      </div>

      <p className="muted-note">
        Las verificaciones pendientes son lo único que espera una decisión humana: cada persona
        aprobada puede pedir ayuda y salir a ayudar desde ese momento.
      </p>
    </div>
  );
}
