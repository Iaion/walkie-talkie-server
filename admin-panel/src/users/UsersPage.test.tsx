/** Tests del directorio de usuarios: render, búsqueda y filtro por estado. */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { UsersPage } from './UsersPage';
import { adminApi } from '../api';

vi.mock('../api', () => ({
  adminApi: {
    listUsers: vi.fn(),
  },
}));

const mockedList = vi.mocked(adminApi.listUsers);

const USERS = [
  { uid: 'U1', email: 'ana@test.local', name: 'Ana García', state: 'approved', role: null, createdAt: '2026-08-01T10:00:00Z', lastLoginAt: '2026-09-01T10:00:00Z' },
  { uid: 'U2', email: 'beto@test.local', name: 'Beto Díaz', state: 'pending_review', role: null, createdAt: null, lastLoginAt: null },
  { uid: 'U3', email: 'jose@test.local', name: 'Jose Giles', state: null, role: 'superadmin' as const, createdAt: null, lastLoginAt: null },
];

describe('UsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue({ success: true, users: USERS, total: USERS.length });
  });

  test('lista todos los usuarios con estado y rol', async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('Ana García')).toBeInTheDocument());
    expect(screen.getByText('Beto Díaz')).toBeInTheDocument();
    expect(screen.getByText('superadmin')).toBeInTheDocument();
    // La gente común muestra el rol "usuario", no un guion
    expect(screen.getAllByText('usuario')).toHaveLength(2);
    expect(screen.getAllByText('Aprobado')).toHaveLength(1);
    expect(screen.getByText('En revisión', { selector: '.pill' })).toBeInTheDocument();
    // El staff sin circuito de repartidor NO figura "Sin verificar": no le aplica
    expect(screen.getByText('No aplica')).toBeInTheDocument();
    expect(screen.queryByText('Sin verificar', { selector: '.pill' })).toBeNull();
  });

  test('la búsqueda filtra por nombre o email', async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('Ana García')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Buscar usuarios'), { target: { value: 'beto' } });
    expect(screen.queryByText('Ana García')).toBeNull();
    expect(screen.getByText('Beto Díaz')).toBeInTheDocument();
  });

  test('el filtro de estado muestra solo ese estado', async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('Ana García')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /En revisión/ }));
    expect(screen.queryByText('Ana García')).toBeNull();
    expect(screen.getByText('Beto Díaz')).toBeInTheDocument();
  });
});
