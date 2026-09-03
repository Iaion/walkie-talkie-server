/** Raíz del panel: gating por sesión + rol, y el shell con sidebar (Resumen / Verificaciones /
 *  Usuarios / Administradores — la última solo para superadmins). */
import { useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { VerificationsPage } from './verifications/VerificationsPage';
import { AdminsPage } from './admins/AdminsPage';
import { UsersPage } from './users/UsersPage';
import { DashboardPage } from './dashboard/DashboardPage';
import { ActivityPage } from './activity/ActivityPage';

type Section = 'dashboard' | 'verifications' | 'users' | 'admins' | 'activity';

const NAV: Array<{ id: Section; label: string; icon: string; superadminOnly?: boolean }> = [
  { id: 'dashboard', label: 'Resumen', icon: '◧' },
  { id: 'verifications', label: 'Verificaciones', icon: '🪪' },
  { id: 'users', label: 'Usuarios', icon: '👥' },
  { id: 'admins', label: 'Administradores', icon: '🛡', superadminOnly: true },
  { id: 'activity', label: 'Actividad', icon: '📜', superadminOnly: true },
];

export function App() {
  const { user, isAdmin, isSuperadmin, loading, logout } = useAuth();
  const [section, setSection] = useState<Section>('dashboard');

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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          AlRescate
          <span className="brand-tag">Admin</span>
        </div>
        <nav className="side-nav">
          {NAV.filter((n) => !n.superadminOnly || isSuperadmin).map((n) => (
            <button
              key={n.id}
              className={`side-link ${section === n.id ? 'active' : ''}`}
              onClick={() => setSection(n.id)}
            >
              <span className="side-icon" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="side-footer">
          <div className="side-user">
            <strong>{isSuperadmin ? 'Superadmin' : 'Admin'}</strong>
            <span>{user.email}</span>
          </div>
          <button onClick={() => void logout()}>Salir</button>
        </div>
      </aside>
      <main className="content">
        {section === 'dashboard' && <DashboardPage onGoTo={setSection} />}
        {section === 'verifications' && <VerificationsPage />}
        {section === 'users' && <UsersPage />}
        {section === 'admins' && isSuperadmin && <AdminsPage />}
        {section === 'activity' && isSuperadmin && <ActivityPage />}
      </main>
    </div>
  );
}
