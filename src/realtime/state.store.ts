/**
 * state.store.ts
 * Estado EN MEMORIA compartido del realtime (réplica del objeto `state` del monolito).
 * Singleton inyectable: el Gateway y los servicios que leen estado (users/rooms/emergencies)
 * comparten esta misma instancia. Inicializa las salas por defecto al arrancar.
 *
 * Nota: es estado en memoria (no Firestore) a propósito — ubicaciones/presencia/locks viven
 * acá para no quemar cuota. Se pierde al reiniciar el server (igual que el monolito).
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

export interface ConnectedUser {
  userData: Record<string, any>;
  sockets: Set<string>;
}

export interface ChatRoom {
  id: string;
  name: string;
  type: string;
  description: string;
  users: Set<string>;
  createdAt: number;
  messageCount: number;
}

@Injectable()
export class StateStore implements OnModuleInit {
  readonly connectedUsers = new Map<string, ConnectedUser>();
  readonly emergencyAlerts = new Map<string, Record<string, any>>();
  readonly emergencyHelpers = new Map<string, Set<string>>();
  readonly chatRooms = new Map<string, ChatRoom>();
  readonly emergencyUserRoom = new Map<string, string>();

  onModuleInit(): void {
    const defaultRooms = [
      { id: 'general', name: 'Chat General', type: 'public', description: 'Sala principal para conversaciones generales' },
      { id: 'ayuda', name: 'Sala de Ayuda', type: 'public', description: 'Sala para pedir y ofrecer ayuda' },
      { id: 'handy', name: 'Modo Handy', type: 'ptt', description: 'Sala para comunicación push-to-talk' },
    ];
    const now = Date.now();
    defaultRooms.forEach((room) => {
      this.chatRooms.set(room.id, { ...room, users: new Set<string>(), createdAt: now, messageCount: 0 });
    });
  }
}
