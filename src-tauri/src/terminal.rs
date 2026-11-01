use crate::{
    contracts::{valid_host, AppError, ErrorKind, Target},
    ssh_config, transport,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock,
    },
    thread,
};
use tauri::ipc::Channel;

const MAX_UNACKED: usize = 1024 * 1024;
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalEvent {
    Output {
        id: String,
        host: String,
        data: Vec<u8>,
    },
    Exit {
        id: String,
        host: String,
        code: Option<u32>,
        error: Option<AppError>,
    },
}

type Sink = Box<dyn Fn(TerminalEvent) -> Result<(), ()> + Send>;
#[derive(Default)]
struct Flow {
    unacked: usize,
    closed: bool,
    exit: Option<Result<u32, AppError>>,
}
struct Session {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Mutex<Flow>,
    ready: Condvar,
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Internal, error.to_string())
}
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorKind::InvalidInput, message)
}
fn size(cols: u16, rows: u16) -> Result<PtySize, AppError> {
    if !(2..=1000).contains(&cols) || !(2..=500).contains(&rows) {
        return Err(invalid(
            "Terminal size must be 2–1000 columns and 2–500 rows",
        ));
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn validate_id(id: &str) -> Result<(), AppError> {
    let digits = id.strip_prefix("terminal-").unwrap_or_default();
    if digits.is_empty()
        || digits.starts_with('0')
        || digits.len() > 20
        || !digits.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(invalid("Invalid terminal session id"));
    }
    Ok(())
}
fn lookup(id: &str) -> Result<Arc<Session>, AppError> {
    validate_id(id)?;
    lock(sessions())
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "Terminal session is closed"))
}
impl Session {
    fn stop(&self) -> Result<(), AppError> {
        let mut flow = lock(&self.flow);
        if flow.closed {
            return Ok(());
        }
        flow.closed = true;
        let exited = flow.exit.is_some();
        self.ready.notify_all();
        drop(flow);
        if !exited && lock(&self.killer).kill().is_err() {
            // Kill can fail on Windows ("handle is invalid"); hanging up the PTY also ends the
            // attached processes (CTRL_CLOSE on Windows, SIGHUP on Unix).
            drop(lock(&self.writer).take());
            drop(lock(&self.master).take());
        }
        Ok(())
    }
    fn wait(&self) -> Result<u32, AppError> {
        let flow = lock(&self.flow);
        let (flow, timeout) = self
            .ready
            .wait_timeout_while(flow, std::time::Duration::from_secs(5), |f| {
                f.exit.is_none()
            })
            .unwrap_or_else(|e| e.into_inner());
        if timeout.timed_out() {
            return Err(internal("Terminal process did not exit"));
        }
        flow.exit.clone().expect("child reaped")
    }
}

fn ssh_command(target: &Target, program: &Path, proxy: Option<&str>) -> CommandBuilder {
    let mut command = CommandBuilder::new(program);
    if let Some(config) = target
        .config
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        command.args(["-F", config]);
    }
    command.arg("-tt");
    for option in [
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
    ] {
        command.args(["-o", option]);
    }
    if let Some(proxy) = proxy {
        command.arg("-o");
        command.arg(format!("ProxyCommand={proxy}"));
    }
    // A saved login password answers ssh's single prompt through NodeScape's askpass mode.
    if let Some(password) = crate::credentials::password(target) {
        command.args(["-o", "NumberOfPasswordPrompts=1"]);
        command.env(
            "SSH_ASKPASS",
            std::env::current_exe().unwrap_or_else(|_| "nodescape".into()),
        );
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env(crate::askpass::SECRET_ENV, password.as_str());
    }
    command.args(["--", &target.host]);
    command.env("TERM", "xterm-256color");
    command
}

fn spawn(
    command: CommandBuilder,
    host: String,
    cols: u16,
    rows: u16,
    sink: Sink,
) -> Result<String, AppError> {
    let mut registry = lock(sessions());
    if SHUTTING_DOWN.load(Ordering::Relaxed) {
        return Err(AppError::new(
            ErrorKind::Cancelled,
            "Application is shutting down",
        ));
    }
    let pair = native_pty_system()
        .openpty(size(cols, rows)?)
        .map_err(internal)?;
    // Acquire I/O before spawning, so setup failures cannot orphan a child.
    let mut reader = pair.master.try_clone_reader().map_err(internal)?;
    let writer = pair.master.take_writer().map_err(internal)?;
    let mut child = pair.slave.spawn_command(command).map_err(internal)?;
    drop(pair.slave);
    let session = Arc::new(Session {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(child.clone_killer()),
        flow: Mutex::new(Flow::default()),
        ready: Condvar::new(),
    });
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = format!("terminal-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    registry.insert(id.clone(), session.clone());
    drop(registry);
    let waiter = session.clone();
    thread::spawn(move || {
        let result = child
            .wait()
            .map(|status| status.exit_code())
            .map_err(internal);
        lock(&waiter.flow).exit = Some(result);
        waiter.ready.notify_all();
        // ConPTY requires closing the master after exit to let its reader reach EOF.
        drop(lock(&waiter.writer).take());
        drop(lock(&waiter.master).take());
    });
    let event_id = id.clone();
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut read_error = None;
        loop {
            let mut flow = lock(&session.flow);
            while flow.unacked >= MAX_UNACKED && !flow.closed {
                flow = session.ready.wait(flow).unwrap_or_else(|e| e.into_inner());
            }
            let capacity = if flow.closed {
                buffer.len()
            } else {
                (MAX_UNACKED - flow.unacked).min(buffer.len())
            };
            drop(flow);
            let count = match reader.read(&mut buffer[..capacity]) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let flow = lock(&session.flow);
                    if !flow.closed
                        && flow.exit.is_none()
                        && error.kind() != std::io::ErrorKind::BrokenPipe
                    {
                        read_error = Some(internal(error));
                    }
                    break;
                }
            };
            let mut flow = lock(&session.flow);
            if flow.closed {
                continue;
            } // Drain while ConPTY closes; never block ClosePseudoConsole.
            flow.unacked += count;
            drop(flow);
            if sink(TerminalEvent::Output {
                id: event_id.clone(),
                host: host.clone(),
                data: buffer[..count].to_vec(),
            })
            .is_err()
            {
                let _ = session.stop();
            }
        }
        if read_error.is_some() {
            let _ = session.stop();
        }
        let result = session.wait();
        let (code, error) = match result {
            Ok(code) => (Some(code), read_error),
            Err(error) => (None, Some(error)),
        };
        let _ = sink(TerminalEvent::Exit {
            id: event_id,
            host,
            code,
            error,
        });
    });
    Ok(id)
}

pub fn input(id: &str, data: &str) -> Result<(), AppError> {
    if data.len() > 64 * 1024 {
        return Err(invalid("Terminal input exceeds 64 KiB"));
    }
    let session = lookup(id)?;
    let flow = lock(&session.flow);
    let ended = flow.closed || flow.exit.is_some();
    drop(flow);
    if ended {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "Terminal session is closed",
        ));
    }
    let mut writer = lock(&session.writer);
    let writer = writer
        .as_mut()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "Terminal session is closed"))?;
    writer.write_all(data.as_bytes()).map_err(internal)?;
    writer.flush().map_err(internal)
}
pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
    let size = size(cols, rows)?;
    let session = lookup(id)?;
    let master = lock(&session.master);
    master
        .as_ref()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "Terminal session is closed"))?
        .resize(size)
        .map_err(internal)
}
pub fn ack(id: &str, bytes: usize) -> Result<(), AppError> {
    let session = lookup(id)?;
    let mut flow = lock(&session.flow);
    if bytes == 0 || bytes > flow.unacked {
        return Err(invalid("Invalid terminal acknowledgement"));
    }
    flow.unacked -= bytes;
    session.ready.notify_all();
    Ok(())
}
pub fn close(id: &str) -> Result<(), AppError> {
    validate_id(id)?;
    let session = lock(sessions()).remove(id);
    if let Some(session) = session {
        session.stop()?;
        session.wait()?;
    }
    Ok(())
}
pub fn close_all() {
    let mut registry = lock(sessions());
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    let active = std::mem::take(&mut *registry);
    drop(registry);
    for session in active.into_values() {
        let _ = session.stop();
        let _ = session.wait();
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Keygen,
    TrustHost,
    InstallKey,
}
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindArgs {
    pub path: Option<String>,
    pub public_key: Option<String>,
}
const INSTALL_KEY: &str = "umask 077\nmkdir -p \"$HOME/.ssh\" || exit\ntouch \"$HOME/.ssh/authorized_keys\" || exit\nchmod 700 \"$HOME/.ssh\" || exit\nchmod 600 \"$HOME/.ssh/authorized_keys\" || exit\nkey={{KEY}}\ngrep -qxF -- \"$key\" \"$HOME/.ssh/authorized_keys\" || printf '\\n%s\\n' \"$key\" >> \"$HOME/.ssh/authorized_keys\"\n";
fn kind_command(
    target: &Target,
    kind: SessionKind,
    args: &KindArgs,
    proxy: Option<&str>,
) -> Result<CommandBuilder, AppError> {
    kind_command_options(target, kind, args, proxy, None)
}
pub(crate) fn kind_command_options(
    target: &Target,
    kind: SessionKind,
    args: &KindArgs,
    proxy: Option<&str>,
    known_hosts: Option<&Path>,
) -> Result<CommandBuilder, AppError> {
    use crate::contracts::{valid_local_path, valid_public_key};
    if matches!(kind, SessionKind::Keygen) {
        if args.public_key.is_some() {
            return Err(invalid("Keygen accepts only a new key path"));
        }
        let path = args
            .path
            .as_deref()
            .ok_or_else(|| invalid("Choose a new identity file path"))?;
        if !valid_local_path(path)
            || !Path::new(path).is_absolute()
            || !Path::new(path).parent().is_some_and(|p| p.is_dir())
        {
            return Err(invalid(
                "Choose an absolute key path in an existing directory",
            ));
        }
        for file in [path.to_owned(), format!("{path}.pub")] {
            match std::fs::symlink_metadata(file) {
                Ok(_) => {
                    return Err(AppError::new(
                        ErrorKind::Conflict,
                        "Key generation refused: the private or public key already exists",
                    ))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(internal(e)),
            }
        }
        let mut command = CommandBuilder::new(crate::onboarding::keygen_program());
        command.args(["-t", "ed25519", "-f", path, "-C", "nodescape"]);
        return Ok(command);
    }
    if !valid_host(&target.host) {
        return Err(invalid("Invalid SSH host"));
    }
    if let Some(config) = &target.config {
        if !valid_local_path(config) || !Path::new(config).is_file() {
            return Err(invalid("SSH config file not found or invalid path"));
        }
    }
    if args.path.is_some() {
        return Err(invalid("This session does not accept a key path"));
    }
    let script = match kind {
        SessionKind::TrustHost if args.public_key.is_none() => "exit".into(),
        SessionKind::InstallKey => {
            let key = args
                .public_key
                .as_deref()
                .filter(|key| valid_public_key(key))
                .ok_or_else(|| invalid("Invalid OpenSSH public key"))?;
            let script = INSTALL_KEY.replace("{{KEY}}", &format!("'{key}'"));
            format!("sh -c '{}'", script.replace('\'', "'\\''"))
        }
        _ => return Err(invalid("Unexpected setup session arguments")),
    };
    let mut command = CommandBuilder::new(transport::ssh_program());
    if let Some(config) = &target.config {
        command.args(["-F", config]);
    }
    command.arg("-T");
    for option in [
        "BatchMode=no",
        "UpdateHostKeys=no",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "PermitLocalCommand=no",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "RequestTTY=no",
        "SessionType=default",
        "RemoteCommand=none",
        "ForkAfterAuthentication=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
    ] {
        command.args(["-o", option]);
    }
    command.args([
        "-o",
        if matches!(kind, SessionKind::TrustHost) {
            "StrictHostKeyChecking=ask"
        } else {
            "StrictHostKeyChecking=yes"
        },
    ]);
    if matches!(kind, SessionKind::InstallKey) {
        command.args([
            "-o",
            "PreferredAuthentications=password,keyboard-interactive",
        ]);
    }
    if let Some(proxy) = proxy {
        command.arg("-o");
        command.arg(format!("ProxyCommand={proxy}"));
    }
    if let Some(path) = known_hosts {
        command.arg("-o");
        command.arg(format!(
            "UserKnownHostsFile=\"{}\"",
            path.to_string_lossy().replace('\\', "/")
        ));
        for option in [
            "GlobalKnownHostsFile=none",
            "KnownHostsCommand=none",
            "VerifyHostKeyDNS=no",
        ] {
            command.args(["-o", option]);
        }
    }
    command.args(["--", &target.host, &script]);
    command.env("TERM", "xterm-256color");
    Ok(command)
}
#[tauri::command]
pub async fn terminal_open_kind(
    target: Target,
    kind: SessionKind,
    args: KindArgs,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> Result<String, AppError> {
    size(cols, rows)?;
    // Validate before ssh -G or creating any PTY/process.
    kind_command(&target, kind, &args, None)?;
    let proxy = if matches!(kind, SessionKind::Keygen) {
        None
    } else {
        let effective = ssh_config::effective(&target).await?;
        effective
            .get("proxyjump")
            .filter(|jump| !jump.eq_ignore_ascii_case("none"))
            .map(|jump| transport::proxy_command(&target, &transport::ssh_program(), jump, None))
            .transpose()?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let command = kind_command(&target, kind, &args, proxy.as_deref())?;
        spawn(
            command,
            target.host,
            cols,
            rows,
            Box::new(move |event| channel.send(event).map_err(|_| ())),
        )
    })
    .await
    .map_err(internal)?
}

pub async fn open(
    target: Target,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> Result<String, AppError> {
    size(cols, rows)?;
    if !valid_host(&target.host) {
        return Err(invalid("Invalid SSH host"));
    }
    let effective = ssh_config::effective(&target).await?;
    let program = transport::ssh_program();
    let proxy = effective
        .get("proxyjump")
        .filter(|jump| !jump.eq_ignore_ascii_case("none"))
        .map(|jump| transport::proxy_command(&target, &program, jump, None))
        .transpose()?;
    let command = ssh_command(&target, &program, proxy.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        spawn(
            command,
            target.host,
            cols,
            rows,
            Box::new(move |event| channel.send(event).map_err(|_| ())),
        )
    })
    .await
    .map_err(internal)?
}
#[tauri::command]
pub async fn terminal_open(
    target: Target,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> Result<String, AppError> {
    open(target, cols, rows, channel).await
}
#[tauri::command]
pub async fn terminal_input(id: String, data: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || input(&id, &data))
        .await
        .map_err(internal)?
}
#[tauri::command]
pub async fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || resize(&id, cols, rows))
        .await
        .map_err(internal)?
}
#[tauri::command]
pub fn terminal_ack(id: String, bytes: usize) -> Result<(), AppError> {
    ack(&id, bytes)
}
#[tauri::command]
pub async fn terminal_close(id: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || close(&id))
        .await
        .map_err(internal)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    fn command(script: &str) -> CommandBuilder {
        #[cfg(windows)]
        let mut command = CommandBuilder::new("powershell.exe");
        #[cfg(windows)]
        command.args(["-NoLogo", "-NoProfile", "-Command", script]);
        #[cfg(not(windows))]
        let mut command = CommandBuilder::new("sh");
        #[cfg(not(windows))]
        command.args(["-c", script]);
        command
    }

    /// Windows ConPTY asks for the cursor position (ESC[6n) and waits for the reply before the
    /// program runs; xterm.js answers it in the app, so the tests answer it here.
    fn local(script: &str) -> (String, mpsc::Receiver<TerminalEvent>) {
        let (tx, rx) = mpsc::channel();
        let session_id = Arc::new(OnceLock::<String>::new());
        let reply_to = session_id.clone();
        let id = spawn(
            command(script),
            "local-test".into(),
            80,
            24,
            Box::new(move |event| {
                if let TerminalEvent::Output { data, .. } = &event {
                    if data.windows(4).any(|w| w == b"[6n") {
                        let reply_to = reply_to.clone();
                        thread::spawn(move || {
                            while reply_to.get().is_none() {
                                thread::yield_now();
                            }
                            let _ = input(reply_to.get().unwrap(), "[1;1R");
                        });
                    }
                }
                tx.send(event).map_err(|_| ())
            }),
        )
        .unwrap();
        session_id.set(id.clone()).unwrap();
        (id, rx)
    }

    #[test]
    fn validates_sizes_ids_and_acknowledgements() {
        for (cols, rows) in [(2, 2), (1000, 500), (80, 24)] {
            assert!(size(cols, rows).is_ok());
        }
        for (cols, rows) in [(0, 24), (1, 24), (1001, 24), (80, 1), (80, 501)] {
            assert_eq!(size(cols, rows).unwrap_err().kind, ErrorKind::InvalidInput);
        }
        for id in [
            "",
            "terminal-0",
            "terminal-01",
            "../1",
            "terminal-x",
            "terminal-1\n",
        ] {
            assert!(validate_id(id).is_err());
        }
        assert!(validate_id("terminal-123").is_ok());
        assert!(ack("terminal-999999", 1).is_err());
    }

    #[test]
    fn ssh_arguments_are_interactive_strict_and_config_safe() {
        let target = Target {
            host: "testbox".into(),
            config: Some("C:/config with spaces/ssh".into()),
        };
        let cmd = ssh_command(&target, Path::new("ssh"), Some("ssh -W proxy"));
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[1..4], ["-F", "C:/config with spaces/ssh", "-tt"]);
        for option in [
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ProxyCommand=ssh -W proxy",
        ] {
            assert!(args.iter().any(|s| s == option));
        }
        assert!(!args.iter().any(|s| s.starts_with("BatchMode=")));
        assert_eq!(&args[args.len() - 2..], ["--", "testbox"]);
    }

    #[test]
    fn pty_input_resize_close_and_double_close() {
        #[cfg(windows)]
        let script = "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::WriteLine('READY'); while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine('REPLY:' + $line) }";
        #[cfg(not(windows))]
        let script = "echo READY; while IFS= read -r line; do printf 'REPLY:%s\\n' \"$line\"; done";
        let (id, rx) = local(script);
        // Type only once the shell is reading; earlier input races ConPTY's startup handshake.
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains("READY") {
            if let TerminalEvent::Output { data, .. } =
                rx.recv_timeout(Duration::from_secs(20)).expect("READY")
            {
                ack(&id, data.len()).unwrap();
                output.extend(data);
            }
        }
        input(&id, "café 漢\r").unwrap();
        loop {
            match rx
                .recv_timeout(Duration::from_secs(10))
                .expect("PTY response")
            {
                TerminalEvent::Output { data, .. } => {
                    ack(&id, data.len()).unwrap();
                    output.extend(data);
                    if String::from_utf8_lossy(&output).contains("REPLY:café 漢") {
                        break;
                    }
                }
                _ => panic!("PTY exited before echo"),
            }
        }
        resize(&id, 120, 40).unwrap();
        assert_eq!(
            lookup(&id)
                .unwrap()
                .master
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .get_size()
                .unwrap(),
            size(120, 40).unwrap()
        );
        assert!(ack(&id, MAX_UNACKED + 1).is_err());
        let session = lookup(&id).unwrap();
        close(&id).unwrap();
        assert!(
            session.flow.lock().unwrap().exit.is_some(),
            "close must reap child"
        );
        close(&id).unwrap();
        assert!(input(&id, "x").is_err());
    }

    #[test]
    fn output_precedes_exactly_one_exit() {
        #[cfg(windows)]
        let script = "[Console]::Write('ORDERED'); exit 7";
        #[cfg(not(windows))]
        let script = "printf ORDERED; exit 7";
        let (id, rx) = local(script);
        let mut output = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                TerminalEvent::Output {
                    data,
                    id: event_id,
                    host,
                } => {
                    assert_eq!(event_id, id);
                    assert_eq!(host, "local-test");
                    ack(&id, data.len()).unwrap();
                    output.extend(data);
                }
                TerminalEvent::Exit { code, error, .. } => {
                    assert!(error.is_none(), "normal PTY exit is not an I/O failure");
                    assert_eq!(code, Some(7));
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("ORDERED"));
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        close(&id).unwrap();
    }

    // Unix PTYs pass bytes through, so byte counts are exact. Windows ConPTY re-renders the screen
    // instead (2.2 MB of output may become far less), so this check runs on Unix only (Linux CI).
    #[cfg(not(windows))]
    #[test]
    fn flow_control_pauses_resumes_and_close_unblocks() {
        #[cfg(windows)]
        let script = "[Console]::Write(('x' * 2200000)); [Console]::Write('FLOW_END'); Start-Sleep -Seconds 30";
        #[cfg(not(windows))]
        let script = "head -c 2200000 /dev/zero | tr '\\000' x; printf FLOW_END; sleep 30";
        let (id, rx) = local(script);
        let mut received = 0;
        while received < MAX_UNACKED {
            match rx.recv_timeout(Duration::from_secs(15)).unwrap() {
                TerminalEvent::Output { data, .. } => received += data.len(),
                _ => panic!("early exit"),
            }
        }
        assert_eq!(received, MAX_UNACKED);
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "reader must pause"
        );
        ack(&id, received).unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            TerminalEvent::Output { .. }
        ));
        let session = lookup(&id).unwrap();
        close(&id).unwrap();
        assert!(session.flow.lock().unwrap().exit.is_some());
    }
}

#[cfg(test)]
mod onboarding_tests {
    use super::*;
    fn argv(command: CommandBuilder) -> Vec<String> {
        command
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into())
            .collect()
    }
    #[test]
    fn fixed_kinds_validate_arguments_and_keygen_never_overwrites() {
        let dir = tempfile::Builder::new()
            .prefix("keygen space ")
            .tempdir()
            .unwrap();
        let path = dir.path().join("new key");
        let target = Target {
            host: "testbox".into(),
            config: None,
        };
        let args = KindArgs {
            path: Some(path.to_string_lossy().into()),
            public_key: None,
        };
        let cmd = kind_command(&target, SessionKind::Keygen, &args, None).unwrap();
        assert_eq!(
            argv(cmd),
            vec![
                crate::onboarding::keygen_program()
                    .to_string_lossy()
                    .into_owned(),
                "-t".into(),
                "ed25519".into(),
                "-f".into(),
                path.to_string_lossy().into_owned(),
                "-C".into(),
                "nodescape".into()
            ]
        );
        std::fs::write(path.with_extension("pub"), "public").unwrap();
        assert!(kind_command(&target, SessionKind::Keygen, &args, None).is_err());
        std::fs::remove_file(path.with_extension("pub")).unwrap();
        std::fs::write(&path, "private").unwrap();
        assert!(kind_command(&target, SessionKind::Keygen, &args, None).is_err());
        let args = KindArgs::default();
        let trust = argv(kind_command(&target, SessionKind::TrustHost, &args, None).unwrap());
        for value in [
            "StrictHostKeyChecking=ask",
            "BatchMode=no",
            "PermitLocalCommand=no",
            "ClearAllForwardings=yes",
        ] {
            assert!(trust.iter().any(|s| s == value));
        }
        assert_eq!(&trust[trust.len() - 3..], ["--", "testbox", "exit"]);
        let args = KindArgs {
            path: None,
            public_key: Some("ssh-ed25519 AAAA nodescape".into()),
        };
        let install = argv(kind_command(&target, SessionKind::InstallKey, &args, None).unwrap());
        assert!(install.iter().any(|s| s == "StrictHostKeyChecking=yes"));
        assert!(install
            .iter()
            .any(|s| s == "PreferredAuthentications=password,keyboard-interactive"));
        assert!(install.last().unwrap().contains("grep -qxF"));
        let bad = KindArgs {
            path: None,
            public_key: Some("ssh-ed25519 AAAA;id".into()),
        };
        assert!(kind_command(&target, SessionKind::InstallKey, &bad, None).is_err());
        assert!(serde_json::from_str::<SessionKind>("\"sh\"").is_err());
        assert!(serde_json::from_str::<KindArgs>(r#"{"command":"id"}"#).is_err());
    }

    #[test]
    fn saved_login_passwords_reach_the_terminal_through_askpass_only() {
        let target = Target {
            host: "terminal-password".into(),
            config: None,
        };
        let plain = ssh_command(&target, Path::new("ssh"), None);
        assert!(plain.get_env(crate::askpass::SECRET_ENV).is_none());
        crate::credentials::remember_for_session(&target, "term pw".into()).unwrap();
        let command = ssh_command(&target, Path::new("ssh"), None);
        assert_eq!(
            command
                .get_env("SSH_ASKPASS_REQUIRE")
                .and_then(|v| v.to_str()),
            Some("force")
        );
        assert!(argv(command.clone())
            .iter()
            .any(|a| a == "NumberOfPasswordPrompts=1"));
        assert!(!argv(command).iter().any(|a| a.contains("term pw")));
        crate::credentials::forget(&target);
    }
}
