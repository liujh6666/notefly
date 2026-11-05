# -*- coding: utf-8 -*-
"""量「双击某个入口」的真实代价：控制台窗口活多久 + 应用到底有没有起来。

用法：
    python scripts/measure-launch-window.py <入口文件> [采样秒数]

输出三件事：
    1. 控制台窗口可见时长（用户肉眼看到的黑窗口）
    2. 启动日志增量（_launch.log）—— 判断启动器有没有真的执行
    3. 3210 端口是否响应 —— 判断服务有没有起来

⚠ 实现上有个坑：回调函数里**不要**直接写 ctypes.xxx —— 某些环境下
   编译器会把回调里的模块名改写掉（实测 ctypes → cypes，
   回调里就变成 NameError）。所以这里把用到的 ctypes 函数全部用
   默认参数绑进闭包，回调体内一次全局查找都不做。
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
shell32 = ctypes.WinDLL("shell32", 64)
LOG = os.path.join(ROOT, "logs", "_launch.log")

CON_EXES = ("cmd.exe", "node.exe", "powershell.exe", "wscript.exe", "cscript.exe")


def _make_enumerator():
    user32 = ctypes.WinDLL("user32", 64)
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    create_unicode_buffer = ctypes.create_unicode_buffer
    get_text_length = user32.GetWindowTextLengthW
    get_text = user32.GetWindowTextW
    get_class = user32.GetClassNameW
    get_pid = user32.GetWindowThreadProcessId
    is_visible = user32.IsWindowVisible
    enum_windows = user32.EnumWindows
    DWORD = wintypes.DWORD

    def vis():
        out = set()

        def cb(h, _l):
            if not is_visible(h):
                return True
            n = get_text_length(h)
            if n <= 0:
                return True
            b = create_unicode_buffer(n + 2)
            get_text(h, b, len(b))
            c = create_unicode_buffer(256)
            get_class(h, c, 256)
            pid = DWORD()
            get_pid(h, ctypes.byref(pid))
            out.add((pid.value, c.value, b.value))
            return True

        enum_windows(EnumWindowsProc(cb), 0)
        return out

    return vis


def is_con(cls, title):
    if any(k in cls.lower() for k in ("consolewindowclass", "cascadia", "pseudoconsole")):
        return True
    t = title.lower().replace("\\", "/")
    return any(t.endswith("/" + e) for e in CON_EXES)


def log_size():
    try:
        return os.path.getsize(LOG)
    except OSError:
        return 0


def port_ok():
    import urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open("http://127.0.0.1:3210/api/config", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "启动NoteFly.lnk"
    total = float(sys.argv[2]) if len(sys.argv) > 2 else 16.0
    path = os.path.join(ROOT, name)
    vis = _make_enumerator()

    base = vis()
    before_log = log_size()
    first, last = {}, {}
    t0 = time.time()
    shell32.ShellExecuteW(None, "open", path, None, None, 1)
    while time.time() - t0 < total:
        time.sleep(0.03)
        now = time.time() - t0
        for k in vis():
            if k in base:
                continue
            if k not in first:
                first[k] = now
            last[k] = now

    consoles = [(k, first[k], last[k]) for k in first if is_con(k[1], k[2])]
    print("入口：%s" % name)
    if consoles:
        worst = 0
        for (pid, cls, title), t1, t2 in sorted(consoles, key=lambda x: x[1]):
            life = (t2 - t1) * 1000
            worst = max(worst, life)
            print("   控制台窗口 +%.0fms~+%.0fms  可见约 %.0fms  title=%r"
                  % (t1 * 1000, t2 * 1000, life, title))
        print("   → 控制台最长可见 %.0fms" % worst)
    else:
        print("   → 全程零可见控制台窗口 ✔")

    grew = (os.path.getsize(LOG) - before_log) if os.path.exists(LOG) else 0
    print("   启动日志新增 %d 字节%s" % (grew, "（启动器执行了）" if grew > 0 else "（启动器没执行）"))
    print("   3210 端口：%s" % ("有响应" if port_ok() else "无响应"))


if __name__ == "__main__":
    main()
