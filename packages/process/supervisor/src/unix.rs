//! Linux and macOS (#268). The supervisor starts the program in a new process group and does not reap it until after the last
//! signal to that group: while the program is unreaped (even as a zombie), the system gives neither its process id nor its group id
//! to another process, so the group signals cannot reach an unrelated program. The control channel is file descriptor 3, a socket
//! that Node.js makes; the program does not inherit it.
//!
//! Command line: `<this program> <program> <arguments...>`. The program is looked up on the PATH of the environment this supervisor
//! was given, as Node.js does, and inherits that environment, the working folder and file descriptors 0–2. Once the program runs,
//! the supervisor points its own 0–2 at /dev/null, so the program's output closes when the program's tree closes it.

use crate::protocol::{self, Channel, Exit, Read, StopResult, Termination, Tree};
use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const CONTROL: libc::c_int = 3;

fn errno() -> libc::c_int {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

static TERMINATE: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

struct Signals;

impl Termination for Signals {
    fn requested(&self) -> bool {
        TERMINATE.load(Ordering::SeqCst)
    }
}

/// SIGTERM, SIGINT and SIGHUP to the supervisor end the tree as a stop does. The program gets the default handling back when it
/// starts (exec resets caught signals).
fn catch_termination() -> io::Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: a zeroed sigaction is valid, and the handler only stores to an atomic.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as *const () as libc::sighandler_t;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

struct Control;

impl Control {
    /// The channel must be open, and it must not reach the program: the end of the channel is how the supervisor learns that the
    /// server is gone, so only the server may hold the other end and only this supervisor this end.
    fn open() -> Result<Self, &'static str> {
        // SAFETY: fcntl on a descriptor number has no memory effects.
        let flags = unsafe { libc::fcntl(CONTROL, libc::F_GETFD) };
        if flags < 0 {
            return Err("the supervisor was not given a control channel");
        }
        // SAFETY: as above.
        let kept = unsafe {
            libc::fcntl(CONTROL, libc::F_SETFD, flags | libc::FD_CLOEXEC) == 0
                && libc::fcntl(CONTROL, libc::F_GETFD) & libc::FD_CLOEXEC != 0
        };
        if !kept {
            return Err("the control channel could not be kept from the program");
        }
        Ok(Self)
    }
}

impl Channel for Control {
    fn read(&mut self, wait: Duration) -> Read {
        let mut ready = libc::pollfd {
            fd: CONTROL,
            events: libc::POLLIN,
            revents: 0,
        };
        let wait = libc::c_int::try_from(wait.as_millis()).unwrap_or(libc::c_int::MAX);
        // SAFETY: one valid pollfd.
        match unsafe { libc::poll(&mut ready, 1, wait) } {
            0 => return Read::Nothing,
            n if n < 0 => {
                return if errno() == libc::EINTR {
                    Read::Nothing
                } else {
                    Read::Closed
                };
            }
            _ => {}
        }
        let mut buffer = [0u8; 4096];
        // SAFETY: the buffer is valid for its length.
        let read = unsafe { libc::read(CONTROL, buffer.as_mut_ptr().cast(), buffer.len()) };
        match usize::try_from(read) {
            Ok(0) => Read::Closed,
            Ok(n) => Read::Bytes(buffer[..n].to_vec()),
            Err(_) if matches!(errno(), libc::EINTR | libc::EAGAIN) => Read::Nothing,
            Err(_) => Read::Closed,
        }
    }

    fn write_message(&mut self, message: &str) {
        let bytes = protocol::frame(message);
        let mut written = 0;
        while written < bytes.len() {
            // SAFETY: the range is inside the buffer.
            let n = unsafe {
                libc::write(
                    CONTROL,
                    bytes[written..].as_ptr().cast(),
                    bytes.len() - written,
                )
            };
            match usize::try_from(n) {
                Ok(n) => written += n,
                Err(_) if errno() == libc::EINTR => {}
                Err(_) if errno() == libc::EAGAIN => {
                    let mut ready = libc::pollfd {
                        fd: CONTROL,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    // SAFETY: one valid pollfd.
                    unsafe { libc::poll(&mut ready, 1, 100) };
                }
                // The server is gone. The next read reports the end of the channel.
                Err(_) => return,
            }
        }
    }
}

fn errno_name(code: Option<i32>) -> &'static str {
    match code {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOEXEC) => "ENOEXEC",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::E2BIG) => "E2BIG",
        Some(libc::ETXTBSY) => "ETXTBSY",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::EAGAIN) => "EAGAIN",
        _ => "UNKNOWN",
    }
}

fn signal_name(signal: libc::c_int) -> &'static str {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGSYS => "SIGSYS",
        _ => "SIGUNKNOWN",
    }
}

fn exit_of(code: libc::c_int, status: libc::c_int) -> Option<Exit> {
    match code {
        libc::CLD_EXITED => Some(Exit::Code(status)),
        libc::CLD_KILLED | libc::CLD_DUMPED => Some(Exit::Signal(signal_name(status))),
        _ => None,
    }
}

/// The program, which is also its process group's leader, and its group.
struct Leader {
    pid: libc::pid_t,
}

impl Leader {
    /// The program's end if it has ended, without reaping it (`WNOWAIT`): its id stays taken. Stopped or continued states are not
    /// an end (Darwin can report them).
    fn peek(&self) -> Option<Exit> {
        // SAFETY: a zeroed siginfo_t is valid; waitid fills it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
        // SAFETY: valid pointer to the siginfo_t above.
        if unsafe { libc::waitid(libc::P_PID, self.pid as libc::id_t, &mut info, flags) } != 0 {
            return None;
        }
        // SAFETY: waitid filled the fields for a child state change, or left them zero when none.
        let (pid, status) = unsafe { (info.si_pid(), info.si_status()) };
        if pid != self.pid {
            return None;
        }
        exit_of(info.si_code, status)
    }

    /// After the last group signal: reaps the program and gives its end. A program that left its group is ended here, while its id
    /// is still ours.
    fn reap(&self) -> Result<Exit, String> {
        if self.peek().is_none() {
            // SAFETY: kill has no memory effects; the id is the unreaped program's.
            unsafe { libc::kill(self.pid, libc::SIGKILL) };
            let deadline = Instant::now() + protocol::END_LIMIT;
            while self.peek().is_none() {
                if Instant::now() >= deadline {
                    return Err("1 (the program did not end)".to_owned());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let mut status = 0;
        loop {
            // SAFETY: valid pointer to status.
            let reaped = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            if reaped == self.pid {
                break;
            }
            if reaped < 0 && errno() == libc::EINTR {
                continue;
            }
            return Err(format!(
                "unknown (the program's end could not be read: {})",
                io::Error::last_os_error()
            ));
        }
        Ok(if libc::WIFSIGNALED(status) {
            Exit::Signal(signal_name(libc::WTERMSIG(status)))
        } else {
            Exit::Code(libc::WEXITSTATUS(status))
        })
    }
}

/// The system calls a stop makes on the tree: the program's group and, on Linux, the orphans outside it that this supervisor took
/// in. Kept apart from the stop's order (`end_tree`) so that order can be tested without real processes.
trait Reach {
    fn group_live(&self) -> Result<usize, String>;
    fn orphans(&self) -> Result<Vec<libc::pid_t>, String>;
    fn signal_group(&self, signal: libc::c_int) -> Result<(), String>;
    fn signal_orphan(&self, orphan: libc::pid_t, signal: libc::c_int) -> Result<(), String>;
}

impl Reach for Leader {
    fn group_live(&self) -> Result<usize, String> {
        live_group_members(self.pid)
            .map_err(|error| format!("unknown (the process group could not be listed: {error})"))
    }

    fn orphans(&self) -> Result<Vec<libc::pid_t>, String> {
        orphans_outside(self.pid)
    }

    fn signal_group(&self, signal: libc::c_int) -> Result<(), String> {
        // SAFETY: killpg has no memory effects. The group id is the unreaped leader's id, so it is still this tree's group.
        if unsafe { libc::killpg(self.pid, signal) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(()),
            // Darwin answers EPERM when the group's only members are zombies (the unreaped program): nothing is left to signal.
            Some(libc::EPERM) if live_group_members(self.pid).is_ok_and(|live| live == 0) => Ok(()),
            _ => Err(format!(
                "unknown (the process group could not be signalled: {error})"
            )),
        }
    }

    fn signal_orphan(&self, orphan: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
        // SAFETY: kill has no memory effects. The orphan is this supervisor's unreaped child, so its id is still that process's.
        if unsafe { libc::kill(orphan, signal) } != 0 && errno() != libc::ESRCH {
            return Err(format!(
                "unknown (a program that left the process group could not be signalled: {})",
                io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

/// What still runs of the tree.
fn live_members(reach: &impl Reach) -> Result<usize, String> {
    Ok(reach.group_live()? + reach.orphans()?.len())
}

fn signal_tree(reach: &impl Reach, signal: libc::c_int) -> Result<(), String> {
    reach.signal_group(signal)?;
    signal_orphans(reach, signal)
}

fn signal_orphans(reach: &impl Reach, signal: libc::c_int) -> Result<(), String> {
    for orphan in reach.orphans()? {
        reach.signal_orphan(orphan, signal)?;
    }
    Ok(())
}

/// Waits until nothing of the tree runs, or until `limit`. Gives how many are left. `repeat` is sent again on every look to the
/// orphans outside the group, so it also reaches those taken in during the wait (a program's children are taken in when it
/// ends). The group got its signal already, and what is in it cannot leave a group being killed.
fn wait_until_empty(
    reach: &impl Reach,
    limit: Duration,
    repeat: Option<libc::c_int>,
) -> Result<usize, String> {
    let deadline = Instant::now() + limit;
    loop {
        let left = live_members(reach)?;
        if left == 0 || Instant::now() >= deadline {
            return Ok(left);
        }
        if let Some(signal) = repeat {
            signal_orphans(reach, signal)?;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// SIGTERM, the grace, SIGKILL, then a bounded wait (`limit`) until nothing of the tree runs.
fn end_tree(reach: &impl Reach, grace: Duration, limit: Duration) -> StopResult {
    let mut left = live_members(reach)?;
    if left > 0 {
        signal_tree(reach, libc::SIGTERM)?;
        left = wait_until_empty(reach, grace, None)?;
    }
    if left > 0 {
        signal_tree(reach, libc::SIGKILL)?;
        left = wait_until_empty(reach, limit, Some(libc::SIGKILL))?;
    }
    if left > 0 {
        return Err(format!("{left} (the tree did not end)"));
    }
    Ok(())
}

/// Reaps the children that ended (on Linux, also the orphans this supervisor took in as their subreaper).
fn reap_ended_children() {
    let mut status = 0;
    // SAFETY: valid pointer to status.
    while unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) } > 0 {}
}

impl Tree for Leader {
    fn tend(&mut self) {
        reap_ended_orphans(self.pid);
    }

    fn leader_exit(&mut self) -> Option<Exit> {
        self.peek()
    }

    fn interrupt(&mut self) {
        // An interrupt is a request, not a stop: a group that is already gone has nothing to interrupt.
        let _ = Reach::signal_group(self, libc::SIGINT);
    }

    fn kill_leader(&mut self) {
        // SAFETY: kill has no memory effects; the id is the unreaped program's.
        unsafe { libc::kill(self.pid, libc::SIGKILL) };
    }

    fn stop(&mut self, grace: Duration) -> (Option<Exit>, StopResult) {
        if let Err(left) = end_tree(self, grace, protocol::END_LIMIT) {
            // Something of the group still runs. The program stays unreaped so its ids stay taken.
            return (self.peek(), Err(left));
        }
        let exit = self.reap();
        reap_ended_children();
        match exit {
            Ok(exit) => (Some(exit), Ok(())),
            Err(left) => (None, Err(left)),
        }
    }
}

#[cfg(target_os = "linux")]
fn live_group_members(group: libc::pid_t) -> io::Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir("/proc")? {
        let name = entry?.file_name();
        let Some(pid) = name.to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            // Ended in the meantime, or not readable: not ours (the group's processes are this user's).
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ESRCH | libc::EACCES | libc::EPERM)
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        if group_member_runs(&stat, group) {
            count += 1;
        }
    }
    Ok(count)
}

/// Linux: whether `/proc/<id>/stat` is of a process in `group` that still runs. The state is the main thread's: a process of several
/// threads (Node.js) shows its main thread as a zombie while its other threads still end, and its children go to the supervisor only
/// once the last thread is gone. So a zombie still runs while it counts more than one thread.
#[cfg(target_os = "linux")]
fn group_member_runs(stat: &str, group: libc::pid_t) -> bool {
    // The fields after the command name, which ends with the last ") ": state, parent, process group, ..., thread count (the 18th).
    let Some((_, rest)) = stat.rsplit_once(") ") else {
        return false;
    };
    let fields: Vec<&str> = rest.split(' ').collect();
    let state = fields.first().copied().unwrap_or("");
    let pgrp = fields
        .get(2)
        .and_then(|field| field.parse::<libc::pid_t>().ok());
    let threads = fields.get(17).and_then(|field| field.parse::<u64>().ok());
    if pgrp != Some(group) || state == "X" {
        return false;
    }
    state != "Z" || threads.is_none_or(|threads| threads > 1)
}

#[cfg(target_os = "macos")]
fn live_group_members(group: libc::pid_t) -> io::Result<usize> {
    /// `PROC_PGRP_ONLY` from XNU's libproc.h (`proc_listpids` type: processes of one process group).
    const PROC_PGRP_ONLY: u32 = 2;
    let size = std::mem::size_of::<libc::pid_t>();
    // SAFETY: a null buffer asks for the size needed.
    let needed =
        unsafe { libc::proc_listpids(PROC_PGRP_ONLY, group as u32, std::ptr::null_mut(), 0) };
    if needed < 0 {
        return Err(io::Error::last_os_error());
    }
    // Room for processes that start between the two calls.
    let mut pids = vec![0 as libc::pid_t; needed as usize / size + 16];
    let bytes = libc::c_int::try_from(pids.len() * size).unwrap_or(libc::c_int::MAX);
    // SAFETY: the buffer is valid for `bytes`.
    let filled = unsafe {
        libc::proc_listpids(
            PROC_PGRP_ONLY,
            group as u32,
            pids.as_mut_ptr().cast(),
            bytes,
        )
    };
    if filled < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut count = 0;
    for &pid in &pids[..filled as usize / size] {
        if pid == 0 {
            continue;
        }
        // SAFETY: a zeroed proc_bsdinfo is valid; proc_pidinfo fills it.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let info_size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is valid for `info_size`.
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                info_size,
            )
        };
        // A process that ended in the meantime has no information any more: it is not live.
        if got == info_size && info.pbi_pgid == group as u32 && info.pbi_status != libc::SZOMB {
            count += 1;
        }
    }
    Ok(count)
}

/// Linux: the supervisor takes in the tree's orphans (subreaper): a live orphan's id cannot go to another process, because only this
/// supervisor reaps it. Like an init process (tini, dumb-init), the supervisor reaps an orphan as soon as it ends, so an ended program
/// does not linger as a zombie that looks alive to others. Only the program itself stays unreaped until the last group signal. A stop
/// ends the orphans that left the group (a new session) along with the group, so what left the group ends with the tree even when
/// the server's marker cleanup does not get to it. A descendant that left the group while its parent still runs is reached once the
/// stop ends that parent. The program also dies with the supervisor (parent-death signal).
#[cfg(target_os = "linux")]
fn prepare_system() -> Result<(), String> {
    // SAFETY: a zeroed sigaction is valid, and the handler only stores to an atomic.
    let caught = unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_child_ended as *const () as libc::sighandler_t;
        action.sa_flags = libc::SA_NOCLDSTOP | libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) == 0
    };
    if !caught {
        return Err(format!(
            "the supervisor could not watch its children: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: prctl with integer arguments.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(format!(
            "the supervisor could not take in the tree's orphans: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn prepare_system() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
static CHILD_ENDED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
extern "C" fn on_child_ended(_: libc::c_int) {
    CHILD_ENDED.store(true, Ordering::SeqCst);
}

/// Linux: the supervisor's children, live or ended but not reaped (the program and the orphans it took in). The kernel lists them
/// in `/proc/self/task/<id>/children`; without that file (`CONFIG_PROC_CHILDREN` off), every process's parent is read instead.
#[cfg(target_os = "linux")]
fn children() -> io::Result<Vec<libc::pid_t>> {
    // SAFETY: getpid has no memory effects.
    let me = unsafe { libc::getpid() };
    match std::fs::read_to_string(format!("/proc/self/task/{me}/children")) {
        Ok(list) => {
            return Ok(list
                .split_whitespace()
                .filter_map(|pid| pid.parse().ok())
                .collect());
        }
        Err(error) if error.raw_os_error() != Some(libc::ENOENT) => return Err(error),
        Err(_) => {}
    }
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let name = entry?.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let parent = stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split(' ').nth(1)?.parse::<libc::pid_t>().ok());
        if parent == Some(me) {
            found.push(pid);
        }
    }
    Ok(found)
}

/// Linux: after a child ended (SIGCHLD), reaps every ended child except the program. A child that is still running is not touched.
/// When the children cannot be listed, the next SIGCHLD tries again and the stop reaps them at the latest.
#[cfg(target_os = "linux")]
fn reap_ended_orphans(program: libc::pid_t) {
    if !CHILD_ENDED.swap(false, Ordering::SeqCst) {
        return;
    }
    let Ok(children) = children() else { return };
    for child in children.into_iter().filter(|&child| child != program) {
        let mut status = 0;
        // SAFETY: valid pointer to status; WNOHANG leaves a running child alone.
        unsafe { libc::waitpid(child, &mut status, libc::WNOHANG) };
    }
}

/// Linux: the orphans this supervisor took in that still run outside the program's group (those in it go with the group signals).
/// Ended ones are reaped on the way. Each one is this supervisor's unreaped child, so its id is not given to another process.
#[cfg(target_os = "linux")]
fn orphans_outside(program: libc::pid_t) -> Result<Vec<libc::pid_t>, String> {
    let children = children().map_err(|error| {
        format!("unknown (the programs that left the process group could not be listed: {error})")
    })?;
    let mut running = Vec::new();
    for child in children.into_iter().filter(|&child| child != program) {
        let mut status = 0;
        // SAFETY: valid pointer to status; WNOHANG leaves a running child alone.
        if unsafe { libc::waitpid(child, &mut status, libc::WNOHANG) } != 0 {
            // Reaped now, or no longer this supervisor's child.
            continue;
        }
        // SAFETY: getpgid has no memory effects; the id is this supervisor's running child.
        if unsafe { libc::getpgid(child) } != program {
            running.push(child);
        }
    }
    Ok(running)
}

/// macOS has no subreaper: the program is the supervisor's only child, and it stays unreaped until the last group signal.
#[cfg(target_os = "macos")]
fn reap_ended_orphans(_program: libc::pid_t) {}

/// macOS: what left the group is not this supervisor's child; the server's marker cleanup ends it after the supervisor ends.
#[cfg(target_os = "macos")]
fn orphans_outside(_program: libc::pid_t) -> Result<Vec<libc::pid_t>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
fn die_with_supervisor(command: &mut Command) {
    // SAFETY: getpid has no memory effects.
    let supervisor = unsafe { libc::getpid() };
    // SAFETY: the closure runs in the child before exec and only calls async-signal-safe functions.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // The supervisor died before the signal was set: do not run without it.
            if libc::getppid() != supervisor {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
}

#[cfg(target_os = "macos")]
fn die_with_supervisor(_command: &mut Command) {}

enum StartFailure {
    Failed(String),
    NotStarted(&'static str, String),
}

fn start(arguments: &[OsString], env: &[(String, String)]) -> Result<Leader, StartFailure> {
    let Some((program, rest)) = arguments.split_first() else {
        return Err(StartFailure::Failed(
            "the supervisor was not given a program".to_owned(),
        ));
    };
    prepare_system().map_err(StartFailure::Failed)?;
    let mut command = Command::new(program);
    command
        .args(rest)
        .envs(env.iter().map(|(name, value)| (name, value)))
        .process_group(0);
    die_with_supervisor(&mut command);
    match command.spawn() {
        Ok(child) => {
            let pid = libc::pid_t::try_from(child.id())
                .map_err(|_| StartFailure::Failed("the program's id is out of range".to_owned()))?;
            // The child handle neither waits nor kills on drop; the supervisor reaps the program itself after the last signal.
            drop(child);
            Ok(Leader { pid })
        }
        Err(error) => Err(StartFailure::NotStarted(
            errno_name(error.raw_os_error()),
            error.to_string(),
        )),
    }
}

/// Points the supervisor's own 0–2 at /dev/null: the program holds its own copies, and the output closes when its tree closes it.
fn release_standard_streams() {
    // SAFETY: open, dup2 and close on descriptors this process owns.
    unsafe {
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
        for fd in 0..3 {
            if null >= 0 {
                libc::dup2(null, fd);
            } else {
                libc::close(fd);
            }
        }
        if null > 2 {
            libc::close(null);
        }
    }
}

pub fn run() -> i32 {
    let mut control = match Control::open() {
        Ok(control) => control,
        Err(why) => {
            eprintln!("[babojubot-supervisor] failed: {why}");
            return 1;
        }
    };
    control.write_message(&protocol::hello());
    if let Err(error) = catch_termination() {
        control.write_message(&format!(
            "failed: the supervisor could not catch termination signals: {error}"
        ));
        return 1;
    }
    let start_request = match protocol::read_start(&mut control, &Signals) {
        protocol::StartRequest::Start(start) => start,
        protocol::StartRequest::Ended => return 1,
        protocol::StartRequest::Refused(why) => {
            control.write_message(&format!("failed: {why}"));
            return 1;
        }
    };
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut leader = match start(&arguments, &start_request.env) {
        Ok(leader) => leader,
        Err(StartFailure::Failed(why)) => {
            control.write_message(&format!("failed: {why}"));
            return 1;
        }
        Err(StartFailure::NotStarted(code, why)) => {
            control.write_message(&format!("not-started {code}: {why}"));
            return 1;
        }
    };
    control.write_message(&format!("ok {}", leader.pid));
    release_standard_streams();
    protocol::supervise(&mut control, &mut leader, &Signals, start_request)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::group_member_runs;

    /// A `/proc/<id>/stat` line of process 200 in group 100 (the command name has the separator in it), with its state and threads.
    fn stat(state: &str, threads: u32) -> String {
        format!(
            "200 (node ) S x) {state} 100 100 100 0 -1 4194304 92 0 0 0 0 0 0 0 20 0 {threads} 0 148788766 5980160 392"
        )
    }

    #[test]
    fn a_member_runs_until_its_last_thread_ends() {
        assert!(group_member_runs(&stat("S", 1), 100));
        assert!(group_member_runs(&stat("R", 7), 100));
        // Node.js ended by a signal: the main thread is a zombie while the other threads still end; its children are not handed over yet.
        assert!(group_member_runs(&stat("Z", 7), 100));
        assert!(!group_member_runs(&stat("Z", 1), 100));
        assert!(!group_member_runs(&stat("X", 1), 100));
    }

    #[test]
    fn a_process_of_another_group_is_not_a_member() {
        assert!(!group_member_runs(&stat("S", 1), 101));
        assert!(!group_member_runs("garbage", 100));
    }
}
