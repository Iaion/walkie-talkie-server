/**
 * ownership.ts
 * Autorización por-usuario: el uid AUTENTICADO (del token) debe coincidir con el recurso.
 * Cierra el agujero heredado del prototipo (el server confiaba en el userId del cliente).
 * El admin (rol admin) puede operar sobre cualquiera.
 */
import { ForbiddenException } from '@nestjs/common';

/** Lanza 403 si el usuario autenticado no es dueño del recurso (salvo que sea admin). */
export function assertSelf(req: any, targetUserId: string | undefined): void {
  const authUid = req?.user?.uid;
  const isAdmin = req?.user?.role === 'admin';
  if (isAdmin) return;
  if (!targetUserId || authUid !== targetUserId) {
    throw new ForbiddenException({ success: false, message: 'No autorizado: solo podés operar sobre tus propios datos' });
  }
}
