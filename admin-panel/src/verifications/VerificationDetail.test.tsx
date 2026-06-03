/** Tests del detalle de verificación: render de datos/fotos + aprobar llama a la API. */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { VerificationDetail } from './VerificationDetail';
import { adminApi } from '../api';

vi.mock('../api', () => ({
  adminApi: {
    getPhotos: vi.fn().mockResolvedValue({ photos: {} }),
    approve: vi.fn().mockResolvedValue({ success: true }),
    reject: vi.fn().mockResolvedValue({ success: true }),
  },
}));

const pending = {
  uid: 'U1',
  accountType: 'owner' as const,
  status: 'pending_review',
  fullName: 'Juan Perez',
  documentNumber: '12345678',
  phone: '555',
};

describe('VerificationDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  test('muestra los datos y pide las fotos al backend', async () => {
    render(<VerificationDetail verification={pending} onBack={() => {}} onReviewed={() => {}} />);
    expect(screen.getByText('Juan Perez')).toBeInTheDocument();
    expect(screen.getByText('12345678')).toBeInTheDocument();
    await waitFor(() => expect(adminApi.getPhotos).toHaveBeenCalledWith('U1'));
  });

  test('Aprobar llama a la API y avisa onReviewed', async () => {
    const onReviewed = vi.fn();
    render(<VerificationDetail verification={pending} onBack={() => {}} onReviewed={onReviewed} />);
    fireEvent.click(screen.getByText('✅ Aprobar'));
    await waitFor(() => expect(adminApi.approve).toHaveBeenCalledWith('U1'));
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
  });

  test('un item ya aprobado no muestra el botón Aprobar', () => {
    render(
      <VerificationDetail
        verification={{ ...pending, status: 'approved' }}
        onBack={() => {}}
        onReviewed={() => {}}
      />,
    );
    expect(screen.queryByText('✅ Aprobar')).toBeNull();
  });
});
