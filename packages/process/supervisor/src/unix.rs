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

    fn write_line(&mut self, line: &str) {
        let bytes = format!("{line}\n").into_bytes();
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

    fn signal_group(&self, signal: libc::c_int) -> Result<(), String> {
        // SAFETY: killpg has no memory effects. The group id is the unreaped leader's id, so it is still this tree's group.
        if unsafe { libc::killpg(self.pid, signal) } == 0 || errno() == libc::ESRCH {
            return Ok(());
        }
        Err(format!(
            "unknown (the process group could not be signalled: {})",
            io::Error::last_os_error()
        ))
    }

    fn live_members(&self) -> Result<usize, String> {
        live_group_members(self.pid)
            .map_err(|error| format!("unknown (the process group could not be listed: {error})"))
    }

    /// Waits until no live process is left in the group, or until `limit`. Gives how many are left.
    fn wait_until_empty(&self, limit: Duration) -> Result<usize, String> {
        let deadline = Instant::now() + limit;
        loop {
            let left = self.live_members()?;
            if left == 0 || Instant::now() >= deadline {
                return Ok(left);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// SIGTERM, the grace, SIGKILL, then a bounded wait until no live process is left in the group.
    fn end_group(&self, grace: Duration) -> StopResult {
        let mut left = self.live_members()?;
        if left > 0 {
            self.signal_group(libc::SIGTERM)?;
            left = self.wait_until_empty(grace)?;
        }
        if left > 0 {
            self.signal_group(libc::SIGKILL)?;
            left = self.wait_until_empty(protocol::END_LIMIT)?;
        }
        if left > 0 {
            return Err(format!("{left} (the process group did not end)"));
        }
        Ok(())
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

/// Reaps the children that ended (on Linux, also the orphans this supervisor took in as their subreaper).
fn reap_ended_children() {
    let mut status = 0;
    // SAFETY: valid pointer to status.
    while unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) } > 0 {}
}

impl Tree for Leader {
    fn leader_exit(&mut self) -> Option<Exit> {
        self.peek()
    }

    fn interrupt(&mut self) {
        // An interrupt is a request, not a stop: a group that is already gone has nothing to interrupt.
        let _ = self.signal_group(libc::SIGINT);
    }

    fn kill_leader(&mut self) {
        // SAFETY: kill has no memory effects; the id is the unreaped program's.
        unsafe { libc::kill(self.pid, libc::SIGKILL) };
    }

    fn stop(&mut self, grace: Duration) -> (Option<Exit>, StopResult) {
        if let Err(left) = self.end_group(grace) {
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
        // The fields after the command name, which ends with the last ") ": state, parent, process group, ...
        let Some((_, rest)) = stat.rsplit_once(") ") else {
            continue;
        };
        let mut fields = rest.split(' ');
        let state = fields.next().unwrap_or("");
        let pgrp = fields
            .nth(1)
            .and_then(|field| field.parse::<libc::pid_t>().ok());
        if pgrp == Some(group) && state != "Z" && state != "X" {
            count += 1;
        }
    }
    Ok(count)
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

/// Linux: the supervisor takes in the tree's orphans (subreaper), so their ids stay taken until the supervisor reaps them at the end,
/// and the program dies with the supervisor (parent-death signal). Neither reaches what left for a new session by itself.
#[cfg(target_os = "linux")]
fn prepare_system() -> Result<(), String> {
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

fn start(arguments: &[OsString]) -> Result<Leader, StartFailure> {
    let Some((program, rest)) = arguments.split_first() else {
        return Err(StartFailure::Failed(
            "the supervisor was not given a program".to_owned(),
        ));
    };
    prepare_system().map_err(StartFailure::Failed)?;
    let mut command = Command::new(program);
    command.args(rest).process_group(0);
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
    control.write_line(&protocol::hello());
    if let Err(error) = catch_termination() {
        control.write_line(&format!(
            "failed: the supervisor could not catch termination signals: {error}"
        ));
        return 1;
    }
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut leader = match start(&arguments) {
        Ok(leader) => leader,
        Err(StartFailure::Failed(why)) => {
            control.write_line(&format!("failed: {why}"));
            return 1;
        }
        Err(StartFailure::NotStarted(code, why)) => {
            control.write_line(&format!("not-started {code}: {why}"));
            return 1;
        }
    };
    control.write_line(&format!("ok {}", leader.pid));
    release_standard_streams();
    protocol::supervise(&mut control, &mut leader, &Signals)
}
