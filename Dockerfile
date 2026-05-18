# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Copia node_modules já compilados do stage 1
COPY --from=builder /app/node_modules ./node_modules

# Copia código da aplicação
COPY . .

EXPOSE 4000

CMD ["node", "server.js"]
