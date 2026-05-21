# HTTP Listener Deployment Guide

**Date:** 2026-05-21  
**Author:** Backend Persona (Cycle 25)  
**Related Issue:** WOT-13 (HTTP listener + queue infrastructure)

## Overview

This guide covers deploying the WoterClip HTTP Listener in production environments. The listener receives webhook events from GitHub and Linear, deduplicates them, and triggers heartbeat cycles.

## Quick Start (Local Development)

### Prerequisites
- Node.js 18+ (or Docker)
- Claude CLI installed and configured
- Webhook receiver URL (for production: public HTTPS endpoint)

### Installation

```bash
# Clone/navigate to WoterClip plugin directory
cd /path/to/woterclip

# Install dependencies
npm install express uuid

# Copy the listener implementation
cp references/listener-implementation-node.js ./listener.js

# Configure environment
export WEBHOOK_LISTENER_PORT=3000
export CLAUDE_PLUGIN_ROOT=/path/to/woterclip
export NODE_ENV=development

# Run listener
node listener.js
```

### Health Check

```bash
curl http://localhost:3000/health
# Expected response:
# {"status":"ok","uptime_ms":1234,"queue_depth":0,"timestamp":"2026-05-21T..."}
```

## Production Deployment

### Option A: AWS Lambda (Serverless)

**Pros:** Auto-scaling, minimal ops, pays only for execution  
**Cons:** Cold starts (~5s), function size limit (250MB code)

**Setup:**
1. Install Serverless Framework: `npm install -g serverless`
2. Create `serverless.yml`:
   ```yaml
   service: woterclip-listener
   provider:
     name: aws
     runtime: nodejs18.x
     environment:
       WEBHOOK_LISTENER_PORT: 3000
       CLAUDE_PLUGIN_ROOT: /opt/plugin
   functions:
     listener:
       handler: listener.handler
       events:
         - http:
             path: webhooks
             method: post
   ```
3. Deploy: `serverless deploy`
4. Copy plugin to Lambda layer: `pip install lambda-layer-builder && layer-pack`

**Webhook URL:** https://{api-id}.execute-api.{region}.amazonaws.com/dev/webhooks

### Option B: Docker Container (Self-Hosted)

**Pros:** Full control, no cold starts, portable  
**Cons:** Requires infrastructure (EC2, Kubernetes), ops overhead

**Dockerfile:**
```dockerfile
FROM node:18-alpine
WORKDIR /app

# Copy listener and dependencies
COPY listener.js package.json package-lock.json ./
RUN npm ci --only=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if(r.statusCode!=200)throw new Error()})"

EXPOSE 3000
CMD ["node", "listener.js"]
```

**Run locally:**
```bash
docker build -t woterclip-listener .
docker run -p 3000:3000 \
  -e WEBHOOK_LISTENER_PORT=3000 \
  -e CLAUDE_PLUGIN_ROOT=/opt/plugin \
  woterclip-listener
```

**Deploy to Kubernetes:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: woterclip-listener
spec:
  replicas: 2
  selector:
    matchLabels:
      app: woterclip-listener
  template:
    metadata:
      labels:
        app: woterclip-listener
    spec:
      containers:
      - name: listener
        image: woterclip-listener:latest
        ports:
        - containerPort: 3000
        env:
        - name: WEBHOOK_LISTENER_PORT
          value: "3000"
        - name: CLAUDE_PLUGIN_ROOT
          value: /opt/plugin
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 2
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: woterclip-listener
spec:
  selector:
    app: woterclip-listener
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

### Option C: Cloud Run (Google Cloud)

**Pros:** Serverless, fast startup, generous free tier  
**Cons:** Vendor lock-in, pricing for CPU after invocation

**Setup:**
```bash
# Build and push container
gcloud builds submit --tag gcr.io/PROJECT_ID/woterclip-listener

# Deploy
gcloud run deploy woterclip-listener \
  --image gcr.io/PROJECT_ID/woterclip-listener \
  --platform managed \
  --region us-central1 \
  --set-env-vars WEBHOOK_LISTENER_PORT=3000
```

**Webhook URL:** https://woterclip-listener-xyz.run.app/webhooks

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBHOOK_LISTENER_PORT` | 3000 | HTTP listener port |
| `CLAUDE_PLUGIN_ROOT` | `./` | Path to WoterClip plugin directory |
| `NODE_ENV` | development | Set to `production` for minified logging |
| `DEDUP_CACHE_TTL_HOURS` | 24 | Deduplication cache TTL |
| `MAX_QUEUE_DEPTH` | 100 | Max concurrent webhooks in queue |

### Webhook URL Registration

**GitHub:**
1. Navigate to repo Settings → Webhooks → Add webhook
2. Payload URL: `https://your-listener.com/webhooks`
3. Content type: `application/json`
4. Events: `Issues`, `Issue comment`
5. Active: ✓

**Linear:**
1. Navigate to workspace Settings → Webhooks → Create
2. URL: `https://your-listener.com/webhooks`
3. Events: `Issue.created`, `Issue.updated`, `Issue.archived`
4. Active: ✓

## Monitoring

### Metrics Endpoint

```bash
curl http://localhost:3000/metrics
# Returns:
# {
#   "queue": {"total": 5, "pending": 2, "triggered": 3, "failed": 0},
#   "dedup_cache": {"size": 143, "ttl_hours": 24}
# }
```

### Logging

Production logs output to stdout (structured JSON for easy parsing):
```
[2026-05-21T10:30:45.123Z] POST /webhooks 202 45ms
[2026-05-21T10:30:46.234Z] Triggered heartbeat for event github:issue-opened-42
```

### Alerting

Set up alerts for:
- **Queue backlog:** `queue_depth > 50` (backpressure)
- **Error rate:** Webhook responses with status >= 500
- **Heartbeat failures:** Check `.woterclip/heartbeat-log.jsonl` for `status: failed`

## Troubleshooting

### Queue Full (503 responses)

**Cause:** Too many events, not being processed fast enough  
**Fix:** 
1. Increase `MAX_QUEUE_DEPTH` in listener code
2. Check if `/heartbeat` is hanging (may need timeout)
3. Scale horizontally (add more listener instances)

### Duplicate Event Rejection (409 responses)

**Cause:** Expected behavior (webhook retries, network duplicates)  
**Fix:** None. This is correct. GitHub/Linear retry policies will resolve naturally.

### Heartbeat Trigger Fails

**Cause:** Claude CLI not in PATH, plugin not found, etc.  
**Fix:**
1. Verify `CLAUDE_PLUGIN_ROOT` is set correctly
2. Check Claude CLI: `claude --version`
3. Test manually: `claude /heartbeat --plugin-dir /path/to/woterclip`

## Testing

### Load Testing

```bash
# Install k6
brew install k6

# Create test script (load-test.js)
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const payload = {
    source: 'github',
    event_id: `test-${Date.now()}-${Math.random()}`,
    event_type: 'issues.opened',
    payload: { issue_number: 42 }
  };
  
  const res = http.post('http://localhost:3000/webhooks', JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  });
  
  check(res, {
    'status 202': (r) => r.status === 202,
    'has queue_depth': (r) => r.json('queue_depth') != null
  });
}

# Run: k6 run --vus 10 --duration 30s load-test.js
```

### Integration Test

See `references/listener-integration-tests.md` for full test suite.

## Maintenance

### Regular Tasks

- **Weekly:** Check metrics endpoint for queue health
- **Monthly:** Review logs for error patterns, adjust config as needed
- **Quarterly:** Update dependencies (`npm audit`, `npm update`)

### Graceful Shutdown

The listener handles SIGTERM (e.g., during Kubernetes rolling updates):
1. Stop accepting new webhooks
2. Wait for queue to drain (up to 30s timeout)
3. Exit cleanly

No special configuration needed; built into Node.js runtime.

## Production Checklist

- [ ] HTTPS enabled (required by GitHub/Linear)
- [ ] Firewall allows inbound traffic on listener port
- [ ] Health check passing (GET /health returns 200)
- [ ] Dedup cache cleared on startup (fresh state)
- [ ] Logging/monitoring configured
- [ ] Max queue depth appropriate for workload
- [ ] Claude CLI configured with correct plugin directory
- [ ] Test webhook from GitHub/Linear (use webhook UI replay)
- [ ] Alerts configured for queue backlog and errors
- [ ] Capacity: Can handle 10 webhooks/min sustained?

## Next Steps

See WOT-13 and WOT-15 (integration tests) for E2E testing and webhook integration from GitHub/Linear endpoints.
