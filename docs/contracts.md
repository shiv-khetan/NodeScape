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

Events use `area:event` names and carry the target host and an operation
or session id. Streams use `tauri::ipc::Channel`.
No command may run arbitrary shell text except the interactive terminal.
All input is validated in Rust even when the UI has already validated it.
Mutations are never retried automatically.
