# syntax=docker/dockerfile:1
# Debian slim (glibc) rather than Alpine: Rollup's native parser overflows the
# small musl thread stack while bundling react-dom ("Code is nested too deeply").

# ---- build: install deps, typecheck, run tests, build frontend + server bundle ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm test && npm run build

# ---- runtime: production deps + built output + synthetic seed data ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/data ./server/data
# Persistent state (personas, uploaded sources, memory, decisions) lives in a volume.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.mjs"]
