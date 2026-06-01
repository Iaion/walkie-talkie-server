/**
 * main.ts
 * Bootstrap de la app NestJS de AlRescate. Escucha en PORT (8080 por defecto), igual que el
 * monolito, para que el mismo harness de tests pueda apuntarle.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // Límite alto para fotos/audio en base64 (igual que el monolito: 25mb)
  app.useBodyParser('json', { limit: '25mb' });

  const port = process.env.PORT || 8080;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 AlRescate NestJS corriendo en puerto ${port}`);
}

bootstrap();
