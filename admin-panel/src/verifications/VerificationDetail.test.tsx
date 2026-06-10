/** Tests del detalle: render, aprobar, rechazo sin/con motivo, error de API y toasts (G3/G4). */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { VerificationDetail } from './VerificationDetail';
import { adminApi } from '../api';
import { ToastProvider } from '../toast/ToastContext';

vi.mock('../api', () => ({
  adminApi: {
    getPhotos: vi.fn().mockResolvedValue({ photos: {} }),
    approve: vi.fn().mockResolvedValue({ success: true }),
    reject: vi.fn().mockResolvedValue({ success: true }),
  },
  PAGE_SIZE: 50,
}));

const pending = {
  uid: 'U1',
  accountType: 'owner' as const,
  status: 'pending_review',
  fullName: 'Juan Perez',
  documentNumber: '12345678',
  phone: '555',
};

function renderDetail(props: Partial<Parameters<typeof VerificationDetail>[0]> = {}) {
  return render(
    <ToastProvider>
      <VerificationDetail verification={pending} onBack={() => {}} onReviewed={() => {}} {...props} />
    </ToastProvider>,
  );
}

describe('VerificationDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminApi.getPhotos).mockResolvedValue({ success: true, photos: {} });
    vi.mocked(adminApi.approve).mockResolvedValue({ success: true });
    vi.mocked(adminApi.reject).mockResolvedValue({ success: true });
  });

  test('muestra los datos y pide las fotos al backend', async () => {
    renderDetail();
    expect(screen.getByText('Juan Perez')).toBeInTheDocument();
    expect(screen.getByText('12345678')).toBeInTheDocument();
    await waitFor(() => expect(adminApi.getPhotos).toHaveBeenCalledWith('U1'));
    await waitFor(() => expect(screen.getByText('Sin fotos disponibles.')).toBeInTheDocument());
  });

  test('Aprobar llama a la API, avisa onReviewed y muestra el toast', async () => {
    const onReviewed = vi.fn();
    renderDetail({ onReviewed });
    fireEvent.click(screen.getByText('✅ Aprobar'));
    await waitFor(() => expect(adminApi.approve).toHaveBeenCalledWith('U1'));
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
    expect(screen.getByText(/aprobada/)).toBeInTheDocument();
  });

  test('Rechazar SIN motivo no llama a la API y muestra el error (G4)', async () => {
    renderDetail();
    fireEvent.click(screen.getByText('❌ Rechazar'));
    await waitFor(() =>
      expect(screen.getByText('Indicá un motivo de rechazo')).toBeInTheDocument(),
    );
    expect(adminApi.reject).not.toHaveBeenCalled();
  });

  test('Rechazar con motivo llama a la API con el motivo (G4)', async () => {
    const onReviewed = vi.fn();
    renderDetail({ onReviewed });
    fireEvent.change(screen.getByLabelText('Motivo de rechazo'), {
      target: { value: 'Documento ilegible' },
    });
    fireEvent.click(screen.getByText('❌ Rechazar'));
    await waitFor(() => expect(adminApi.reject).toHaveBeenCalledWith('U1', 'Documento ilegible'));
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
  });

  test('si aprobar falla muestra el error y NO avisa onReviewed (G4)', async () => {
    vi.mocked(adminApi.approve).mockRejectedValueOnce(new Error('Sesión expirada: volvé a iniciar sesión'));
    const onReviewed = vi.fn();
    renderDetail({ onReviewed });
    fireEvent.click(screen.getByText('✅ Aprobar'));
    await waitFor(() =>
      expect(screen.getAllByText(/Sesión expirada/).length).toBeGreaterThan(0),
    );
    expect(onReviewed).not.toHaveBeenCalled();
  });

  test('un item ya aprobado no muestra el botón Aprobar', async () => {
    render(
      <ToastProvider>
        <VerificationDetail
          verification={{ ...pending, status: 'approved' }}
          onBack={() => {}}
          onReviewed={() => {}}
        />
      </ToastProvider>,
    );
    expect(screen.queryByText('✅ Aprobar')).toBeNull();
    await waitFor(() => expect(adminApi.getPhotos).toHaveBeenCalled());
  });
});
