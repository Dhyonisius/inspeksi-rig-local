FROM node:22-bookworm-slim

# Set to Y only after your organization approves the Microsoft SQL tools license.
ARG ACCEPT_SQLTOOLS_EULA=N
ARG INSTALL_RIG_TRAINING=false
USER root
RUN test "$ACCEPT_SQLTOOLS_EULA" = Y \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv libgomp1 libgl1 libglib2.0-0 \
    && curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/microsoft.deb \
    && dpkg -i /tmp/microsoft.deb \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 mssql-tools18 \
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
    && chgrp -R 0 /app /opt/venv \
    && chmod -R g=u /app /opt/venv

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    SQLCMD_EXE=/opt/mssql-tools18/bin/sqlcmd \
    SQL_MIGRATE_ON_START=false SQL_ENCRYPT=mandatory SQL_TRUST_SERVER_CERTIFICATE=false \
    PYTHON_EXE=/opt/venv/bin/python DETECTOR_PYTHON_EXE=/opt/training/bin/python \
    RIG_TRAINING_PYTHON_EXE=/opt/training/bin/python \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
