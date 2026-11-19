/**
 * emergency.service.ts
 * Reglas de concurrencia e historial de emergencias.
 *
 * Antes había un lock GLOBAL (una emergencia a la vez para todo el sistema). Ahora cada usuario
 * tiene a lo sumo UNA emergencia activa y pueden convivir todas las que hagan falta. Este
 * servicio aporta lo que el gateway necesita para que eso sea seguro:
 *  - runExclusive: serializa las operaciones sobre la emergencia de un mismo usuario (crear,
 *    reemplazar, confirmar/rechazar ayuda, resolver, vencer). Sin esto, un doble toque o la misma
 *    cuenta en dos teléfonos podían crear dos emergencias, y un "puedo ayudar" podía cruzarse
 *    con la cancelación.
 *  - allowNew: tope de emergencias nuevas por usuario por minuto (abuso o cliente con bug).
 *  - historial: emergencias terminadas en la última hora, para la lista de la pantalla principal.
 *  - vencimiento: cuáles emergencias llevan demasiado tiempo sin actividad de la víctima.
 */
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { StateStore } from './state.store';

export interface HelperInfo {
  id: string;
  name: string;
}

export interface EndedEmergency {
  emergencyId: string;
  userId: string;
  userName: string;
  avatarUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  emergencyType: string;
  startedAt: number;
  endedAt: number;
  endReason: string;
  helpersInfo: HelperInfo[];
}

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

@Injectable()
export class EmergencyService {
  private readonly logger = new Logger(EmergencyService.name);

  /** Sin actividad de la víctima por este tiempo, la emergencia se da por abandonada. */
  readonly IDLE_TTL_MS = envMs('EMERGENCY_IDLE_TTL_MS', 3 * 60 * 60 * 1000);
  /** Cada cuánto se revisan los vencimientos. */
  readonly SWEEP_MS = envMs('EMERGENCY_SWEEP_MS', 60 * 1000);
  /** Ventana del historial que ve la app ("últimos SOS"). */
  readonly HISTORY_MS = envMs('EMERGENCY_HISTORY_MS', 60 * 60 * 1000);
  /** Emergencias nuevas (o reemplazos) permitidas por usuario por minuto. */
  readonly MAX_PER_MINUTE = envMs('EMERGENCY_MAX_PER_MINUTE', 6);

  private readonly chains = new Map<string, Promise<void>>();
  private readonly starts = new Map<string, number[]>();

  constructor(private readonly firebase: FirebaseService, private readonly state: StateStore) {}

  /** Ejecuta `fn` en serie respecto de cualquier otra operación sobre la emergencia de `key`. */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => gate);
    this.chains.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /** true si el usuario puede abrir (o reemplazar) una emergencia ahora; registra el intento. */
  allowNew(userId: string, now = Date.now()): boolean {
    const recent = (this.starts.get(userId) || []).filter((t) => now - t < 60_000);
    if (recent.length >= this.MAX_PER_MINUTE) {
      this.starts.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.starts.set(userId, recent);
    return true;
  }

  /** Ayudantes de la emergencia de `userId` con su nombre (para la lista y el historial). */
  helpersInfo(userId: string): HelperInfo[] {
    const names: Record<string, string> = this.state.emergencyAlerts.get(userId)?.helperNames || {};
    return [...(this.state.emergencyHelpers.get(userId) || [])].map((id) => ({
      id,
      name: names[id] || this.state.connectedUsers.get(id)?.userData?.username || 'Ayudante',
    }));
  }

  /** Emergencias cuya víctima no da señales hace más de IDLE_TTL_MS. */
  expiredOwners(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [userId, alert] of this.state.emergencyAlerts) {
      const last = Number(alert.lastActivityAt || alert.timestamp || 0);
      if (last > 0 && now - last > this.IDLE_TTL_MS) out.push(userId);
    }
    return out;
  }

  /** Marca actividad de la víctima (ubicación, mensaje, reconexión): posterga el vencimiento. */
  touch(userId: string): void {
    const alert = this.state.emergencyAlerts.get(userId);
    if (alert) alert.lastActivityAt = Date.now();
  }

  /** Guarda la emergencia terminada en memoria y en Firestore (best-effort). */
  archive(alert: Record<string, any>, endReason: string, helpersInfo: HelperInfo[]): EndedEmergency {
    const now = Date.now();
    const ended: EndedEmergency = {
      emergencyId: String(alert.emergencyId || `${alert.userId}_${alert.timestamp}`),
      userId: String(alert.userId),
      userName: String(alert.userName || 'Usuario'),
      avatarUrl: alert.avatarUrl || null,
      latitude: typeof alert.latitude === 'number' ? alert.latitude : null,
      longitude: typeof alert.longitude === 'number' ? alert.longitude : null,
      emergencyType: String(alert.emergencyType || 'general'),
      startedAt: Number(alert.timestamp) || now,
      endedAt: now,
      endReason,
      helpersInfo,
    };
    this.state.recentEmergencies.push(ended);
    this.prune(now);
    this.firebase.firestore.collection('emergency_history').doc(ended.emergencyId).set(ended)
      .catch((e) => this.logger.warn(`emergency_history no disponible: ${(e as Error).message}`));
    return ended;
  }

  /** Terminadas en la última hora, las más nuevas primero. Los reemplazos no se listan. */
  recent(now = Date.now()): EndedEmergency[] {
    this.prune(now);
    return this.state.recentEmergencies
      .filter((e) => e.endReason !== 'replaced')
      .sort((a, b) => b.endedAt - a.endedAt);
  }

  /** Al arrancar: recupera de Firestore el historial de la última hora. */
  async loadRecent(): Promise<void> {
    try {
      const since = Date.now() - this.HISTORY_MS;
      const snap = await this.firebase.firestore.collection('emergency_history').where('endedAt', '>=', since).get();
      const known = new Set(this.state.recentEmergencies.map((e) => e.emergencyId));
      snap.docs.forEach((d) => {
        const e = d.data() as EndedEmergency;
        if (e?.emergencyId && !known.has(e.emergencyId)) this.state.recentEmergencies.push(e);
      });
    } catch (e) {
      this.logger.warn(`No se pudo recuperar emergency_history: ${(e as Error).message}`);
    }
  }

  private prune(now: number): void {
    const keep = this.state.recentEmergencies.filter((e) => now - e.endedAt <= this.HISTORY_MS);
    if (keep.length !== this.state.recentEmergencies.length) {
      this.state.recentEmergencies.length = 0;
      this.state.recentEmergencies.push(...keep);
    }
  }
}
