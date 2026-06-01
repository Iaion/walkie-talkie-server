/**
 * roles.guard.ts
 * Autoriza por rol (custom claim del token). Corre DESPUÉS del AuthGuard global (que ya
 * puso req.user con el token decodificado). Si el endpoint no pide roles, deja pasar.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;
    if (!required.includes(role)) {
      throw new ForbiddenException({ success: false, message: 'Acceso denegado: requiere rol admin' });
    }
    return true;
  }
}
