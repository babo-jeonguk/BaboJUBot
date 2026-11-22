//! Windows (#205, #262, #268). Windows has no process groups: once a program ends, nothing finds what it left. The supervisor starts
//! the program already inside a new job object that ends every process in it when the job closes, and only this supervisor holds the
//! job, so the job also closes (and ends the tree) when the supervisor is killed. Programs in the job cannot leave it.
//!
//! Command line: `<this program> <application path, hex of UTF-8> <program command line, passed on verbatim>`. The server resolves
//! the program and builds its command line as cross-spawn does (`.cmd` files through cmd.exe included), so nothing is re-quoted here.
//!
//! The control channel is the fourth handle that Node.js (libuv) passes in the C runtime's handle table (`stdio[3]`). The program
//! inherits only the standard handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), and once it runs the supervisor closes its own copies,
//! so the program's output closes when the program's tree closes it.

use crate::attempt;
use crate::protocol::{self, Channel, Exit, Read, StopResult, Termination, Tree};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
    GetHandleInformation, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
};
use windows_sys::Win32::System::Environment::{GetCommandLineW, SetEnvironmentVariableW};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, GetStartupInfoW, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, Sleep, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

const STANDARD: [STD_HANDLE; 3] = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];

fn usable(handle: HANDLE) -> bool {
    !handle.is_null() && handle != INVALID_HANDLE_VALUE
}

/// A handle from the C runtime's handle table that Node.js (libuv) passes in `lpReserved2`: an int count, then count flag bytes,
/// then count handles, packed without padding.
fn runtime_handle(index: usize) -> Option<HANDLE> {
    // SAFETY: GetStartupInfoW fills the zeroed structure.
    let startup = unsafe {
        let mut startup: STARTUPINFOW = zeroed();
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        GetStartupInfoW(&mut startup);
        startup
    };
    let table = startup.lpReserved2;
    let size = usize::from(startup.cbReserved2);
    if table.is_null() || size < 4 {
        return None;
    }
    // SAFETY: the table holds at least the count (checked above).
    let count = usize::try_from(unsafe { table.cast::<i32>().read_unaligned() }).ok()?;
    if count <= index || size < 4 + count + count * size_of::<usize>() {
        return None;
    }
    // SAFETY: the slot is inside the table (checked above).
    let handle = unsafe {
        table
            .add(4 + count + index * size_of::<usize>())
            .cast::<usize>()
            .read_unaligned()
    } as HANDLE;
    usable(handle).then_some(handle)
}

struct Control {
    handle: HANDLE,
}

impl Control {
    /// The channel must be there, and it must not reach the program: its end is how the supervisor learns that the server is gone.
    fn open() -> Result<Self, &'static str> {
        let handle = runtime_handle(3).ok_or("the supervisor was not given a control channel")?;
        let mut flags = 0;
        // SAFETY: valid handle and pointer.
        let kept = unsafe {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) != 0
                && GetHandleInformation(handle, &mut flags) != 0
                && flags & HANDLE_FLAG_INHERIT == 0
        };
        if !kept {
            return Err("the control channel could not be kept from the program");
        }
        Ok(Self { handle })
    }
}

impl Channel for Control {
    fn read(&mut self, wait: Duration) -> Read {
        let mut available = 0;
        // SAFETY: valid handle and pointer; no buffer is read.
        if unsafe {
            PeekNamedPipe(
                self.handle,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            return Read::Closed;
        }
        if available == 0 {
            // SAFETY: Sleep has no memory effects.
            unsafe { Sleep(u32::try_from(wait.as_millis()).unwrap_or(u32::MAX)) };
            return Read::Nothing;
        }
        let mut buffer = vec![0u8; available.min(4096) as usize];
        let mut read = 0;
        // SAFETY: the buffer is valid for its length.
        if unsafe {
            ReadFile(
                self.handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Read::Closed;
        }
        buffer.truncate(read as usize);
        Read::Bytes(buffer)
    }

    fn write_message(&mut self, message: &str) {
        let bytes = protocol::frame(message);
        let mut written = 0;
        while written < bytes.len() {
            let mut count = 0;
            let rest = &bytes[written..];
            // SAFETY: the range is inside the buffer.
            if unsafe {
                WriteFile(
                    self.handle,
                    rest.as_ptr(),
                    rest.len() as u32,
                    &mut count,
                    null_mut(),
                )
            } == 0
                || count == 0
            {
                // The server is gone. The next read reports the end of the channel.
                return;
            }
            written += count as usize;
        }
    }
}

enum StartFailure {
    Failed(String),
    NotStarted(&'static str, String),
}

fn last_error() -> u32 {
    // SAFETY: GetLastError has no memory effects.
    unsafe { GetLastError() }
}

fn decode_hex(text: &[u16]) -> Option<Vec<u8>> {
    let digit = |unit: u16| char::from_u32(u32::from(unit))?.to_digit(16);
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.chunks(2)
        .map(|pair| Some((digit(pair[0])? * 16 + digit(pair[1])?) as u8))
        .collect()
}

/// Splits `<this program> <hex> <rest>` without unquoting the rest, so the program gets the exact command line the server built.
/// Both are given back NUL-terminated.
fn arguments() -> Result<(Vec<u16>, Vec<u16>), StartFailure> {
    // SAFETY: GetCommandLineW returns a NUL-terminated string that lives as long as the process.
    let line: Vec<u16> = unsafe {
        let start = GetCommandLineW();
        let mut length = 0;
        while *start.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(start, length).to_vec()
    };
    let space = |unit: u16| unit == u16::from(b' ') || unit == u16::from(b'\t');
    let mut i = 0;
    if line.first() == Some(&u16::from(b'"')) {
        i = line[1..]
            .iter()
            .position(|&unit| unit == u16::from(b'"'))
            .map_or(line.len(), |close| close + 2);
    }
    while i < line.len() && !space(line[i]) {
        i += 1;
    }
    while i < line.len() && space(line[i]) {
        i += 1;
    }
    let start = i;
    while i < line.len() && !space(line[i]) {
        i += 1;
    }
    let encoded = &line[start..i];
    if i < line.len() {
        i += 1;
    }
    let application = decode_hex(encoded)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| {
            StartFailure::Failed("the supervisor's command line could not be read".to_owned())
        })?;
    let command_line = &line[i..];
    if application.is_empty() || command_line.is_empty() {
        return Err(StartFailure::Failed(
            "the supervisor was not given a program".to_owned(),
        ));
    }
    let mut application: Vec<u16> = application.encode_utf16().collect();
    application.push(0);
    let mut command_line = command_line.to_vec();
    command_line.push(0);
    Ok((application, command_line))
}

/// A job object that ends its programs when it closes. The handle is not inheritable and the job has no name, so only this program
/// holds it. No breakaway flag: programs in the job cannot leave it.
fn kill_on_close_job() -> Result<HANDLE, StartFailure> {
    // SAFETY: null attributes and name.
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(StartFailure::Failed(format!(
            "a job object could not be made (error {})",
            last_error()
        )));
    }
    // SAFETY: a zeroed limit structure is valid.
    let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
    // SAFETY: the structure is valid for `size`.
    let set = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limit).cast::<c_void>(),
            size,
        )
    };
    if set == 0 {
        let error = last_error();
        // SAFETY: the handle is ours.
        unsafe { CloseHandle(job) };
        return Err(StartFailure::Failed(format!(
            "a job object could not be set to end its programs (error {error})"
        )));
    }
    Ok(job)
}

/// The supervisor's standard handles, each once, made inheritable: the only handles the program inherits.
fn standard_handles() -> Vec<HANDLE> {
    let mut handles: Vec<HANDLE> = Vec::new();
    for which in STANDARD {
        // SAFETY: GetStdHandle has no memory effects.
        let handle = unsafe { GetStdHandle(which) };
        if !usable(handle) || handles.contains(&handle) {
            continue;
        }
        let mut flags = 0;
        // SAFETY: valid handle and pointer.
        let inheritable = unsafe {
            GetHandleInformation(handle, &mut flags) != 0
                && (flags & HANDLE_FLAG_INHERIT != 0
                    || SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0)
        };
        if inheritable {
            handles.push(handle);
        }
    }
    handles
}

/// The process attribute list for the start: the job to start in, and the handles to inherit.
struct Attributes {
    // usize elements keep the list pointer-aligned.
    buffer: Vec<usize>,
}

impl Attributes {
    fn new(job: &HANDLE, handles: &[HANDLE]) -> Result<Self, StartFailure> {
        let count = if handles.is_empty() { 1 } else { 2 };
        let mut size = 0;
        // SAFETY: a null list asks for the size needed.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
        let mut attributes = Self {
            buffer: vec![0; size.div_ceil(size_of::<usize>())],
        };
        let failed = |what: &str| {
            StartFailure::Failed(format!(
                "the program's {what} could not be set (error {})",
                last_error()
            ))
        };
        // SAFETY: the buffer is at least `size` bytes.
        if unsafe { InitializeProcThreadAttributeList(attributes.list(), count, 0, &mut size) } == 0
        {
            attributes.buffer.clear();
            return Err(failed("start attributes"));
        }
        // SAFETY: the values outlive the list's use in CreateProcessW (the caller keeps them).
        let set = unsafe {
            UpdateProcThreadAttribute(
                attributes.list(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                (job as *const HANDLE).cast(),
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        };
        if set == 0 {
            return Err(failed("job object"));
        }
        if !handles.is_empty() {
            // SAFETY: as above.
            let set = unsafe {
                UpdateProcThreadAttribute(
                    attributes.list(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr().cast(),
                    size_of_val(handles),
                    null_mut(),
                    null(),
                )
            };
            if set == 0 {
                return Err(failed("inherited handles"));
            }
        }
        Ok(attributes)
    }

    fn list(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: the list was initialized.
            unsafe { DeleteProcThreadAttributeList(self.list()) };
        }
    }
}

struct Job {
    job: HANDLE,
    process: HANDLE,
    pid: u32,
}

impl Job {
    fn exit(&self) -> Option<Exit> {
        // SAFETY: valid handle.
        if unsafe { WaitForSingleObject(self.process, 0) } != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 1;
        // SAFETY: valid handle and pointer.
        unsafe { GetExitCodeProcess(self.process, &mut code) };
        Some(Exit::Code(code as i32))
    }

    fn active(&self) -> Result<u32, String> {
        // SAFETY: a zeroed structure is valid; the call fills it.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let size = size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32;
        // SAFETY: the structure is valid for `size`.
        let read = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                size,
                null_mut(),
            )
        };
        if read == 0 {
            return Err(format!(
                "the job object could not be read: error {}",
                last_error()
            ));
        }
        Ok(accounting.ActiveProcesses)
    }

    /// The job counts a process out before the process's handle is signalled, so an emptied job does not yet mean the program's end
    /// can be read. Waits for the handle within the limit.
    fn wait_for_program(&self) -> StopResult {
        let limit = protocol::END_LIMIT.as_millis() as u32;
        // SAFETY: valid handle.
        if unsafe { WaitForSingleObject(self.process, limit) } != WAIT_OBJECT_0 {
            return Err(
                "unknown (the job object emptied, but the program's end could not be read)"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

/// The system calls a stop makes on the job, kept apart from the stop's order (`end_job`) so that order can be tested without a job.
trait JobReach {
    /// Ends everything in the job.
    fn terminate(&self) -> Result<(), String>;
    /// How many processes of the job still run.
    fn active(&self) -> Result<usize, String>;
    /// Waits, within a limit, until the program's end can be read.
    fn wait_for_program(&self) -> StopResult;
}

impl JobReach for Job {
    fn terminate(&self) -> Result<(), String> {
        // SAFETY: valid handle.
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            return Err(format!(
                "the job object could not be ended: error {}",
                last_error()
            ));
        }
        Ok(())
    }

    fn active(&self) -> Result<usize, String> {
        Job::active(self).map(|active| active as usize)
    }

    fn wait_for_program(&self) -> StopResult {
        Job::wait_for_program(self)
    }
}

/// Ends everything in the job and waits, within `limit`, until nothing in it runs and the program's end can be read. A failed end
/// does not skip the wait: whether the job emptied is still what tells. A failed read is tried again until the limit.
fn end_job(reach: &impl JobReach, limit: Duration) -> StopResult {
    let mut failures = attempt::Failures::default();
    failures.note(reach.terminate());
    let left = attempt::wait_until_empty(limit, || reach.active(), || Ok(()), &mut failures);
    match left {
        attempt::Left::Count(0) => reach.wait_for_program(),
        attempt::Left::Count(left) => {
            Err(failures.reason(&left.to_string(), "the job object did not empty"))
        }
        attempt::Left::Unknown(why) => Err(failures.reason("unknown", &why)),
    }
}

impl Tree for Job {
    fn leader_exit(&mut self) -> Option<Exit> {
        self.exit()
    }

    /// Windows has no process groups, and a program without a window gets no interrupt.
    fn interrupt(&mut self) {}

    fn kill_leader(&mut self) {
        // SAFETY: valid handle.
        unsafe { TerminateProcess(self.process, 1) };
    }

    /// Windows ends the job at once; there is no grace.
    fn stop(&mut self, _grace: Duration) -> (Option<Exit>, StopResult) {
        let result = end_job(self, protocol::END_LIMIT);
        (self.exit(), result)
    }
}

fn start() -> Result<Job, StartFailure> {
    let (application, mut command_line) = arguments()?;
    let job = kill_on_close_job()?;
    let handles = standard_handles();
    let mut attributes = Attributes::new(&job, &handles)?;
    // SAFETY: a zeroed structure is valid.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Hidden like Node.js's windowsHide (SW_HIDE is 0), with this supervisor's standard handles.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = 0;
    // SAFETY: GetStdHandle has no memory effects.
    unsafe {
        startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    }
    startup.lpAttributeList = attributes.list();
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: NUL-terminated strings; the attribute list and the values it points to are alive.
    let started = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            i32::from(!handles.is_empty()),
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            null(),
            null(),
            &raw const startup.StartupInfo,
            &mut info,
        )
    };
    drop(attributes);
    if started == 0 {
        let error = last_error();
        // SAFETY: the job handle is ours.
        unsafe { CloseHandle(job) };
        return Err(match error {
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => StartFailure::NotStarted(
                "ENOENT",
                format!("the program was not found (error {error})"),
            ),
            ERROR_ACCESS_DENIED => StartFailure::NotStarted(
                "EACCES",
                format!("the program could not be run (error {error})"),
            ),
            // Includes a job that cannot be nested in the supervisor's own job: the program never runs outside a job.
            _ => StartFailure::Failed(format!(
                "the program could not start in a job object (error {error})"
            )),
        });
    }
    // SAFETY: the thread handle is ours and not needed.
    unsafe { CloseHandle(info.hThread) };
    Ok(Job {
        job,
        process: info.hProcess,
        pid: info.dwProcessId,
    })
}

/// Closes the supervisor's own standard handles, each once: the program holds its own copies, and the output closes when its tree
/// closes it.
fn release_standard_handles() {
    let mut closed: Vec<HANDLE> = Vec::new();
    for which in STANDARD {
        // SAFETY: the handles are this process's own.
        unsafe {
            let handle = GetStdHandle(which);
            if usable(handle) && !closed.contains(&handle) {
                CloseHandle(handle);
                closed.push(handle);
            }
            SetStdHandle(which, null_mut());
        }
    }
}

struct NoTermination;

impl Termination for NoTermination {
    fn requested(&self) -> bool {
        false
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
    let start_request = match protocol::read_start(&mut control, &NoTermination) {
        protocol::StartRequest::Start(start) => start,
        protocol::StartRequest::Ended => return 1,
        protocol::StartRequest::Refused(why) => {
            control.write_message(&format!("failed: {why}"));
            return 1;
        }
    };
    // The program inherits this environment. Windows has no marker cleanup, so the supervisor may carry the entries itself.
    for (name, value) in &start_request.env {
        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        // SAFETY: NUL-terminated strings.
        if unsafe { SetEnvironmentVariableW(wide(name).as_ptr(), wide(value).as_ptr()) } == 0 {
            control.write_message(&format!(
                "failed: the program's environment could not be set (error {})",
                last_error()
            ));
            return 1;
        }
    }
    let mut job = match start() {
        Ok(job) => job,
        Err(StartFailure::Failed(why)) => {
            control.write_message(&format!("failed: {why}"));
            return 1;
        }
        Err(StartFailure::NotStarted(code, why)) => {
            control.write_message(&format!("not-started {code}: {why}"));
            return 1;
        }
    };
    control.write_message(&format!("ok {}", job.pid));
    release_standard_handles();
    protocol::supervise(&mut control, &mut job, &NoTermination, start_request)
}
