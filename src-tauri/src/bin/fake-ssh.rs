use std::io::{self, BufRead, Read, Write};

fn stall() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

fn flood(host: &str) {
    let block = [b'x'; 8192];
    loop {
        if host != "flood-err" && io::stdout().write_all(&block).is_err() {
            break;
        }
        if host != "flood-out" && io::stderr().write_all(&block).is_err() {
            break;
        }
    }
}

fn main() {
    // Askpass mode, as NodeScape's own exe behaves: answer password prompts only.
    // ssh calls askpass with exactly one argument, the prompt; as ssh itself the fake sees many.
    if let (Ok(secret), 2) = (std::env::var("NODESCAPE_ASKPASS"), std::env::args().count()) {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        if prompt.to_ascii_lowercase().contains("password") {
            println!("{secret}");
            return;
        }
        std::process::exit(1);
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    let host = if let Some(index) = args.iter().position(|arg| arg == "--") {
        args.get(index + 1).map(String::as_str).unwrap_or("echo")
    } else {
        args.last().map(String::as_str).unwrap_or("echo")
    };
    if args.iter().any(|arg| arg == "-G") {
        // Count config lookups so tests can prove they are cached.
        if host.starts_with("countg-") {
            use std::io::Write as _;
            let log = std::env::temp_dir().join(format!("nodescape-fake-{host}.log"));
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .unwrap();
            writeln!(file, "-G").unwrap();
        }
        match host {
            "config-stall" => stall(),
            "config-flood" => {
                flood("flood-out");
                return;
            }
            "config-auth" => {
                eprint!("Permission denied (publickey).");
                std::process::exit(255);
            }
            "jump-one" => println!("proxyjump testjump"),
            "jump-port" => println!("proxyjump testuser@testjump:2222"),
            "jump-chain" => println!("proxyjump one,two"),
            "jump-invalid" => println!("proxyjump bad;command"),
            _ => println!("proxyjump none"),
        }
        return;
    }
    match host {
        "password-auth" => {
            let askpass = std::env::var("SSH_ASKPASS").ok();
            let forced = std::env::var("SSH_ASKPASS_REQUIRE").as_deref() == Ok("force");
            let batch = args.iter().any(|a| a == "BatchMode=yes");
            let answer = match askpass {
                Some(program) if forced && !batch => std::process::Command::new(program)
                    .arg("tester@password-auth's password: ")
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_owned())
                    .unwrap_or_default(),
                _ => String::new(),
            };
            if answer == "right pw" {
                println!("logged in with password");
                for arg in &args {
                    println!("{arg}");
                }
                return;
            }
            if !answer.is_empty() {
                eprintln!("Permission denied, please try again.");
            }
            eprint!("tester@password-auth: Permission denied (publickey,password).");
            std::process::exit(255);
        }
        "verbose-refused" | "verbose-ok" => {
            assert!(args.iter().any(|a| a == "-v"), "diagnose must run ssh -v");
            eprintln!("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2");
            eprintln!("debug1: Connecting to {host} [10.0.0.9] port 22.");
            if host == "verbose-ok" {
                eprintln!("debug1: Authenticated to {host} ([10.0.0.9]:22) using \"publickey\".");
                return;
            }
            eprintln!("debug1: connect to address 10.0.0.9 port 22: Connection refused");
            eprint!("ssh: connect to host {host} port 22: Connection refused");
            std::process::exit(255);
        }
        "stall" => {
            let mut path = String::new();
            io::stdin().lock().read_line(&mut path).unwrap();
            if !path.trim().is_empty() {
                std::fs::write(path.trim(), std::process::id().to_string()).unwrap();
            }
            stall();
        }
        "flood-out" | "flood-err" | "flood-both" => flood(host),
        "dual" => {
            io::stdout().write_all(&[b'x'; 40_000]).unwrap();
            io::stderr().write_all(&[b'e'; 40_000]).unwrap();
            io::copy(&mut io::stdin(), &mut io::sink()).unwrap();
        }
        host if host.starts_with("countg-") => print!("ran"),
        "args" | "jump-one" | "jump-port" => {
            // Read the script like `sh -s` would, so the writer never races a closed pipe.
            io::copy(&mut io::stdin(), &mut io::sink()).unwrap();
            for arg in &args {
                println!("{arg}");
            }
        }
        "sudo-audit" => {
            let mut script = String::new();
            io::stdin().read_to_string(&mut script).unwrap();
            let expected = "P='p'\\''ass $word;💫'; printf '%s\\n' \"$P\" | sudo -S -k -p '' -- 'systemctl' 'restart' '--' 'test.service'; s=$?; unset P; exit $s";
            assert_eq!(script, expected);
            assert!(!args
                .iter()
                .any(|arg| arg.contains("p'ass") || arg.contains("$word")));
            assert_eq!(&args[args.len() - 3..], ["--", "sudo-audit", "sh -s"]);
            assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
            print!("verified stdin and argv");
        }
        "sudo-stderr" | "sudo-stdout" => {
            let mut script = String::new();
            io::stdin().read_to_string(&mut script).unwrap();
            // The password straddles the 4000-char cap; redacting first leaves exactly "[redacted]" at the end.
            let text = format!(
                "{}p'ass $word;💫\n{script}\nSorry, try again.",
                "x".repeat(3990)
            );
            if host == "sudo-stderr" {
                eprint!("{text}");
            } else {
                print!("{text}");
            }
            std::process::exit(1);
        }
        "proxy-args" => {
            eprintln!("PROXY_ARGS");
            for arg in &args {
                eprintln!("{arg}");
            }
            std::process::exit(255);
        }
        host if host.starts_with("exit-") => {
            let (code, message) = match host {
                "exit-255-auth" => (255, "Permission denied (publickey)."),
                "exit-255-unknown" => (255, "Host key verification failed."),
                "exit-255-changed" => (255, "REMOTE HOST IDENTIFICATION HAS CHANGED"),
                "exit-255-unreachable" => (255, "Connection refused"),
                "exit-sudo-wrong" => (1, "sudo: 1 incorrect password attempt"),
                "exit-empty" => (42, ""),
                _ => (42, "collector failed"),
            };
            eprint!("{message}");
            std::process::exit(code);
        }
        _ => {
            let mut input = Vec::new();
            io::stdin().read_to_end(&mut input).unwrap();
            io::stdout().write_all(&input).unwrap();
        }
    }
}
