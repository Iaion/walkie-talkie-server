/** Actividad: el registro de auditoría legible — quién hizo qué y cuándo, lo más nuevo
 *  primero. Solo superadmins (el backend además lo exige). */
import { useEffect, useState } from 'react';
import { adminsApi, type AuditEntry } from '../api';

/** Traducción de cada acción auditada a una frase humana. */
const ACTION_LABELS: Record<string, { label: string; icon: string }> = {
  emergency_alert: { label: 'disparó una alerta de emergencia', icon: '🚨' },
  help_confirm: { label: 'confirmó que va a ayudar a', icon: '🤝' },
  help_reject: { label: 'rechazó ayudar a', icon: '🙅' },
  emergency_resolve: { label: 'cerró su emergencia', icon: '✅' },
  verification_submitted: { label: 'envió su verificación de identidad', icon: '🪪' },
  verification_photo_uploaded: { label: 'subió una foto de verificación', icon: '📷' },
  approve_verification: { label: 'aprobó la verificación de', icon: '✔️' },
  reject_verification: { label: 'rechazó la verificación de', icon: '✖️' },
  vehicle_created: { label: 'agregó un vehículo', icon: '🛵' },
  vehicle_updated: { label: 'editó un vehículo', icon: '🛠' },
  vehicle_deleted: { label: 'eliminó un vehículo', icon: '🗑' },
  vehicle_photo_uploaded: { label: 'subió la foto de su vehículo', icon: '📸' },
  profile_updated: { label: 'actualizó su perfil', icon: '👤' },
  avatar_uploaded: { label: 'cambió su foto de perfil', icon: '🖼' },
  grant_admin: { label: 'dio rol de admin a', icon: '🛡' },
  revoke_admin: { label: 'quitó el rol de admin a', icon: '🚫' },
  grandfather_users: { label: 'aplicó el alta masiva de usuarios previos', icon: '👴' },
};

const describe = (a: AuditEntry) => ACTION_LABELS[a.action] || { label: a.action, icon: '·' };

const fmtWhen = (ts: number | null) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-AR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};

export function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminsApi.audit(150);
      setEntries(res.entries || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando la actividad');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Actividad</h2>
          <p className="page-sub">
            Todo lo que pasa en el sistema queda registrado acá: emergencias, verificaciones,
            vehículos y acciones de administración.
          </p>
        </div>
        <button onClick={() => void load()} aria-label="Actualizar la actividad">
          Actualizar
        </button>
      </header>

      {loading && <p>Cargando…</p>}
      {error && (
        <p className="error">
          {error}{' '}
          <button onClick={() => void load()} aria-label="Reintentar la carga">
            Reintentar
          </button>
        </p>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className="empty">Todavía no hay actividad registrada.</div>
      )}

      <ul className="feed">
        {entries.map((e) => {
          const d = describe(e);
          return (
            <li key={e.id}>
              <span className="feed-icon" aria-hidden>
                {d.icon}
              </span>
              <span className="feed-text">
                <strong>{e.actor || '¿?'}</strong> {d.label}
                {e.target && <strong> {e.target}</strong>}
              </span>
              <span className="feed-when">{fmtWhen(e.timestamp)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
