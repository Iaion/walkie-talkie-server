/**
 * auth.guard.ts
 * Guard GLOBAL que verifica el Firebase ID token en cada request REST (equivalente al
 * middleware `authenticate` del monolito, Fase 1). Las rutas con @Public() quedan exentas.
 * Adjunta el token decodificado en req.user (base para la autorización fina por-usuario).
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseService } from '../firebase/firebase.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string = req.headers?.authorization || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) {
      throw new UnauthorizedException({ success: false, message: 'No autenticado: falta token' });
    }

    try {
      req.user = await this.firebase.auth.verifyIdToken(match[1]);
      return true;
    } catch {
      throw new UnauthorizedException({ success: false, message: 'Token inválido' });
    }
  }
}
