/**
 * Cliente de la API NestJS. Adjunta el Firebase ID token del admin en cada request.
 * Tipado de punta a punta (G1): cada endpoint declara su respuesta; los errores son
 * ApiError (con status) y un 401 dispara el logout global (sesión caída ≠ error genérico).
 */
import { auth } from './firebase';

// En dev, VITE_API_URL apunta al backend local (otro puerto → con CORS).
// En producción servido por el backend, queda VACÍO = mismo origen (sin CORS): los pedidos
// van a /admin, /verification, etc. del mismo host que sirve el panel.
const API_URL = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Callback global ante 401 (lo registra AuthContext: desloguea y vuelve al login). */
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

async function authedFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError('No autenticado', 401);
  const token = await user.getIdToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  if (options.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError('No se pudo conectar con el servidor (¿red caída?)', 0);
  }

  // Distinguir "respuesta no-JSON" (ej. HTML de un proxy caído) de "sin datos".
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError('Sesión expirada: volvé a iniciar sesión', 401);
  }
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message || `Error ${res.status}`;
    throw new ApiError(message, res.status);
  }
  if (data === null) {
    throw new ApiError('Respuesta inválida del servidor (no es JSON)', res.status);
  }
  return data as T;
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

export interface ListVerificationsResponse {
  success: boolean;
  verifications: Verification[];
  total: number;
  hasMore?: boolean;
}

export interface PhotosResponse {
  success: boolean;
  photos: Record<string, string>;
}

export interface ReviewResponse {
  success: boolean;
  state?: string;
  message?: string;
  reason?: string;
}

export interface PanelUser {
  uid: string;
  email: string | null;
  name: string | null;
  state: string | null;
  role: 'admin' | 'superadmin' | null;
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface UsersListResponse {
  success: boolean;
  users: PanelUser[];
  total: number;
}

/** Tamaño de página de la cola (G2). */
export const PAGE_SIZE = 50;

export interface AdminEntry {
  uid: string;
  email: string | null;
  role: 'admin' | 'superadmin';
}

export interface AdminsListResponse {
  success: boolean;
  admins: AdminEntry[];
}

export interface AdminMutationResponse {
  success: boolean;
  uid?: string;
  email?: string;
  role?: string;
  message?: string;
}

/** Gestión de administradores — solo superadmin (el backend rechaza a los demás). */
export const adminsApi = {
  list: () => authedFetch<AdminsListResponse>('/admin/admins'),
  grant: (email: string) =>
    authedFetch<AdminMutationResponse>('/admin/admins', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  revoke: (uid: string) =>
    authedFetch<AdminMutationResponse>(`/admin/admins/${uid}`, { method: 'DELETE' }),
};

export const adminApi = {
  listVerifications: (status = 'pending_review', offset = 0) =>
    authedFetch<ListVerificationsResponse>(
      `/admin/verifications?status=${encodeURIComponent(status)}&limit=${PAGE_SIZE}&offset=${offset}`,
    ),
  getPhotos: (uid: string) => authedFetch<PhotosResponse>(`/admin/verifications/${uid}/photos`),
  listUsers: () => authedFetch<UsersListResponse>('/admin/users'),
  approve: (uid: string) =>
    authedFetch<ReviewResponse>(`/admin/verifications/${uid}/approve`, { method: 'POST' }),
  reject: (uid: string, reason: string) =>
    authedFetch<ReviewResponse>(`/admin/verifications/${uid}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
