/**
 * roles.decorator.ts
 * Marca un endpoint como exclusivo de ciertos roles (custom claims de Firebase Auth).
 * Lo lee el RolesGuard. Ej: @Roles('admin').
 */
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
