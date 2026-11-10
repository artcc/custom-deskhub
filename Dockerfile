# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Production stage
FROM node:26-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_FILE=/app/data/data.json

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY . .

# Create directory for persistent data
RUN mkdir -p /app/data

# Expose port
EXPOSE 3005

# Health check
HEALTHCHECK --interval=60s --timeout=3s --start-period=5s --retries=3 \
  CMD sh -c "node -e \"require('http').get('http://localhost:' + (process.env.PORT || 3005) + '/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\""

# Run the application
CMD ["node", "index.js"]
