FROM node:18-alpine

WORKDIR /app

# Copy application files
COPY listener-implementation-node.js ./listener.js
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if(r.statusCode!=200)throw new Error()})" || exit 1

EXPOSE 3000

CMD ["node", "listener.js"]
