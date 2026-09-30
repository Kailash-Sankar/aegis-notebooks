# ADR 0003: Isolate the Pi runner in a container from day one

- Status: Accepted
- Date: 2026-09-29

## Context

The Pi agent executes model-generated shell commands (`duckdb-cli`, `jq`,
`grep`, Node) inside a workspace. Pi's own security guidance is explicit:
generated commands run with the permissions of the process, are not
approval-gated, and approval prompts do not create a security boundary.
Uploaded data can carry prompt injection.

A web UI that lets a user (or injected content) drive shell tools is remote
code execution by design. The safety has to come from an OS/virtualization
boundary, not from a "shell safety layer" tool.

## Decision

Run the runner and Pi inside a **Docker container**. The container is the
security boundary.

**Phase 1 (MVP):** one container for the whole application. Pi runs inside it
with `cwd = /workspaces/{workspace_id}`. The container is the boundary; no
per-workspace orchestration yet.

**Phase 2:** one container per *active* workspace, created lazily by the runner
and torn down on idle. Workspace directory bind-mounted at a fixed path.

### Hardening (Docker flags, not application code)

- non-root user; read-only root filesystem; `--tmpfs /tmp`
- mount **only** the workspace directory — never `~/.pi/agent`, never the
  Docker socket
- network egress allowlisted to the model endpoint only
- `--pids-limit`, `--memory`, `--cpus`, disk quota on the workspace volume
- scoped, short-lived credentials; prefer keeping the real key outside the
  sandbox and proxying it

### Explicitly not built

- A command approval/safety layer inside the app. It is not a boundary and
  wastes effort that belongs on the container.

## Consequences

### Positive
- A real boundary against arbitrary generated commands.
- Matches Pi's documented "plain Docker" model; minimal custom code.
- Per-workspace isolation is a deployment change later, not a rewrite.

### Negative / costs
- The "just run it locally" story becomes "run a local container".
- Container lifecycle, cold starts, and resource limits must be managed
  (Phase 2).
- Credentials must be routed deliberately; no ambient host env.

## Alternatives considered

- **Run Pi directly on the host with a dedicated OS user.** Weak: shares OS and
  network with the user; no filesystem boundary.
- **Approval prompts / transcript review.** Rejected per Pi's own docs.
- **Docker Sandboxes / OpenShell with credential proxying.** Good future
  option (keeps the real provider key on the host); deferred, not required for
  the MVP boundary.
