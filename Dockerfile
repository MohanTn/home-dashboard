FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/data \
    STACKS_DIR=/stacks

# The manager shells out to `docker compose` against the host socket.
RUN apk add --no-cache docker-cli docker-cli-compose su-exec

WORKDIR /app
COPY package.json server.js apps.json docker-entrypoint.sh ./
COPY src ./src
COPY public ./public

RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app

# The entrypoint discovers the host socket group, then drops to node.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
