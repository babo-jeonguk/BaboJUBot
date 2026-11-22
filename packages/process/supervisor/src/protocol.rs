//! The control protocol every system shares (#268). The server and the supervisor exchange text lines over the control channel:
//! a byte stream that only the server and this supervisor hold. The supervisor writes:
//!
//! ```text
//! babojubot-supervisor <protocol>     first, before anything runs: the protocol this supervisor speaks
//! ok <pid>                            the program runs; <pid> is its process id
//! failed: <why>                       the supervisor could not set up, so the program did not run; nothing follows
//! not-started <code>: <why>           the program could not start (<code> is the errno name, ENOENT and so on); nothing follows
//! exit <code> | exit-signal <name>    the program ended. What it started keeps running until stop
//! ended | left: <what>                the reply to stop: nothing of the tree runs any more, or what was still running and why.
//!                                     The supervisor exits right after
//! ```
//!
//! Before the program runs, the server writes `env <NAME>=<VALUE>` lines (the run's marker: the program gets them on top of the
//! supervisor's own environment, and the supervisor itself does not carry them, so marker cleanup never reaches the supervisor) and
//! then `start`. The supervisor starts the program only after `start`; the end of the channel before it ends the supervisor.
//!
//! Then the server writes `stop <grace ms>` (end the tree, report, exit), `kill-leader` (end the program only, as a crash would)
//! and `interrupt` (SIGINT to the program's process group; nothing on Windows). The end of the channel means the server is gone and
//! does what `stop` does with the default grace. A line this supervisor does not know is ignored.

use std::time::Duration;

pub const PROTOCOL: u32 = 2;
/// The grace after SIGTERM when the channel ends without a stop (the server is gone).
pub const DEFAULT_GRACE: Duration = Duration::from_millis(2000);
/// How long a stop waits, after the last signal, until nothing of the tree runs.
pub const END_LIMIT: Duration = Duration::from_secs(10);
/// How often the loop looks at the program and the channel when nothing arrives.
pub const POLL: Duration = Duration::from_millis(20);

pub fn hello() -> String {
    format!("babojubot-supervisor {PROTOCOL}")
}

/// How the program ended.
pub enum Exit {
    Code(i32),
    #[cfg_attr(windows, allow(dead_code))]
    Signal(&'static str),
}

pub fn exit_line(exit: &Exit) -> String {
    match exit {
        Exit::Code(code) => format!("exit {code}"),
        Exit::Signal(name) => format!("exit-signal {name}"),
    }
}

/// What a stop found: the tree ended, or what was still running (and why) when the stop gave up.
pub type StopResult = Result<(), String>;

pub fn end_line(result: &StopResult) -> String {
    match result {
        Ok(()) => "ended".to_owned(),
        Err(what) => format!("left: {what}"),
    }
}

pub enum Command {
    Stop(Duration),
    KillLeader,
    Interrupt,
}

fn parse(line: &str) -> Option<Command> {
    let line = line.trim();
    if line == "kill-leader" {
        return Some(Command::KillLeader);
    }
    if line == "interrupt" {
        return Some(Command::Interrupt);
    }
    let grace = line.strip_prefix("stop ")?.parse::<u64>().ok()?;
    Some(Command::Stop(Duration::from_millis(grace)))
}

/// What the server asked for before the start: the environment entries for the program, and what arrived after `start`.
pub struct Start {
    pub env: Vec<(String, String)>,
    pub rest: Vec<u8>,
}

/// Reads the server's `env` lines until `start`. `None` when the channel ends or termination is requested first: nothing ran.
pub fn read_start(channel: &mut impl Channel, termination: &impl Termination) -> Option<Start> {
    let mut pending: Vec<u8> = Vec::new();
    let mut env = Vec::new();
    loop {
        if termination.requested() {
            return None;
        }
        match channel.read(POLL) {
            Read::Closed => return None,
            Read::Nothing => {}
            Read::Bytes(bytes) => pending.extend_from_slice(&bytes),
        }
        while let Some(newline) = pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=newline).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end();
            if line == "start" {
                return Some(Start { env, rest: pending });
            }
            if let Some((name, value)) = line
                .strip_prefix("env ")
                .and_then(|entry| entry.split_once('='))
                && !name.is_empty()
            {
                env.push((name.to_owned(), value.to_owned()));
            }
        }
    }
}

/// Splits what arrives on the channel into commands. A line may arrive in pieces.
#[derive(Default)]
pub struct Commands {
    pending: Vec<u8>,
}

impl Commands {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Command> {
        self.pending.extend_from_slice(bytes);
        let mut commands = Vec::new();
        while let Some(newline) = self.pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=newline).collect();
            if let Some(command) = parse(&String::from_utf8_lossy(&line)) {
                commands.push(command);
            }
        }
        commands
    }
}

/// What reading the channel gave.
pub enum Read {
    Bytes(Vec<u8>),
    /// Nothing arrived within the wait.
    Nothing,
    /// The channel ended or failed: the server is gone.
    Closed,
}

/// The control channel as the supervisor loop uses it.
pub trait Channel {
    /// Waits at most `wait` for bytes.
    fn read(&mut self, wait: Duration) -> Read;
    /// Writes one line. A failure means the server is gone; the next read reports the end.
    fn write_line(&mut self, line: &str);
}

/// The tree under one supervisor: the program it started and everything the system ties to it (process group, job object).
pub trait Tree {
    /// Housekeeping on every turn of the loop, before and after the program ends (Linux reaps the orphans that ended).
    fn tend(&mut self) {}
    /// The program's end, without releasing its process id: the id is not reused until the stop's last signal.
    fn leader_exit(&mut self) -> Option<Exit>;
    fn interrupt(&mut self);
    fn kill_leader(&mut self);
    /// Ends the whole tree and checks within a limit that nothing of it runs. Also gives the program's end when it is known only now.
    fn stop(&mut self, grace: Duration) -> (Option<Exit>, StopResult);
}

/// A request from outside the channel to end the tree (SIGTERM, SIGINT or SIGHUP to the supervisor on Linux and macOS).
pub trait Termination {
    fn requested(&self) -> bool;
}

/// Runs the tree until a stop, the end of the channel or a termination request, then ends the tree and reports. Returns the exit
/// code of the supervisor.
pub fn supervise(
    channel: &mut impl Channel,
    tree: &mut impl Tree,
    termination: &impl Termination,
    already: &[u8],
) -> i32 {
    let mut commands = Commands::default();
    let mut exited = false;
    let mut waiting = commands.push(already);
    let grace = 'run: loop {
        for command in waiting.drain(..) {
            match command {
                Command::Stop(grace) => break 'run grace,
                Command::KillLeader => tree.kill_leader(),
                Command::Interrupt => tree.interrupt(),
            }
        }
        tree.tend();
        if !exited && let Some(exit) = tree.leader_exit() {
            channel.write_line(&exit_line(&exit));
            exited = true;
        }
        if termination.requested() {
            break DEFAULT_GRACE;
        }
        match channel.read(POLL) {
            Read::Closed => break DEFAULT_GRACE,
            Read::Nothing => {}
            Read::Bytes(bytes) => {
                for command in commands.push(&bytes) {
                    match command {
                        Command::Stop(grace) => break 'run grace,
                        Command::KillLeader if !exited => tree.kill_leader(),
                        Command::Interrupt if !exited => tree.interrupt(),
                        Command::KillLeader | Command::Interrupt => {}
                    }
                }
            }
        }
    };
    let (exit, result) = tree.stop(grace);
    if !exited && let Some(exit) = exit {
        channel.write_line(&exit_line(&exit));
    }
    channel.write_line(&end_line(&result));
    i32::from(result.is_err())
}
