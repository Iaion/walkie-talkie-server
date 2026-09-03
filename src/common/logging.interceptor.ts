/**
 * logging.interceptor.ts
 * Registro automático de CADA pedido REST: quién (uid del token), qué (método + ruta),
 * resultado (status) y duración. Los 4xx se loguean como warning con su mensaje y los 5xx
 * como error — así ningún fallo vuelve a pasar en silencio (lección del bug de la foto de
 * vehículo: la app recibía 404 y nadie lo veía en ningún lado).
 * /health queda excluido: el healthcheck del host pega cada pocos segundos y sería ruido.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  /** Eventos de socket que NO se loguean: llegan cada pocos segundos por usuario (puro ruido). */
  private static readonly WS_NOISE = /location|heartbeat|typing|ping/i;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'ws') return this.interceptWs(context, next);
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const path: string = req.originalUrl || req.url || '';
    if (path.startsWith('/health')) return next.handle();

    const started = Date.now();
    const who = () => req.user?.uid || 'anon';
    const line = (status: number | string) =>
      `${req.method} ${path} → ${status} · uid=${who()} · ${Date.now() - started}ms`;

    return next.handle().pipe(
      tap({
        next: () => {
          const status = context.switchToHttp().getResponse().statusCode;
          this.logger.log(line(status));
        },
        error: (err: any) => {
          const status = err?.status ?? err?.response?.statusCode ?? 500;
          const msg = err?.response?.message || err?.message || 'error';
          if (status >= 500) this.logger.error(`${line(status)} · ${msg}`);
          else this.logger.warn(`${line(status)} · ${msg}`);
        },
      }),
    );
  }

  /** Socket.IO: loguea cada evento (handler + uid) y si el ack fue success o no. */
  private interceptWs(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler().name;
    if (LoggingInterceptor.WS_NOISE.test(handler)) return next.handle();

    const client = context.switchToWs().getClient();
    const uid = client?.user?.uid || 'anon';
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: (ack: any) => {
          const ok = ack === undefined || ack?.success !== false;
          const detail = ok ? 'ok' : `FALLO: ${ack?.code || ack?.message || '?'}`;
          const line = `WS ${handler} · uid=${uid} → ${detail} · ${Date.now() - started}ms`;
          if (ok) this.logger.log(line);
          else this.logger.warn(line);
        },
        error: (err: any) => {
          this.logger.error(`WS ${handler} · uid=${uid} → ERROR: ${err?.message || err} · ${Date.now() - started}ms`);
        },
      }),
    );
  }
}
