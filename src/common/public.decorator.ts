/**
 * public.decorator.ts
 * Marca un endpoint como PÚBLICO (sin auth). Lo lee el AuthGuard global para exentarlo.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
