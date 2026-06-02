# Backend AlRescate (NestJS) — imagen de producción, multi-stage.
# Las credenciales NO se hornean: se pasan por env var en el deploy (ver DEPLOYMENT.md).

# ---- build: compila con devDependencies ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: solo dependencias de producción + dist ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# El host inyecta PORT; el server escucha en process.env.PORT || 8080.
EXPOSE 8080
CMD ["node", "dist/main.js"]
