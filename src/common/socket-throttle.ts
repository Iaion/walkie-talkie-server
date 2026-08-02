/**
 * socket-throttle.ts
 * Rate limiting por-socket y por-evento para el gateway (PLAN_MEJORAS A2).
 * Ventana fija: cada socket puede emitir hasta N veces un evento por ventana; al pasarse,
 * el handler responde ack { success:false, message:'RATE_LIMITED...' } sin ejecutar nada.
 * Protege los eventos calientes (pánico, chat, ubicaciones) de clientes buggeados o maliciosos
 * (spam de emergency_alert = broadcast storm + cuota Firestore).
 * Defaults generosos (no molestan a un cliente legítimo); override por env para prod o tests:
 *   SOCKET_RATE_WINDOW_MS y SOCKET_RATE_LIMIT_<EVENTO> (ej. SOCKET_RATE_LIMIT_EMERGENCY_ALERT).
 */
import { Injectable } from '@nestjs/common';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

@Injectable()
export class SocketThrottle {
  private readonly windows = new Map<string, { count: number; start: number }>();
  private readonly windowMs = envInt('SOCKET_RATE_WINDOW_MS', 10_000);
  private readonly limits: Record<string, number> = {
    emergency_alert: envInt('SOCKET_RATE_LIMIT_EMERGENCY_ALERT', 30),
    send_message: envInt('SOCKET_RATE_LIMIT_SEND_MESSAGE', 100),
    audio_message: envInt('SOCKET_RATE_LIMIT_AUDIO_MESSAGE', 50),
    update_location: envInt('SOCKET_RATE_LIMIT_UPDATE_LOCATION', 300),
    update_emergency_location: envInt('SOCKET_RATE_LIMIT_UPDATE_EMERGENCY_LOCATION', 300),
    update_helper_location: envInt('SOCKET_RATE_LIMIT_UPDATE_HELPER_LOCATION', 300),
  };

  /** true = el evento puede procesarse; false = excedió el límite en esta ventana. */
  allow(socketId: string, event: string): boolean {
    const limit = this.limits[event];
    if (!limit) return true; // evento sin límite configurado
    const key = `${socketId}:${event}`;
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { count: 1, start: now });
      return true;
    }
    w.count++;
    return w.count <= limit;
  }

  /** Limpieza al desconectar el socket (evita crecimiento indefinido del Map). */
  forget(socketId: string): void {
    for (const key of this.windows.keys()) {
      if (key.startsWith(`${socketId}:`)) this.windows.delete(key);
    }
  }
}

export const RATE_LIMITED_ACK = {
  success: false,
  message: 'RATE_LIMITED: demasiados eventos en poco tiempo, reintentá en unos segundos',
};
