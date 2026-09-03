/**
 * vehicles.service.ts
 * Lógica de negocio de vehículos (CRUD + foto). Replica EXACTAMENTE el comportamiento del
 * monolito (validaciones, códigos de estado, shape de respuesta, isPrimary automático en el
 * primero, soft-delete) — verificado por los tests de caracterización.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { FirebaseService } from '../firebase/firebase.service';
import { VehiclesRepository } from './vehicles.repository';
import { isDataUrl, getMimeFromDataUrl } from '../common/image-utils';
import { StorageService } from '../common/storage.service';
import { AuditService } from '../common/audit.service';

const VALID_TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE'];

@Injectable()
export class VehiclesService {
  constructor(
    private readonly repo: VehiclesRepository,
    private readonly firebase: FirebaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Mapea un doc de Firestore al shape de respuesta del monolito (con campos por tipo). */
  private map(v: Record<string, any>) {
    return {
      id: v.id,
      type: v.type || v.tipo,
      name: v.name || v.nombre,
      brand: v.brand || v.marca,
      model: v.model || v.modelo,
      year: v.year,
      color: v.color,
      licensePlate: v.licensePlate || v.patente,
      photoUri: v.photoUri || v.fotoVehiculoUri,
      isPrimary: v.isPrimary,
      isActive: v.isActive,
      userId: v.userId,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      ...(v.type === 'CAR' && { doors: v.doors }),
      ...(v.type === 'MOTORCYCLE' && { cylinderCapacity: v.cylinderCapacity, mileage: v.mileage }),
      ...(v.type === 'BICYCLE' && {
        frameSerialNumber: v.frameSerialNumber,
        hasElectricMotor: v.hasElectricMotor,
        frameSize: v.frameSize,
      }),
    };
  }

  async listByUser(userId: string) {
    const vehicles = (await this.repo.listActiveByUser(userId)).map((v) => this.map(v));
    return { success: true, vehicles, count: vehicles.length };
  }

  async getOne(userId: string, vehicleId: string) {
    const v = await this.repo.getById(vehicleId);
    if (!v) throw new NotFoundException({ success: false, message: 'Vehículo no encontrado' });
    if (v.userId !== userId) {
      throw new ForbiddenException({ success: false, message: 'No tienes permisos para acceder a este vehículo' });
    }
    return { success: true, vehicle: this.map(v) };
  }

  async upsert(body: Record<string, any>) {
    if (!body.userId) throw new BadRequestException({ success: false, message: 'userId es requerido' });
    if (!body.type || !VALID_TYPES.includes(body.type)) {
      throw new BadRequestException({ success: false, message: 'Tipo de vehículo inválido' });
    }

    const now = Date.now();

    if (body.id) {
      const existing = await this.repo.getById(body.id);
      if (!existing) {
        // La app genera el id (UUID) ANTES de guardar: un id desconocido es un ALTA con id
        // propio, no un error. (El 404 de acá rompía la creación de vehículos en silencio.)
        const active = await this.repo.listActiveByUser(body.userId);
        const newVehicle = { ...body, createdAt: now, updatedAt: now, isActive: true, isPrimary: active.length === 0 };
        await this.repo.createWithId(body.id, newVehicle);
        await this.audit.record({ actorUid: body.userId, action: 'vehicle_created', details: { vehicleId: body.id, type: body.type } });
        return { success: true, message: 'Vehículo creado', vehicle: newVehicle };
      }
      if (existing.userId !== body.userId) {
        throw new ForbiddenException({ success: false, message: 'No tienes permisos para editar este vehículo' });
      }
      const updateData = {
        ...body,
        updatedAt: now,
        createdAt: existing.createdAt,
        isActive: body.isActive !== undefined ? body.isActive : existing.isActive,
        isPrimary: body.isPrimary !== undefined ? body.isPrimary : existing.isPrimary,
      };
      await this.repo.update(body.id, updateData);
      await this.audit.record({ actorUid: body.userId, action: 'vehicle_updated', details: { vehicleId: body.id, type: body.type } });
      return { success: true, message: 'Vehículo actualizado', vehicle: { id: body.id, ...updateData } };
    }

    const active = await this.repo.listActiveByUser(body.userId);
    const newVehicle = { ...body, createdAt: now, updatedAt: now, isActive: true, isPrimary: active.length === 0 };
    const id = await this.repo.create(newVehicle);
    await this.audit.record({ actorUid: body.userId, action: 'vehicle_created', details: { vehicleId: id, type: body.type } });
    return { success: true, message: 'Vehículo creado', vehicle: { id, ...newVehicle } };
  }

  async remove(userId: string, vehicleId: string) {
    const v = await this.repo.getById(vehicleId);
    if (!v) throw new NotFoundException({ success: false, message: 'Vehículo no encontrado' });
    if (v.userId !== userId) {
      throw new ForbiddenException({ success: false, message: 'No tienes permisos para eliminar este vehículo' });
    }
    await this.repo.update(vehicleId, { isActive: false, updatedAt: Date.now() });
    await this.audit.record({ actorUid: userId, action: 'vehicle_deleted', details: { vehicleId } });
    return { success: true, message: 'Vehículo eliminado correctamente' };
  }

  async setPrimary(userId: string, vehicleId: string | undefined) {
    if (!vehicleId) throw new BadRequestException({ success: false, message: 'vehicleId es requerido' });
    const v = await this.repo.getById(vehicleId);
    if (!v) throw new NotFoundException({ success: false, message: 'Vehículo no encontrado' });
    if (v.userId !== userId) {
      throw new ForbiddenException({ success: false, message: 'No tienes permisos para este vehículo' });
    }
    await this.repo.setPrimary(userId, vehicleId);
    return { success: true, message: 'Vehículo primario actualizado' };
  }

  async uploadPhoto(body: Record<string, any>) {
    const { userId, vehicleId, imageData } = body;
    if (!userId || !vehicleId || !imageData || !isDataUrl(imageData)) {
      throw new BadRequestException({
        success: false,
        message: 'Datos inválidos: userId, vehicleId e imageData son requeridos',
      });
    }
    const v = await this.repo.getById(vehicleId);
    if (!v) throw new NotFoundException({ success: false, message: 'Vehículo no encontrado' });
    if (v.userId !== userId) {
      throw new ForbiddenException({ success: false, message: 'No tienes permisos para este vehículo' });
    }

    const url = await this.savePhoto(userId, vehicleId, imageData);
    await this.repo.update(vehicleId, { photoUri: url, updatedAt: Date.now() });
    await this.audit.record({ actorUid: userId, action: 'vehicle_photo_uploaded', details: { vehicleId } });
    return { success: true, message: 'Foto de vehículo subida correctamente', url };
  }

  private async savePhoto(userId: string, vehicleId: string, imageData: string): Promise<string> {
    // Upload unificado (D5).
    const ext = getMimeFromDataUrl(imageData).split('/')[1] || 'jpg';
    const { url } = await this.storage.uploadDataUrl({
      dataUrl: imageData,
      pathPrefix: `vehicles/${userId}`,
      fileName: `${vehicleId}_${Date.now()}_${uuidv4()}.${ext}`,
      makePublic: true,
      cacheControl: 'public, max-age=31536000',
    });
    return url as string;
  }
}
