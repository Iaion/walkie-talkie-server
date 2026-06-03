/**
 * main.ts
 * Bootstrap de la app NestJS de AlRescate. Escucha en PORT (8080 por defecto), igual que el
 * monolito, para que el mismo harness de tests pueda apuntarle.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // Límite alto para fotos/audio en base64 (igual que el monolito: 25mb)
  app.useBodyParser('json', { limit: '25mb' });

  // Si el panel admin está compilado (admin-panel/dist), el backend lo SIRVE en /panel.
  // Así queda un solo deploy y una sola URL (sin Vercel ni CORS). En dev, el panel corre
  // aparte con `npm run dev`, así que esta carpeta no existe y simplemente no se sirve.
  const panelDist = join(process.cwd(), 'admin-panel', 'dist');
  if (fs.existsSync(join(panelDist, 'index.html'))) {
    app.useStaticAssets(panelDist, { prefix: '/panel' });
    // eslint-disable-next-line no-console
    console.log('🖥️  Panel admin servido en /panel');
  }

  const port = process.env.PORT || 8080;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 AlRescate NestJS corriendo en puerto ${port}`);
}

bootstrap();
