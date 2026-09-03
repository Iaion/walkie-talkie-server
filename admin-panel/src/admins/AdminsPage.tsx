/** Gestión de administradores — visible SOLO para superadmins (App la esconde y el backend
 *  la rechaza igual). Alta por email de cuentas existentes; los superadmins no se tocan. */
import { useEffect, useState } from 'react';
import { adminsApi, type AdminEntry } from '../api';
import { useToast } from '../toast/ToastContext';

export function AdminsPage() {
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const { showToast } = useToast();

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminsApi.list();
      setAdmins(res.admins || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando administradores');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grant = async () => {
    const clean = email.trim();
    if (!clean) return;
    setWorking(true);
    try {
      const res = await adminsApi.grant(clean);
      showToast('success', `${res.email} ahora es admin. Tiene que cerrar sesión y volver a entrar.`);
      setEmail('');
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo dar el rol');
    } finally {
      setWorking(false);
    }
  };

  const revoke = async (a: AdminEntry) => {
    if (!window.confirm(`¿Quitarle el acceso de admin a ${a.email || a.uid}?`)) return;
    setWorking(true);
    try {
      await adminsApi.revoke(a.uid);
      showToast('success', `${a.email || a.uid} ya no es admin.`);
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo quitar el rol');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="queue">
      <header>
        <h2>Administradores ({admins.length})</h2>
        <button onClick={() => void load()} aria-label="Actualizar la lista">
          Actualizar
        </button>
      </header>

      <p className="muted-note">
        La cuenta tiene que existir (la persona se registra primero en la app). El flamante admin
        debe cerrar sesión y volver a entrar al panel para que el rol tome efecto.
      </p>

      <form
        className="grant-form"
        onSubmit={(e) => {
          e.preventDefault();
          void grant();
        }}
      >
        <input
          type="email"
          placeholder="email@delapersona.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email de la persona a hacer admin"
          disabled={working}
        />
        <button type="submit" disabled={working || !email.trim()}>
          Dar admin
        </button>
      </form>

      {loading && <p>Cargando…</p>}
      {error && (
        <p className="error">
          {error}{' '}
          <button onClick={() => void load()} aria-label="Reintentar la carga">
            Reintentar
          </button>
        </p>
      )}

      <ul className="list">
        {admins.map((a) => (
          <li key={a.uid} className="static">
            <span className={`pill role-${a.role}`}>{a.role}</span>
            <strong>{a.email || a.uid}</strong>
            {a.role === 'admin' ? (
              <button
                className="ghost-danger"
                onClick={() => void revoke(a)}
                disabled={working}
                aria-label={`Quitar admin a ${a.email || a.uid}`}
              >
                Quitar
              </button>
            ) : (
              <span className="doc">no se gestiona desde el panel</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
