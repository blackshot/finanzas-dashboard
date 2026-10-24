# Dashboard de finanzas: servidor estático (Bun). No contiene ni guarda datos:
# los CSV se cargan en el navegador y la configuración vive en su localStorage.
FROM oven/bun:1.4.4-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

# dependencias primero, para aprovechar la caché de capas
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts tsconfig.json ./
COPY src ./src
COPY public ./public

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["bun", "index.ts"]
