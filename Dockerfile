# OpenShift runtime: Ubuntu 22.04 is the only image used in this build.
# Install the official Node.js Linux binary directly; no Debian image/stage.
FROM ubuntu:22.04
ARG NODE_VERSION=22.23.4
ARG ACCEPT_SQLTOOLS_EULA=N
ARG INSTALL_RIG_TRAINING=true
USER root
# Public organizational CA certificates only; never copy keys or credentials.
COPY deploy/container/ca/ /usr/local/share/ca-certificates/
RUN test "$ACCEPT_SQLTOOLS_EULA" = Y \
    || { echo >&2 'Microsoft SQL tools license approval required: ACCEPT_SQLTOOLS_EULA=Y'; exit 1; }
# Bootstrap trust using Ubuntu's signed package repositories. Keep APT signature
# checks enabled; switch the repository transport to HTTPS once CA roots exist.
RUN set -eu; \
    test "$(dpkg --print-architecture)" = amd64; \
    case "$INSTALL_RIG_TRAINING" in true|false) ;; *) echo >&2 'INSTALL_RIG_TRAINING must be true or false'; exit 1;; esac; \
    case "$NODE_VERSION" in 22.*) ;; *) echo >&2 'NODE_VERSION must be a Node.js 22 release'; exit 1;; esac; \
    printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAPT::Update::Error-Mode "any";\n' > /etc/apt/apt.conf.d/80-rig-network; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates; \
    update-ca-certificates; \
    find /etc/apt -type f \( -name '*.sources' -o -name '*.list' \) \
      -exec sed -i -e 's|http://archive.ubuntu.com/|https://archive.ubuntu.com/|g' \
                   -e 's|http://security.ubuntu.com/|https://security.ubuntu.com/|g' {} +; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl xz-utils python3 python3-venv libstdc++6 libatomic1 \
      libgomp1 libgl1 libglib2.0-0 libgssapi-krb5-2; \
    node_archive="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    node_url="https://nodejs.org/dist/v${NODE_VERSION}"; \
    curl --fail --show-error --silent --location --retry 3 --connect-timeout 30 --max-time 300 \
      "$node_url/$node_archive" -o "/tmp/$node_archive"; \
    curl --fail --show-error --silent --location --retry 3 --connect-timeout 30 --max-time 180 \
      "$node_url/SHASUMS256.txt" -o /tmp/node-SHASUMS256.txt; \
    cd /tmp; \
    awk -v archive="$node_archive" '$2 == archive { print }' node-SHASUMS256.txt > node-SHASUMS256.selected; \
    test "$(wc -l < node-SHASUMS256.selected)" -eq 1; \
    sha256sum --check node-SHASUMS256.selected; \
    tar -xJf "$node_archive" -C /usr/local --strip-components=1 --no-same-owner; \
    cd /; \
    test "$(node --version)" = "v$NODE_VERSION"; \
    npm --version; \
    rm -f "/tmp/$node_archive" /tmp/node-SHASUMS256.txt /tmp/node-SHASUMS256.selected; \
    curl --fail --show-error --silent --location --retry 3 --connect-timeout 30 --max-time 180 \
      https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -o /tmp/microsoft.deb; \
    dpkg -i /tmp/microsoft.deb; \
    apt-get update; \
    ACCEPT_EULA="$ACCEPT_SQLTOOLS_EULA" DEBIAN_FRONTEND=noninteractive \
      apt-get install -y --no-install-recommends msodbcsql18 mssql-tools18; \
    /opt/mssql-tools18/bin/sqlcmd -? >/dev/null; \
    rm -f /tmp/microsoft.deb; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/container/requirements*.txt /tmp/
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && /opt/venv/bin/pip check \
    && if [ "$INSTALL_RIG_TRAINING" = true ]; then \
         python3 -m venv /opt/training \
         && /opt/training/bin/pip install --no-cache-dir 'torch==2.8.0' 'torchvision==0.23.0' --index-url https://download.pytorch.org/whl/cpu \
         && /opt/training/bin/pip install --no-cache-dir -r /tmp/requirements-training.txt \
         && /opt/training/bin/pip check; \
       fi

COPY package.json server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY sql/ ./sql/
COPY docs/work-area-catalog.json ./docs/work-area-catalog.json
RUN mkdir -p /app/data/private /app/models \
    && chgrp -R 0 /app/data /app/models \
    && chmod -R g=u /app/data /app/models \
    && /opt/venv/bin/python scripts/container-smoke.py \
    && if [ "$INSTALL_RIG_TRAINING" = true ]; then \
         /opt/training/bin/python scripts/container-smoke.py --training \
         && /opt/training/bin/python scripts/detector_worker.py --probe; \
       fi

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    SQLCMD_EXE=/opt/mssql-tools18/bin/sqlcmd \
    SQL_MIGRATE_ON_START=false SQL_ENCRYPT=mandatory SQL_TRUST_SERVER_CERTIFICATE=false \
    PYTHON_EXE=/opt/venv/bin/python DETECTOR_PYTHON_EXE=/opt/training/bin/python \
    RIG_TRAINING_PYTHON_EXE=/opt/training/bin/python \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache MPLCONFIGDIR=/tmp/matplotlib \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    YOLO_AUTOINSTALL=False YOLO_OFFLINE=true
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
