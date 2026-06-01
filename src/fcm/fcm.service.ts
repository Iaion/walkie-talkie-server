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
    const { userId, oldToken, newToken, deviceId } = body;
    if (!userId || !newToken) {
      throw new BadRequestException({ success: false, message: 'userId y newToken son requeridos' });
    }
    try {
      await this.repo.refreshToken(userId, { oldToken, newToken, deviceId });
      return { success: true, message: 'Token actualizado correctamente', updatedAt: Date.now() };
    } catch (err: any) {
      throw new InternalServerErrorException({ success: false, message: err.message });
    }
  }
}
