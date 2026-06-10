# Backend AlRescate (NestJS) + panel admin servido en /panel. Un solo deploy, una sola URL.
# Las credenciales del SERVIDOR no se hornean (van por env var en el deploy, ver DEPLOYMENT.md).
# La config WEB de Firebase del PANEL sí se hornea al compilar (build args VITE_FIREBASE_*),
# porque el panel es estático: necesita esos valores adentro del bundle.

# ---- 1) build del PANEL (frontend estático) ----
FROM node:22-alpine AS panel
WORKDIR /panel
COPY admin-panel/package*.json ./
RUN npm ci
COPY admin-panel/ ./
# Config web de Firebase para el build del panel (pasar como --build-arg en el deploy):
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
# (.env.production ya fija VITE_API_URL="" = mismo origen, y VITE_USE_EMULATOR=false)
RUN npm run build

# ---- 2) build del BACKEND ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 3) runtime: deps de prod + dist del backend + panel compilado ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# El panel compilado donde main.ts lo busca (admin-panel/dist) → se sirve en /panel.
COPY --from=panel /panel/dist ./admin-panel/dist
# Sin privilegios de root en runtime (la imagen node trae el usuario "node").
RUN chown -R node:node /app
USER node
EXPOSE 8080
# El orquestador (Cloud Run/Render/Docker) detecta un container muerto vía /health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
