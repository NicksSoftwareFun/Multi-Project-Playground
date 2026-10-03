// Native side of the Rain World Desktop helper. Loaded by rw-helper.ps1 via
// Add-Type, so it must stay C# 5 compatible (Windows PowerShell 5.1 compiles
// it with the .NET Framework compiler): no string interpolation, no
// expression-bodied members, no `out var`.
//
// Reports, in physical screen pixels:
//   - the primary monitor rectangle
//   - visible top-level app windows (front to back)
//   - desktop icon rectangles (read from Explorer's SysListView32)
//   - taskbar rectangles
//   - the cursor position
// Window titles are deliberately NOT reported.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class RwNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr addr, UIntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr addr, UIntPtr size, uint type);
    [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const uint LVM_GETITEMCOUNT = 0x1004;
    const uint LVM_GETITEMRECT = 0x100E;
    const uint PROCESS_VM_OPERATION = 0x0008;
    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_VM_WRITE = 0x0020;
    const uint MEM_COMMIT = 0x1000;
    const uint MEM_RESERVE = 0x2000;
    const uint MEM_RELEASE = 0x8000;
    const uint PAGE_READWRITE = 0x04;

    // Shell and system surfaces that aren't app windows. (Dictionary rather
    // than HashSet: HashSet lives in System.Core, which Windows PowerShell's
    // Add-Type doesn't reference by default.)
    static readonly Dictionary<string, bool> SkipClasses = MakeSkip(
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Button",
        "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow", "Xaml_WindowedPopupClass",
        "TopLevelWindowForOverflowXamlIsland", "ForegroundStaging", "MultitaskingViewFrame",
        "XamlExplorerHostIslandWindow", "TaskListThumbnailWnd", "tooltips_class32");

    static Dictionary<string, bool> MakeSkip(params string[] names)
    {
        Dictionary<string, bool> d = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (string n in names) d[n] = true;
        return d;
    }

    static bool dpiSet;

    public static void InitDpi()
    {
        if (dpiSet) return;
        dpiSet = true;
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 so every rect is in physical pixels.
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
        }
        catch (EntryPointNotFoundException)
        {
            SetProcessDPIAware();
        }
    }

    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static RECT FrameOf(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            GetWindowRect(h, out r);
        return r;
    }

    public static RECT PrimaryMonitor()
    {
        POINT origin = new POINT();
        IntPtr mon = MonitorFromPoint(origin, 1 /* MONITOR_DEFAULTTOPRIMARY */);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        GetMonitorInfo(mon, ref mi);
        return mi.rcMonitor;
    }

    static bool Intersects(RECT a, RECT b)
    {
        return a.Left < b.Right && a.Right > b.Left && a.Top < b.Bottom && a.Bottom > b.Top;
    }

    public static List<KeyValuePair<long, RECT>> AppWindows(RECT screen)
    {
        List<KeyValuePair<long, RECT>> list = new List<KeyValuePair<long, RECT>>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            int cloaked;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            if ((ex & WS_EX_TOOLWINDOW) != 0) return true;
            if ((ex & WS_EX_TRANSPARENT) != 0 && (ex & WS_EX_LAYERED) != 0) return true; // click-through overlays
            if ((ex & WS_EX_NOACTIVATE) != 0) return true;
            if (GetWindowTextLength(h) == 0) return true;
            if (SkipClasses.ContainsKey(ClassOf(h))) return true;
            RECT r = FrameOf(h);
            if (r.Right - r.Left < 60 || r.Bottom - r.Top < 30) return true;
            if (!Intersects(r, screen)) return true;
            list.Add(new KeyValuePair<long, RECT>(h.ToInt64(), r));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<RECT> Taskbars(RECT screen)
    {
        List<RECT> list = new List<RECT>();
        IntPtr main = FindWindow("Shell_TrayWnd", null);
        if (main != IntPtr.Zero && IsWindowVisible(main))
        {
            RECT r;
            GetWindowRect(main, out r);
            if (Intersects(r, screen)) list.Add(r);
        }
        IntPtr sec = IntPtr.Zero;
        while ((sec = FindWindowEx(IntPtr.Zero, sec, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero)
        {
            if (!IsWindowVisible(sec)) continue;
            RECT r;
            GetWindowRect(sec, out r);
            if (Intersects(r, screen)) list.Add(r);
        }
        return list;
    }

    // The desktop icon list view lives under Progman, or under a WorkerW once
    // a live-wallpaper app has split the desktop.
    static IntPtr DesktopListView()
    {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero)
        {
            IntPtr w = IntPtr.Zero;
            while ((w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero)
            {
                defView = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (defView != IntPtr.Zero) break;
            }
        }
        if (defView == IntPtr.Zero) return IntPtr.Zero;
        return FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
    }

    public static List<RECT> DesktopIcons()
    {
        List<RECT> list = new List<RECT>();
        IntPtr lv = DesktopListView();
        if (lv == IntPtr.Zero || !IsWindowVisible(lv)) return list;
        int count = SendMessage(lv, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0) return list;
        if (count > 500) count = 500;
        uint pid;
        GetWindowThreadProcessId(lv, out pid);
        IntPtr proc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid);
        if (proc == IntPtr.Zero) return list;
        IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, new UIntPtr(16), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (mem == IntPtr.Zero)
        {
            CloseHandle(proc);
            return list;
        }
        try
        {
            byte[] buf = new byte[16];
            UIntPtr n;
            for (int i = 0; i < count; i++)
            {
                // RECT.left carries the request code: LVIR_BOUNDS (0) = icon + label.
                Array.Clear(buf, 0, 16);
                if (!WriteProcessMemory(proc, mem, buf, new UIntPtr(16), out n)) break;
                if (SendMessage(lv, LVM_GETITEMRECT, new IntPtr(i), mem) == IntPtr.Zero) continue;
                if (!ReadProcessMemory(proc, mem, buf, new UIntPtr(16), out n)) break;
                POINT tl = new POINT();
                tl.X = BitConverter.ToInt32(buf, 0);
                tl.Y = BitConverter.ToInt32(buf, 4);
                POINT br = new POINT();
                br.X = BitConverter.ToInt32(buf, 8);
                br.Y = BitConverter.ToInt32(buf, 12);
                ClientToScreen(lv, ref tl);
                ClientToScreen(lv, ref br);
                RECT r = new RECT();
                r.Left = tl.X;
                r.Top = tl.Y;
                r.Right = br.X;
                r.Bottom = br.Y;
                list.Add(r);
            }
        }
        finally
        {
            VirtualFreeEx(proc, mem, UIntPtr.Zero, MEM_RELEASE);
            CloseHandle(proc);
        }
        return list;
    }

    // ---- JSON -------------------------------------------------------------

    static void Rect(StringBuilder sb, string id, RECT r)
    {
        sb.Append("{\"id\":\"").Append(id).Append("\",\"x\":").Append(r.Left.ToString(CultureInfo.InvariantCulture))
          .Append(",\"y\":").Append(r.Top.ToString(CultureInfo.InvariantCulture))
          .Append(",\"w\":").Append((r.Right - r.Left).ToString(CultureInfo.InvariantCulture))
          .Append(",\"h\":").Append((r.Bottom - r.Top).ToString(CultureInfo.InvariantCulture)).Append('}');
    }

    static List<RECT> iconCache = new List<RECT>();
    static DateTime iconTime = DateTime.MinValue;

    public static string GeometryJson()
    {
        InitDpi();
        RECT screen = PrimaryMonitor();
        StringBuilder sb = new StringBuilder(4096);
        sb.Append("{\"screen\":");
        Rect(sb, "screen", screen);

        POINT c;
        GetCursorPos(out c);
        sb.Append(",\"cursor\":{\"x\":").Append(c.X.ToString(CultureInfo.InvariantCulture))
          .Append(",\"y\":").Append(c.Y.ToString(CultureInfo.InvariantCulture)).Append('}');

        sb.Append(",\"windows\":[");
        List<KeyValuePair<long, RECT>> wins = AppWindows(screen);
        for (int i = 0; i < wins.Count; i++)
        {
            if (i > 0) sb.Append(',');
            Rect(sb, "w" + wins[i].Key.ToString(CultureInfo.InvariantCulture), wins[i].Value);
        }
        sb.Append(']');

        // Icons rarely move; reading them touches Explorer's memory, so cache.
        if ((DateTime.UtcNow - iconTime).TotalMilliseconds > 1500)
        {
            try { iconCache = DesktopIcons(); }
            catch (Exception) { iconCache = new List<RECT>(); }
            iconTime = DateTime.UtcNow;
        }
        sb.Append(",\"icons\":[");
        for (int i = 0; i < iconCache.Count; i++)
        {
            if (i > 0) sb.Append(',');
            Rect(sb, "i" + i.ToString(CultureInfo.InvariantCulture), iconCache[i]);
        }
        sb.Append(']');

        sb.Append(",\"taskbars\":[");
        List<RECT> bars = Taskbars(screen);
        for (int i = 0; i < bars.Count; i++)
        {
            if (i > 0) sb.Append(',');
            Rect(sb, "t" + i.ToString(CultureInfo.InvariantCulture), bars[i]);
        }
        sb.Append("]}");
        return sb.ToString();
    }
}
