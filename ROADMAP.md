# WoterClip Roadmap

High-level features and improvements planned for WoterClip.

## Current State

**Stable (v1.0)**
- SQLite and Linear backends
- 9 personas (orchestrator, CEO, architect, QA, backend, frontend, infra, backlog-groomer, loop)
- Heartbeat system with parallel issue processing (max_parallel)
- Goal injection for persona guidance
- Webhook integrations (Phase 1)
- Full-text search (FTS5)
- Comprehensive schema documentation

## In Progress

- **Phase 2: Webhook Infrastructure** (WOT-11, WOT-22)
  - Async webhook receiver deployment
  - Redis queue integration for reliability
  - Event replay API for recovery
  - Observability and metrics

- **Observability** (WOT-4, WOT-14, WOT-23)
  - Heartbeat telemetry collection
  - Metrics dashboard
  - Query patterns for analysis

## Planned (Next Quarter)

### v1.1 — Web Dashboard
- Issue visualization and management UI
- Real-time heartbeat monitoring
- Custom persona creator interface
- Webhook event browser

### v1.2 — Advanced Features
- Multi-repo orchestration
- Cross-team collaboration
- Custom workflow states
- Persona composition (inheritance/mixins)

### v1.3 — Production Readiness
- Horizontal scaling (multi-worker heartbeat)
- Data retention policies
- Audit log export
- Role-based access control

## Future (Roadmap Items)

- **v2.0** — AI-native task decomposition
  - Automatic subtask generation
  - Dependency resolution
  - Effort estimation

- **Cloud Hosting** — Managed WoterClip service
  - Multi-tenant SaaS
  - GitHub App integration
  - Pre-built personas library

## Contributing

Want to help? Check `CONTRIBUTING.md` for how to get started.

Issues are tracked in [Linear](https://linear.app) (WoterClip project). See [CLAUDE.md](./CLAUDE.md) for architecture context.
