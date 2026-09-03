/**
 * vehicles.repository.ts
 * Encapsula TODO el acceso a Firestore de vehículos (colección "vehicles").
 * El service nunca toca db.collection() directo (convención de ARQUITECTURA.md) — así, migrar
 * a Postgres en el futuro toca solo esta clase.
 */
import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class VehiclesRepository {
  constructor(private readonly firebase: FirebaseService) {}

  private get col() {
    return this.firebase.firestore.collection('vehicles');
  }

  async getById(id: string): Promise<Record<string, any> | null> {
    const doc = await this.col.doc(id).get();
    return doc.exists ? { id: doc.id, ...(doc.data() as Record<string, any>) } : null;
  }

  async listActiveByUser(userId: string): Promise<Record<string, any>[]> {
    const snap = await this.col
      .where('userId', '==', userId)
      .where('isActive', '==', true)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
  }

  async create(data: Record<string, any>): Promise<string> {
    const ref = await this.col.add(data);
    return ref.id;
  }

  /** Crea con un id ELEGIDO por el cliente (la app genera UUID antes de guardar). */
  async createWithId(id: string, data: Record<string, any>): Promise<void> {
    await this.col.doc(id).set(data);
  }

  async update(id: string, data: Record<string, any>): Promise<void> {
    await this.col.doc(id).update(data);
  }

 /** Pone isPrimary=false a todos los primarios del usuario
 *  y isPrimary=true al elegido.
 */
async setPrimary(userId: string, vehicleId: string): Promise<void> {
  const batch = this.firebase.firestore.batch();

  const currentPrimary = await this.col
    .where('userId', '==', userId)
    .where('isPrimary', '==', true)
    .get();

  const now = Date.now();

  currentPrimary.docs.forEach((d) => {
    batch.update(d.ref, {
      isPrimary: false,
      updatedAt: now,
    });
  });

  batch.update(this.col.doc(vehicleId), {
    isPrimary: true,
    updatedAt: now,
  });

  await batch.commit();
}}
