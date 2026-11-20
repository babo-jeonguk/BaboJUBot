// BaboJUBot Windows job object launcher (#205, #262).
//
// On Windows the server starts this program in place of a program whose whole tree it must be able to stop. It starts the program
// inside a new job object that ends every process in it when the job closes. The program inherits this launcher's standard input,
// output and error as they are; nothing is relayed, and this launcher closes its own copies once the program runs, so the server
// sees the output end when the program's tree closes it.
//
// Command line: <this program> <application path in base64 UTF-8> <program command line, passed on verbatim>
// The program never runs outside the job: when the job cannot be made or joined, the launcher reports "failed" and does not run it.
//
// The server talks to this launcher over a control channel: the fourth standard handle Node.js passes (stdio[3], a pipe).
// The program does not inherit it. Lines this launcher writes:
//   "ok" | "failed: <why>"                     once, how the start went ("failed": the program did not start, nothing follows)
//   "exit <code>"                              the program ended (on its own or by "kill-leader")
//   "ended" | "left: <n>" | "left: unknown (error <e>)"
//                                              the reply to a stop: nothing in the job runs any more, or what was still running
//                                              after ten seconds. The launcher exits right after.
// Lines the server writes:
//   "stop"         end everything in the job, report, and exit. The end of the channel (the server is gone) does the same.
//   "kill-leader"  end the program only, as a crash would. What it started keeps running until "stop".
// The program ending on its own does not end the job: the server's stop does, so leaving children behind looks the same on every
// system. Only this launcher holds the job handle, so the job also closes when this launcher is killed.
//
// The server compiles this file with the C# compiler of the .NET Framework that ships with Windows, so it stays within C# 5.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class JobObjectLauncher
{
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const int STARTF_USESHOWWINDOW = 0x1;
    const int STARTF_USESTDHANDLES = 0x100;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint WAIT_OBJECT_0 = 0;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x2000D;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr file, byte[] buffer, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern void GetStartupInfoW(out StartupInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr left);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll")]
    static extern void Sleep(uint milliseconds);

    static IntPtr control;
    static string received = "";

    static int Main()
    {
        control = ControlChannel();
        if (control == IntPtr.Zero)
        {
            Write(STD_ERROR_HANDLE, "[babojubot-job-object] failed: the launcher was not given a control channel\n");
            return 1;
        }
        // The end of the channel tells this launcher the server is gone. The program must not keep it open.
        SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0);

        string encoded, application, commandLine;
        try
        {
            commandLine = SplitCommandLine(Marshal.PtrToStringUni(GetCommandLineW()), out encoded);
            application = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        }
        catch (FormatException)
        {
            Report("failed: the launcher's command line could not be read");
            return 1;
        }
        if (application.Length == 0 || commandLine.Length == 0)
        {
            Report("failed: the launcher was not given a program");
            return 1;
        }

        string problem = null;
        IntPtr job = CreateKillOnCloseJob(ref problem);
        if (job == IntPtr.Zero)
        {
            Report("failed: " + problem);
            return 1;
        }
        ProcessInformation info = new ProcessInformation();
        // Windows 10 and later can start the program already inside the job. Otherwise start it suspended and add it before it runs.
        bool started = StartInJob(application, commandLine, job, out info);
        if (!started)
        {
            if (!Start(application, commandLine, IntPtr.Zero, out info))
            {
                Report("failed: the program could not start (error " + Marshal.GetLastWin32Error() + ")");
                return 1;
            }
            // The program was made suspended and has not run. It runs only once it is in the job.
            if (!AssignProcessToJobObject(job, info.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(info.hProcess, 1);
                Report("failed: the program could not join a job object (error " + error + ")");
                return 1;
            }
        }
        if (ResumeThread(info.hThread) == 0xFFFFFFFF)
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.hProcess, 1);
            Report("failed: the program could not be resumed (error " + error + ")");
            return 1;
        }
        CloseHandle(info.hThread);
        Report("ok");
        // The program holds its own copies of the standard handles.
        CloseStandardHandles();

        int code = 1;
        bool exited = false;
        for (;;)
        {
            if (!exited && WaitForSingleObject(info.hProcess, 0) == WAIT_OBJECT_0)
            {
                exited = true;
                code = ExitCode(info.hProcess);
                Report("exit " + code);
            }
            string command = ReadCommand();
            if (command == null || command == "stop") break;
            if (command == "kill-leader" && !exited) TerminateProcess(info.hProcess, 1);
            if (command.Length > 0) continue;
            if (exited) Sleep(50);
            else WaitForSingleObject(info.hProcess, 50);
        }
        string end = EndJob(job);
        if (!exited && WaitForSingleObject(info.hProcess, 0) == WAIT_OBJECT_0)
        {
            code = ExitCode(info.hProcess);
            Report("exit " + code);
        }
        Report(end);
        return code;
    }

    static int ExitCode(IntPtr process)
    {
        uint code;
        return GetExitCodeProcess(process, out code) ? unchecked((int)code) : 1;
    }

    // The fourth handle in the C runtime's handle table that Node.js (libuv) passes in lpReserved2:
    // an int count, then count flag bytes, then count handles, packed without padding.
    static IntPtr ControlChannel()
    {
        StartupInfo startup;
        GetStartupInfoW(out startup);
        if (startup.lpReserved2 == IntPtr.Zero || startup.cbReserved2 < 4) return IntPtr.Zero;
        int count = Marshal.ReadInt32(startup.lpReserved2);
        if (count < 4 || (ushort)startup.cbReserved2 < 4 + count + count * IntPtr.Size) return IntPtr.Zero;
        IntPtr handle = Marshal.ReadIntPtr(startup.lpReserved2, 4 + count + 3 * IntPtr.Size);
        return handle == new IntPtr(-1) ? IntPtr.Zero : handle;
    }

    static void CloseStandardHandles()
    {
        foreach (int which in new int[] { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE })
        {
            IntPtr handle = GetStdHandle(which);
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }
    }

    // The next command from the server without waiting: "" when none has arrived, null when the channel ended.
    static string ReadCommand()
    {
        int newline = received.IndexOf('\n');
        if (newline < 0)
        {
            uint available;
            if (!PeekNamedPipe(control, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) return null;
            if (available == 0) return "";
            byte[] buffer = new byte[available];
            uint read;
            if (!ReadFile(control, buffer, available, out read, IntPtr.Zero)) return null;
            received += Encoding.UTF8.GetString(buffer, 0, (int)read);
            newline = received.IndexOf('\n');
            if (newline < 0) return "";
        }
        string command = received.Substring(0, newline).Trim();
        received = received.Substring(newline + 1);
        return command;
    }

    // Splits "<launcher> <encoded> <rest>" without unquoting the rest, so the program gets the exact command line the server built.
    static string SplitCommandLine(string line, out string encoded)
    {
        int i = 0;
        if (i < line.Length && line[i] == '"')
        {
            int close = line.IndexOf('"', 1);
            i = close < 0 ? line.Length : close + 1;
        }
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        encoded = NextToken(line, ref i);
        return i < line.Length ? line.Substring(i) : "";
    }

    // The next word, and the one separator after it.
    static string NextToken(string line, ref int i)
    {
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        int start = i;
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        string token = line.Substring(start, i - start);
        if (i < line.Length) i++;
        return token;
    }

    // The handle is not inheritable and has no name, so only this program holds it.
    static IntPtr CreateKillOnCloseJob(ref string problem)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            problem = "a job object could not be made (error " + Marshal.GetLastWin32Error() + ")";
            return IntPtr.Zero;
        }
        // No breakaway flag: programs in the job cannot leave it.
        ExtendedLimit limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            problem = "a job object could not be set to end its programs (error " + Marshal.GetLastWin32Error() + ")";
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    static bool StartInJob(string application, string commandLine, IntPtr job, out ProcessInformation info)
    {
        info = new ProcessInformation();
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) return false;
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
        bool ready = false;
        try
        {
            Marshal.WriteIntPtr(jobs, job);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) return false;
            ready = true;
            if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                return false;
            return Start(application, commandLine, list, out info);
        }
        finally
        {
            if (ready) DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(jobs);
            Marshal.FreeHGlobal(list);
        }
    }

    // Starts the program suspended with this program's standard handles, hidden like Node.js's windowsHide.
    static bool Start(string application, string commandLine, IntPtr attributes, out ProcessInformation info)
    {
        StartupInfoEx startup = new StartupInfoEx();
        startup.StartupInfo.cb = attributes == IntPtr.Zero ? Marshal.SizeOf(typeof(StartupInfo)) : Marshal.SizeOf(typeof(StartupInfoEx));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.StartupInfo.wShowWindow = 0;
        startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        startup.lpAttributeList = attributes;
        uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | (attributes == IntPtr.Zero ? 0 : EXTENDED_STARTUPINFO_PRESENT);
        return CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null,
            ref startup, out info);
    }

    // Ends everything in the job and waits, for at most ten seconds, until nothing in it runs.
    static string EndJob(IntPtr job)
    {
        TerminateJobObject(job, 1);
        for (int i = 0; ; i++)
        {
            Accounting accounting;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                return "left: unknown (error " + Marshal.GetLastWin32Error() + ")";
            if (accounting.ActiveProcesses == 0) return "ended";
            if (i >= 1000) return "left: " + accounting.ActiveProcesses;
            Sleep(10);
        }
    }

    static void Report(string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text + "\n");
        int written;
        WriteFile(control, bytes, bytes.Length, out written, IntPtr.Zero);
    }

    static void Write(int which, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        int written;
        WriteFile(GetStdHandle(which), bytes, bytes.Length, out written, IntPtr.Zero);
    }
}
