/** Raíz del panel: gating por sesión + rol admin; muestra el login o la cola de verificaciones. */
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { VerificationsPage } from './verifications/VerificationsPage';

export function App() {
  const { user, isAdmin, loading, logout } = useAuth();

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
        <span className="spacer" />
        <span className="email">{user.email}</span>
        <button onClick={() => void logout()}>Salir</button>
      </nav>
      <main>
        <VerificationsPage />
      </main>
    </div>
  );
}
