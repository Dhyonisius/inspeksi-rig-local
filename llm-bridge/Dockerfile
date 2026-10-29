# Tanpa dependensi npm: hanya node:alpine + server.js.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# OpenShift menjalankan UID acak; 1001 aman karena tidak ada berkas yang perlu ditulis.
USER 1001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
