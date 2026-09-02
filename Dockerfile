FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY .env.example ./

COPY start.sh /app/start.sh

RUN chmod +x /app/start.sh

ENV CLOUDSTREAM_RUNTIME_PORT=10001
ENV CLOUDSTREAM_RUNTIME_TIMEOUT=120000

EXPOSE 3000

CMD ["/app/start.sh"]
