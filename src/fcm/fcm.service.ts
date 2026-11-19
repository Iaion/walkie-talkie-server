/**
 * fcm.service.ts
 * Lógica de gestión de tokens FCM. Replica el monolito, incluido su comportamiento de que
 * "usuario no encontrado" en cleanup/refresh devuelve 500 (el throw cae en el catch → 500),
 * no 404. Se reproduce con InternalServerErrorException.
 */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { FcmRepository } from './fcm.repository';

@Injectable()
export class FcmService {
  constructor(private readonly repo: FcmRepository) {}

  async getUserTokens(userId: string) {
    const data = await this.repo.getUser(userId);
    if (!data) throw new NotFoundException({ success: false, message: 'Usuario no encontrado' });
    const tokens = {
      fcmTokens: data.fcmTokens || [],
      fcmToken: data.fcmToken || '',
      devices: data.devices || {},
      count: (data.fcmTokens?.length || 0) + (data.fcmToken ? 1 : 0),
      lastUpdated: data.fcmTokensUpdatedAt || null,
      tokensCleanedAt: data.tokensCleanedAt || null,
    };
    return { success: true, userId, tokens, totalTokens: tokens.count };
  }

  async cleanupTokens(body: Record<string, any>) {
    const { userId, invalidTokens } = body;
    if (!userId || !Array.isArray(invalidTokens)) {
      throw new BadRequestException({ success: false, message: 'userId y invalidTokens array son requeridos' });
    }
    try {
      const removedCount = await this.repo.cleanupTokens(userId, invalidTokens);
      return { success: true, message: `Se eliminaron ${removedCount} tokens inválidos`, removedCount, cleanedAt: Date.now() };
    } catch (err: any) {
      throw new InternalServerErrorException({ success: false, message: err.message });
    }
  }

  async refresh(body: Record<string, any>) {
    const { userId, oldToken, newToken } = body;
    if (!userId || !newToken) {
      throw new BadRequestException({ success: false, message: 'userId y newToken son requeridos' });
    }
    const token = String(newToken).trim();
    // Sin deviceId (cliente viejo) se deriva uno estable del token para no duplicar documentos.
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim()
      ? body.deviceId.trim().slice(0, 128)
      : `tok_${createHash('sha1').update(token).digest('hex').slice(0, 20)}`;
    const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
    try {
      await this.repo.refreshToken(userId, { oldToken, newToken: token, deviceId });
      await this.repo.upsertDeviceToken(userId, {
        deviceId, token, oldToken: typeof oldToken === 'string' ? oldToken : undefined,
        platform: clean(body.platform) || 'android', deviceModel: clean(body.deviceModel), appVersion: clean(body.appVersion),
      });
      return { success: true, message: 'Token actualizado correctamente', updatedAt: Date.now(), deviceId };
    } catch (err: any) {
      throw new InternalServerErrorException({ success: false, message: err.message });
    }
  }

  /** ¿Este usuario (y este dispositivo) puede recibir alertas? La app lo consulta al abrir. */
  async status(userId: string, deviceId?: string) {
    const devices = await this.repo.activeDevices(userId);
    return {
      success: true,
      hasValidToken: devices.length > 0,
      deviceRegistered: !!deviceId && devices.some((d) => d.deviceId === deviceId),
      validDevices: devices.length,
    };
  }

  async unregister(userId: string, deviceId: string) {
    if (!deviceId) throw new BadRequestException({ success: false, message: 'deviceId es requerido' });
    await this.repo.disableDevice(userId, deviceId);
    return { success: true };
  }
}
