//! Programs that carry this run's marker (#268 PR 2). Every program of a run gets the run's marker in its environment, and its
//! descendants inherit it. The supervisor finds them by the marker and ends them with the tree, so what left the tree (a new session
//! on macOS, another subreaper, `systemd-run`) does not outlive the run, also when the server is gone. When the server and the
//! supervisor both died, the restart recovery runs a supervisor only for this (`clean`).
//!
//! A program gets a signal only as the very process whose marker was read:
//! - Linux opens a process handle (pidfd, Linux 5.3) before the read that decides, checks after it that the handle still names a
//!   running process (a number reused in between leaves the handle on the ended one), and signals through the handle.
//! - macOS has no process handle. It reads the marker with the start time and reads the start time again right before each signal:
//!   the gap between that check and the signal is narrowed, not closed.
//!
//! A program of this user whose environment cannot be read may be ours if it started after the run (on Linux, also in the
//! supervisor's cgroup). It gets no signal and is reported as unverified, so the stop does not count as clean.

/// The marker's names: `BABOJUBOT_PROCESS_LEASE`, and `BABOJUBOT_PROCESS_LEASE_<n>` (a tree started inside a run keeps the outer
/// markers under the lower numbers and its own under the next one).
const MARKER_NAME: &[u8] = b"BABOJUBOT_PROCESS_LEASE";

/// Whether one environment entry (`NAME=VALUE`) is this marker: one of the marker's names, and exactly this value.
pub fn is_marker_entry(entry: &[u8], marker: &str) -> bool {
    let Some(equals) = entry.iter().position(|&byte| byte == b'=') else {
        return false;
    };
    let (name, value) = (&entry[..equals], &entry[equals + 1..]);
    let Some(number) = name.strip_prefix(MARKER_NAME) else {
        return false;
    };
    let named = match number {
        [] => true,
        [b'_', digits @ ..] => !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    named && value == marker.as_bytes()
}

/// What one read of a process's environment told about the marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    /// It carries the marker.
    Carries,
    /// Its environment was read and the marker is not in it.
    Clear,
    /// It ended, or the number names no process.
    Gone,
    /// It could not be read; it may carry the marker.
    Unreadable,
}

/// What one read of `/proc/<id>/environ` tells (Linux). An empty read is judged with the process's state (`stat`, read only
/// then). An error other than an ended or unreadable process is passed on.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn environ_reading(
    read: std::io::Result<Vec<u8>>,
    marker: &str,
    stat: impl FnOnce() -> std::io::Result<String>,
) -> std::io::Result<Reading> {
    match read {
        Ok(environment) if environment.is_empty() => Ok(empty_environ(stat)),
        Ok(environment) => Ok(
            if environment
                .split(|&byte| byte == 0)
                .any(|entry| is_marker_entry(entry, marker))
            {
                Reading::Carries
            } else {
                Reading::Clear
            },
        ),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
            Ok(Reading::Gone)
        }
        Err(error) if matches!(error.raw_os_error(), Some(libc::EACCES | libc::EPERM)) => {
            Ok(Reading::Unreadable)
        }
        Err(error) => Err(error),
    }
}

/// What a `KERN_PROCARGS2` buffer tells (macOS). macOS gives another process's environment only when that process is not code-signing
/// restricted (psutil quotes XNU: empty "unless ... target process is not cs_restricted", with SIP on), and the empty answer looks like
/// a process whose environment really is empty (this supervisor runs with none). So no environment entry is Clear only when
/// `restricted` (asked only then) says the process is not restricted; otherwise it is Unreadable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn procargs_reading(buffer: &[u8], marker: &str, restricted: impl FnOnce() -> bool) -> Reading {
    let mut entries = environment(buffer).peekable();
    if entries.peek().is_none() {
        return if restricted() {
            Reading::Unreadable
        } else {
            Reading::Clear
        };
    }
    if entries.any(|entry| is_marker_entry(entry, marker)) {
        Reading::Carries
    } else {
        Reading::Clear
    }
}

/// What an empty `/proc/<id>/environ` tells (Linux), given the process's state. The kernel reads the environment from the process's
/// memory, and a task without memory reads empty too: one that is ending, and one whose main thread is a zombie while other threads
/// still run user code (and can fork). So an empty read is a read that found no marker only for a process that runs with its main
/// thread (an environment that really is empty, `env -i`); one whose main thread is gone may carry the marker (#283 review 2).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn empty_environ(stat: impl FnOnce() -> std::io::Result<String>) -> Reading {
    match stat() {
        Ok(stat) => match life_in_stat(&stat) {
            Life::Runs => Reading::Clear,
            Life::Ended => Reading::Gone,
            Life::ThreadsRun | Life::Unknown => Reading::Unreadable,
        },
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
            Reading::Gone
        }
        Err(_) => Reading::Unreadable,
    }
}

/// What the read made after the handle is open says about a candidate (Linux).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirmed {
    /// Hold it: it carries the marker.
    Hold,
    /// Pass it over.
    Pass,
    /// It may be ours but could not be read: no signal, and the stop is not clean while it stays.
    Unverified,
}

/// Decides on a candidate from the read made after its handle was opened. A candidate that cannot be read now may still be ours (it
/// carried the marker a moment ago): it stays unverified, not passed over. Another failure is a failed look.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn confirm(
    second: std::io::Result<Vec<u8>>,
    marker: &str,
    stat: impl FnOnce() -> std::io::Result<String>,
) -> Result<Confirmed, String> {
    match environ_reading(second, marker, stat) {
        Ok(Reading::Carries) => Ok(Confirmed::Hold),
        Ok(Reading::Clear | Reading::Gone) => Ok(Confirmed::Pass),
        Ok(Reading::Unreadable) => Ok(Confirmed::Unverified),
        Err(error) => Err(format!(
            "the environment of a candidate could not be read: {error}"
        )),
    }
}

/// Whether a held program still runs, as far as could be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Running {
    Yes,
    Ended,
    /// It could not be told: no signal, and the stop is not clean while it stays (the unverified way).
    Unknown,
}

/// What the kernel's record of a process says (macOS): its start (microseconds since the epoch), whether it is a zombie, its real
/// user and its process group.
#[derive(Debug, Clone, Copy)]
pub struct Seen {
    pub start: u64,
    pub zombie: bool,
    pub user: libc::uid_t,
    /// Read by the macOS count of a process group's live members.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub group: libc::pid_t,
}

/// The size of the kernel's record of a process on 64-bit macOS (`struct kinfo_proc`, XNU `bsd/sys/sysctl.h`): 0x288 in the layout
/// cgo generates from the system headers for golang.org/x/sys `KinfoProc` (darwin/amd64 and darwin/arm64 alike).
const KINFO_PROC_SIZE: usize = 648;
/// Where the fields read are in that record (the same generated layout). `kp_proc` (`struct extern_proc`, XNU `bsd/sys/proc.h`) opens
/// with the union `p_un`, whose `__p_starttime` (`struct timeval`: seconds as i64, then microseconds as i32) is at 0; `kp_proc.p_stat`
/// is at 36; `kp_eproc` follows at 296, with `e_pcred.p_ruid` at 392 and `e_pgid` at 564.
const KINFO_START_SECONDS: usize = 0;
const KINFO_START_MICROSECONDS: usize = 8;
const KINFO_STAT: usize = 36;
const KINFO_REAL_USER: usize = 392;
const KINFO_GROUP: usize = 564;
/// `SZOMB` (XNU `bsd/sys/proc.h`): the process ended and waits to be reaped.
const SZOMB: u8 = 5;

/// `N` bytes of a record at `at`, in range by the record's checked size.
fn record_bytes<const N: usize>(record: &[u8], at: usize) -> [u8; N] {
    let mut bytes = [0u8; N];
    bytes.copy_from_slice(&record[at..at + N]);
    bytes
}

/// What the kernel's record of a process (`sysctl(KERN_PROC_PID)`) says, or `None` for an empty answer: the process is gone (psutil
/// takes it so). A record of another size, or with a start that is not a time, is not this record: an error, not a guess.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn seen_in_record(record: &[u8]) -> std::io::Result<Option<Seen>> {
    let invalid = |what: String| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the kernel's record of a process {what}"),
        )
    };
    if record.is_empty() {
        return Ok(None);
    }
    if record.len() != KINFO_PROC_SIZE {
        return Err(invalid(format!(
            "has {} bytes, not {KINFO_PROC_SIZE}",
            record.len()
        )));
    }
    let seconds = i64::from_ne_bytes(record_bytes(record, KINFO_START_SECONDS));
    let microseconds = i32::from_ne_bytes(record_bytes(record, KINFO_START_MICROSECONDS));
    let start = u64::try_from(seconds)
        .ok()
        .zip(u64::try_from(microseconds).ok())
        .filter(|&(_, microseconds)| microseconds < 1_000_000)
        .and_then(|(seconds, microseconds)| {
            seconds
                .checked_mul(1_000_000)
                .and_then(|start| start.checked_add(microseconds))
        })
        .ok_or_else(|| invalid(format!("has the start {seconds}.{microseconds}")))?;
    Ok(Some(Seen {
        start,
        zombie: record[KINFO_STAT] == SZOMB,
        user: u32::from_ne_bytes(record_bytes(record, KINFO_REAL_USER)),
        group: i32::from_ne_bytes(record_bytes(record, KINFO_GROUP)),
    }))
}

/// What a macOS candidate was decided to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Candidate {
    /// Hold it: it carries the marker, read along with this start.
    Hold {
        start: u64,
    },
    Pass,
    /// It may be ours but could not be read: no signal, and the stop is not clean while it stays.
    Unverified,
}

/// Decides on a process of this user's list (macOS) from its record read before and after its environment. The environment read in
/// between is the process's only when the start read again is the same. A process whose environment cannot be read is told by its
/// start: one that started before the run is not ours, one that started after it may be. One whose record cannot be read may be ours
/// as well: passing it over would let a holder of the marker outlive a stop that answers `ended` (#283 review 2).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn candidate(
    first: std::io::Result<Option<Seen>>,
    user: libc::uid_t,
    since: Option<u64>,
    reading: impl FnOnce() -> Reading,
    second: impl FnOnce() -> std::io::Result<Option<Seen>>,
) -> Candidate {
    let before = match first {
        Ok(Some(before)) => before,
        Ok(None) => return Candidate::Pass,
        // Without a beginning nothing is unverified (a clean request for a record kept without a start).
        Err(_) if since.is_none() => return Candidate::Pass,
        Err(_) => return Candidate::Unverified,
    };
    if before.user != user || before.zombie {
        return Candidate::Pass;
    }
    let reading = reading();
    let same = match second() {
        Ok(None) => return Candidate::Pass,
        Ok(Some(after)) => after.start == before.start,
        // What was read a moment ago cannot be told to be this process's.
        Err(_) => return Candidate::Unverified,
    };
    let after_run = same && since.is_some_and(|since| before.start >= since);
    match reading {
        Reading::Carries if same => Candidate::Hold {
            start: before.start,
        },
        Reading::Unreadable if after_run => Candidate::Unverified,
        Reading::Carries | Reading::Unreadable | Reading::Clear | Reading::Gone => Candidate::Pass,
    }
}

/// Whether the recorded start and the start read now are the same process's. Both are in the system's finest measure (the supervisor
/// reports its own start so; macOS: microseconds), so they are compared exactly: two processes with one number can start within the
/// same second (#283 review 2, SPEC-3).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn same_start(recorded: u64, now: u64) -> bool {
    recorded == now
}

/// Whether a held program that started at `start` still runs, from what reading its record gave (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn running_from(now: std::io::Result<Option<Seen>>, start: u64) -> Running {
    match now {
        Ok(Some(seen)) if seen.start == start && !seen.zombie => Running::Yes,
        Ok(Some(_) | None) => Running::Ended,
        // Only a process that is not there (`None`) has ended; a read that failed tells nothing.
        Err(_) => Running::Unknown,
    }
}

/// What a line of `/proc/<id>/stat` tells of a process's life (Linux). The state is the main thread's: a process of several threads
/// (Node.js ended by a signal) shows its main thread as a zombie while its other threads still run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Life {
    /// It runs, its main thread included.
    Runs,
    /// Its main thread is a zombie while other threads still run (or the thread count cannot be read): it still runs.
    ThreadsRun,
    /// It ended or is ending: dead, or a zombie of one thread.
    Ended,
    /// The line holds no state.
    Unknown,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn life_in_stat(stat: &str) -> Life {
    let fields = stat
        .rsplit_once(") ")
        .map(|(_, rest)| rest.split(' ').collect::<Vec<_>>())
        .unwrap_or_default();
    let threads = fields.get(17).and_then(|field| field.parse::<u64>().ok());
    match fields.first().copied() {
        None | Some("") => Life::Unknown,
        Some("X") => Life::Ended,
        Some("Z") if threads.is_some_and(|threads| threads <= 1) => Life::Ended,
        Some("Z") => Life::ThreadsRun,
        Some(_) => Life::Runs,
    }
}

/// Whether a held program still runs, from its handle's answer and its state (Linux). A process whose main thread is a zombie
/// still runs while another thread does (Node.js ended by a signal).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn running_from_handle(handle: std::io::Result<()>, stat: std::io::Result<String>) -> Running {
    match handle {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Running::Ended,
        // The handle could not tell: it may still run.
        Err(_) => return Running::Unknown,
    }
    match stat {
        Ok(stat) => match life_in_stat(&stat) {
            Life::Ended => Running::Ended,
            // The handle says it runs; a state that cannot be read does not say otherwise.
            Life::Runs | Life::ThreadsRun | Life::Unknown => Running::Yes,
        },
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
            Running::Ended
        }
        Err(_) => Running::Yes,
    }
}

/// What to look for: this run's marker, and when the run began, in the system's own measure of a start time (Linux: clock ticks
/// after boot; macOS: microseconds since the epoch). Without a beginning nothing is taken as unverified.
pub struct Search {
    pub marker: String,
    pub since: Option<u64>,
}

/// A program found by the marker.
pub trait Holder {
    fn pid(&self) -> libc::pid_t;
}

impl<H: Holder> Holder for std::rc::Rc<H> {
    fn pid(&self) -> libc::pid_t {
        (**self).pid()
    }
}

/// What one search found: the programs whose marker was read, and the programs that may be ours but could not be read.
pub struct Found<H> {
    pub holders: Vec<H>,
    pub unverified: Vec<libc::pid_t>,
}

/// The fields of `/proc/<id>/stat` after the command name, which ends with the last ") ".
#[cfg(target_os = "linux")]
fn stat_fields(stat: &str) -> Vec<&str> {
    stat.rsplit_once(") ")
        .map(|(_, rest)| rest.split(' ').collect())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
pub use linux::{Held, find, hold, signal, start_of_self, still_runs};

#[cfg(target_os = "linux")]
mod linux {
    use super::{
        Confirmed, Found, Reading, Running, Search, confirm, environ_reading, running_from_handle,
        stat_fields,
    };
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    /// A program whose marker was read, with the handle the read was checked against.
    pub struct Held {
        pid: libc::pid_t,
        handle: OwnedFd,
    }

    impl super::Holder for Held {
        fn pid(&self) -> libc::pid_t {
            self.pid
        }
    }

    fn open_handle(pid: libc::pid_t) -> io::Result<OwnedFd> {
        // SAFETY: pidfd_open takes integers and returns a new descriptor, or -1.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the descriptor is new and this process owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) })
    }

    fn send(handle: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
        // SAFETY: pidfd_send_signal takes the descriptor, the signal, a null siginfo and no flags.
        let sent = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                handle.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if sent == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// What the handle says: the process runs (or is an unreaped zombie), has ended (ESRCH), or it could not be told.
    fn handle_state(handle: &OwnedFd) -> Running {
        match send(handle, 0) {
            Ok(()) => Running::Yes,
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Running::Ended,
            Err(_) => Running::Unknown,
        }
    }

    fn gone(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
    }

    fn unreadable(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(libc::EACCES | libc::EPERM))
    }

    fn environ(pid: libc::pid_t) -> io::Result<Vec<u8>> {
        std::fs::read(format!("/proc/{pid}/environ"))
    }

    fn stat(pid: libc::pid_t) -> io::Result<String> {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
    }

    /// When this supervisor started (clock ticks after boot).
    pub fn start_of_self() -> Option<u64> {
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        stat_fields(&stat).get(19)?.parse().ok()
    }

    pub fn find(search: &Search) -> Result<Found<Held>, String> {
        // SAFETY: getpid has no memory effects.
        let me = unsafe { libc::getpid() };
        let mut cgroup: Option<Option<String>> = None;
        let mut found = Found {
            holders: Vec::new(),
            unverified: Vec::new(),
        };
        let entries = std::fs::read_dir("/proc")
            .map_err(|error| format!("the processes could not be listed: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("the processes could not be listed: {error}"))?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<libc::pid_t>().ok())
            else {
                continue;
            };
            if pid == me {
                continue;
            }
            // A first read only picks the candidates; the read that decides comes after the handle is open.
            match environ_reading(environ(pid), &search.marker, || stat(pid)) {
                Ok(Reading::Clear | Reading::Gone) => continue,
                Ok(Reading::Carries) => {}
                Ok(Reading::Unreadable) => {
                    let Some(since) = search.since else { continue };
                    let own = match &cgroup {
                        Some(own) => own.clone(),
                        None => {
                            let own = own_cgroup()?;
                            cgroup = Some(own.clone());
                            own
                        }
                    };
                    let handle = match open_handle(pid) {
                        Ok(handle) => handle,
                        Err(error) if gone(&error) => continue,
                        Err(error) => {
                            return Err(format!(
                                "a handle on process {pid} could not be opened: {error}"
                            ));
                        }
                    };
                    if may_be_ours(pid, since, own.as_deref())?
                        && handle_state(&handle) != Running::Ended
                    {
                        found.unverified.push(pid);
                    }
                    continue;
                }
                Err(error) => {
                    return Err(format!(
                        "the environment of process {pid} could not be read: {error}"
                    ));
                }
            }
            let handle = match open_handle(pid) {
                Ok(handle) => handle,
                Err(error) if gone(&error) => continue,
                Err(error) => {
                    return Err(format!(
                        "a handle on process {pid} could not be opened: {error}"
                    ));
                }
            };
            // What the handle says decides with the read: an ended process is passed over, one that cannot be told stays unverified.
            match (
                confirm(environ(pid), &search.marker, || stat(pid))?,
                handle_state(&handle),
            ) {
                (Confirmed::Pass, _) | (_, Running::Ended) => {}
                (Confirmed::Hold, Running::Yes) => found.holders.push(Held { pid, handle }),
                (Confirmed::Hold | Confirmed::Unverified, Running::Unknown)
                | (Confirmed::Unverified, Running::Yes) => found.unverified.push(pid),
            }
        }
        Ok(found)
    }

    /// The recorded process, held by a handle, when it is still the one that started at `start` (clock ticks after boot) and runs.
    pub fn hold(pid: libc::pid_t, start: u64) -> Result<Option<Held>, String> {
        let handle = match open_handle(pid) {
            Ok(handle) => handle,
            Err(error) if gone(&error) => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "a handle on process {pid} could not be opened: {error}"
                ));
            }
        };
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if gone(&error) => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "the state of process {pid} could not be read: {error}"
                ));
            }
        };
        let fields = stat_fields(&stat);
        let state = fields.first().copied().unwrap_or("");
        let Some(started) = fields.get(19).and_then(|field| field.parse::<u64>().ok()) else {
            return Err(format!("the start of process {pid} could not be read"));
        };
        if started != start || state == "Z" || state == "X" {
            return Ok(None);
        }
        match handle_state(&handle) {
            Running::Yes => Ok(Some(Held { pid, handle })),
            Running::Ended => Ok(None),
            Running::Unknown => Err(format!(
                "whether process {pid} still runs could not be told"
            )),
        }
    }

    /// Whether a held program still runs. Its handle says whether it ended; a process whose main thread is a zombie still runs while
    /// another thread does (Node.js ended by a signal), and a state that cannot be read leaves it running.
    pub fn still_runs(held: &Held) -> Running {
        running_from_handle(send(&held.handle, 0), stat(held.pid))
    }

    /// Whether the handle still reaches a running process (for the tests).
    #[cfg(test)]
    pub fn reaches(held: &Held) -> bool {
        handle_state(&held.handle) == Running::Yes
    }

    pub fn signal(held: &Held, signal: libc::c_int) -> Result<(), String> {
        match send(&held.handle, signal) {
            Ok(()) => Ok(()),
            Err(error) if gone(&error) => Ok(()),
            Err(error) => Err(format!(
                "program {}, which carries this run's marker, could not be signalled: {error}",
                held.pid
            )),
        }
    }

    /// This supervisor's cgroup. A kernel without cgroups has none, and then nothing is compared.
    fn own_cgroup() -> Result<Option<String>, String> {
        match std::fs::read_to_string("/proc/self/cgroup") {
            Ok(cgroup) => Ok(Some(cgroup)),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(None),
            Err(error) => Err(format!(
                "this supervisor's cgroup could not be read: {error}"
            )),
        }
    }

    /// A program whose environment could not be read may be ours: this user's, still running, started after the run, and in the
    /// supervisor's cgroup (a run's descendants inherit it; a desktop app or a systemd service runs in another one). Once it is this
    /// user's, what cannot be read about it does not clear it: an unreadable state or cgroup leaves it possibly ours, and a kernel
    /// without cgroups leaves the user and the start to decide. Its status cannot be read only when /proc hides another user's
    /// process (hidepid), so then it is not ours.
    fn may_be_ours(pid: libc::pid_t, since: u64, own: Option<&str>) -> Result<bool, String> {
        enum Read {
            Text(String),
            Gone,
            Unreadable,
        }
        let read = |what: &str| match std::fs::read_to_string(format!("/proc/{pid}/{what}")) {
            Ok(text) => Ok(Read::Text(text)),
            Err(error) if gone(&error) => Ok(Read::Gone),
            Err(error) if unreadable(&error) => Ok(Read::Unreadable),
            Err(error) => Err(format!(
                "the {what} of process {pid} could not be read: {error}"
            )),
        };
        let status = match read("status")? {
            Read::Text(status) => status,
            Read::Gone | Read::Unreadable => return Ok(false),
        };
        // SAFETY: getuid has no memory effects.
        let me = unsafe { libc::getuid() };
        let uid = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .and_then(|ids| ids.split_whitespace().next())
            .and_then(|real| real.parse::<libc::uid_t>().ok());
        match uid {
            Some(uid) if uid != me => return Ok(false),
            Some(_) => {}
            // A status without a readable user does not clear it.
            None => return Ok(true),
        }
        let stat = match read("stat")? {
            Read::Text(stat) => stat,
            Read::Gone => return Ok(false),
            Read::Unreadable => return Ok(true),
        };
        let fields = stat_fields(&stat);
        let state = fields.first().copied().unwrap_or("");
        let threads = fields.get(17).and_then(|field| field.parse::<u64>().ok());
        let runs = state != "X" && (state != "Z" || threads.is_none_or(|threads| threads > 1));
        let start = fields.get(19).and_then(|field| field.parse::<u64>().ok());
        if !runs || start.is_some_and(|start| start < since) {
            return Ok(false);
        }
        let Some(own) = own else { return Ok(true) };
        Ok(match read("cgroup")? {
            Read::Text(cgroup) => cgroup == own,
            Read::Gone => false,
            Read::Unreadable => true,
        })
    }
}

#[cfg(target_os = "macos")]
pub use macos::{Held, find, hold, record, signal, start_of_self, still_runs};

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        Candidate, Found, KINFO_PROC_SIZE, Reading, Running, Search, Seen, candidate,
        procargs_reading, running_from, same_start, seen_in_record,
    };
    use std::io;

    /// A program whose marker was read, with the start time read along with it.
    pub struct Held {
        pid: libc::pid_t,
        start: u64,
    }

    impl super::Holder for Held {
        fn pid(&self) -> libc::pid_t {
            self.pid
        }
    }

    /// The kernel's record of the process (`sysctl(KERN_PROC_PID)`, what `ps` and psutil read), or `None` when it is gone. Unlike
    /// `proc_pidinfo`, it is given for every process, also one whose information is refused to this credential (a set-id program,
    /// another user's), so such a process is told by its start rather than passed over. A record longer than this one makes the
    /// call fail (ENOMEM); a shorter one is refused by `seen_in_record`.
    pub fn record(pid: libc::pid_t) -> io::Result<Option<Seen>> {
        let mut buffer = vec![0u8; KINFO_PROC_SIZE];
        let mut size = buffer.len();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
        // SAFETY: the buffer is valid for `size` bytes.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                4,
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(size);
        seen_in_record(&buffer)
    }

    unsafe extern "C" {
        /// libSystem's code signing operations (XNU `sys/codesign.h`).
        fn csops(
            pid: libc::pid_t,
            ops: u32,
            useraddr: *mut libc::c_void,
            usersize: libc::size_t,
        ) -> libc::c_int;
    }
    /// `CS_OPS_STATUS` (XNU `sys/codesign.h`): the code signing flags of a process.
    const CS_OPS_STATUS: u32 = 0;
    /// `CS_RESTRICT` (XNU `osfmk/kern/cs_blobs.h`): the process is restricted; its environment is not given to others.
    const CS_RESTRICT: u32 = 0x0000_0800;

    /// Whether the kernel keeps this process's environment from others. A status that cannot be read leaves it kept.
    fn restricted(pid: libc::pid_t) -> bool {
        let mut flags: u32 = 0;
        // SAFETY: the buffer is a u32 of the size given.
        let read = unsafe {
            csops(
                pid,
                CS_OPS_STATUS,
                (&raw mut flags).cast(),
                std::mem::size_of::<u32>(),
            )
        };
        read != 0 || flags & CS_RESTRICT != 0
    }

    /// When this supervisor started (microseconds since the epoch).
    pub fn start_of_self() -> Option<u64> {
        // SAFETY: getpid has no memory effects.
        let me = unsafe { libc::getpid() };
        record(me).ok().flatten().map(|seen| seen.start)
    }

    /// `PROC_RUID_ONLY` from XNU's libproc.h (`proc_listpids` type: processes of one real user).
    const PROC_RUID_ONLY: u32 = 5;

    /// The processes whose real user is `uid`. A program this user started keeps this real user even when it runs set-id.
    fn pids_of(uid: libc::uid_t) -> io::Result<Vec<libc::pid_t>> {
        let size = std::mem::size_of::<libc::pid_t>();
        // SAFETY: a null buffer asks for the size needed.
        let needed = unsafe { libc::proc_listpids(PROC_RUID_ONLY, uid, std::ptr::null_mut(), 0) };
        if needed < 0 {
            return Err(io::Error::last_os_error());
        }
        // Room for processes that start between the two calls.
        let mut pids = vec![0 as libc::pid_t; needed as usize / size + 64];
        let bytes = libc::c_int::try_from(pids.len() * size).unwrap_or(libc::c_int::MAX);
        // SAFETY: the buffer is valid for `bytes`.
        let filled =
            unsafe { libc::proc_listpids(PROC_RUID_ONLY, uid, pids.as_mut_ptr().cast(), bytes) };
        if filled < 0 {
            return Err(io::Error::last_os_error());
        }
        pids.truncate(filled as usize / size);
        Ok(pids)
    }

    /// The process's arguments and environment as the kernel keeps them (`KERN_PROCARGS2`, what `ps` reads): the argument count,
    /// the executable path, then the arguments and the environment entries, each ending with NUL.
    fn arguments(pid: libc::pid_t) -> io::Result<Vec<u8>> {
        let mut argmax: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        // SAFETY: the buffers are valid for their sizes.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&raw mut argmax).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u8; argmax.max(0) as usize];
        let mut size = buffer.len();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        // SAFETY: the buffer is valid for `size` bytes.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(size);
        Ok(buffer)
    }

    pub fn find(search: &Search) -> Result<Found<Held>, String> {
        // SAFETY: getpid and getuid have no memory effects.
        let (me, uid) = unsafe { (libc::getpid(), libc::getuid()) };
        let mut found = Found {
            holders: Vec::new(),
            unverified: Vec::new(),
        };
        let pids =
            pids_of(uid).map_err(|error| format!("the processes could not be listed: {error}"))?;
        for pid in pids.into_iter().filter(|&pid| pid > 0 && pid != me) {
            let decided = candidate(
                record(pid),
                uid,
                search.since,
                || {
                    arguments(pid)
                        .map(|arguments| {
                            procargs_reading(&arguments, &search.marker, || restricted(pid))
                        })
                        .unwrap_or(Reading::Unreadable)
                },
                || record(pid),
            );
            match decided {
                Candidate::Hold { start } => found.holders.push(Held { pid, start }),
                Candidate::Unverified => found.unverified.push(pid),
                Candidate::Pass => {}
            }
        }
        Ok(found)
    }

    /// The recorded process when it is still the one that started at `start` (microseconds since the epoch, as the run's supervisor
    /// reported its own start).
    pub fn hold(pid: libc::pid_t, start: u64) -> Result<Option<Held>, String> {
        let now =
            record(pid).map_err(|error| format!("process {pid} could not be read: {error}"))?;
        Ok(now
            .filter(|now| !now.zombie && same_start(start, now.start))
            .map(|now| Held {
                pid,
                start: now.start,
            }))
    }

    /// Whether a held program still runs: the same start time, and not a zombie. Another user's process with its number now is not it.
    pub fn still_runs(held: &Held) -> Running {
        running_from(record(held.pid), held.start)
    }

    pub fn signal(held: &Held, signal: libc::c_int) -> Result<(), String> {
        // No process handle on macOS: the start time read right before the signal must be the one read with the marker.
        let now = record(held.pid).map_err(|error| {
            format!(
                "program {} could not be read before its signal: {error}",
                held.pid
            )
        })?;
        if now.is_none_or(|now| now.start != held.start || now.zombie) {
            return Ok(());
        }
        // SAFETY: kill has no memory effects; the number was checked to still be that process just above.
        if unsafe { libc::kill(held.pid, signal) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!(
            "program {}, which carries this run's marker, could not be signalled: {error}",
            held.pid
        ))
    }
}

/// The environment entries in a `KERN_PROCARGS2` buffer: after the argument count, the executable path and its padding, and the
/// arguments, up to the first empty entry. A buffer that does not hold that shape gives none.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn environment(buffer: &[u8]) -> impl Iterator<Item = &[u8]> {
    let entries = (|| {
        let count = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
        let rest = buffer.get(4..)?;
        let path_end = rest.iter().position(|&byte| byte == 0)?;
        let mut rest = rest.get(path_end..)?;
        while rest.first() == Some(&0) {
            rest = &rest[1..];
        }
        let mut entries = rest.split(|&byte| byte == 0);
        for _ in 0..count.max(0) {
            entries.next()?;
        }
        Some(entries)
    })();
    entries
        .into_iter()
        .flatten()
        .take_while(|entry| !entry.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{
        Candidate, Confirmed, Reading, Running, Seen, candidate, confirm, environ_reading,
        environment, is_marker_entry, procargs_reading, running_from, running_from_handle,
        same_start, seen_in_record,
    };

    #[test]
    fn a_marker_entry_has_a_marker_name_and_exactly_the_value() {
        let marker = "6f1c2a3e-1111-4222-8333-944455556666";
        assert!(is_marker_entry(
            format!("BABOJUBOT_PROCESS_LEASE={marker}").as_bytes(),
            marker
        ));
        assert!(is_marker_entry(
            format!("BABOJUBOT_PROCESS_LEASE_12={marker}").as_bytes(),
            marker
        ));
        assert!(!is_marker_entry(
            format!("BABOJUBOT_PROCESS_LEASE_={marker}").as_bytes(),
            marker
        ));
        assert!(!is_marker_entry(
            format!("BABOJUBOT_PROCESS_LEASE_X={marker}").as_bytes(),
            marker
        ));
        assert!(!is_marker_entry(
            format!("OTHER={marker}").as_bytes(),
            marker
        ));
        assert!(!is_marker_entry(
            format!("BABOJUBOT_PROCESS_LEASE={marker}x").as_bytes(),
            marker
        ));
        assert!(!is_marker_entry(b"BABOJUBOT_PROCESS_LEASE", marker));
    }

    /// A `KERN_PROCARGS2` buffer: the argument count, the executable path with padding, the arguments, then the environment.
    fn procargs(arguments: &[&str], environment: &[&str]) -> Vec<u8> {
        let mut buffer = (arguments.len() as i32).to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/bin/tool\0\0\0");
        for entry in arguments.iter().chain(environment) {
            buffer.extend_from_slice(entry.as_bytes());
            buffer.push(0);
        }
        buffer
    }

    /// #283 review 1, SPEC-1: macOS answers `KERN_PROCARGS2` for a restricted executable without its environment. A missing
    /// environment of a restricted process is not a read that found no marker: it could not be read. One of a process that is not
    /// restricted is an environment that really is empty (macOS CI showed this supervisor's own processes, which run with none).
    #[test]
    fn a_macos_process_without_an_environment_could_not_be_read() {
        let marker = "6f1c2a3e-1111-4222-8333-944455556666";
        let entry = format!("BABOJUBOT_PROCESS_LEASE={marker}");
        let restricted = || true;
        let not_restricted = || false;
        let never_asked = || -> bool { panic!("a process with an environment is not asked about") };
        assert_eq!(
            procargs_reading(&procargs(&["tool"], &[&entry]), marker, never_asked),
            Reading::Carries
        );
        assert_eq!(
            procargs_reading(&procargs(&["tool"], &["A=1"]), marker, never_asked),
            Reading::Clear
        );
        assert_eq!(
            procargs_reading(&procargs(&["tool"], &[]), marker, restricted),
            Reading::Unreadable
        );
        assert_eq!(
            procargs_reading(&procargs(&["tool", &entry], &[]), marker, restricted),
            Reading::Unreadable
        );
        assert_eq!(
            procargs_reading(b"\x01", marker, restricted),
            Reading::Unreadable
        );
        assert_eq!(
            procargs_reading(&procargs(&["tool"], &[]), marker, not_restricted),
            Reading::Clear
        );
    }

    /// #283 review 2, STD-2: a held program whose state cannot be read has not ended; it could not be told (macOS EPERM or EACCES,
    /// another failure). Only a process that is gone, a zombie, or another process with its number has ended.
    #[test]
    fn a_held_program_whose_state_cannot_be_read_has_not_ended() {
        fn error<T>(code: i32) -> std::io::Result<T> {
            Err(std::io::Error::from_raw_os_error(code))
        }
        let seen = |start, zombie| {
            Ok(Some(Seen {
                start,
                zombie,
                user: 501,
                group: 9,
            }))
        };
        assert_eq!(running_from(seen(7, false), 7), Running::Yes);
        assert_eq!(running_from(seen(7, true), 7), Running::Ended);
        assert_eq!(running_from(seen(8, false), 7), Running::Ended);
        assert_eq!(running_from(Ok(None), 7), Running::Ended);
        assert_eq!(running_from(error(libc::EPERM), 7), Running::Unknown);
        assert_eq!(running_from(error(libc::EACCES), 7), Running::Unknown);
        assert_eq!(running_from(error(libc::EIO), 7), Running::Unknown);
        let stat = |state: &str| {
            Ok(format!(
                "9 (x) {state} 1 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5"
            ))
        };
        assert_eq!(running_from_handle(Ok(()), stat("S")), Running::Yes);
        assert_eq!(running_from_handle(Ok(()), stat("Z")), Running::Ended);
        assert_eq!(
            running_from_handle(error(libc::ESRCH), stat("S")),
            Running::Ended
        );
        assert_eq!(
            running_from_handle(error(libc::EPERM), stat("S")),
            Running::Unknown
        );
        assert_eq!(
            running_from_handle(Ok(()), error(libc::EACCES)),
            Running::Yes
        );
        assert_eq!(
            running_from_handle(Ok(()), error(libc::ENOENT)),
            Running::Ended
        );
    }

    /// #283 review 2, STD-2 follow-up: a macOS process of this user whose information or environment is refused is told by
    /// its start, not passed over. One that started before the run is not ours; one that started after it may be ours and is
    /// unverified; one whose start cannot be read at all is unverified. Without a beginning nothing is unverified (round 1).
    #[test]
    fn a_macos_candidate_is_told_by_its_start_and_not_passed_over_when_refused() {
        fn error<T>(code: i32) -> std::io::Result<T> {
            Err(std::io::Error::from_raw_os_error(code))
        }
        let seen = |start, zombie, user| {
            Ok(Some(Seen {
                start,
                zombie,
                user,
                group: 9,
            }))
        };
        let decide = |first, since, reading: Reading, second| {
            Some(candidate(first, 501, since, || reading, || second))
        };
        let since = Some(100);
        let unreadable = Reading::Unreadable;
        // Started before the run: its environment being refused does not make it ours.
        assert_eq!(
            decide(
                seen(50, false, 501),
                since,
                unreadable,
                seen(50, false, 501)
            ),
            Some(Candidate::Pass)
        );
        // Started after the run: it may be ours.
        assert_eq!(
            decide(
                seen(150, false, 501),
                since,
                unreadable,
                seen(150, false, 501)
            ),
            Some(Candidate::Unverified)
        );
        // Its start could not be read: it may be ours, whatever the failure.
        assert_eq!(
            decide(error(libc::EPERM), since, unreadable, Ok(None)),
            Some(Candidate::Unverified)
        );
        assert_eq!(
            decide(error(libc::EIO), since, unreadable, Ok(None)),
            Some(Candidate::Unverified)
        );
        assert_eq!(
            decide(
                seen(150, false, 501),
                since,
                Reading::Clear,
                error(libc::EIO)
            ),
            Some(Candidate::Unverified)
        );
        // Without a beginning nothing is unverified.
        assert_eq!(
            decide(error(libc::EPERM), None, unreadable, Ok(None)),
            Some(Candidate::Pass)
        );
        // What is read decides the rest.
        assert_eq!(
            decide(
                seen(50, false, 501),
                since,
                Reading::Carries,
                seen(50, false, 501)
            ),
            Some(Candidate::Hold { start: 50 })
        );
        assert_eq!(
            decide(
                seen(50, false, 501),
                since,
                Reading::Carries,
                seen(60, false, 501)
            ),
            Some(Candidate::Pass)
        );
        assert_eq!(
            decide(seen(150, false, 501), since, Reading::Carries, Ok(None)),
            Some(Candidate::Pass)
        );
        assert_eq!(
            decide(
                seen(150, false, 502),
                since,
                unreadable,
                seen(150, false, 502)
            ),
            Some(Candidate::Pass)
        );
        assert_eq!(
            decide(
                seen(150, true, 501),
                since,
                unreadable,
                seen(150, true, 501)
            ),
            Some(Candidate::Pass)
        );
        assert_eq!(
            decide(Ok(None), since, unreadable, Ok(None)),
            Some(Candidate::Pass)
        );
    }

    /// The kernel's record of a process on 64-bit macOS (`sysctl(KERN_PROC_PID)`, `struct kinfo_proc`, 648 bytes): the start at 0
    /// (seconds, then microseconds at 8), the state at 36, the real user at 392, the process group at 564 (the layout cgo generates
    /// for golang.org/x/sys `KinfoProc`). An empty answer is a process that is gone (psutil); any other size is not this record.
    #[test]
    fn the_kernel_record_of_a_process_is_read_only_at_its_size() {
        let record = |stat: u8, usec: i32| {
            let mut buffer = vec![0u8; 648];
            buffer[..8].copy_from_slice(&1_700_000_000i64.to_ne_bytes());
            buffer[8..12].copy_from_slice(&usec.to_ne_bytes());
            buffer[36] = stat;
            buffer[392..396].copy_from_slice(&501u32.to_ne_bytes());
            buffer[564..568].copy_from_slice(&77i32.to_ne_bytes());
            buffer
        };
        let running = seen_in_record(&record(2, 123_456))
            .expect("read")
            .expect("runs");
        assert_eq!(running.start, 1_700_000_000_123_456);
        assert!(!running.zombie);
        assert_eq!(running.user, 501);
        assert_eq!(running.group, 77);
        assert!(
            seen_in_record(&record(5, 0))
                .expect("read")
                .expect("is there")
                .zombie
        );
        assert!(seen_in_record(&[]).expect("read").is_none());
        assert!(seen_in_record(&record(2, 0)[..647]).is_err());
        assert!(seen_in_record(&[record(2, 0), vec![0]].concat()).is_err());
        assert!(seen_in_record(&record(2, -1)).is_err());
    }

    /// #283 review 2, SPEC-3: a recorded start is compared exactly. Two processes with the same number that started in the same
    /// second are different processes.
    #[test]
    fn a_recorded_start_is_compared_exactly() {
        assert!(same_start(1_700_000_000_123_456, 1_700_000_000_123_456));
        assert!(!same_start(1_700_000_000_123_456, 1_700_000_000_654_321));
    }

    /// #283 review 2 (follow-up check): an empty `/proc/<id>/environ` is a read that found no marker only when the process has memory
    /// of its own. A process whose main thread is a zombie while other threads still run gives an empty read too, and it still runs
    /// user code and can fork: it may be ours. One that ended or is ending is gone, and a state that cannot be read leaves it unread.
    #[test]
    fn an_empty_linux_environment_is_judged_by_the_process_state() {
        let marker = "6f1c2a3e-1111-4222-8333-944455556666";
        let stat = |state: &'static str, threads: u32| {
            move || {
                Ok(format!(
                    "9 (x) {state} 1 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 {threads} 0 5"
                ))
            }
        };
        let failed = |code| {
            move || -> std::io::Result<String> { Err(std::io::Error::from_raw_os_error(code)) }
        };
        let empty = || Ok(Vec::new());
        let read = |stat| environ_reading(empty(), marker, stat).ok();
        assert_eq!(read(stat("Z", 3)), Some(Reading::Unreadable));
        assert_eq!(read(stat("Z", 1)), Some(Reading::Gone));
        assert_eq!(read(stat("X", 1)), Some(Reading::Gone));
        assert_eq!(read(stat("S", 1)), Some(Reading::Clear));
        assert_eq!(read(stat("R", 4)), Some(Reading::Clear));
        assert_eq!(
            environ_reading(empty(), marker, failed(libc::ENOENT)).ok(),
            Some(Reading::Gone)
        );
        assert_eq!(
            environ_reading(empty(), marker, failed(libc::EACCES)).ok(),
            Some(Reading::Unreadable)
        );
        assert_eq!(
            environ_reading(empty(), marker, || Ok("garbage".to_string())).ok(),
            Some(Reading::Unreadable)
        );
        // The read after the handle is open judges an empty read the same way.
        assert_eq!(
            confirm(empty(), marker, stat("Z", 3)),
            Ok(Confirmed::Unverified)
        );
        assert_eq!(confirm(empty(), marker, stat("Z", 1)), Ok(Confirmed::Pass));
    }

    /// #283 review 1, SPEC-2: the read made after the handle is open decides. One that cannot be read is not a read that found no
    /// marker; another failure is a failed look, not a pass.
    #[test]
    fn the_read_after_the_handle_decides_and_a_failure_is_not_a_pass() {
        let marker = "6f1c2a3e-1111-4222-8333-944455556666";
        let error = |code| Err(std::io::Error::from_raw_os_error(code));
        let marked = format!("A=1\0BABOJUBOT_PROCESS_LEASE={marker}\0").into_bytes();
        let never =
            || -> std::io::Result<String> { panic!("a read that is not empty needs no state") };
        assert_eq!(confirm(Ok(marked), marker, never), Ok(Confirmed::Hold));
        assert_eq!(
            confirm(Ok(b"A=1\0".to_vec()), marker, never),
            Ok(Confirmed::Pass)
        );
        assert_eq!(
            confirm(error(libc::ENOENT), marker, never),
            Ok(Confirmed::Pass)
        );
        assert_eq!(
            confirm(error(libc::ESRCH), marker, never),
            Ok(Confirmed::Pass)
        );
        assert_eq!(
            confirm(error(libc::EACCES), marker, never),
            Ok(Confirmed::Unverified)
        );
        assert_eq!(
            confirm(error(libc::EPERM), marker, never),
            Ok(Confirmed::Unverified)
        );
        assert!(confirm(error(libc::EIO), marker, never).is_err());
    }

    #[test]
    fn the_environment_starts_after_the_arguments() {
        let mut buffer = 2i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(
            b"/bin/tool\0\0\0tool\0BABOJUBOT_PROCESS_LEASE=in-an-argument\0A=1\0B=2\0\0junk\0",
        );
        let entries: Vec<&[u8]> = environment(&buffer).collect();
        assert_eq!(entries, vec![&b"A=1"[..], &b"B=2"[..]]);
        assert_eq!(environment(b"\x01").count(), 0);
    }
}

/// macOS: the kernel's record is read at the right places, and a process refused to this credential still has one.
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::macos::record;

    /// This process's own record gives its real user, its process group, and the start `proc_pidinfo` gives.
    #[test]
    fn the_record_of_this_process_is_read_at_the_right_places() {
        // SAFETY: getpid, getuid and getpgrp have no memory effects.
        let (me, uid, group) = unsafe { (libc::getpid(), libc::getuid(), libc::getpgrp()) };
        let seen = record(me).expect("read").expect("this process runs");
        assert_eq!(seen.user, uid);
        assert_eq!(seen.group, group);
        assert!(!seen.zombie);
        // SAFETY: a zeroed proc_bsdinfo is valid; proc_pidinfo fills at most its size.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is valid for `size` bytes.
        let filled = unsafe {
            libc::proc_pidinfo(me, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        assert_eq!(filled, size);
        assert_eq!(
            seen.start,
            info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
        );
    }

    /// launchd belongs to root, so its information is refused to this user's processes; its record still gives its start.
    #[test]
    fn a_process_of_another_user_has_its_record() {
        let launchd = record(1).expect("read").expect("launchd runs");
        assert_eq!(launchd.user, 0);
        assert!(launchd.start > 0);
    }

    /// A child that ended shows as a zombie until it is reaped, and has no record after.
    #[test]
    fn an_ended_child_is_a_zombie_and_then_has_no_record() {
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("true starts");
        let pid = child.id() as libc::pid_t;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !record(pid).expect("read").expect("not reaped").zombie {
            assert!(
                std::time::Instant::now() < deadline,
                "the child did not end"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.wait().expect("the child is reaped");
        assert!(record(pid).expect("read").is_none());
    }
}

/// Linux: the handle a marked program is held by stays on that very process. Once it ended, a signal through the handle reaches
/// nothing, whatever process gets its number later.
#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::linux::reaches;
    use super::{Holder, Running, Search, find, hold, signal, stat_fields, still_runs};
    use std::process::{Command, Stdio};

    #[test]
    fn a_marked_program_is_found_and_held_to_that_very_process() {
        let marker = format!(
            "test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        );
        let mut marked = Command::new("sleep")
            .arg("30")
            .env("BABOJUBOT_PROCESS_LEASE_3", &marker)
            .stdin(Stdio::null())
            .spawn()
            .expect("sleep runs");
        let mut other = Command::new("sleep").arg("30").spawn().expect("sleep runs");
        let search = Search {
            marker: marker.clone(),
            since: None,
        };
        let found = find(&search).expect("the processes can be searched");
        let pids: Vec<_> = found.holders.iter().map(Holder::pid).collect();
        assert_eq!(pids, vec![marked.id() as libc::pid_t]);
        // The program ends and is reaped: its number is free for another process, but the handle stays on the ended one.
        assert!(reaches(&found.holders[0]));
        marked.kill().expect("sleep can be killed");
        marked.wait().expect("sleep is reaped");
        assert!(!reaches(&found.holders[0]));
        assert_eq!(signal(&found.holders[0], libc::SIGKILL), Ok(()));
        assert!(
            find(&search)
                .expect("the processes can be searched")
                .holders
                .is_empty()
        );
        other.kill().expect("sleep can be killed");
        other.wait().expect("sleep is reaped");
    }

    #[test]
    fn the_recorded_process_is_held_only_while_it_is_the_one_that_started_then() {
        let mut child = Command::new("sleep").arg("30").spawn().expect("sleep runs");
        let pid = child.id() as libc::pid_t;
        let stat =
            std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("its state can be read");
        let start: u64 = stat_fields(&stat)[19]
            .parse()
            .expect("its start is a number");
        assert!(hold(pid, start + 1).expect("it can be looked at").is_none());
        let held = hold(pid, start)
            .expect("it can be looked at")
            .expect("it is that process");
        assert_eq!(held.pid(), pid);
        assert_eq!(signal(&held, libc::SIGKILL), Ok(()));
        child.wait().expect("sleep is reaped");
        assert!(hold(pid, start).expect("it can be looked at").is_none());
    }

    /// #283 review 1: a held program still runs until it has ended, even when a look no longer finds it by its environment.
    #[test]
    fn a_held_program_runs_until_it_has_ended() {
        let marker = format!(
            "runs-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        );
        let mut child = Command::new("sleep")
            .arg("30")
            .env("BABOJUBOT_PROCESS_LEASE", &marker)
            .spawn()
            .expect("sleep runs");
        let found = find(&Search {
            marker: marker.clone(),
            since: None,
        })
        .expect("the processes can be searched");
        let held = &found.holders[0];
        assert_eq!(still_runs(held), Running::Yes);
        assert_eq!(signal(held, libc::SIGKILL), Ok(()));
        // Ended but not reaped yet (a zombie of one thread): it no longer runs, though its number is still taken.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while still_runs(held) == Running::Yes && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(still_runs(held), Running::Ended);
        child.wait().expect("sleep is reaped");
        assert_eq!(still_runs(held), Running::Ended);
    }
}
