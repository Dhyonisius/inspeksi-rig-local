# Varian Ubuntu 22.04 (jammy).
# Dipilih karena kebijakan perusahaan melarang base image Debian, dan
# repositori Microsoft untuk msodbcsql18 + mssql-tools18 tersedia resmi di jammy.
#
# Node.js diambil dari tarball resmi nodejs.org dengan verifikasi SHA-256,
# bukan dari PPA pihak ketiga. Pin versi agar build reprodusibel.
FROM ubuntu:22.04

ARG ACCEPT_SQLTOOLS_EULA=N
ARG INSTALL_RIG_TRAINING=false
ARG INSTALL_VLM_TRAINING=false
ARG NODE_VERSION=22.23.4
ARG TARGETARCH=amd64

USER root

# Map arsitektur Docker ke nama arsitektur Node.js.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo >&2 "Arsitektur tidak didukung: $TARGETARCH"; exit 1 ;; \
    esac; \
    echo "$node_arch" > /tmp/node_arch; \
    printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAPT::Update::Error-Mode "any";\n' > /etc/apt/apt.conf.d/80-rig-network

# Gerbang lisensi tetap dipertahankan: build gagal bila EULA belum disetujui.
RUN set -eux; \
    if [ "$ACCEPT_SQLTOOLS_EULA" != Y ]; then \
      echo >&2 'SQL tools license approval required: set ACCEPT_SQLTOOLS_EULA=Y only after authorized approval.'; exit 1; \
    fi; \
    case "$INSTALL_RIG_TRAINING" in true|false) ;; *) echo >&2 'INSTALL_RIG_TRAINING must be true or false'; exit 1 ;; esac; \
    case "$INSTALL_VLM_TRAINING" in true|false) ;; *) echo >&2 'INSTALL_VLM_TRAINING must be true or false'; exit 1 ;; esac

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils gnupg \
      python3 python3-venv \
      libgomp1 libgl1 libglib2.0-0 libgssapi-krb5-2; \
    rm -rf /var/lib/apt/lists/*

# Node.js resmi + verifikasi checksum.
RUN set -eux; \
    node_arch="$(cat /tmp/node_arch)"; \
    cd /tmp; \
    curl -fsSLO --retry 3 --connect-timeout 30 --max-time 300 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSL --retry 3 --connect-timeout 30 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt; \
    grep " node-v${NODE_VERSION}-linux-${node_arch}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" SHASUMS256.txt; \
    node --version; npm --version

# Microsoft ODBC Driver 18 + sqlcmd (satu-satunya jalur database aplikasi).
RUN set -eux; \
    curl -fsSL --retry 3 --connect-timeout 30 --max-time 180 \
      https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -o /tmp/microsoft.deb; \
    dpkg -i /tmp/microsoft.deb; \
    rm -f /tmp/microsoft.deb; \
    apt-get update; \
    ACCEPT_EULA="$ACCEPT_SQLTOOLS_EULA" DEBIAN_FRONTEND=noninteractive \
      apt-get install -y --no-install-recommends msodbcsql18 mssql-tools18; \
    rm -rf /var/lib/apt/lists/*; \
    /opt/mssql-tools18/bin/sqlcmd -? > /dev/null 2>&1 || true

WORKDIR /app
COPY deploy/container/vlm-requirements.txt /tmp/vlm-requirements.txt
RUN set -eux; \
    if [ "$INSTALL_VLM_TRAINING" = true ]; then \
      python3 -m venv /opt/vlm; \
      /opt/vlm/bin/pip install --no-cache-dir 'torch==2.8.0' 'torchvision==0.23.0' --index-url https://download.pytorch.org/whl/cpu; \
      /opt/vlm/bin/pip install --no-cache-dir -r /tmp/vlm-requirements.txt; \
    fi

COPY deploy/container/requirements.txt /tmp/requirements.txt
RUN set -eux; \
    python3 -m venv /opt/venv; \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip; \
    /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt; \
    if [ "$INSTALL_RIG_TRAINING" = true ]; then \
      python3 -m venv /opt/training; \
      /opt/training/bin/pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu; \
      /opt/training/bin/pip install --no-cache-dir 'ultralytics>=8.3,<9' 'onnx>=1.17,<2' 'onnxruntime>=1.20,<2'; \
    fi

COPY package.json server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY sql/ ./sql/
COPY docs/work-area-catalog.json ./docs/work-area-catalog.json
RUN mkdir -p /app/data/private /app/models \
    && chgrp -R 0 /app/data /app/models \
    && chmod -R g=u /app/data /app/models

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    SQLCMD_EXE=/opt/mssql-tools18/bin/sqlcmd \
    SQL_MIGRATE_ON_START=false SQL_ENCRYPT=mandatory SQL_TRUST_SERVER_CERTIFICATE=false \
    PYTHON_EXE=/opt/venv/bin/python DETECTOR_PYTHON_EXE=/opt/training/bin/python \
    RIG_TRAINING_PYTHON_EXE=/opt/training/bin/python \
    VLM_TRAIN_PYTHON=/opt/vlm/bin/python \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
