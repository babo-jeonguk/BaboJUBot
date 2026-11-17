// BaboJUBot Windows job runner (#205).
//
// On Windows the server starts this program in place of a provider program. It starts the provider inside a new job object
// that ends every process in it when the job closes, waits for the provider, ends whatever the provider left running, and
// exits with the provider's exit code. The provider inherits this program's standard input, output and error as they are;
// nothing is relayed. Only this program holds the job handle, so the job also closes when this program is killed
// (cancel, or the server ending and Node.js ending its children).
//
// Command line: <this program> <application path in base64 UTF-8> <provider command line, passed on verbatim>
// Before the provider can run, one status line goes to standard error:
//   "[babojubot-job] ok"              the provider runs inside the job
//   "[babojubot-job] warning: <why>"  the provider runs without the job (the job could not be made or joined)
//   "[babojubot-job] failed: <why>"   the provider did not start
//
// The server compiles this file with the C# compiler of the .NET Framework that ships with Windows, so it stays within C# 5.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class JobRunner
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
    const uint INFINITE = 0xFFFFFFFF;
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

    static int Main()
    {
        string application, commandLine;
        try
        {
            string encoded;
            commandLine = SplitCommandLine(Marshal.PtrToStringUni(GetCommandLineW()), out encoded);
            application = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        }
        catch (FormatException)
        {
            Status("failed: the runner's command line could not be read");
            return 1;
        }
        if (application.Length == 0 || commandLine.Length == 0)
        {
            Status("failed: the runner was not given a program");
            return 1;
        }

        string warning = null;
        IntPtr job = CreateKillOnCloseJob(ref warning);
        ProcessInformation info;
        // Windows 10 and later can start the program already inside the job. Otherwise start it suspended and add it before it runs.
        bool started = job != IntPtr.Zero && StartInJob(application, commandLine, job, out info);
        if (!started)
        {
            if (!Start(application, commandLine, IntPtr.Zero, out info))
            {
                Status("failed: the program could not start (error " + Marshal.GetLastWin32Error() + ")");
                return 1;
            }
            if (job != IntPtr.Zero && !AssignProcessToJobObject(job, info.hProcess))
            {
                warning = "the program could not join a job object (error " + Marshal.GetLastWin32Error() + ")";
                CloseHandle(job);
                job = IntPtr.Zero;
            }
        }
        // The program has not run yet, so this line comes before anything it writes.
        Status(warning == null ? "ok" : "warning: " + warning);
        if (ResumeThread(info.hThread) == 0xFFFFFFFF)
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.hProcess, 1);
            Write(STD_ERROR_HANDLE, "[babojubot-job] the program could not be resumed (error " + error + ")\n");
            return 1;
        }
        CloseHandle(info.hThread);
        WaitForSingleObject(info.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(info.hProcess, out code)) code = 1;
        if (job != IntPtr.Zero) EndJob(job);
        return unchecked((int)code);
    }

    // Splits "<runner> <first> <rest>" without unquoting the rest, so the provider gets the exact command line the server built.
    static string SplitCommandLine(string line, out string first)
    {
        int i = 0;
        if (i < line.Length && line[i] == '"')
        {
            int close = line.IndexOf('"', 1);
            i = close < 0 ? line.Length : close + 1;
        }
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        int start = i;
        while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        first = line.Substring(start, i - start);
        if (i < line.Length) i++;
        return line.Substring(i);
    }

    // The handle is not inheritable and has no name, so only this program holds it.
    static IntPtr CreateKillOnCloseJob(ref string warning)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            warning = "a job object could not be made (error " + Marshal.GetLastWin32Error() + ")";
            return IntPtr.Zero;
        }
        // No breakaway flag: programs in the job cannot leave it.
        ExtendedLimit limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            warning = "a job object could not be set to end its programs (error " + Marshal.GetLastWin32Error() + ")";
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

    // Ends what the program left running and waits, for at most ten seconds, until nothing in the job runs.
    static void EndJob(IntPtr job)
    {
        TerminateJobObject(job, 1);
        for (int i = 0; i < 1000; i++)
        {
            Accounting accounting;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)
                || accounting.ActiveProcesses == 0)
                return;
            Thread.Sleep(10);
        }
    }

    static void Status(string text)
    {
        Write(STD_ERROR_HANDLE, "[babojubot-job] " + text + "\n");
    }

    static void Write(int which, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        int written;
        WriteFile(GetStdHandle(which), bytes, bytes.Length, out written, IntPtr.Zero);
    }
}
