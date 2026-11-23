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

/// What one read of `/proc/<id>/environ` tells (Linux). An error other than an ended or unreadable process is passed on.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn environ_reading(read: std::io::Result<Vec<u8>>, marker: &str) -> std::io::Result<Reading> {
    match read {
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

/// What a `KERN_PROCARGS2` buffer tells (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn procargs_reading(buffer: &[u8], marker: &str) -> Reading {
    if environment(buffer).any(|entry| is_marker_entry(entry, marker)) {
        Reading::Carries
    } else {
        Reading::Clear
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
    #[allow(dead_code)]
    // `confirm` does not give it yet; the next commit does (#283 review 1, SPEC-2).
    Unverified,
}

/// Decides on a candidate from the read made after its handle was opened.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn confirm(second: std::io::Result<Vec<u8>>, marker: &str) -> Result<Confirmed, String> {
    Ok(match environ_reading(second, marker) {
        Ok(Reading::Carries) => Confirmed::Hold,
        Ok(Reading::Clear | Reading::Gone | Reading::Unreadable) | Err(_) => Confirmed::Pass,
    })
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
pub use linux::{Held, find, hold, signal, start_of_self};

#[cfg(target_os = "linux")]
mod linux {
    use super::{Confirmed, Found, Reading, Search, confirm, environ_reading, stat_fields};
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

    /// The handle still names a running process: what was read through its number after the handle was opened was that process's.
    fn still_running(handle: &OwnedFd) -> bool {
        send(handle, 0).is_ok()
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
            match environ_reading(environ(pid), &search.marker) {
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
                    let Ok(handle) = open_handle(pid) else {
                        continue;
                    };
                    if may_be_ours(pid, since, own.as_deref())? && still_running(&handle) {
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
            match confirm(environ(pid), &search.marker)? {
                Confirmed::Hold if still_running(&handle) => {
                    found.holders.push(Held { pid, handle })
                }
                Confirmed::Unverified if still_running(&handle) => found.unverified.push(pid),
                Confirmed::Hold | Confirmed::Unverified | Confirmed::Pass => {}
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
        let started = fields.get(19).and_then(|field| field.parse::<u64>().ok());
        let same = started == Some(start) && state != "Z" && state != "X";
        Ok((same && still_running(&handle)).then_some(Held { pid, handle }))
    }

    /// Whether the handle still reaches a running process (for the tests).
    #[cfg(test)]
    pub fn reaches(held: &Held) -> bool {
        still_running(&held.handle)
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
    /// supervisor's cgroup (a run's descendants inherit it; a desktop app or a systemd service runs in another one).
    fn may_be_ours(pid: libc::pid_t, since: u64, own: Option<&str>) -> Result<bool, String> {
        let Some(own) = own else { return Ok(false) };
        let read = |what: &str| match std::fs::read_to_string(format!("/proc/{pid}/{what}")) {
            Ok(text) => Ok(Some(text)),
            Err(error) if gone(&error) || unreadable(&error) => Ok(None),
            Err(error) => Err(format!(
                "the {what} of process {pid} could not be read: {error}"
            )),
        };
        let Some(status) = read("status")? else {
            return Ok(false);
        };
        // SAFETY: getuid has no memory effects.
        let me = unsafe { libc::getuid() };
        let uid = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .and_then(|ids| ids.split_whitespace().next())
            .and_then(|real| real.parse::<libc::uid_t>().ok());
        if uid != Some(me) {
            return Ok(false);
        }
        let Some(stat) = read("stat")? else {
            return Ok(false);
        };
        let fields = stat_fields(&stat);
        let state = fields.first().copied().unwrap_or("");
        let threads = fields.get(17).and_then(|field| field.parse::<u64>().ok());
        let runs = state != "X" && (state != "Z" || threads.is_none_or(|threads| threads > 1));
        let start = fields.get(19).and_then(|field| field.parse::<u64>().ok());
        if !runs || start.is_none_or(|start| start < since) {
            return Ok(false);
        }
        Ok(read("cgroup")?.as_deref() == Some(own))
    }
}

#[cfg(target_os = "macos")]
pub use macos::{Held, find, hold, signal, start_of_self};

#[cfg(target_os = "macos")]
mod macos {
    use super::{Found, Reading, Search, procargs_reading};
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

    /// Another user's or a protected process (EPERM): not this user's program.
    fn unreadable(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES))
    }

    /// The process's BSD information, or `None` when it ended.
    fn info(pid: libc::pid_t) -> io::Result<Option<libc::proc_bsdinfo>> {
        // SAFETY: a zeroed proc_bsdinfo is valid; proc_pidinfo fills at most its size.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is valid for `size` bytes.
        let filled = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        if filled == size {
            return Ok(Some(info));
        }
        let error = io::Error::last_os_error();
        if filled <= 0 && error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        Err(error)
    }

    /// Microseconds since the epoch.
    fn start_of(info: &libc::proc_bsdinfo) -> u64 {
        info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
    }

    /// When this supervisor started (microseconds since the epoch).
    pub fn start_of_self() -> Option<u64> {
        // SAFETY: getpid has no memory effects.
        let me = unsafe { libc::getpid() };
        info(me).ok().flatten().map(|info| start_of(&info))
    }

    fn pids() -> io::Result<Vec<libc::pid_t>> {
        // SAFETY: a null buffer asks for the count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        // Room for processes that start between the two calls.
        let mut pids = vec![0 as libc::pid_t; count as usize + 64];
        let bytes = libc::c_int::try_from(pids.len() * std::mem::size_of::<libc::pid_t>())
            .unwrap_or(libc::c_int::MAX);
        // SAFETY: the buffer is valid for `bytes`.
        let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if filled < 0 {
            return Err(io::Error::last_os_error());
        }
        pids.truncate(filled as usize);
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
        let pids = pids().map_err(|error| format!("the processes could not be listed: {error}"))?;
        for pid in pids.into_iter().filter(|&pid| pid > 0 && pid != me) {
            // A process this user cannot read is not this user's (another user's, or protected): it is passed over.
            let read = |pid| match info(pid) {
                Ok(found) => Ok(found),
                Err(error) if unreadable(&error) => Ok(None),
                Err(error) => Err(format!("process {pid} could not be read: {error}")),
            };
            let Some(before) = read(pid)? else { continue };
            // Another user's program is not ours, and its environment is not this user's to read.
            if before.pbi_ruid != uid || before.pbi_status == libc::SZOMB {
                continue;
            }
            let start = start_of(&before);
            let reading = arguments(pid)
                .map(|arguments| procargs_reading(&arguments, &search.marker))
                .unwrap_or(Reading::Unreadable);
            // The start time read again says the arguments read in between were this process's.
            let same = read(pid)?.is_some_and(|after| start_of(&after) == start);
            let may_be_ours = same && search.since.is_some_and(|since| start >= since);
            match reading {
                Reading::Carries if same => found.holders.push(Held { pid, start }),
                Reading::Unreadable if may_be_ours => found.unverified.push(pid),
                Reading::Carries | Reading::Unreadable | Reading::Clear | Reading::Gone => {}
            }
        }
        Ok(found)
    }

    /// The recorded process when it is still the one that started at `start` (microseconds since the epoch). Records keep the start
    /// to the second (`ps -o lstart`), so it is compared to the second.
    pub fn hold(pid: libc::pid_t, start: u64) -> Result<Option<Held>, String> {
        let now = match info(pid) {
            Ok(now) => now,
            // Not this user's process: not the recorded one.
            Err(error) if unreadable(&error) => None,
            Err(error) => return Err(format!("process {pid} could not be read: {error}")),
        };
        Ok(now
            .filter(|now| {
                now.pbi_status != libc::SZOMB && start_of(now) / 1_000_000 == start / 1_000_000
            })
            .map(|now| Held {
                pid,
                start: start_of(&now),
            }))
    }

    pub fn signal(held: &Held, signal: libc::c_int) -> Result<(), String> {
        // No process handle on macOS: the start time read right before the signal must be the one read with the marker.
        let now = info(held.pid).map_err(|error| {
            format!(
                "program {} could not be read before its signal: {error}",
                held.pid
            )
        })?;
        if now.is_none_or(|now| start_of(&now) != held.start || now.pbi_status == libc::SZOMB) {
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
    use super::{environment, is_marker_entry};

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

/// Linux: the handle a marked program is held by stays on that very process. Once it ended, a signal through the handle reaches
/// nothing, whatever process gets its number later.
#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::linux::reaches;
    use super::{Holder, Search, find, hold, signal, stat_fields};
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
}
