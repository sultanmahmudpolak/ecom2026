# ==============================================================================
# StockMaster BD - Coolify & VPS Production Dockerfile (Node.js 22 + SQLite WAL)
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# Set production environment & timezone to Asia/Dhaka
ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Dhaka
ENV NODE_NO_WARNINGS=1

# Copy package manifests first for fast Docker layer caching
COPY package*.json ./

# Install dependencies (including tsx & build tooling)
RUN npm install --no-audit --no-fund

# Copy application source
COPY . .

# Build optimized React frontend & assets
RUN npm run build

# Ensure persistent volume directories exist for SQLite WAL DB and Product Uploads
RUN mkdir -p /app/data /app/uploads/products /app/uploads/logos

# Declare persistent volumes so Coolify / Docker preserves database & uploaded images across redeployments
VOLUME ["/app/data", "/app/uploads"]

EXPOSE 3000

# Built-in container healthcheck for Coolify Zero-Downtime deployments
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/db-status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the high-speed Node.js + SQLite WAL server
CMD ["npm", "start"]
