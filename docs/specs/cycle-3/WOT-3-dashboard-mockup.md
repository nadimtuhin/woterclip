# WoterClip Web Dashboard — Mockup Spec

## Overview
Interactive React-based dashboard for visualizing WoterClip orchestration state, issue workload, and persona activity. Provides real-time insights into heartbeat execution, bottlenecks, and team capacity.

## Component Architecture

### 1. **Dashboard Layout** (root container)
- Header: Project name, last heartbeat timestamp, current cycle #
- Sidebar: Navigation, filter controls
- Main content area: Grid of widgets (responsive)
- Footer: Status indicator (connected/disconnected from backend)

### 2. **Header Widget**
```
┌─ WoterClip Dashboard ───────────────────────┐
│ Project: woterclip | Cycle #3 | 2h 15m ago │
│ Backend: SQLite | Max Parallel: 2           │
└─────────────────────────────────────────────┘
```
Props: project name, heartbeat number, last run timestamp, backend type

### 3. **Issue Overview Panel**
Table with columns:
- Issue ID (clickable, expands details)
- Title
- State (badge: backlog/todo/in_progress/in_review/done/canceled)
- Persona assigned
- Priority (1–5 scale)
- Age (time since created_at)
- Last update (human-readable: "2h ago")

Filtering:
- State dropdown
- Persona dropdown
- Priority slider
- Search by title

### 4. **Persona Workload Card** (per persona)
```
┌─ Frontend Persona ─────────────────────┐
│ In Progress: 2 | Blocked: 1 | Done: 5  │
│ Capacity: ███████░░ (70% utilized)     │
│ Avg Time/Issue: 2.5h                   │
│ Next Issue: WOT-8 (React component)    │
└────────────────────────────────────────┘
```
Props: persona name, in_progress count, blocked count, done count, utilization %, avg time, next assigned

### 5. **Heartbeat Timeline**
Vertical timeline showing last 5 heartbeats:
- Cycle #3: ✓ 45 min ago | 4 issues processed | 2 issues in_review
- Cycle #2: ✓ 1.5h ago | 3 issues processed | 1 escalation
- Cycle #1: ✓ 2.5h ago | 2 issues processed

Click to expand: show detailed persona breakdown per cycle

### 6. **Issue Detail Modal** (opened from table)
- Issue title, description, full state
- Current persona assigned
- Comments thread (agent + human)
- State transition history
- Parent/child relationships (if any)
- Edit form: update title, description, priority, reassign persona

### 7. **Metrics Summary** (mini cards)
- Total issues: 10
- Completion rate: 50%
- Avg time per issue: 2h 30m
- Personas active: 4/6
- Last heartbeat duration: 45m

### 8. **Bottleneck Alert** (if issues exist)
```
⚠️  2 issues blocked for >2h
    - WOT-2: Waiting for architect review
    - WOT-7: Insufficient context
```
Click to jump to issue.

## Data Flow

1. **Fetch state:** `GET /api/dashboard/state` → returns issue list, persona workload, last heartbeat info
2. **Refresh interval:** Auto-refresh every 30s (configurable)
3. **Mutations:** Issue updates (state, persona, priority) POST back to backend
4. **WebSocket (future):** Real-time heartbeat notifications

## Styling
- Theme: Dark mode (WoterClip brand colors)
- Layout: CSS Grid for responsiveness
- Charts: Recharts or Chart.js for workload visualization
- Tables: Tanstack React Table for sorting/filtering

## File Structure
```
components/
  ├── Dashboard.jsx (root)
  ├── Header.jsx
  ├── Sidebar.jsx
  ├── IssueTable.jsx
  ├── IssueDetailModal.jsx
  ├── PersonaWorkloadCard.jsx
  ├── HeartbeatTimeline.jsx
  ├── MetricsSummary.jsx
  ├── BottleneckAlert.jsx
  └── styles.css

hooks/
  ├── useDashboardState.js (fetch + refresh)
  └── useIssueUpdate.js (mutations)

api/
  └── dashboardApi.js (fetch/POST helpers)

types/
  └── dashboard.d.ts (TypeScript interfaces)
```

## API Contract

### GET /api/dashboard/state
Returns:
```json
{
  "issues": [
    {
      "id": 3,
      "title": "Build web dashboard",
      "state": "in_review",
      "persona": "frontend",
      "priority": 3,
      "created_at": "2026-05-20T10:00:00Z",
      "updated_at": "2026-05-21T15:30:00Z"
    }
  ],
  "personas": [
    {
      "name": "frontend",
      "in_progress": 2,
      "blocked": 0,
      "done": 5,
      "capacity_pct": 70
    }
  ],
  "heartbeat": {
    "number": 3,
    "last_run": "2026-05-21T15:30:00Z",
    "duration_seconds": 2700,
    "issues_processed": 4
  },
  "backend": "sqlite"
}
```

## Future Enhancements
1. WebSocket real-time updates during heartbeat
2. Persona drill-down: view persona SOUL.md, TOOLS.md, skill assignments
3. Issue dependency graph visualization
4. Custom dashboard layouts (user-saved filters)
5. Export metrics to PDF/CSV
6. Audit log viewer (state change history)
