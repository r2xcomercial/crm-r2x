# ── Stage 1: Build ─────────────────────────────────────────────────────────────
# Usa a imagem completa para compilar módulos nativos (better-sqlite3)
FROM node:20-bookworm AS builder

WORKDIR /app

# Ferramentas de compilação para módulos nativos (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Dependências de sistema para ODA File Converter (Qt6 headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    libfontconfig1 \
    libdbus-1-3 \
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# ── ODA File Converter (DWG → DXF) ─────────────────────────────────────────────
# Instala ODA File Converter para Linux x64 (54 MB, Qt6 integrado)
RUN curl -fsSL \
    "https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb" \
    -o /tmp/oda.deb \
    && dpkg -i /tmp/oda.deb \
    && rm /tmp/oda.deb \
    && ODAFileConverter --version 2>&1 || true

# Qt em modo headless (sem display) — necessário para ambiente servidor
ENV QT_QPA_PLATFORM=offscreen
ENV DISPLAY=""

# Copia node_modules compilados do stage anterior
COPY --from=builder /app/node_modules ./node_modules

# Copia código da aplicação
COPY . .

EXPOSE 4000

CMD ["node", "server.js"]
