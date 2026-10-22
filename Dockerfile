
FROM ubuntu:24.04

ARG ACCEPT_SQLTOOLS_EULA=N

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg python3 python3-venv \
    libgomp1 libgl1 libglib2.0-0 xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Microsoft SQL tools
RUN test "$ACCEPT_SQLTOOLS_EULA" = Y \
    && curl -fsSL \
       https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb \
       -o /tmp/microsoft.deb \
    && dpkg -i /tmp/microsoft.deb \
    && ACCEPT_EULA=Y apt-get update \
    && ACCEPT_EULA=Y apt-get install -y \
       msodbcsql18 mssql-tools18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deploy/container/requirements.txt /tmp/requirements.txt

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
       -r /tmp/requirements.txt

COPY package.json server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY sql/ ./sql/
COPY docs/work-area-catalog.json ./docs/work-area-catalog.json

RUN mkdir -p /app/data/private /app/models \
    && chgrp -R 0 /app /opt/venv \
    && chmod -R g=u /app /opt/venv

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SQLCMD_EXE=/opt/mssql-tools18/bin/sqlcmd \
    SQL_MIGRATE_ON_START=false \
    SQL_ENCRYPT=mandatory \
    SQL_TRUST_SERVER_CERTIFICATE=false \
    PYTHON_EXE=/opt/venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

EXPOSE 8080

USER 1001

CMD ["node", "server.js"]
