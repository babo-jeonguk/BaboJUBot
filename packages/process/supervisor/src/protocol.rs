//! The control protocol every system shares (#268). The server and the supervisor exchange messages over the control channel: a
//! byte stream that only the server and this supervisor hold. Every message, in both directions, is one netstring
//! (`[length]":"[bytes]","`, D. J. Bernstein, <https://cr.yp.to/proto/netstrings.txt>), so no value inside a message can split or
//! forge another message (a newline in a marker, a carriage return in a reason). The same framing vectors are in
//! `protocol-vectors.txt`, and the order the supervisor keeps is the table in `protocol-transitions.txt`; the server reads both.
//!
//! The supervisor writes:
//!
//! ```text
//! babojubot-supervisor <protocol>     first, before anything runs: the protocol this supervisor speaks
//! ok <pid>                            the program runs; <pid> is its process id
//! failed: <why>                       the supervisor could not set up, so the program did not run; nothing follows
//! not-started <code>: <why>           the program could not start (<code> is the errno name, ENOENT and so on); nothing follows
//! exit <code> | exit-signal <name>    the program ended. What it started keeps running until stop
//! ended | left: <what>                the reply to stop: nothing of the tree runs any more (only after the program's end), or
//!                                     what was still running and why. The supervisor exits right after
//! ```
//!
//! Before the program runs, the server writes `env <NAME>=<VALUE>` messages (the run's markers: the program gets them on top of the
//! supervisor's own environment, and the supervisor itself does not carry them, so marker cleanup never reaches the supervisor),
//! `marker <VALUE>` (this run's own marker: a stop also ends the programs that carry it, wherever they run; protocol 4) and then
//! `start`. The supervisor starts the program only after `start`; the end of the channel before it ends the supervisor.
//!
//! Instead of `start`, the server may write `clean` (protocol 4): the restart recovery's request when the run's server and supervisor
//! both died. No program runs; the supervisor ends the programs that carry `marker`, answers `ended` or `left: <what>` and exits.
//! `since <N>` before it says when that run began (Linux: clock ticks after boot; macOS: microseconds since the epoch), so a program
//! of this user that started after it and whose environment cannot be read is reported as unverified instead of passed over.
//! `recorded <PID> <START>` names the process the run's record kept (its supervisor, or before the supervisor its program), with its
//! start time in the same measure: it is ended too when it is still that process (macOS compares to the second, as its records keep
//! the start). A clean needs a marker, a recorded process, or both.
//!
//! Then the server writes `stop <grace ms>` (end the tree, report, exit), `kill-leader` (end the program only, as a crash would)
//! and `interrupt` (SIGINT to the program's process group; nothing on Windows). The end of the channel means the server is gone and
//! does what `stop` does with the default grace; so does a malformed message (the server broke the protocol). A well-formed message
//! this supervisor does not know is ignored.

use std::time::Duration;

pub const PROTOCOL: u32 = 4;
/// The grace after SIGTERM when the channel ends without a stop (the server is gone).
pub const DEFAULT_GRACE: Duration = Duration::from_millis(2000);
/// How long a stop waits, after the last signal, until nothing of the tree runs.
pub const END_LIMIT: Duration = Duration::from_secs(10);
/// How often the loop looks at the program and the channel when nothing arrives.
pub const POLL: Duration = Duration::from_millis(20);
/// The longest message either side accepts.
pub const MESSAGE_LIMIT: usize = 1024 * 1024;

pub fn hello() -> String {
    format!("babojubot-supervisor {PROTOCOL}")
}

/// One message as a netstring.
pub fn frame(text: &str) -> Vec<u8> {
    let mut bytes = format!("{}:", text.len()).into_bytes();
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(b',');
    bytes
}

/// Reads netstrings from what arrives on the channel. A message may arrive in pieces, and several may arrive together.
#[derive(Default)]
pub struct Messages {
    pending: Vec<u8>,
}

impl Messages {
    /// The messages complete so far. A malformed netstring (or one over `MESSAGE_LIMIT`, or not UTF-8) is an error.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let digits = self
                .pending
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let limit_digits = MESSAGE_LIMIT.to_string().len();
            if digits > limit_digits
                || (digits == self.pending.len() && digits > 0 && digits == limit_digits + 1)
            {
                return Err("malformed control message: its length is over the limit".to_owned());
            }
            if digits == self.pending.len() {
                return Ok(messages);
            }
            if digits == 0 {
                return Err(
                    "malformed control message: it does not start with its length".to_owned(),
                );
            }
            if self.pending[digits] != b':' {
                return Err("malformed control message: no \":\" after its length".to_owned());
            }
            if digits > 1 && self.pending[0] == b'0' {
                return Err("malformed control message: its length has a leading zero".to_owned());
            }
            let length: usize = std::str::from_utf8(&self.pending[..digits])
                .ok()
                .and_then(|text| text.parse().ok())
                .ok_or("malformed control message: its length is not a number")?;
            if length > MESSAGE_LIMIT {
                return Err("malformed control message: its length is over the limit".to_owned());
            }
            let end = digits + 1 + length;
            if self.pending.len() <= end {
                return Ok(messages);
            }
            if self.pending[end] != b',' {
                return Err("malformed control message: no \",\" after it".to_owned());
            }
            let body: Vec<u8> = self.pending[digits + 1..end].to_vec();
            self.pending.drain(..=end);
            messages.push(
                String::from_utf8(body)
                    .map_err(|_| "malformed control message: it is not UTF-8".to_owned())?,
            );
        }
    }
}

/// How the program ended.
pub enum Exit {
    Code(i32),
    #[cfg_attr(windows, allow(dead_code))]
    Signal(&'static str),
}

pub fn exit_message(exit: &Exit) -> String {
    match exit {
        Exit::Code(code) => format!("exit {code}"),
        Exit::Signal(name) => format!("exit-signal {name}"),
    }
}

/// What a stop found: the tree ended, or what was still running (and why) when the stop gave up.
pub type StopResult = Result<(), String>;

pub fn end_message(result: &StopResult) -> String {
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

fn parse(message: &str) -> Option<Command> {
    if message == "kill-leader" {
        return Some(Command::KillLeader);
    }
    if message == "interrupt" {
        return Some(Command::Interrupt);
    }
    let grace = message.strip_prefix("stop ")?.parse::<u64>().ok()?;
    Some(Command::Stop(Duration::from_millis(grace)))
}

/// What the server asked for before the start: the environment entries for the program, this run's own marker, and what arrived
/// after `start`.
pub struct Start {
    pub env: Vec<(String, String)>,
    /// Windows ends a run with its job object and has no marker search.
    #[cfg_attr(windows, allow(dead_code))]
    pub marker: Option<String>,
    pub rest: Messages,
    pub waiting: Vec<String>,
}

/// The restart recovery's request: end what carries `marker` and the `recorded` process (its id and start time); `since` is when that
/// run began. Windows refuses it.
#[cfg_attr(windows, allow(dead_code))]
pub struct Clean {
    pub marker: Option<String>,
    pub since: Option<u64>,
    pub recorded: Option<(i32, u64)>,
}

/// How reading the start request ended.
pub enum StartRequest {
    Start(Start),
    Clean(#[cfg_attr(windows, allow(dead_code))] Clean),
    /// The channel ended or termination was requested first: nothing ran.
    Ended,
    /// The server sent something the supervisor must not use (a malformed message, an environment entry that cannot be one).
    Refused(String),
}

/// An environment entry the program can get: a name without `=` or NUL, a value without NUL.
fn environment_entry(entry: &str) -> Result<(String, String), String> {
    let (name, value) = entry
        .split_once('=')
        .ok_or("an environment entry has no \"=\"")?;
    if name.is_empty() || name.contains('\0') || value.contains('\0') {
        return Err("an environment entry has an empty name or a NUL byte".to_owned());
    }
    Ok((name.to_owned(), value.to_owned()))
}

/// A marker the supervisor can compare: not empty, without NUL.
fn marker_value(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("the run's marker is empty or has a NUL byte".to_owned());
    }
    Ok(value.to_owned())
}

/// Reads the server's `env`, `marker` and `since` messages until `start` or `clean`.
pub fn read_start(channel: &mut impl Channel, termination: &impl Termination) -> StartRequest {
    let mut messages = Messages::default();
    let mut env = Vec::new();
    let mut marker = None;
    let mut since = None;
    let mut recorded = None;
    loop {
        if termination.requested() {
            return StartRequest::Ended;
        }
        let bytes = match channel.read(POLL) {
            Read::Closed => return StartRequest::Ended,
            Read::Nothing => continue,
            Read::Bytes(bytes) => bytes,
        };
        let complete = match messages.push(&bytes) {
            Ok(complete) => complete,
            Err(why) => return StartRequest::Refused(why),
        };
        let mut complete = complete.into_iter();
        while let Some(message) = complete.next() {
            if message == "start" {
                return StartRequest::Start(Start {
                    env,
                    marker,
                    rest: messages,
                    waiting: complete.collect(),
                });
            }
            if message == "clean" {
                if marker.is_none() && recorded.is_none() {
                    return StartRequest::Refused(
                        "clean came without the run's marker or a recorded process".to_owned(),
                    );
                }
                return StartRequest::Clean(Clean {
                    marker,
                    since,
                    recorded,
                });
            }
            if let Some(entry) = message.strip_prefix("env ") {
                match environment_entry(entry) {
                    Ok(pair) => env.push(pair),
                    Err(why) => return StartRequest::Refused(why),
                }
            } else if let Some(value) = message.strip_prefix("marker ") {
                match marker_value(value) {
                    Ok(value) => marker = Some(value),
                    Err(why) => return StartRequest::Refused(why),
                }
            } else if let Some(value) = message.strip_prefix("recorded ") {
                let parsed = value
                    .split_once(' ')
                    .and_then(|(pid, start)| {
                        Some((pid.parse::<i32>().ok()?, start.parse::<u64>().ok()?))
                    })
                    .filter(|&(pid, _)| pid > 1);
                match parsed {
                    Some(pair) => recorded = Some(pair),
                    None => {
                        return StartRequest::Refused(format!(
                            "\"recorded {value}\" is not a process id above 1 and a start time"
                        ));
                    }
                }
            } else if let Some(value) = message.strip_prefix("since ") {
                match value.parse::<u64>() {
                    Ok(value) => since = Some(value),
                    Err(_) => {
                        return StartRequest::Refused(format!(
                            "\"since {value}\" is not a start time"
                        ));
                    }
                }
            }
        }
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
    /// Writes one message, framed. A failure means the server is gone; the next read reports the end.
    fn write_message(&mut self, message: &str);
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

/// Runs the tree until a stop, the end of the channel or a termination request, then ends the tree and reports. `start` carries
/// what arrived after `start`. Returns the exit code of the supervisor.
pub fn supervise(
    channel: &mut impl Channel,
    tree: &mut impl Tree,
    termination: &impl Termination,
    start: Start,
) -> i32 {
    let Start {
        rest: mut messages,
        waiting,
        ..
    } = start;
    let mut exited = false;
    let mut waiting: Vec<Command> = waiting
        .iter()
        .filter_map(|message| parse(message))
        .collect();
    let grace = 'run: loop {
        for command in waiting.drain(..) {
            match command {
                Command::Stop(grace) => break 'run grace,
                Command::KillLeader if !exited => tree.kill_leader(),
                Command::Interrupt if !exited => tree.interrupt(),
                Command::KillLeader | Command::Interrupt => {}
            }
        }
        tree.tend();
        if !exited && let Some(exit) = tree.leader_exit() {
            channel.write_message(&exit_message(&exit));
            exited = true;
        }
        if termination.requested() {
            break DEFAULT_GRACE;
        }
        match channel.read(POLL) {
            Read::Closed => break DEFAULT_GRACE,
            Read::Nothing => {}
            Read::Bytes(bytes) => match messages.push(&bytes) {
                Ok(complete) => {
                    waiting = complete
                        .iter()
                        .filter_map(|message| parse(message))
                        .collect()
                }
                // The server broke the protocol: treat it as gone and end the tree.
                Err(_) => break DEFAULT_GRACE,
            },
        }
    };
    let (exit, mut result) = tree.stop(grace);
    if !exited {
        match exit {
            Some(exit) => channel.write_message(&exit_message(&exit)),
            // `ended` comes only after the program's end: without it, the tree's end is not confirmed.
            None if result.is_ok() => {
                result = Err("unknown (the program's end could not be read)".to_owned())
            }
            None => {}
        }
    }
    channel.write_message(&end_message(&result));
    i32::from(result.is_err())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    fn rows(text: &str) -> Vec<Vec<&str>> {
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.split_whitespace().collect())
            .collect()
    }

    fn bytes(hex: &str) -> Vec<u8> {
        if hex == "-" {
            return Vec::new();
        }
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn framing_follows_the_shared_vectors() {
        for row in rows(include_str!("../protocol-vectors.txt")) {
            match row[0] {
                "ok" => {
                    let text = String::from_utf8(bytes(row[1])).unwrap();
                    let encoded = bytes(row[2]);
                    assert_eq!(frame(&text), encoded, "{text:?}");
                    assert_eq!(
                        Messages::default().push(&encoded).unwrap(),
                        vec![text.clone()]
                    );
                    let mut reader = Messages::default();
                    let mut read = Vec::new();
                    for byte in &encoded {
                        read.extend(reader.push(&[*byte]).unwrap());
                    }
                    assert_eq!(read, vec![text]);
                }
                "bad" => {
                    let error = Messages::default().push(&bytes(row[1])).unwrap_err();
                    assert!(error.contains("malformed control message"), "{error}");
                }
                other => panic!("unknown vector kind {other}"),
            }
        }
    }

    type Table = HashMap<(String, String), String>;

    fn table() -> (Table, Vec<(bool, Vec<String>)>) {
        let mut table = HashMap::new();
        let mut sequences = Vec::new();
        for row in rows(include_str!("../protocol-transitions.txt")) {
            match row[0] {
                "transition" => {
                    table.insert((row[1].to_owned(), row[2].to_owned()), row[3].to_owned());
                }
                kind => sequences.push((
                    kind == "accept",
                    row[1..].iter().map(|event| (*event).to_owned()).collect(),
                )),
            }
        }
        (table, sequences)
    }

    fn accepts(table: &Table, events: &[String]) -> bool {
        let mut phase = "hello".to_owned();
        for event in events {
            match table.get(&(phase.clone(), event.clone())) {
                Some(next) => phase = next.clone(),
                None => return false,
            }
        }
        true
    }

    #[test]
    fn the_table_reads_the_shared_sequences_as_the_server_does() {
        let (table, sequences) = table();
        for (accept, events) in sequences {
            assert_eq!(accepts(&table, &events), accept, "{events:?}");
        }
    }

    /// A channel that gives scripted reads and records what the supervisor writes.
    struct Script {
        reads: VecDeque<Read>,
        written: Vec<String>,
    }

    impl Channel for Script {
        /// Records the moment the server's stop is handed over, so the order of events is what the server sees.
        fn read(&mut self, _wait: Duration) -> Read {
            let next = self.reads.pop_front().unwrap_or(Read::Nothing);
            if matches!(next, Read::Bytes(_)) {
                self.written.push("stop".to_owned());
            }
            next
        }
        fn write_message(&mut self, message: &str) {
            let mut reader = Messages::default();
            self.written.extend(reader.push(&frame(message)).unwrap());
        }
    }

    /// A tree whose program ends after `exits_after` turns, and whose stop gives `stop`.
    struct Fake {
        turns: u32,
        exits_after: Option<u32>,
        stop: (Option<i32>, StopResult),
    }

    impl Tree for Fake {
        fn leader_exit(&mut self) -> Option<Exit> {
            self.turns += 1;
            match self.exits_after {
                Some(after) if self.turns > after => Some(Exit::Code(0)),
                _ => None,
            }
        }
        fn interrupt(&mut self) {}
        fn kill_leader(&mut self) {}
        fn stop(&mut self, _grace: Duration) -> (Option<Exit>, StopResult) {
            (self.stop.0.map(Exit::Code), self.stop.1.clone())
        }
    }

    struct Never;
    impl Termination for Never {
        fn requested(&self) -> bool {
            false
        }
    }

    /// The events the server sees: hello and ok (written before `supervise`), then the stop it sends and what the supervisor writes,
    /// in order.
    fn events(
        stop_after_reads: usize,
        exits_after: Option<u32>,
        stop: (Option<i32>, StopResult),
    ) -> Vec<String> {
        let mut reads: VecDeque<Read> = (0..stop_after_reads).map(|_| Read::Nothing).collect();
        reads.push_back(Read::Bytes(frame("stop 0")));
        let mut channel = Script {
            reads,
            written: Vec::new(),
        };
        let mut tree = Fake {
            turns: 0,
            exits_after,
            stop,
        };
        let start = Start {
            env: Vec::new(),
            marker: None,
            rest: Messages::default(),
            waiting: Vec::new(),
        };
        supervise(&mut channel, &mut tree, &Never, start);
        let kind = |message: &String| {
            if message.starts_with("exit") {
                "exit".to_owned()
            } else {
                message.split([' ', ':']).next().unwrap().to_owned()
            }
        };
        ["hello".to_owned(), "ok".to_owned()]
            .into_iter()
            .chain(channel.written.iter().map(kind))
            .collect()
    }

    #[test]
    fn what_the_supervisor_writes_keeps_to_the_table() {
        let (table, _) = table();
        for (case, written) in [
            (
                "the program ends, then the stop",
                events(3, Some(0), (None, Ok(()))),
            ),
            (
                "the stop, then the program's end",
                events(0, None, (Some(0), Ok(()))),
            ),
            (
                "the stop leaves programs",
                events(0, None, (None, Err("1 (left)".to_owned()))),
            ),
            (
                "the stop ends the tree but cannot read the program's end",
                events(0, None, (None, Ok(()))),
            ),
        ] {
            assert!(accepts(&table, &written), "{case}: {written:?}");
        }
        assert_eq!(
            events(0, None, (None, Ok(()))).last().unwrap(),
            "left",
            "no `ended` without the program's end"
        );
    }

    #[test]
    fn the_start_request_refuses_entries_the_program_cannot_get() {
        for entry in ["env A", "env =x", "env A=x\0y"] {
            let mut channel = Script {
                reads: VecDeque::from([Read::Bytes(frame(entry))]),
                written: Vec::new(),
            };
            assert!(
                matches!(read_start(&mut channel, &Never), StartRequest::Refused(_)),
                "{entry:?}"
            );
        }
        let mut bytes = frame("env A=one\ntwo");
        bytes.extend(frame("start"));
        bytes.extend(frame("stop 5"));
        let mut channel = Script {
            reads: VecDeque::from([Read::Bytes(bytes)]),
            written: Vec::new(),
        };
        match read_start(&mut channel, &Never) {
            StartRequest::Start(start) => {
                assert_eq!(start.env, vec![("A".to_owned(), "one\ntwo".to_owned())]);
                assert_eq!(start.waiting, vec!["stop 5".to_owned()]);
            }
            _ => panic!("the start request was not read"),
        }
    }

    #[test]
    fn the_restart_recovery_asks_for_a_clean_with_the_run_s_marker() {
        let read = |messages: &[&str]| {
            let mut bytes = Vec::new();
            for message in messages {
                bytes.extend(frame(message));
            }
            let mut channel = Script {
                reads: VecDeque::from([Read::Bytes(bytes)]),
                written: Vec::new(),
            };
            read_start(&mut channel, &Never)
        };
        match read(&["marker abc", "since 12", "clean"]) {
            StartRequest::Clean(clean) => {
                assert_eq!(clean.marker.as_deref(), Some("abc"));
                assert_eq!(clean.since, Some(12));
                assert_eq!(clean.recorded, None);
            }
            _ => panic!("the clean request was not read"),
        }
        match read(&["recorded 4242 77", "clean"]) {
            StartRequest::Clean(clean) => {
                assert_eq!(clean.marker, None);
                assert_eq!(clean.recorded, Some((4242, 77)));
            }
            _ => panic!("the clean request was not read"),
        }
        match read(&["env BABOJUBOT_PROCESS_LEASE=abc", "marker abc", "start"]) {
            StartRequest::Start(start) => assert_eq!(start.marker.as_deref(), Some("abc")),
            _ => panic!("the start request was not read"),
        }
        for refused in [
            &["clean"][..],
            &["marker ", "clean"],
            &["since soon", "marker abc", "clean"],
            &["recorded 1 5", "clean"],
            &["recorded 42", "clean"],
        ] {
            assert!(
                matches!(read(refused), StartRequest::Refused(_)),
                "{refused:?}"
            );
        }
    }
}
