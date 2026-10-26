# NodeScape build plan

Status: draft for owner approval. Architecture independently reviewed.
Owner principles: YAGNI / minimal code, keep the current visual design, test-driven development,
very thorough testing, no personal data in the repo (use made-up hosts and paths).

## Goal

Turn the prototype into a complete desktop app: no demo data in production, first-run onboarding,
multiple servers, files, terminal, services, users and network, all over plain SSH with nothing
installed on the server.

## Key decisions

| Area | Decision | Why | Not doing |
|---|---|---|---|
| Transport | Keep the system `ssh`; short reads spawn `ssh` per call with an overall deadline (15 s) | Honours the user's ssh config, keys, agent, known_hosts, HostKeyAlias, ProxyJump with zero parsing | A Rust SSH client (russh/libssh2): would need its own config, agent and trust handling |
| Latency (Windows has no ControlMaster) | Batch reads per page, poll only the visible page, cap concurrent calls per server | Each call pays a handshake | Remote daemon or agent |
| Files | SFTP protocol via `russh-sftp` running over `ssh -s sftp` stdin/stdout; one browsing session, one child per transfer | Structured listings, byte progress, cancel, without parsing `sftp` CLI text | Parsing `sftp`/`scp` output |
| Terminal | `portable-pty` (ConPTY on Windows) around `ssh -tt`; xterm.js + fit addon vendored locally | Same auth/config as everything else; real PTY for htop, resize, Ctrl+C | Library PTY channel |
| Host keys | Normal operations refuse unknown/changed keys; first contact is approved by the user inside an embedded terminal showing OpenSSH's own fingerprint prompt | The approval applies to the key actually presented | accept-new, ssh-keyscan trust, auto-deleting known_hosts lines |
| SSH config | Let OpenSSH evaluate it (`ssh -G` to inspect). New profiles go to an app-owned config file that the user's config is not rewritten by | No config parser to maintain | Full config editor |
| Sudo | Fixed, validated commands with `sudo -S -k`; password typed per action, sent once over stdin, never stored or logged | No args, files, history or cached credentials | Stored passwords, NOPASSWD setup |
| Frontend | Native ES modules, one file per page, one backend adapter, existing CSS | Enough structure for ~11 pages | Framework, bundler, state library |
| Demo data | Moves to `tests/fixtures/`; production has no demo fallback. No backend = clear error | Owner request | Hidden demo flag |
| Tauri security | Command ACL in capabilities, strict CSP, validate again in Rust | Commands are open to the webview by default | Relying on frontend validation |

## Target layout

Backend `src-tauri/src/`: `main.rs` (thin), `contracts.rs` (DTOs, validated ids, errors),
`profiles.rs`, `ssh_config.rs`, `transport.rs` (process ownership, deadlines, cancel),
`onboarding.rs`, `terminal.rs`, `files.rs`, `transfers.rs`, `system.rs`, `journal.rs`,
`services.rs`, `sudo.rs`, `accounts.rs`, `network.rs`, `scripts/*.sh` (embedded collectors).

Frontend `src/`: `app.js` (routes), `backend.js` (only Tauri adapter), `state.js`,
`ui/` (dom, dialogs, charts, terminal, sudo), `pages/` (onboarding, servers, overview, services,
processes, logs, scheduled, files, terminal, accounts, network), `style.css` + `styles/`,
`vendor/xterm/`, `fonts/`.

Rules: no arbitrary shell-execution command outside the interactive terminal; every response is
tagged with profile + request id and stale ones are dropped before they touch state; missing data
shows as unavailable, never as zero; mutations are never auto-retried (disconnect = "outcome unknown").

## Work packages

Each package: write failing tests first, then implement; owns only its listed files.

| Id | Package | Depends on | Effort |
|---|---|---|---|
| P01 | Contracts: DTOs, errors, module/route slots, `docs/contracts.md` | – | medium |
| P02 | Transport: deadlines, cancel, no pipe deadlocks, config paths with spaces, strict trust on every hop; spike SFTP-over-ssh and ConPTY on Windows | P01 | xhigh |
| P03 | Frontend modules, remove demo from `src/`, fixture-based tests over a local HTTP server, stale-response fix | P01 | high |
| P04 | Terminal (PTY + vendored xterm.js, flow control) | P02, P03 | xhigh |
| P05 | Profiles + onboarding (detect ssh, config, add server, key gen, install public key, fingerprint approval, connection test) | P04 | xhigh |
| P06 | System info + existing read pages (temps via lm-sensors, journal access states) | P02, P03 | high |
| P07 | Files + transfers (Unicode names, >100 MB with progress/cancel, symlinks, denied paths, staged writes) | P02, P03 | xhigh |
| P08 | Per-action sudo | P02, P03 | xhigh |
| P09 | Services: system + `systemctl --user`, all actions | P06, P08 | high |
| P10 | Users, groups, sudoers (create/remove/membership via sudo) | P08 | high |
| P11 | Network: interfaces, routes, ports, firewall status, Tailscale (read-only) | P02, P03 | medium |
| P12 | Security + release: capabilities ACL, CSP, real-app tests, packaging checks, CI | all | xhigh |

Parallel waves (no two parallel packages touch the same file):
1. P01 → 2. P02 ∥ P03 → 3. P04 ∥ P06 ∥ P07 ∥ P08 ∥ P11 → 4. P05 ∥ P09 ∥ P10 → 5. P12.

## Test strategy

| Layer | What | Tool |
|---|---|---|
| Rust unit | validation, parsers, config overlay, deadlines, cancel, sudo prompt handling, redaction | `cargo test` |
| Frontend | every page, races, errors, confirmations, progress/cancel, layout sizes, offline | Playwright + typed fake backend + fixtures |
| Real app | the built Tauri app's WebView2, attached over CDP: real IPC, capabilities, channels | Playwright `connectOverCDP` |
| Real SSH | SSH/SFTP/PTY against a real Linux sshd: unprivileged test account on the owner's server (details only in a gitignored local env file), later a disposable sshd in Linux CI | `cargo test` integration + Playwright |
| Review | Independent adversarial review per package; diff review, full test runs, over-engineering and UI reviews | – |
| Manual | native file pickers, installer, fingerprint/passphrase UX, terminal fidelity, network unplug | checklist |

Leak tests use synthetic secrets; traces/screenshots disabled where secrets are typed.

## Not building (YAGNI)

Server agent or daemon; multiple SSH transports; full ssh-config editor; password vault or cached
sudo; framework/bundler; cloud sync or telemetry; fleet orchestration; transfer resume or folder
sync; firewall/Tailscale/package/cron editing; root file browsing; macOS/Linux claims before native
testing.

## Workflow

Each package is built in its own git worktree, reviewed, fully tested and then merged; effort per table above.
