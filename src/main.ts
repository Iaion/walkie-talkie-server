/**
 * main.ts
 * Bootstrap de la app NestJS de AlRescate. Escucha en PORT (8080 por defecto), igual que el
 * monolito, para que el mismo harness de tests pueda apuntarle.
 */
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOrigins } from './common/cors';
import { validateEnv } from './common/env.validation';
import { join } from 'path';
import * as fs from 'fs';

async function bootstrap(): Promise<void> {
  validateEnv();
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: corsOrigins() });
  // Límite alto para fotos/audio en base64 (igual que el monolito: 25mb)
  app.useBodyParser('json', { limit: '25mb' });
  // Validación de DTOs REST (D1): los endpoints con DTO tipado se validan/transforman;
  // los que reciben Record<string,any> (contrato del monolito) pasan sin tocar.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  // Cierre ordenado (D3): SIGTERM/SIGINT disparan onModuleDestroy/beforeApplicationShutdown
  // (el orquestador puede matar el container sin dejar sockets/writes colgados).
  app.enableShutdownHooks();

  // Si el panel admin está compilado (admin-panel/dist), el backend lo SIRVE en /panel.
  // Así queda un solo deploy y una sola URL (sin Vercel ni CORS). En dev, el panel corre
  // aparte con `npm run dev`, así que esta carpeta no existe y simplemente no se sirve.
  const panelDist = join(process.cwd(), 'admin-panel', 'dist');
  if (fs.existsSync(join(panelDist, 'index.html'))) {
    app.useStaticAssets(panelDist, { prefix: '/panel' });
    logger.log('🖥️  Panel admin servido en /panel');
  }

  const port = process.env.PORT || 8080;
  await app.listen(port);
  logger.log(`🚀 AlRescate NestJS corriendo en puerto ${port}`);
}

bootstrap();
