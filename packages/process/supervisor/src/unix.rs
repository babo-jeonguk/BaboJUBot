//! Linux and macOS (#268). The supervisor starts the program in a new process group and does not reap it until after the last
//! signal to that group: while the program is unreaped (even as a zombie), the system gives neither its process id nor its group id
//! to another process, so the group signals cannot reach an unrelated program. The control channel is file descriptor 3, a socket
//! that Node.js makes; the program does not inherit it.
//!
//! Command line: `<this program> <program> <arguments...>`. The program is looked up on the PATH of the environment this supervisor
//! was given, as Node.js does, and inherits that environment, the working folder and file descriptors 0–2. Once the program runs,
//! the supervisor points its own 0–2 at /dev/null, so the program's output closes when the program's tree closes it.

use crate::attempt;
use crate::marked::{self, Holder};
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

/// The program, which is also its process group's leader, and its group. `marked` finds the programs that carry this run's marker.
struct Leader {
    pid: libc::pid_t,
    marked: Marked,
}

/// The programs that carry this run's marker, as a stop sees them. One a later look no longer finds (a dying process shows no
/// environment) still counts until what holds it says it ended (#283 review 1): not finding it again is not its end.
struct Marked<H = marked::Held> {
    search: Option<marked::Search>,
    seen: std::cell::RefCell<Vec<std::rc::Rc<H>>>,
}

impl<H: Holder> Default for Marked<H> {
    fn default() -> Self {
        Marked::new(None)
    }
}

impl<H: Holder> Marked<H> {
    fn new(search: Option<marked::Search>) -> Self {
        Marked {
            search,
            seen: Default::default(),
        }
    }

    /// This look's programs, and those held before that still run as `runs` tells (`marked::still_runs`).
    fn keep(
        &self,
        found: marked::Found<H>,
        runs: impl Fn(&H) -> marked::Running,
    ) -> marked::Found<std::rc::Rc<H>> {
        let mut holders: Vec<std::rc::Rc<H>> =
            found.holders.into_iter().map(std::rc::Rc::new).collect();
        let mut unverified = found.unverified;
        for held in self.seen.borrow_mut().drain(..) {
            if holders.iter().any(|each| each.pid() == held.pid()) {
                continue;
            }
            match runs(&held) {
                marked::Running::Yes => holders.push(held),
                marked::Running::Ended => {}
                marked::Running::Unknown => unverified.push(held.pid()),
            }
        }
        *self.seen.borrow_mut() = holders.clone();
        marked::Found {
            holders,
            unverified,
        }
    }
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

/// The system calls a stop makes on the tree: the program's group, on Linux the orphans outside it that this supervisor took in, and
/// the programs outside the group that carry this run's marker (`marked.rs`). Kept apart from the stop's order (`end_tree`) so that
/// order can be tested without real processes.
trait Reach {
    /// A program found by the marker, held so that its signal reaches that very process.
    type Held: Holder;
    fn group_live(&self) -> Result<usize, String>;
    fn orphans(&self) -> Result<Vec<libc::pid_t>, String>;
    /// The programs outside the group that carry this run's marker, and those that may be ours but could not be read.
    fn marked(&self) -> Result<marked::Found<Self::Held>, String>;
    fn signal_group(&self, signal: libc::c_int) -> Result<(), String>;
    fn signal_orphan(&self, orphan: libc::pid_t, signal: libc::c_int) -> Result<(), String>;
    fn signal_marked(&self, held: &Self::Held, signal: libc::c_int) -> Result<(), String>;
}

/// The programs that carry `search`'s marker, leaving out the members of `group` (the group signals reach them).
fn marked_outside(
    search: Option<&marked::Search>,
    group: Option<libc::pid_t>,
) -> Result<marked::Found<marked::Held>, String> {
    let Some(search) = search else {
        return Ok(marked::Found {
            holders: Vec::new(),
            unverified: Vec::new(),
        });
    };
    let mut found = marked::find(search)?;
    if let Some(group) = group {
        // SAFETY: getpgid has no memory effects.
        found
            .holders
            .retain(|held| unsafe { libc::getpgid(held.pid()) } != group);
    }
    Ok(found)
}

impl Reach for Leader {
    type Held = std::rc::Rc<marked::Held>;

    fn marked(&self) -> Result<marked::Found<Self::Held>, String> {
        Ok(self.marked.keep(
            marked_outside(self.marked.search.as_ref(), Some(self.pid))?,
            marked::still_runs,
        ))
    }

    fn signal_marked(&self, held: &Self::Held, signal: libc::c_int) -> Result<(), String> {
        marked::signal(held, signal)
    }

    fn group_live(&self) -> Result<usize, String> {
        live_group_members(self.pid)
            .map_err(|error| format!("the process group could not be listed: {error}"))
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
            _ => Err(format!("the process group could not be signalled: {error}")),
        }
    }

    fn signal_orphan(&self, orphan: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
        // SAFETY: kill has no memory effects. The orphan is this supervisor's unreaped child, so its id is still that process's.
        if unsafe { libc::kill(orphan, signal) } != 0 && errno() != libc::ESRCH {
            return Err(format!(
                "program {orphan}, which left the process group, could not be signalled: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

/// The restart recovery's request when the run's server and supervisor both died: no program and no group, only what carries the
/// run's marker and the process the run's record kept, when it is still that process (`clean`).
struct Stray {
    marked: Marked,
    recorded: Option<(libc::pid_t, u64)>,
}

impl Reach for Stray {
    type Held = std::rc::Rc<marked::Held>;

    fn group_live(&self) -> Result<usize, String> {
        Ok(0)
    }

    fn orphans(&self) -> Result<Vec<libc::pid_t>, String> {
        Ok(Vec::new())
    }

    fn marked(&self) -> Result<marked::Found<Self::Held>, String> {
        let mut found = marked_outside(self.marked.search.as_ref(), None)?;
        if let Some((pid, start)) = self.recorded
            && !found.holders.iter().any(|held| held.pid() == pid)
            && let Some(held) = marked::hold(pid, start)?
        {
            found.holders.push(held);
        }
        Ok(self.marked.keep(found, marked::still_runs))
    }

    fn signal_group(&self, _signal: libc::c_int) -> Result<(), String> {
        Ok(())
    }

    fn signal_orphan(&self, _orphan: libc::pid_t, _signal: libc::c_int) -> Result<(), String> {
        Ok(())
    }

    fn signal_marked(&self, held: &Self::Held, signal: libc::c_int) -> Result<(), String> {
        marked::signal(held, signal)
    }
}

/// What still runs of the tree: the group, the orphans, and the marked programs that are neither. The count needs every list, so
/// any failing leaves it unknown.
fn live_members(reach: &impl Reach) -> Result<usize, String> {
    let orphans = reach.orphans()?;
    let marked = reach.marked()?;
    let outside = marked
        .holders
        .iter()
        .filter(|held| !orphans.contains(&held.pid()))
        .count();
    Ok(reach.group_live()? + orphans.len() + outside)
}

/// The group, every orphan and every marked program are separate targets: each gets the signal whatever the others answer.
fn signal_tree(reach: &impl Reach, signal: libc::c_int) -> Result<(), String> {
    attempt::all_of([
        reach.signal_group(signal),
        signal_orphans(reach, signal),
        signal_marked(reach, signal),
    ])
}

/// Every marked program found now gets the signal whatever the others answer, through what holds it (`Reach::signal_marked`).
fn signal_marked(reach: &impl Reach, signal: libc::c_int) -> Result<(), String> {
    let found = reach.marked()?;
    attempt::all_of(
        found
            .holders
            .iter()
            .map(|held| reach.signal_marked(held, signal)),
    )
}

/// Every orphan gets the signal whatever the others answer. Without their list there is nothing to signal.
fn signal_orphans(reach: &impl Reach, signal: libc::c_int) -> Result<(), String> {
    let orphans = reach.orphans()?;
    attempt::all_of(
        orphans
            .into_iter()
            .map(|orphan| reach.signal_orphan(orphan, signal)),
    )
}

/// SIGTERM, the grace, SIGKILL, then a bounded wait (`limit`) until nothing of the tree runs. The steps keep their order, and none is
/// skipped because a signal or a look before it failed: a failed signal leaves the next one and the end check to tell, and a failed
/// look tells nothing. During the last wait SIGKILL goes again to the orphans outside the group, so it also reaches those taken in
/// meanwhile (a program's children are taken in when it ends); a group being killed cannot grow. The tree counts as ended only when
/// a look finds nothing; otherwise the result names what is left with the failures on the way. The restart recovery's group stop
/// (`packages/process/src/group.ts`) keeps the same rules with one difference: it finds the group by a recorded number, which can go
/// to another group once the group is empty, so it signals only right after a look saw the group. Here the unreaped program keeps
/// the number, so the signals go whatever the looks say.
fn end_tree(reach: &impl Reach, grace: Duration, limit: Duration) -> StopResult {
    let mut failures = attempt::Failures::default();
    let look = || live_members(reach);
    let mut left = attempt::wait_until_empty(Duration::ZERO, look, || Ok(()), &mut failures);
    if !left.is_empty() {
        failures.note(signal_tree(reach, libc::SIGTERM));
        left = attempt::wait_until_empty(grace, look, || Ok(()), &mut failures);
    }
    if !left.is_empty() {
        failures.note(signal_tree(reach, libc::SIGKILL));
        left = attempt::wait_until_empty(
            limit,
            look,
            || {
                attempt::all_of([
                    signal_orphans(reach, libc::SIGKILL),
                    signal_marked(reach, libc::SIGKILL),
                ])
            },
            &mut failures,
        );
    }
    match left {
        attempt::Left::Count(0) => settle_unverified(reach, &mut failures),
        attempt::Left::Count(left) => {
            Err(failures.reason(&left.to_string(), "the tree did not end"))
        }
        attempt::Left::Unknown(why) => Err(failures.reason("unknown", &why)),
    }
}

/// After the tree ended: a program that may carry the run's marker but could not be read gets no signal. It is looked at again for
/// the default grace, as short-lived programs that hide their environment (`ssh`) come and go; one that becomes readable and
/// carries the marker gets SIGKILL. What is still unverified (or marked) then makes the stop not clean.
fn settle_unverified(reach: &impl Reach, failures: &mut attempt::Failures) -> StopResult {
    let deadline = std::time::Instant::now() + protocol::DEFAULT_GRACE;
    loop {
        let found = reach
            .marked()
            .map_err(|why| failures.reason("unknown", &why))?;
        if found.unverified.is_empty() && found.holders.is_empty() {
            return Ok(());
        }
        failures.note(attempt::all_of(
            found
                .holders
                .iter()
                .map(|held| reach.signal_marked(held, libc::SIGKILL)),
        ));
        if std::time::Instant::now() >= deadline {
            let pids: Vec<String> = found.unverified.iter().map(ToString::to_string).collect();
            let left = found.unverified.len() + found.holders.len();
            return Err(failures.reason(
                &left.to_string(),
                &format!(
                    "programs of this user that may carry the run's marker could not be checked, so they got no signal: {}",
                    pids.join(", ")
                ),
            ));
        }
        std::thread::sleep(protocol::POLL);
    }
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
    // The fields after the command name, which ends with the last ") ": state, parent, process group, ...
    let pgrp = stat
        .rsplit_once(") ")
        .and_then(|(_, rest)| rest.split(' ').nth(2))
        .and_then(|field| field.parse::<libc::pid_t>().ok());
    pgrp == Some(group)
        && match marked::life_in_stat(stat) {
            marked::Life::Runs | marked::Life::ThreadsRun | marked::Life::Unknown => true,
            marked::Life::Ended => false,
        }
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
        // The kernel's record is given for every process, also a set-id member whose `proc_pidinfo` is refused, so a member that still
        // runs is not missed (#283 review 2). One that ended in the meantime has none; one that cannot be read fails the look.
        match marked::record(pid)? {
            Some(seen) if seen.group == group && !seen.zombie => count += 1,
            Some(_) | None => {}
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
        // A process that ended meanwhile is not a child; one whose state cannot be read leaves the children unknown.
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
                continue;
            }
            Err(error) => return Err(error),
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
        format!("the programs that left the process group could not be listed: {error}")
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
            Ok(Leader {
                pid,
                marked: Marked::default(),
            })
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
    control.write_message(&protocol::hello(marked::start_of_self()));
    if let Err(error) = catch_termination() {
        control.write_message(&format!(
            "failed: the supervisor could not catch termination signals: {error}"
        ));
        return 1;
    }
    let start_request = match protocol::read_start(&mut control, &Signals) {
        protocol::StartRequest::Start(start) => start,
        protocol::StartRequest::Clean(clean) => {
            let stray = Stray {
                marked: Marked::new(clean.marker.map(|marker| marked::Search {
                    marker,
                    since: clean.since,
                })),
                recorded: clean.recorded,
            };
            let result = end_tree(&stray, protocol::DEFAULT_GRACE, protocol::END_LIMIT);
            control.write_message(&protocol::end_message(&result));
            return 0;
        }
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
    // Programs of this user that started after this supervisor and cannot be read may be the run's (`marked.rs`).
    // Without its own start, the widest beginning: every unreadable program of this user may then be ours.
    leader.marked = Marked::new(start_request.marker.clone().map(|marker| marked::Search {
        marker,
        since: Some(marked::start_of_self().unwrap_or(0)),
    }));
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

/// The stop's order with signals and looks that fail (#274 external review 3, STD-4): one failure must not keep the other parts of the
/// tree from their signals, nor skip the grace, SIGKILL and the end check.
#[cfg(test)]
mod stop_tests {
    use super::{Reach, end_tree};
    use crate::marked::{Found, Holder};
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;
    use std::time::Duration;

    /// A tree whose group members and orphans ignore SIGTERM and end on SIGKILL. `refuses` lists the (target, signal) pairs that
    /// fail, as for a program of another user (EPERM); the group is target 0. `failed_looks` is how many looks fail first.
    struct Fake {
        group: Cell<usize>,
        orphans: RefCell<BTreeSet<libc::pid_t>>,
        /// Programs outside the tree that carry the run's marker; they end on SIGKILL too.
        marked: RefCell<BTreeSet<libc::pid_t>>,
        /// Programs of this user that may carry the marker but cannot be read, and for how many looks they are still there.
        unverified: Vec<libc::pid_t>,
        unverified_for: Cell<usize>,
        refuses: Vec<(libc::pid_t, libc::c_int)>,
        failed_looks: Cell<usize>,
        sent: RefCell<Vec<(libc::pid_t, libc::c_int)>>,
    }

    struct FakeHeld(libc::pid_t);

    impl Holder for FakeHeld {
        fn pid(&self) -> libc::pid_t {
            self.0
        }
    }

    impl Fake {
        fn new(
            group: usize,
            orphans: &[libc::pid_t],
            refuses: &[(libc::pid_t, libc::c_int)],
        ) -> Self {
            Fake {
                group: Cell::new(group),
                orphans: RefCell::new(orphans.iter().copied().collect()),
                marked: RefCell::new(BTreeSet::new()),
                unverified: Vec::new(),
                unverified_for: Cell::new(usize::MAX),
                refuses: refuses.to_vec(),
                failed_looks: Cell::new(0),
                sent: RefCell::new(Vec::new()),
            }
        }

        fn got(&self, target: libc::pid_t, signal: libc::c_int) -> bool {
            self.sent.borrow().contains(&(target, signal))
        }

        fn deliver(&self, target: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
            self.sent.borrow_mut().push((target, signal));
            if self.refuses.contains(&(target, signal)) {
                return Err(format!(
                    "{target} could not be signalled: Operation not permitted"
                ));
            }
            if signal == libc::SIGKILL {
                if target == 0 {
                    self.group.set(0);
                } else {
                    self.orphans.borrow_mut().remove(&target);
                    self.marked.borrow_mut().remove(&target);
                }
            }
            Ok(())
        }
    }

    impl Reach for Fake {
        type Held = FakeHeld;

        fn marked(&self) -> Result<Found<FakeHeld>, String> {
            let left = self.unverified_for.get();
            self.unverified_for.set(left.saturating_sub(1));
            Ok(Found {
                holders: self.marked.borrow().iter().copied().map(FakeHeld).collect(),
                unverified: if left > 0 {
                    self.unverified.clone()
                } else {
                    Vec::new()
                },
            })
        }

        fn signal_marked(&self, held: &FakeHeld, signal: libc::c_int) -> Result<(), String> {
            self.deliver(held.0, signal)
        }

        fn group_live(&self) -> Result<usize, String> {
            Ok(self.group.get())
        }

        fn orphans(&self) -> Result<Vec<libc::pid_t>, String> {
            if self.failed_looks.get() > 0 {
                self.failed_looks.set(self.failed_looks.get() - 1);
                return Err("the orphans could not be listed".to_owned());
            }
            Ok(self.orphans.borrow().iter().copied().collect())
        }

        fn signal_group(&self, signal: libc::c_int) -> Result<(), String> {
            self.deliver(0, signal)
        }

        fn signal_orphan(&self, orphan: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
            self.deliver(orphan, signal)
        }
    }

    fn stop(tree: &Fake) -> Result<(), String> {
        end_tree(tree, Duration::ZERO, Duration::from_millis(200))
    }

    #[test]
    fn an_orphan_that_refuses_its_signals_does_not_keep_the_others_from_theirs() {
        let tree = Fake::new(0, &[11, 12], &[(11, libc::SIGTERM), (11, libc::SIGKILL)]);
        let result = stop(&tree);
        assert!(tree.got(12, libc::SIGTERM));
        assert!(tree.got(12, libc::SIGKILL));
        let left = result.expect_err("orphan 11 still runs");
        assert!(left.starts_with("1 ("), "{left}");
        assert!(left.contains("11 could not be signalled"), "{left}");
    }

    #[test]
    fn a_group_that_refuses_its_signals_does_not_keep_the_orphans_from_theirs() {
        let tree = Fake::new(1, &[12], &[(0, libc::SIGTERM), (0, libc::SIGKILL)]);
        let result = stop(&tree);
        assert!(tree.got(12, libc::SIGTERM));
        assert!(tree.got(12, libc::SIGKILL));
        let left = result.expect_err("the group still runs");
        assert!(left.starts_with("1 ("), "{left}");
        assert!(left.contains("0 could not be signalled"), "{left}");
    }

    #[test]
    fn a_tree_that_ends_after_a_refused_signal_has_ended() {
        let tree = Fake::new(1, &[11], &[(0, libc::SIGTERM), (11, libc::SIGTERM)]);
        assert_eq!(stop(&tree), Ok(()));
        assert!(tree.got(0, libc::SIGKILL));
        assert!(tree.got(11, libc::SIGKILL));
    }

    #[test]
    fn a_failed_look_does_not_end_the_stop() {
        let tree = Fake::new(0, &[12], &[]);
        tree.failed_looks.set(1);
        assert_eq!(stop(&tree), Ok(()));
        assert!(tree.got(12, libc::SIGKILL));
    }

    #[test]
    fn marked_programs_outside_the_tree_get_the_signals_and_are_waited_for() {
        let tree = Fake::new(1, &[], &[]);
        tree.marked.borrow_mut().extend([31, 32]);
        assert_eq!(stop(&tree), Ok(()));
        for target in [31, 32] {
            assert!(tree.got(target, libc::SIGTERM));
            assert!(tree.got(target, libc::SIGKILL));
        }
    }

    #[test]
    fn a_marked_program_that_refuses_its_signals_does_not_keep_the_tree_from_theirs() {
        let tree = Fake::new(1, &[12], &[(31, libc::SIGTERM), (31, libc::SIGKILL)]);
        tree.marked.borrow_mut().insert(31);
        let left = stop(&tree).expect_err("program 31 still runs");
        assert!(tree.got(0, libc::SIGKILL));
        assert!(tree.got(12, libc::SIGKILL));
        assert!(left.starts_with("1 ("), "{left}");
        assert!(left.contains("31 could not be signalled"), "{left}");
    }

    #[test]
    fn a_program_that_could_not_be_checked_gets_no_signal_and_the_stop_is_not_clean() {
        let mut tree = Fake::new(1, &[], &[]);
        tree.unverified = vec![41];
        let left = stop(&tree).expect_err("program 41 could not be checked");
        assert!(tree.sent.borrow().iter().all(|&(target, _)| target != 41));
        assert!(left.starts_with("1 ("), "{left}");
        assert!(
            left.contains("could not be checked") && left.contains("41"),
            "{left}"
        );
    }

    #[test]
    fn a_short_lived_program_that_could_not_be_checked_does_not_make_the_stop_unclean() {
        let mut tree = Fake::new(1, &[], &[]);
        tree.unverified = vec![41];
        tree.unverified_for.set(6);
        assert_eq!(stop(&tree), Ok(()));
        assert!(tree.sent.borrow().iter().all(|&(target, _)| target != 41));
    }
}
