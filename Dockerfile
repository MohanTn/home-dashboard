FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js apps.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
