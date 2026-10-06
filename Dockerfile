FROM node:22-slim

WORKDIR /app

# Install build tools required for native packages
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV DATA_DIR=/data

EXPOSE 3000
CMD ["npm", "start"]
