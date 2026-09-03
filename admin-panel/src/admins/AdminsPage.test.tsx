/** Tests de la gestión de administradores: render, alta por email, quitar (con confirm),
 *  y que a un superadmin no se le ofrece el botón Quitar. */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminsPage } from './AdminsPage';
import { adminsApi } from '../api';
import { ToastProvider } from '../toast/ToastContext';

vi.mock('../api', () => ({
  adminsApi: {
    list: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
  },
}));

const mockedList = vi.mocked(adminsApi.list);
const mockedGrant = vi.mocked(adminsApi.grant);
const mockedRevoke = vi.mocked(adminsApi.revoke);

const SUPER = { uid: 'S1', email: 'jose@test.local', role: 'superadmin' as const };
const ADMIN = { uid: 'A1', email: 'caro@test.local', role: 'admin' as const };

function renderPage() {
  return render(
    <ToastProvider>
      <AdminsPage />
    </ToastProvider>,
  );
}

describe('AdminsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue({ success: true, admins: [SUPER, ADMIN] });
  });

  test('lista admins y superadmins; el superadmin no tiene botón Quitar', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('jose@test.local')).toBeInTheDocument());
    expect(screen.getByText('caro@test.local')).toBeInTheDocument();
    expect(screen.getByLabelText('Quitar admin a caro@test.local')).toBeInTheDocument();
    expect(screen.queryByLabelText('Quitar admin a jose@test.local')).toBeNull();
  });

  test('dar admin por email llama a la API y recarga', async () => {
    mockedGrant.mockResolvedValue({ success: true, email: 'nuevo@test.local', role: 'admin' });
    renderPage();
    await waitFor(() => expect(screen.getByText('caro@test.local')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Email de la persona a hacer admin'), {
      target: { value: 'nuevo@test.local' },
    });
    fireEvent.click(screen.getByText('Dar admin'));

    await waitFor(() => expect(adminsApi.grant).toHaveBeenCalledWith('nuevo@test.local'));
    expect(adminsApi.list).toHaveBeenCalledTimes(2); // carga inicial + recarga post-alta
  });

  test('quitar pide confirmación y llama a la API', async () => {
    mockedRevoke.mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('caro@test.local')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Quitar admin a caro@test.local'));
    await waitFor(() => expect(adminsApi.revoke).toHaveBeenCalledWith('A1'));
  });

  test('si la API de alta falla, muestra el error en un toast', async () => {
    mockedGrant.mockRejectedValue(new Error('No existe una cuenta con ese email'));
    renderPage();
    await waitFor(() => expect(screen.getByText('caro@test.local')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Email de la persona a hacer admin'), {
      target: { value: 'fantasma@test.local' },
    });
    fireEvent.click(screen.getByText('Dar admin'));
    await waitFor(() => expect(screen.getByText(/No existe una cuenta/)).toBeInTheDocument());
  });
});
