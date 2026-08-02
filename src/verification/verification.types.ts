/**
 * verification.types.ts
 * Tipos del dominio de registro + verificación (Fase 3).
 * El "titular" NO es un usuario de la app: es dato declarado por el alquilador.
 */

/** Estado del usuario en el flujo de alta. Gobierna el gating de la app (el server es la fuente de verdad). */
export enum UserState {
  PENDING_VERIFICATION = 'pending_verification', // se registró, falta cargar verificación
  PENDING_REVIEW = 'pending_review', // envió verificación, espera al admin
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}

export enum Role {
  DELIVERY = 'delivery',
  ADMIN = 'admin',
}

export enum AccountType {
  OWNER = 'owner', // cuenta propia de la app de reparto
  RENTER = 'renter', // alquila la cuenta de un titular
}

/** Datos del titular declarados por el alquilador (no es un usuario). */
export interface TitularData {
  name: string;
  document: string;
  accountId: string; // identificador de la cuenta de PedidosYa del titular
}

/** Payload que envía el delivery al verificarse. Las fotos son refs a Storage (subidas aparte). */
export interface VerificationSubmission {
  accountType: AccountType;
  selfieUrl: string;
  deliveryAppScreenshotUrl: string;
  documentUrl: string;
  // Datos personales declarados (para los cruces antifraude)
  fullName: string;
  phone: string;
  documentNumber: string;
  // Solo si accountType === RENTER
  renterFaceUrl?: string;
  workPhonePhotoUrl?: string;
  titular?: TitularData;
}

/** Un flag levantado por los cruces automáticos (no bloquea, lo ve el admin). */
export interface VerificationFlag {
  code: string;
  message: string;
}

export interface VerificationDoc extends VerificationSubmission {
  uid: string;
  status: UserState;
  flags: VerificationFlag[];
  submittedAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
  rejectionReason?: string;
}
