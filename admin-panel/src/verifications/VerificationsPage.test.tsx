/** Tests de la cola: render, cambio de tab, error de API con reintento y paginación (G2/G4). */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { VerificationsPage } from './VerificationsPage';
import { adminApi } from '../api';
import { ToastProvider } from '../toast/ToastContext';

// Mockeamos la API (evita cargar firebase y pegarle a la red en el test).
vi.mock('../api', () => ({
  adminApi: {
    listVerifications: vi.fn(),
    getPhotos: vi.fn().mockResolvedValue({ photos: {} }),
    approve: vi.fn(),
    reject: vi.fn(),
  },
  PAGE_SIZE: 50,
}));

const mockedList = vi.mocked(adminApi.listVerifications);

const JUAN = {
  uid: 'U1',
  accountType: 'owner' as const,
  status: 'pending_review',
  fullName: 'Juan Perez',
  documentNumber: '12345678',
  flags: [],
};

function renderPage() {
  return render(
    <ToastProvider>
      <VerificationsPage />
    </ToastProvider>,
  );
}

describe('VerificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue({ success: true, verifications: [JUAN], total: 1, hasMore: false });
  });

  test('muestra las verificaciones pendientes', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Juan Perez')).toBeInTheDocument());
    expect(screen.getByText(/Verificaciones/)).toBeInTheDocument();
  });

  test('cambiar al tab Aprobados pide ese estado al backend', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Juan Perez')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Aprobados'));
    await waitFor(() => expect(adminApi.listVerifications).toHaveBeenCalledWith('approved', 0));
  });

  test('si la API falla muestra el error y Reintentar vuelve a pedir (G4)', async () => {
    mockedList.mockRejectedValueOnce(new Error('Servidor caído'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Servidor caído/)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Reintentar la carga'));
    await waitFor(() => expect(screen.getByText('Juan Perez')).toBeInTheDocument());
  });

  test('con hasMore muestra "Cargar más" y pide la página siguiente con offset (G2)', async () => {
    mockedList.mockResolvedValueOnce({ success: true, verifications: [JUAN], total: 1, hasMore: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('Cargar más')).toBeInTheDocument());

    mockedList.mockResolvedValueOnce({
      success: true,
      verifications: [{ ...JUAN, uid: 'U2', fullName: 'Maria Lopez' }],
      total: 1,
      hasMore: false,
    });
    fireEvent.click(screen.getByText('Cargar más'));
    await waitFor(() => expect(screen.getByText('Maria Lopez')).toBeInTheDocument());
    // El offset es la cantidad ya cargada (1)
    expect(adminApi.listVerifications).toHaveBeenLastCalledWith('pending_review', 1);
    // Y las dos quedan en la lista
    expect(screen.getByText('Juan Perez')).toBeInTheDocument();
  });

  test('cola vacía muestra el mensaje correspondiente', async () => {
    mockedList.mockResolvedValueOnce({ success: true, verifications: [], total: 0, hasMore: false });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('No hay verificaciones en esta categoría.')).toBeInTheDocument(),
    );
  });
});
