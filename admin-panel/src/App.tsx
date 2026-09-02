/** Raíz del panel: gating por sesión + rol; muestra el login, la cola de verificaciones y
 *  (solo para superadmins) la gestión de administradores. */
import { useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { VerificationsPage } from './verifications/VerificationsPage';
import { AdminsPage } from './admins/AdminsPage';

export function App() {
  const { user, isAdmin, isSuperadmin, loading, logout } = useAuth();
  const [section, setSection] = useState<'verifications' | 'admins'>('verifications');

  if (loading) return <div className="center">Cargando…</div>;
  if (!user) return <LoginPage />;

  if (!isAdmin) {
    return (
      <div className="center">
        <div className="card">
          <p>Tu cuenta no tiene permisos de administrador.</p>
          <button onClick={() => void logout()}>Salir</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav>
        <strong>AlRescate · Admin</strong>
        {isSuperadmin && (
          <span className="nav-sections">
            <button
              className={`nav-link ${section === 'verifications' ? 'active' : ''}`}
              onClick={() => setSection('verifications')}
            >
              Verificaciones
            </button>
            <button
              className={`nav-link ${section === 'admins' ? 'active' : ''}`}
              onClick={() => setSection('admins')}
            >
              Administradores
            </button>
          </span>
        )}
        <span className="spacer" />
        <span className="email">{user.email}</span>
        <button onClick={() => void logout()}>Salir</button>
      </nav>
      <main>{isSuperadmin && section === 'admins' ? <AdminsPage /> : <VerificationsPage />}</main>
    </div>
  );
}
