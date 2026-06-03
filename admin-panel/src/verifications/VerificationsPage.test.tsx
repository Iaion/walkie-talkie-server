/** Tests de la cola de verificaciones: render de pendientes + cambio de tab pide el estado correcto. */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { VerificationsPage } from './VerificationsPage';
import { adminApi } from '../api';

// Mockeamos la API (evita cargar firebase y pegarle a la red en el test).
vi.mock('../api', () => ({
  adminApi: {
    listVerifications: vi.fn().mockResolvedValue({
      verifications: [
        {
          uid: 'U1',
          accountType: 'owner',
          status: 'pending_review',
          fullName: 'Juan Perez',
          documentNumber: '12345678',
          flags: [],
        },
      ],
    }),
    getPhotos: vi.fn().mockResolvedValue({ photos: {} }),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

describe('VerificationsPage', () => {
  test('muestra las verificaciones pendientes', async () => {
    render(<VerificationsPage />);
    await waitFor(() => expect(screen.getByText('Juan Perez')).toBeInTheDocument());
    expect(screen.getByText(/Verificaciones/)).toBeInTheDocument();
  });

  test('cambiar al tab Aprobados pide ese estado al backend', async () => {
    render(<VerificationsPage />);
    await waitFor(() => expect(screen.getByText('Juan Perez')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Aprobados'));
    await waitFor(() => expect(adminApi.listVerifications).toHaveBeenCalledWith('approved'));
  });
});
