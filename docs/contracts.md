# Shared contracts

Commands use snake_case names in the form `<area>_<verb>`.
JavaScript argument names use camelCase.
Every remote command takes `target: Target`; local-only commands are exempt.
`Target` is `{ host: string, config: string | null }`: an SSH alias or
user@host plus an optional SSH config file path. Profiles belong to P05.
Existing prototype command names and arguments remain unchanged in P01.

Errors serialize as `{"kind":"snake_case","message":"..."}`.
Messages are capped at 4000 characters. Kinds:

| Kind | Meaning |
| --- | --- |
| conflict | The file changed since it was read; reload before saving. |
| invalid_input | An argument failed validation. |
| ssh_missing | The system SSH executable was not found. |
| auth_failed | SSH authentication failed. |
| host_key_unknown | The host key is not trusted. |
| host_key_changed | The presented host key differs from the trusted key. |
| unreachable | Name resolution or network connection failed. |
| timeout | The operation timed out. |
| permission_denied | Access to a remote resource was denied. |
| not_found | A requested resource does not exist. |
| sudo_required | The action requires a sudo password. |
| sudo_wrong_password | Sudo rejected the supplied password. |
| cancelled | The operation was cancelled. |
| outcome_unknown | A mutation may have completed before contact was lost. |
| remote | An unclassified remote failure; preserve its message. |
| internal | A local unexpected failure occurred. |
| password_required | The server accepts password login and none is held for this target. |
| password_refused | The server refused the held password; it has been forgotten. |
| connection_closed | The server closed or reset the connection (limits, fail2ban, sshd restart). |

Events use `area:event` names and carry the target host and an operation
or session id. Streams use `tauri::ipc::Channel`.
No command may run arbitrary shell text except the interactive terminal.
All input is validated in Rust even when the UI has already validated it.
Mutations are never retried automatically.

## Login passwords and diagnostics

| Command | Arguments | Returns |
| --- | --- | --- |
| login_password_set | `login: { target, password, remember }` | `null`. Holds the password for the session; `remember` also saves it in Windows Credential Manager (Local persistence). |
| login_password_forget | `target` | `null`. Removes the session and saved copies. |
| login_password_saved | `target` | `boolean`. Never returns the password. |
| connection_diagnose | `target` | `{ ok, error, log }`: runs `ssh -v … exit`; `log` is the redacted client log. |
| server_health | `target` | `{ failed }`: count of failed systemd units, for the sidebar fleet list (10 s timeout). |
| sudo_status | `target` | `"passwordless" \| "password" \| "none" \| "missing"`. |

`ssh_config_save` takes `server: { alias, hostname, user, port, auth: "key" | "password", identityFile: string | null, jump: string | null }`.
Password servers get `PreferredAuthentications password,keyboard-interactive` and `PubkeyAuthentication no`; the password is never written to the config.
