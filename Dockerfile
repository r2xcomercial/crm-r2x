# ── Stage 1: Build ─────────────────────────────────────────────────────────────
# Imagem completa para compilar módulos nativos (better-sqlite3)
FROM node:20-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
# Usa bookworm (não slim) para ter mais libs base disponíveis para o ODA
FROM node:20-bookworm

WORKDIR /app

# Instala libs de sistema + ODA File Converter numa única camada
# para que o apt cache esteja disponível quando o dpkg precisar de deps
RUN apt-get update \
    # Deps do sistema para Qt6 headless + pymupdf via pip
    && apt-get install -y --no-install-recommends \
        curl \
        poppler-utils \
        python3 \
        python3-pip \
        libgl1 \
        libglib2.0-0 \
        libfontconfig1 \
        libdbus-1-3 \
        libxcb1 \
        libxrender1 \
        libxi6 \
        libxext6 \
    # Instala pymupdf via pip (python3-pymupdf não existe no bookworm)
    && pip3 install --no-cache-dir pymupdf --break-system-packages \
    # Baixa e instala ODA File Converter
    && curl -fsSL \
        "https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb" \
        -o /tmp/oda.deb \
    # dpkg -i + apt-get install -f: resolve dependências faltantes automaticamente
    && dpkg -i /tmp/oda.deb; apt-get install -f -y --no-install-recommends \
    && dpkg -i /tmp/oda.deb \
    && rm /tmp/oda.deb \
    # Confirma instalação
    && ls /usr/bin/ODAFileConverter \
    && rm -rf /var/lib/apt/lists/*

# Qt headless: executa sem display (servidor Linux sem X11)
ENV QT_QPA_PLATFORM=offscreen
ENV DISPLAY=""

# Copia node_modules já compilados do stage 1
COPY --from=builder /app/node_modules ./node_modules

# Copia código da aplicação
COPY . .

EXPOSE 4000

CMD ["node", "server.js"]
