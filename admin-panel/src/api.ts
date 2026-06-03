/**
 * Cliente de la API NestJS. Adjunta el Firebase ID token del admin en cada request.
 */
import { auth } from './firebase';

// En dev, VITE_API_URL apunta al backend local (otro puerto → con CORS).
// En producción servido por el backend, queda VACÍO = mismo origen (sin CORS): los pedidos
// van a /admin, /verification, etc. del mismo host que sirve el panel.
const API_URL = import.meta.env.VITE_API_URL ?? '';

async function authedFetch(path: string, options: RequestInit = {}): Promise<any> {
  const user = auth.currentUser;
  if (!user) throw new Error('No autenticado');
  const token = await user.getIdToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Error ${res.status}`);
  return data;
}

export interface VerificationFlag {
  code: string;
  message: string;
}

export interface Verification {
  uid: string;
  accountType: 'owner' | 'renter';
  status: string;
  fullName?: string;
  phone?: string;
  documentNumber?: string;
  flags?: VerificationFlag[];
  titular?: { name: string; document: string; accountId: string };
  submittedAt?: number;
}

export const adminApi = {
  listVerifications: (status = 'pending_review') =>
    authedFetch(`/admin/verifications?status=${encodeURIComponent(status)}`),
  getPhotos: (uid: string) => authedFetch(`/admin/verifications/${uid}/photos`),
  approve: (uid: string) => authedFetch(`/admin/verifications/${uid}/approve`, { method: 'POST' }),
  reject: (uid: string, reason: string) =>
    authedFetch(`/admin/verifications/${uid}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
