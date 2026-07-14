using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const int AttachParentProcess = -1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [STAThread]
    private static int Main(string[] args)
    {
        var root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var node = Path.Combine(root, "node", "node.exe");
        var app = Path.Combine(root, "app");
        var bin = Path.Combine(app, "bin", "intelbyte.js");

        if (!File.Exists(node) || !File.Exists(bin))
        {
            MessageBox.Show(
                "IntelByte install is broken.\n\nRe-run IntelByte-Setup.exe.",
                "IntelByte", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // Split GUI flags from CLI passthrough. `--minimized` boots straight to the
        // tray (used by the "Start with Windows" shortcut); any other args behave
        // as the CLI (IntelByte.exe protect-mail ...).
        var minimized = false;
        var passthrough = new List<string>();
        foreach (var a in args)
        {
            if (a == "--minimized" || a == "/min" || a == "-m") minimized = true;
            else passthrough.Add(a);
        }
        if (passthrough.Count > 0) return RunCliConsole(node, bin, app, passthrough.ToArray());

        // Single instance: if IntelByte is already running (e.g. in the tray), ask
        // that instance to surface its window and exit — never launch a second copy
        // (two would each run setup+start and fight, which looked like the window
        // "closing and reopening").
        bool createdNew;
        var mutex = new Mutex(true, "IntelByte_SingleInstance_v1", out createdNew);
        if (!createdNew)
        {
            try
            {
                NativeMethods.PostMessage(new IntPtr(NativeMethods.HWND_BROADCAST),
                    AppWindow.WmShowIntelByte, IntPtr.Zero, IntPtr.Zero);
            }
            catch { /* best effort */ }
            return 0;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            var win = new AppWindow(node, bin, app, minimized);
            NativeMethods.ForceHandle(win); // create the native handle now so the tray
                                            // + single-instance broadcast work even when
                                            // we boot straight to the tray (hidden).
            Application.Run(win);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "IntelByte could not start:\n\n" + ex.Message,
                "IntelByte",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
        GC.KeepAlive(mutex);
        return 0;
    }

    /// Run the Node CLI hidden and return combined stdout+stderr (for the GUI).
    internal static string RunCli(string node, string bin, string app, string[] args)
    {
        var full = new string[args.Length + 1];
        full[0] = bin;
        Array.Copy(args, 0, full, 1, args.Length);

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = QuoteArgs(full),
            WorkingDirectory = app,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.EnvironmentVariables["INTELBYTE_APP_ROOT"] = app;
        psi.EnvironmentVariables["INTELBYTE_NODE"] = node;
        psi.EnvironmentVariables["NO_COLOR"] = "1";

        try
        {
            using (var proc = Process.Start(psi))
            {
                if (proc == null) return "";
                var outText = proc.StandardOutput.ReadToEnd();
                var errText = proc.StandardError.ReadToEnd();
                proc.WaitForExit();
                return outText + errText;
            }
        }
        catch (Exception ex)
        {
            return "ERROR: " + ex.Message;
        }
    }

    private static int RunCliConsole(string node, string bin, string app, string[] args)
    {
        if (!AttachConsole(AttachParentProcess)) AllocConsole();

        var full = new string[args.Length + 1];
        full[0] = bin;
        Array.Copy(args, 0, full, 1, args.Length);

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = QuoteArgs(full),
            WorkingDirectory = app,
            UseShellExecute = false,
            CreateNoWindow = false,
        };
        psi.EnvironmentVariables["INTELBYTE_APP_ROOT"] = app;
        psi.EnvironmentVariables["INTELBYTE_NODE"] = node;

        using (var proc = Process.Start(psi))
        {
            if (proc == null) return 1;
            proc.WaitForExit();
            return proc.ExitCode;
        }
    }

    private static string QuoteArgs(string[] parts)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < parts.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(Quote(parts[i]));
        }
        return sb.ToString();
    }

    internal static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        if (value.IndexOf(' ') < 0 && value.IndexOf('"') < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    // Load a frame of the embedded app icon at the requested size (crisp tray /
    // window / header art from a single multi-size .ico compiled into the exe).
    internal static Icon LoadIcon(int size)
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("intelbyte.ico"))
            {
                if (s == null) return null;
                return new Icon(s, new Size(size, size));
            }
        }
        catch { return null; }
    }

    internal static Icon LoadIconFull()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("intelbyte.ico"))
            {
                if (s == null) return null;
                return new Icon(s);
            }
        }
        catch { return null; }
    }

    // The header/window logo as a real PNG (Icon.ToBitmap() garbles PNG-encoded
    // icon frames, so we load the crisp PNG resource directly).
    internal static Image LoadLogo()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("intelbyte-logo.png"))
            {
                if (s == null) return null;
                using (var tmp = Image.FromStream(s))
                {
                    // Clone so we own a standalone bitmap (stream would close).
                    return new Bitmap(tmp);
                }
            }
        }
        catch { return null; }
    }

    // Detective/noir title face (Special Elite, embedded in the exe).
    internal static Font LoadDetectiveFont(float size, FontStyle style = FontStyle.Regular)
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("SpecialElite-Regular.ttf"))
            {
                if (s == null) return new Font("Courier New", size, style);
                var buf = new byte[s.Length];
                s.Read(buf, 0, buf.Length);
                var handle = GCHandle.Alloc(buf, GCHandleType.Pinned);
                try
                {
                    var col = new PrivateFontCollection();
                    col.AddMemoryFont(handle.AddrOfPinnedObject(), buf.Length);
                    return new Font(col.Families[0], size, style, GraphicsUnit.Point);
                }
                finally
                {
                    handle.Free();
                }
            }
        }
        catch
        {
            return new Font("Courier New", size, style);
        }
    }
}

/// Win32 helpers for single-instance signalling + forcing a hidden form's handle.
internal static class NativeMethods
{
    public const int HWND_BROADCAST = 0xffff;

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int RegisterWindowMessage(string message);

    // Accessing .Handle forces the native window into existence even while hidden.
    public static void ForceHandle(Form form)
    {
        if (form == null) return;
        try { if (form.Handle == IntPtr.Zero) { } } catch { }
    }
}

/// Crisp circular logo — black matte keyed out, no gray square corners.
internal sealed class LogoBox : Control
{
    private Image _src;
    private static readonly Color Ring = Color.FromArgb(64, 255, 255, 255);

    public LogoBox()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = AppTheme.Bg;
        Size = new Size(48, 48);
        ApplyCircleClip();
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        ApplyCircleClip();
    }

    private void ApplyCircleClip()
    {
        var path = new GraphicsPath();
        path.AddEllipse(0, 0, Width, Height);
        Region = new Region(path);
    }

    public void SetImage(Image img)
    {
        _src = img;
        Invalidate();
    }

    protected override void OnPaintBackground(PaintEventArgs pevent) { }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.SmoothingMode = SmoothingMode.HighQuality;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

        var box = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var circle = new GraphicsPath())
        {
            circle.AddEllipse(box);
            g.SetClip(circle);
            using (var matte = new SolidBrush(AppTheme.Bg))
                g.FillEllipse(matte, box);
            if (_src != null)
                g.DrawImage(_src, box);
            g.ResetClip();
            using (var pen = new Pen(Ring, 1f))
                g.DrawEllipse(pen, box);
        }
    }
}

/// Hides a window from OBS / Discord stream / screen capture (Windows 10 2004+).
internal static class StreamCapture
{
    private const uint WdaExcludeFromCapture = 0x00000011;

    [DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

    public static void HideFromCapture(Form form)
    {
        if (form == null) return;
        Apply(form);
        form.HandleCreated += StreamCaptureOnHandle;
        form.Shown += StreamCaptureOnHandle;
    }

    private static void StreamCaptureOnHandle(object sender, EventArgs e)
    {
        Apply(sender as Form);
    }

    private static void Apply(Form form)
    {
        if (form == null || !form.IsHandleCreated) return;
        try { SetWindowDisplayAffinity(form.Handle, WdaExcludeFromCapture); }
        catch { /* older Windows — no-op */ }
    }
}

internal static class UiShapes
{
    public static GraphicsPath RoundedRect(Rectangle r, int radius)
    {
        var path = new GraphicsPath();
        var d = Math.Max(4, radius * 2);
        if (r.Width < d || r.Height < d) { path.AddRectangle(r); return path; }
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void ApplyRoundedRegion(Control c, int radius)
    {
        if (c.Width < 4 || c.Height < 4) return;
        using (var path = RoundedRect(new Rectangle(0, 0, c.Width, c.Height), radius))
            c.Region = new Region(path);
    }
}

/// Flat control-painted button — rounded, inset, no border bleed.
internal sealed class FlatBtn : Control
{
    public Color Fill = AppTheme.Btn;
    public Color FillHover = AppTheme.BtnHover;
    public Color FillAccent = Color.Empty;
    public Color Border = AppTheme.BtnBorder;
    public int Radius = 8;
    private bool _hover;
    private bool _pressed;

    public FlatBtn(string text)
    {
        Text = text;
        Font = new Font("Segoe UI Semibold", 9.5f);
        ForeColor = Color.White;
        BackColor = AppTheme.Bg;
        Cursor = Cursors.Hand;
        TabStop = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.Selectable |
                 ControlStyles.Opaque, true);
        MouseEnter += delegate { _hover = true; Invalidate(); };
        MouseLeave += delegate { _hover = false; _pressed = false; Invalidate(); };
        MouseDown += delegate { _pressed = true; Invalidate(); };
        MouseUp += delegate { _pressed = false; Invalidate(); };
    }

    protected override void OnPaintBackground(PaintEventArgs pevent)
    {
        var bg = Parent != null ? Parent.BackColor : AppTheme.Bg;
        using (var brush = new SolidBrush(bg))
            pevent.Graphics.FillRectangle(brush, ClientRectangle);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space)
        {
            OnClick(EventArgs.Empty);
            e.Handled = true;
        }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        // Opaque style means OnPaintBackground isn't called — fill the whole control
        // with the parent's colour first so the rounded corners never leak the
        // desktop behind them.
        var parentBg = Parent != null ? Parent.BackColor : AppTheme.Bg;
        using (var pb = new SolidBrush(parentBg))
            g.FillRectangle(pb, new Rectangle(0, 0, Width, Height));

        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var rect = new Rectangle(1, 1, Width - 3, Height - 3);
        var color = FillAccent != Color.Empty
            ? (_pressed ? ControlPaint.Dark(FillAccent, 0.06f) : _hover ? ControlPaint.Light(FillAccent, 0.06f) : FillAccent)
            : (_pressed ? ControlPaint.Dark(Fill, 0.08f) : _hover ? FillHover : Fill);

        using (var path = UiShapes.RoundedRect(rect, Radius))
        using (var fill = new SolidBrush(color))
            g.FillPath(fill, path);
        using (var path = UiShapes.RoundedRect(rect, Radius))
        using (var pen = new Pen(Border))
            g.DrawPath(pen, path);

        TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
            TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
    }

    public void AsAccent(Color c)
    {
        FillAccent = c;
        Fill = c;
        Border = ControlPaint.Dark(c, 0.15f);
        ForeColor = Color.Black;
        Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold);
        Invalidate();
    }

    public void AsNeutral(Color normal, Color hover)
    {
        FillAccent = Color.Empty;
        Fill = normal;
        FillHover = hover;
        Border = AppTheme.BtnBorder;
        ForeColor = Color.White;
        Font = new Font("Segoe UI Semibold", 9.5f);
        Invalidate();
    }
}

internal static class AppTheme
{
    public static readonly Color Bg = Color.FromArgb(10, 10, 12);
    public static readonly Color Card = Color.FromArgb(20, 20, 26);
    public static readonly Color CardHi = Color.FromArgb(30, 30, 38);
    public static readonly Color Line = Color.FromArgb(52, 52, 64);
    public static readonly Color Btn = Color.FromArgb(36, 36, 44);
    public static readonly Color BtnHover = Color.FromArgb(52, 52, 62);
    public static readonly Color BtnBorder = Color.FromArgb(68, 68, 80);
    public static readonly Color AccentGreen = Color.FromArgb(72, 228, 140);
    public static readonly Color AccentRed = Color.FromArgb(240, 88, 96);
    public static readonly Color Dim = Color.FromArgb(148, 148, 158);
    public static readonly Color Muted = Color.FromArgb(98, 98, 108);
}

internal sealed class CardPanel : Panel
{
    public int Radius = 10;

    public CardPanel()
    {
        BackColor = AppTheme.Card;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
    }

    protected override void OnPaintBackground(PaintEventArgs pevent) { }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        // Paint the full bounds with the parent colour first so the rounded corners
        // outside the card don't leak whatever is behind the window.
        var parentBg = Parent != null ? Parent.BackColor : AppTheme.Bg;
        using (var pb = new SolidBrush(parentBg))
            g.FillRectangle(pb, new Rectangle(0, 0, Width, Height));

        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = UiShapes.RoundedRect(r, Radius))
        using (var fill = new SolidBrush(AppTheme.Card))
            g.FillPath(fill, path);
        using (var path = UiShapes.RoundedRect(r, Radius))
        using (var pen = new Pen(AppTheme.Line))
            g.DrawPath(pen, path);
    }
}

internal sealed class RowData
{
    public string Type;
    public string Real;
    public string Fake;
}

internal sealed class AppWindow : Form
{
    private readonly string _node;
    private readonly string _bin;
    private readonly string _app;
    private readonly bool _startMinimized;

    private readonly Panel _dot;
    private readonly Label _stateLbl;
    private readonly FlatBtn _toggle;
    private readonly CheckBox _startup;
    private readonly ListView _list;
    private readonly Label _foot;

    private NotifyIcon _tray;
    private System.Windows.Forms.Timer _refreshTimer;
    private bool _running;
    private bool _busy;
    private bool _reallyQuit;
    private bool _allowShow;
    private bool _bootDone;
    private bool _balloonShown;
    private volatile bool _refreshing;

    // Registered message a second launch broadcasts so this instance surfaces.
    public static readonly int WmShowIntelByte =
        NativeMethods.RegisterWindowMessage("IntelByte_Show_Message_v1");

    // Reals the user has clicked to reveal — persists across list refreshes.
    private readonly HashSet<string> _revealed = new HashSet<string>();

    private static readonly Color Bg = AppTheme.Bg;
    private static readonly Color Card = AppTheme.Card;
    private static readonly Color CardHi = AppTheme.CardHi;
    private static readonly Color Line = AppTheme.Line;
    private static readonly Color AccentGreen = AppTheme.AccentGreen;
    private static readonly Color AccentRed = AppTheme.AccentRed;
    private static readonly Color Dim = AppTheme.Dim;
    private static readonly Color Muted = AppTheme.Muted;
    private const int Side = 26;
    private const int CardW = 488;
    private const int Pad = 16;
    private const int InnerW = CardW - Pad * 2;
    private const int LogoSz = 52;

    public AppWindow(string node, string bin, string app, bool startMinimized)
    {
        _node = node;
        _bin = bin;
        _app = app;
        _startMinimized = startMinimized;
        _allowShow = !startMinimized;

        Text = "IntelByte";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(540, 640);
        BackColor = Bg;
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 9.5f);
        DoubleBuffered = true;
        var full = Program.LoadIconFull();
        if (full != null) Icon = full;

        // ---- Header accent line ----
        var headerLine = new Panel
        {
            Location = new Point(0, 0),
            Size = new Size(540, 3),
            BackColor = Color.FromArgb(72, 228, 140),
        };
        Controls.Add(headerLine);

        // ---- Header: logo column + text column (strict separation) ----
        var header = new TableLayoutPanel
        {
            Location = new Point(Side, 20),
            Size = new Size(CardW, 76),
            BackColor = Bg,
            ColumnCount = 2,
            RowCount = 2,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 58));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        header.RowStyles.Add(new RowStyle(SizeType.Absolute, 36f));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        Controls.Add(header);

        var logo = new LogoBox
        {
            Size = new Size(LogoSz, LogoSz),
            Margin = new Padding(0, 8, 0, 0),
            Anchor = AnchorStyles.None,
        };
        logo.SetImage(Program.LoadLogo());
        header.Controls.Add(logo, 0, 0);
        header.SetRowSpan(logo, 2);

        var title = new Label
        {
            Text = "IntelByte",
            Font = Program.LoadDetectiveFont(22f),
            AutoSize = true,
            Dock = DockStyle.Bottom,
            Margin = new Padding(4, 0, 0, 0),
            ForeColor = Color.White,
            BackColor = Bg,
        };
        header.Controls.Add(title, 1, 0);

        var sub = new Label
        {
            Text = "Hide your email, phone & names on screen while you stream.",
            Font = new Font("Segoe UI", 9f),
            Dock = DockStyle.Top,
            Margin = new Padding(4, 4, 0, 0),
            ForeColor = Dim,
            BackColor = Bg,
            UseMnemonic = false,
        };
        header.Controls.Add(sub, 1, 1);

        // ---- Status card ----
        var statusCard = MakeCard(new Rectangle(Side, 104, CardW, 84));
        Controls.Add(statusCard);

        _dot = new Panel { Size = new Size(10, 10), Location = new Point(Pad + 6, 38), BackColor = AccentRed };
        MakeCircle(_dot);
        statusCard.Controls.Add(_dot);

        _stateLbl = new Label
        {
            Text = "Protection OFF",
            Font = new Font("Segoe UI Semibold", 13f),
            AutoSize = true,
            Location = new Point(Pad + 24, 20),
            MaximumSize = new Size(240, 0),
            ForeColor = Color.White,
            BackColor = Card,
        };
        statusCard.Controls.Add(_stateLbl);

        var stateSub = new Label
        {
            Text = "Auto-connects to Discord & browsers.",
            Font = new Font("Segoe UI", 8.75f),
            AutoSize = true,
            Location = new Point(Pad + 24, 48),
            MaximumSize = new Size(240, 0),
            ForeColor = Muted,
            BackColor = Card,
            UseMnemonic = false,
        };
        statusCard.Controls.Add(stateSub);

        _toggle = new FlatBtn("Start");
        _toggle.Size = new Size(100, 36);
        _toggle.Location = new Point(CardW - Pad - 100, 24);
        _toggle.BackColor = Card;
        _toggle.Radius = 9;
        _toggle.AsAccent(AccentGreen);
        _toggle.Click += delegate { ToggleShield(); };
        statusCard.Controls.Add(_toggle);

        // ---- Start with Windows ----
        _startup = new CheckBox
        {
            Text = "  Start with Windows (open to tray, keep protecting)",
            Location = new Point(Side + 4, 198),
            AutoSize = true,
            ForeColor = Color.FromArgb(205, 205, 212),
            BackColor = Bg,
            Cursor = Cursors.Hand,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 9f),
        };
        _startup.CheckedChanged += delegate { OnStartupToggled(); };
        Controls.Add(_startup);

        // ---- Protected list (dark header, no white WinForms chrome) ----
        Controls.Add(new Label
        {
            Text = "PROTECTED ON SCREEN",
            Font = new Font("Segoe UI Semibold", 8.5f),
            AutoSize = true,
            Location = new Point(Side + 4, 232),
            ForeColor = Dim,
            BackColor = Bg,
        });
        Controls.Add(new Label
        {
            Text = "click a row to reveal",
            Font = new Font("Segoe UI", 8f),
            AutoSize = true,
            Location = new Point(Side + CardW - 130, 233),
            ForeColor = Muted,
            BackColor = Bg,
        });

        var listCard = MakeCard(new Rectangle(Side, 254, CardW, 248));
        Controls.Add(listCard);

        var colHead = new Panel
        {
            Location = new Point(Pad, Pad),
            Size = new Size(InnerW, 28),
            BackColor = CardHi,
        };
        colHead.Paint += delegate (object s, PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new Rectangle(0, 0, colHead.Width - 1, colHead.Height - 1);
            using (var path = UiShapes.RoundedRect(r, 6))
            using (var fill = new SolidBrush(CardHi))
                g.FillPath(fill, path);
            using (var pen = new Pen(Line))
                g.DrawLine(pen, 0, colHead.Height - 1, colHead.Width, colHead.Height - 1);
            // Align each header label with its ListView column (Type 0 / Hidden 72 /
            // Shown 268 + ~6px details-view text indent).
            var cols = new[] { "Type", "Hidden value", "Shown as" };
            var xs = new[] { 6, 78, 274 };
            using (var font = new Font("Segoe UI Semibold", 8.5f))
            {
                for (var i = 0; i < cols.Length; i++)
                    TextRenderer.DrawText(g, cols[i], font, new Point(xs[i], 7), Dim);
            }
        };
        listCard.Controls.Add(colHead);

        _list = new ListView
        {
            Location = new Point(Pad, Pad + 30),
            Size = new Size(InnerW, 248 - Pad * 2 - 30),
            View = View.Details,
            FullRowSelect = true,
            HeaderStyle = ColumnHeaderStyle.None,
            BorderStyle = BorderStyle.None,
            BackColor = Card,
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 9.5f),
            MultiSelect = false,
        };
        _list.Columns.Add("Type", 72);
        _list.Columns.Add("Hidden value", 196);
        _list.Columns.Add("Shown as", InnerW - 72 - 196);
        _list.MouseClick += ListMouseClick;
        listCard.Controls.Add(_list);

        // ---- Add / remove buttons (TableLayout — cannot overlap) ----
        var btnRow = new TableLayoutPanel
        {
            Location = new Point(Side, 514),
            Size = new Size(CardW, 40),
            BackColor = Bg,
            ColumnCount = 4,
            RowCount = 1,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        btnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        btnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        btnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        btnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        btnRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        Controls.Add(btnRow);

        AddRowBtn(btnRow, "+ Email", delegate { AddItem("email"); }, 0, false);
        AddRowBtn(btnRow, "+ Phone", delegate { AddItem("phone"); }, 1, false);
        AddRowBtn(btnRow, "+ Custom", delegate { AddItem("custom"); }, 2, false);
        AddRowBtn(btnRow, "Remove", delegate { RemoveSelected(); }, 3, true);

        _foot = new Label
        {
            Text = "Starting up…",
            Font = new Font("Segoe UI", 8.5f),
            AutoSize = true,
            Location = new Point(Side + 4, 566),
            ForeColor = Muted,
            BackColor = Bg,
        };
        Controls.Add(_foot);

        SetupTray();

        // Periodic status refresh — only while the window is actually on screen.
        // When minimized to the tray we stop it (see HideToTray), so IntelByte sits
        // idle instead of spawning node every few seconds in the background.
        _refreshTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        _refreshTimer.Tick += delegate { if (!_busy) RefreshAsync(false); };
        if (!startMinimized) _refreshTimer.Start();

        // One-shot boot: runs setup+start whether we start visible or hidden.
        var boot = new System.Windows.Forms.Timer { Interval = 150 };
        boot.Tick += delegate
        {
            boot.Stop();
            if (_bootDone) return;
            _bootDone = true;
            _startup.Checked = StartupEnabled();
            AutoStart();
            if (_startMinimized) HideToTray();
        };
        boot.Start();

        // Preview mode leaves the window capturable so its UI can be screenshotted.
        if (Environment.GetEnvironmentVariable("INTELBYTE_GUI_PREVIEW") != "1")
            StreamCapture.HideFromCapture(this);
    }

    // Keep the window hidden on a `--minimized` boot until the user opens it.
    protected override void SetVisibleCore(bool value)
    {
        if (!_allowShow && _startMinimized) { base.SetVisibleCore(false); return; }
        base.SetVisibleCore(value);
    }

    // A second launch broadcasts WmShowIntelByte — surface this instance instead of
    // starting a duplicate.
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmShowIntelByte)
        {
            try { ShowFromTray(); } catch { }
            return;
        }
        base.WndProc(ref m);
    }

    // ---- tray ----------------------------------------------------------------

    private void SetupTray()
    {
        _tray = new NotifyIcon();
        var ico = Program.LoadIcon(16);
        _tray.Icon = ico != null ? ico : (Icon ?? SystemIcons.Application);
        _tray.Text = "IntelByte — screen privacy";
        _tray.Visible = true;
        _tray.DoubleClick += delegate { ShowFromTray(); };

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open IntelByte", null, delegate { ShowFromTray(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Start / Stop protection", null, delegate { ToggleShield(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, delegate { _reallyQuit = true; Close(); });
        _tray.ContextMenuStrip = menu;
    }

    private void HideToTray()
    {
        _allowShow = false;
        if (_refreshTimer != null) _refreshTimer.Stop(); // idle in the tray, no polling
        // NOTE: never toggle ShowInTaskbar here — changing it recreates the native
        // handle, which makes the window visibly vanish and pop back ("closing and
        // reopening"). A hidden form is already absent from the taskbar.
        Hide();
        if (!_balloonShown)
        {
            _balloonShown = true;
            try { _tray.ShowBalloonTip(2500, "IntelByte", "Still protecting in the background. Right-click the tray icon to quit.", ToolTipIcon.None); }
            catch { }
        }
    }

    private void ShowFromTray()
    {
        _allowShow = true;
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        BringToFront();
        Activate();
        if (_refreshTimer != null && !_refreshTimer.Enabled) _refreshTimer.Start();
        RefreshAsync(true);
    }

    // X button → hide to tray instead of quitting (protection keeps running).
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_reallyQuit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        if (_tray != null) _tray.Visible = false;
        base.OnFormClosing(e);
    }

    // ---- boot / toggle -------------------------------------------------------

    // On launch: wire the CDP apps (setup) and start the shield in the background,
    // so protection "just works" without the user doing anything.
    private void AutoStart()
    {
        // Preview mode: show the UI without touching apps (used to screenshot the
        // window). Never set in normal use.
        if (Environment.GetEnvironmentVariable("INTELBYTE_GUI_PREVIEW") == "1")
        {
            RefreshAsync(true);
            SetBusy(false, "");
            return;
        }
        SetBusy(true, "Setting up and starting protection…");
        RunBg(new string[][] { new[] { "setup" }, new[] { "start" } }, delegate
        {
            RefreshAsync(true);
            SetBusy(false, "");
        });
    }

    private void ToggleShield()
    {
        if (_busy) return;
        var cmd = _running ? "stop" : "start";
        SetBusy(true, _running ? "Stopping…" : "Starting protection (restarting open apps)…");
        if (_running)
            RunBg(new string[][] { new[] { cmd } }, delegate
            {
                RefreshAsync(true);
                SetBusy(false, "");
            });
        else
            RunBg(new string[][] { new[] { "setup" }, new[] { "start" } }, delegate
        {
            RefreshAsync(true);
            SetBusy(false, "");
        });
    }

    // ---- add / remove --------------------------------------------------------

    private void AddItem(string kind)
    {
        if (_busy) return;
        string title, label, cmd;
        if (kind == "email") { title = "Add email"; label = "Email to hide on screen:"; cmd = "protect-mail"; }
        else if (kind == "phone") { title = "Add phone"; label = "Phone number to hide on screen:"; cmd = "protect-phone"; }
        else { title = "Add custom"; label = "Any text or name to hide on screen:"; cmd = "protect-custom"; }

        using (var dlg = new InputPrompt(title, label))
        {
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            var real = (dlg.Value ?? "").Trim();
            if (real.Length == 0) return;
            var fake = (dlg.Fake ?? "").Trim();

            string[] command;
            if (fake.Length > 0)
            {
                // Pick the fake yourself instead of a random one.
                if (kind == "custom") command = new[] { "protect-custom-custom", real, fake };
                else command = new[] { cmd, "custom", real, fake };
            }
            else
            {
                command = new[] { cmd, real };
            }

            SetBusy(true, "Adding…");
            RunBg(new string[][] { command }, delegate
            {
                RefreshAsync(true);
                SetBusy(false, "");
            });
        }
    }

    private void RemoveSelected()
    {
        if (_busy || _list.SelectedItems.Count == 0) return;
        var item = _list.SelectedItems[0];
        var row = item.Tag as RowData;
        if (row == null) return;
        string cmd = row.Type == "Email" ? "unprotect-mail" : row.Type == "Phone" ? "unprotect-phone" : "unprotect-custom";
        _revealed.Remove(row.Real);
        SetBusy(true, "Removing…");
        RunBg(new string[][] { new[] { cmd, row.Real } }, delegate
        {
            RefreshAsync(true);
            SetBusy(false, "");
        });
    }

    // Click a row to reveal / re-hide its real value.
    private void ListMouseClick(object sender, MouseEventArgs e)
    {
        var item = _list.GetItemAt(e.X, e.Y);
        if (item == null) return;
        var row = item.Tag as RowData;
        if (row == null) return;
        if (_revealed.Contains(row.Real)) _revealed.Remove(row.Real);
        else _revealed.Add(row.Real);
        item.SubItems[1].Text = _revealed.Contains(row.Real) ? row.Real : MaskValue(row.Real, row.Type);
    }

    // ---- Start with Windows --------------------------------------------------

    private static string StartupLnkPath()
    {
        var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        return Path.Combine(startup, "IntelByte.lnk");
    }

    private static bool StartupEnabled()
    {
        return File.Exists(StartupLnkPath());
    }

    private void OnStartupToggled()
    {
        var want = _startup.Checked;
        if (want == StartupEnabled()) return; // reflects current state, nothing to do
        try
        {
            if (want)
            {
                var exe = Assembly.GetExecutingAssembly().Location;
                CreateShortcut(StartupLnkPath(), exe, "--minimized",
                    Path.GetDirectoryName(exe), "IntelByte — screen privacy shield");
                _foot.Text = "IntelByte will open (to tray) when Windows starts.";
            }
            else
            {
                var lnk = StartupLnkPath();
                if (File.Exists(lnk)) File.Delete(lnk);
                _foot.Text = "IntelByte will no longer start with Windows.";
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not update auto-start:\n" + ex.Message, "IntelByte",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            _startup.Checked = StartupEnabled();
        }
    }

    private static void CreateShortcut(string path, string target, string args, string workdir, string desc)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        if (File.Exists(path)) File.Delete(path);

        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new InvalidOperationException("Windows Script Host unavailable.");
        var shell = Activator.CreateInstance(shellType);
        var sc = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        var t = sc.GetType();
        t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
        t.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args });
        t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workdir });
        t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
        t.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { desc });
        t.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
    }

    // ---- status / list -------------------------------------------------------

    private void RunBg(string[][] commands, Action done)
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            foreach (var c in commands)
            {
                try { Program.RunCli(_node, _bin, _app, c); }
                catch { /* keep going */ }
            }
            try { BeginInvoke(done); } catch { /* closing */ }
        });
    }

    private void RefreshAsync(bool full)
    {
        if (_refreshing) return; // never let two status polls overlap
        _refreshing = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var status = Program.RunCli(_node, _bin, _app, new[] { "status" });
                var list = Program.RunCli(_node, _bin, _app, new[] { "list", "--reveal" });
                try { BeginInvoke((Action)delegate { ApplyState(status, list); }); }
                catch { /* window closing */ }
            }
            finally { _refreshing = false; }
        });
    }

    private void ApplyState(string status, string list)
    {
        var running = status != null && status.IndexOf("running", StringComparison.OrdinalIgnoreCase) >= 0
                      && status.IndexOf("Not running", StringComparison.OrdinalIgnoreCase) < 0;
        _running = running;
        _dot.BackColor = running ? AccentGreen : AccentRed;
        _stateLbl.Text = running ? "Protection ON" : "Protection OFF";
        _stateLbl.ForeColor = running ? AccentGreen : Color.White;
        _stateLbl.BackColor = Card;
        _toggle.Text = running ? "Stop" : "Start";
        if (running)
            _toggle.AsNeutral(Color.FromArgb(38, 38, 46), Color.FromArgb(54, 54, 64));
        else
            _toggle.AsAccent(AccentGreen);

        _list.BeginUpdate();
        _list.Items.Clear();
        FillFromList(list);
        _list.EndUpdate();
        if (_list.Items.Count == 0)
        {
            var empty = new ListViewItem("");
            empty.SubItems.Add("Nothing protected yet — add an email, phone, or name.");
            empty.ForeColor = Dim;
            _list.Items.Add(empty);
        }

        if (!_busy)
            _foot.Text = running ? "Protection is running." : "Protection is off — press Start.";
    }

    // Parse CLI `list --reveal` (Type header lines + "real → fake" rows) into rows.
    private void FillFromList(string list)
    {
        if (string.IsNullOrEmpty(list)) return;
        var type = "";
        var lines = list.Replace("\r", "").Split('\n');
        foreach (var raw in lines)
        {
            var line = raw.TrimEnd();
            var t = line.Trim();
            if (t.StartsWith("Protected email")) { type = "Email"; continue; }
            if (t.StartsWith("Protected phone")) { type = "Phone"; continue; }
            if (t.StartsWith("Protected custom")) { type = "Custom"; continue; }
            var arrow = line.IndexOf("→");
            if (arrow < 0) arrow = line.IndexOf("->");
            if (arrow >= 0 && type.Length > 0)
            {
                var left = line.Substring(0, arrow).Trim();
                var right = line.Substring(arrow + 1).Trim();
                if (right.StartsWith(">")) right = right.Substring(1).Trim();
                if (left.Length == 0) continue;

                var row = new RowData { Type = type, Real = left, Fake = right };
                var revealed = _revealed.Contains(left);
                var item = new ListViewItem(type);
                item.SubItems.Add(revealed ? left : MaskValue(left, type));
                item.SubItems.Add(right);
                item.Tag = row;
                _list.Items.Add(item);
            }
        }
    }

    // Mask a real value for on-screen display: first char + **** + short tail.
    private static string MaskValue(string v, string type)
    {
        if (string.IsNullOrEmpty(v)) return v;
        var at = v.IndexOf('@');
        if (at > 0)
        {
            var dot = v.LastIndexOf('.');
            var tail = (dot > at) ? v.Substring(dot) : v.Substring(at);
            return v.Substring(0, 1) + "****" + tail; // m****.com
        }
        if (v.Length <= 2) return "****";
        if (v.Length <= 4) return v.Substring(0, 1) + "****";
        return v.Substring(0, 1) + "****" + v.Substring(v.Length - 2);
    }

    private void SetBusy(bool busy, string msg)
    {
        _busy = busy;
        _toggle.Enabled = !busy;
        if (msg.Length > 0) _foot.Text = msg;
        else _foot.Text = _running ? "Protection is running." : "Protection is off — press Start.";
    }

    // ---- painting helpers ----------------------------------------------------

    private static void AddRowBtn(TableLayoutPanel row, string text, EventHandler click, int col, bool last)
    {
        var b = new FlatBtn(text);
        b.Dock = DockStyle.Fill;
        // Identical margin on every button → all four are exactly the same width with
        // even gaps (previously the last one was 8px wider).
        b.Margin = new Padding(4, 0, 4, 0);
        b.BackColor = AppTheme.Bg;
        b.Click += click;
        row.Controls.Add(b, col, 0);
    }

    private Panel MakeCard(Rectangle bounds)
    {
        return new CardPanel { Bounds = bounds };
    }

    private static void MakeCircle(Control c)
    {
        var path = new GraphicsPath();
        path.AddEllipse(0, 0, c.Width, c.Height);
        c.Region = new Region(path);
    }
}

internal sealed class InputPrompt : Form
{
    private readonly TextBox _box;
    private readonly TextBox _fakeBox;
    public string Value { get { return _box.Text; } }
    public string Fake { get { return _fakeBox.Text; } }

    public InputPrompt(string title, string label)
    {
        Text = "IntelByte — " + title;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 220);
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(14, 14, 18);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 9.5f);
        var ico = Program.LoadIconFull();
        if (ico != null) Icon = ico;
        ShowInTaskbar = false;

        Controls.Add(new Label
        {
            Text = label,
            Location = new Point(16, 16),
            AutoSize = true,
            ForeColor = Color.FromArgb(210, 210, 214),
        });

        _box = new TextBox
        {
            Location = new Point(16, 42),
            Width = 408,
            BackColor = Color.FromArgb(32, 32, 38),
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 11f),
        };
        Controls.Add(_box);

        Controls.Add(new Label
        {
            Text = "Show instead as  (leave empty for a random fake):",
            Location = new Point(16, 82),
            AutoSize = true,
            ForeColor = Color.FromArgb(150, 150, 158),
        });

        _fakeBox = new TextBox
        {
            Location = new Point(16, 106),
            Width = 408,
            BackColor = Color.FromArgb(32, 32, 38),
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 11f),
        };
        Controls.Add(_fakeBox);

        var ok = new FlatBtn("Add");
        ok.Size = new Size(96, 36);
        ok.Location = new Point(232, 158);
        ok.BackColor = BackColor;
        ok.AsAccent(Color.FromArgb(64, 220, 130));
        ok.Click += delegate { DialogResult = DialogResult.OK; Close(); };
        Controls.Add(ok);

        var cancel = new FlatBtn("Cancel");
        cancel.Size = new Size(96, 36);
        cancel.Location = new Point(328, 158);
        cancel.BackColor = BackColor;
        cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
        Controls.Add(cancel);

        KeyPreview = true;
        KeyDown += delegate (object s, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) { DialogResult = DialogResult.Cancel; Close(); }
            else if (e.KeyCode == Keys.Enter) { DialogResult = DialogResult.OK; Close(); }
        };
        Shown += delegate { _box.Focus(); };
        StreamCapture.HideFromCapture(this);
    }
}
