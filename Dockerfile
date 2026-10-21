FROM node:22-bookworm-slim

# Set to Y only after your organization approves the Microsoft SQL tools license.
ARG ACCEPT_SQLTOOLS_EULA=N
ARG INSTALL_RIG_TRAINING=false
USER root
RUN if [ "$ACCEPT_SQLTOOLS_EULA" != Y ]; then \
      echo >&2 'SQL tools license approval required: set ACCEPT_SQLTOOLS_EULA=Y only after authorized approval.'; exit 1; \
    fi \
    && case "$INSTALL_RIG_TRAINING" in true|false) ;; *) echo >&2 'INSTALL_RIG_TRAINING must be true or false'; exit 1;; esac \
    # Bootstrap HTTPS trust from Node's bundled CA set if the slim image lacks it.
    && node -e 'const fs=require("fs");const p="/etc/ssl/certs/ca-certificates.crt";if(!fs.existsSync(p)){fs.mkdirSync("/etc/ssl/certs",{recursive:true});fs.writeFileSync(p,require("tls").rootCertificates.join("\n")+"\n")}' \
    # Handle both deb822 (.sources) and legacy (.list) Debian definitions.
    && find /etc/apt -type f \( -name '*.sources' -o -name '*.list' \) \
       -exec sed -i -e 's|http://deb.debian.org/|https://deb.debian.org/|g' \
                    -e 's|http://security.debian.org/|https://security.debian.org/|g' {} + \
    && printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAPT::Update::Error-Mode "any";\n' > /etc/apt/apt.conf.d/80-rig-network \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv libgomp1 libgl1 libglib2.0-0 libgssapi-krb5-2 \
    && curl --fail --show-error --silent --location --retry 3 --connect-timeout 30 --max-time 180 https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/microsoft.deb \
    && dpkg -i /tmp/microsoft.deb \
    && apt-get update \
    && ACCEPT_EULA="$ACCEPT_SQLTOOLS_EULA" DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends msodbcsql18 mssql-tools18 \
    && rm -f /tmp/microsoft.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/container/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && if [ "$INSTALL_RIG_TRAINING" = true ]; then \
         python3 -m venv /opt/training \
         && /opt/training/bin/pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
         && /opt/training/bin/pip install --no-cache-dir 'ultralytics>=8.3,<9' 'onnx>=1.17,<2' 'onnxruntime>=1.20,<2'; \
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
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
