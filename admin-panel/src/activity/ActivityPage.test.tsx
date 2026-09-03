/** Tests del feed de actividad: render legible (acciones traducidas, actores visibles). */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ActivityPage } from './ActivityPage';
import { adminsApi } from '../api';

vi.mock('../api', () => ({
  adminsApi: {
    audit: vi.fn(),
  },
}));

const mockedAudit = vi.mocked(adminsApi.audit);

const ENTRIES = [
  { id: 'a1', action: 'emergency_alert', actor: 'sergio@test.local', target: null, details: null, timestamp: 1788400000000 },
  { id: 'a2', action: 'grant_admin', actor: 'jose@test.local', target: 'caro@test.local', details: null, timestamp: 1788400001000 },
  { id: 'a3', action: 'accion_desconocida', actor: 'x@test.local', target: null, details: null, timestamp: null },
];

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAudit.mockResolvedValue({ success: true, entries: ENTRIES, total: ENTRIES.length });
  });

  test('muestra las acciones traducidas con actor y destinatario', async () => {
    render(<ActivityPage />);
    await waitFor(() => expect(screen.getByText('sergio@test.local')).toBeInTheDocument());
    expect(screen.getByText(/disparó una alerta de emergencia/)).toBeInTheDocument();
    expect(screen.getByText(/dio rol de admin a/)).toBeInTheDocument();
    expect(screen.getByText('caro@test.local')).toBeInTheDocument();
    // Acción sin traducción: cae al nombre crudo, no rompe
    expect(screen.getByText(/accion_desconocida/)).toBeInTheDocument();
  });

  test('sin actividad muestra el vacío', async () => {
    mockedAudit.mockResolvedValueOnce({ success: true, entries: [], total: 0 });
    render(<ActivityPage />);
    await waitFor(() => expect(screen.getByText('Todavía no hay actividad registrada.')).toBeInTheDocument());
  });
});
