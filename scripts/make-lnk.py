# -*- coding: utf-8 -*-
"""生成 Windows 快捷方式（.lnk）—— 零窗口启动入口。

为什么需要它：
    双击 .bat 必然启动 cmd.exe —— cmd 是控制台程序，在 Windows 11 上还会被
    「默认终端应用」（本机是 Windows Terminal）接管，弹出一个 Terminal 窗口，
    而且**那个窗口不会自行关闭**。这是系统行为，脚本层绕不开。
    真正零窗口的入口必须指向一个 **GUI 子系统** 的可执行文件。
    本项目的 Electron 运行时（electron.exe，PE Subsystem=2）正好是 GUI 程序。

    所以最终形态是：快捷方式直接指向 electron.exe，双击全程零窗口；
    .bat 只作为兼容入口，转交同名 .lnk 后立即退出。

为什么不直接用 COM 生成：
    捷径由 COM 的 WScript.Shell.CreateShortcut 生成最省事，但换台机器未必
    有 PowerShell。这里直接按 MS-SHLLINK 规范写二进制，零依赖、跨平台可复现。
    （scripts/make-lnk.ps1 是 COM 版的退路，由 scripts/make-lnk.js 自动挑选。）

⚠ 两条硬约束（踩过才知道）：
    1) .lnk **必须带 LinkTargetIDList**（外壳靠它解析目标）。实测去掉这一段、
       只留 LinkInfo 的 .lnk 双击毫无反应。
    2) LinkInfo 的 LinkInfoFlags 必须是 1（VolumeInfoAndLocalBasePath），
       VolumeIDOffset / LocalBasePathOffset 要按 Windows 的实际字节布局来。
       写错的表现是双击弹「Windows 无法访问指定设备、路径或文件」。

用法：python scripts/make-lnk.py
生成：<项目根>/启动NoteFly.lnk（浏览器版）、启动NoteFly桌面版.lnk（桌面版）
"""
import os
import struct
import ctypes
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# MS-SHLLINK
LINK_CLSID = bytes.fromhex("0114020000000000C000000000000046")

HAS_LINK_TARGET_ID_LIST = 0x00000001
HAS_LINK_INFO = 0x00000002
HAS_NAME = 0x00000004
HAS_RELATIVE_PATH = 0x00000008
HAS_WORKING_DIR = 0x00000010
HAS_ARGUMENTS = 0x00000020
HAS_ICON_LOCATION = 0x00000040
IS_UNICODE = 0x00000080

_shell32 = ctypes.WinDLL("shell32")
_ole32 = ctypes.WinDLL("ole32")


def _absolute_pidl(path):
    """把路径解析成绝对 PIDL（IDList 用的那段二进制）。

    手写 PIDL 很容易错：每一项除名字外还带 shell 私有的扩展数据
    （时间戳、大小、卷信息），字节数算错就解析不出来。
    直接调 shell32 的 SHParseDisplayName 让系统生成最稳。
    """
    SHParseDisplayName = _shell32.SHParseDisplayName
    SHParseDisplayName.argtypes = [
        wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
    ]
    SHParseDisplayName.restype = ctypes.c_long

    ptr = ctypes.c_void_p()
    hr = SHParseDisplayName(os.path.abspath(path), None, ctypes.byref(ptr), 0, None)
    if hr != 0 or not ptr:
        raise OSError("SHParseDisplayName 失败: 0x%08X (%s)" % (hr & 0xFFFFFFFF, path))

    try:
        # PIDL 是若干项的链表，每项以 2 字节长度开头，逐项拷贝即可
        buf = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_ubyte))
        out = bytearray()
        off = 0
        while True:
            cb = buf[off] | (buf[off + 1] << 8)
            if cb == 0:
                break
            out += bytes(bytearray(buf[off + i] for i in range(cb)))
            off += cb
        out += b"\x00\x00"          # IDList 结束符
        return bytes(out)
    finally:
        try:
            _ole32.ILFree(ptr)
        except Exception:
            pass  # 释放失败无所谓，脚本马上就退出


def _utf16(s):
    return s.encode("utf-16-le")


def _filetime(unix_ts):
    """unix 时间戳 → Windows FILETIME（自 1601-01-01 起的 100 纳秒数）。"""
    return int((unix_ts + 11644473600) * 10000000) & 0xFFFFFFFFFFFFFFFF


def _volume_info(drive):
    """取卷标与卷序列号（VolumeID 结构要写）。失败就返回空。"""
    try:
        kernel32 = ctypes.WinDLL("kernel32", 64)
        name = ctypes.create_unicode_buffer(261)
        serial = wintypes.DWORD(0)
        max_comp = wintypes.DWORD(0)
        flags = wintypes.DWORD(0)
        ok = kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(drive + "\\"), name, 261, ctypes.byref(serial),
            ctypes.byref(max_comp), ctypes.byref(flags), None, 0)
        if not ok:
            return 0, ""
        return serial.value & 0xFFFFFFFF, name.value
    except Exception:
        return 0, ""


def _volume_id(drive):
    """VolumeID 结构（照抄 Windows 自己写出来的形状）。

    布局（MS-SHLLINK 2.3.2.4，Windows 实际写法）：
        VolumeIDSize(4) | VolumeIDFlags(4)=3 | DriveSerialNumber(4)
        | DriveLetterOffset(4)=16 | 卷标(ANSI)+NUL

    ⚠ Windows 把卷标写成 ANSI 而不是 UTF-16 的盘符，
      这里必须一致，否则外壳解析出来的盘符/卷全是乱的。
    """
    serial, label = _volume_info(drive)
    label_bytes = label.encode("mbcs", "replace") + b"\x00"
    size = 16 + len(label_bytes)
    return struct.pack("<IIII", size, 3, serial, 16) + label_bytes


def _link_info(local_base_path):
    """LinkInfo 结构（MS-SHLLINK 2.3.2.3）。

    ⚠⚠ 这里曾经写错过两次，两次都表现为「双击快捷方式弹
    「Windows 无法访问指定设备、路径或文件」」：

      1) LinkInfoFlags 写成 0。该位是 VolumeInfoAndLocalBasePath，
         为 0 时外壳根本不按「卷信息 + 本地基路径」来读，
         后面那个 LocalBasePathOffset 会被当成别的结构的偏移 → 解析失败。
         Windows 自己写的一律是 1。
      2) VolumeIDOffset 写成 0 而 LocalBasePathOffset 写 0x1C。
         真实布局是：卷信息块在 0x1C 处，本地基路径紧跟在卷信息块**后面**。

    现在完全按 Windows 的实际字节布局来写：
        [LinkInfo 头 28 字节]
        [VolumeID 块]
        [LocalBasePath: ANSI 路径 + NUL]
        [CommonPathSuffix: 空串（只有一个 NUL）]
    """
    base = local_base_path.replace("/", "\\")
    drive = base[:2] if len(base) > 1 and base[1] == ":" else "C:"
    vol = _volume_id(drive)
    path_bytes = base.encode("mbcs", "replace") + b"\x00"

    volume_off = 0x1C                       # 卷信息紧跟在 28 字节头后面
    localbase_off = volume_off + len(vol)   # 本地基路径紧跟在卷信息后面
    suffix_off = localbase_off + len(path_bytes)   # 空后缀：只有一个 NUL
    size = suffix_off + 1

    header = struct.pack(
        "<IIIIIII",
        size,          # LinkInfoSize
        0x1C,          # LinkInfoHeaderSize
        1,             # LinkInfoFlags = VolumeInfoAndLocalBasePath
        volume_off,    # VolumeIDOffset
        localbase_off, # LocalBasePathOffset
        0,             # CommonNetworkRelativeLinkOffset（0 = 无网络路径）
        suffix_off,    # CommonPathSuffixOffset（指向那个空后缀）
    )
    return header + vol + path_bytes + b"\x00"


def _string_data(text):
    """StringData 的一段：2 字节字符数 + UTF-16LE 字符。

    ⚠ 段与段之间**没有空字符终止符** —— Windows 自己写出来的 .lnk 就是
    「count + 字符」紧密排列（对照系统里 AutoHotkey / WampServer 的快捷方式，
    第一个字符串的字符后面紧跟的就是下一个字符串的 count）。
    多写一个 \\x00\\x00 会让后面所有字段整体错位：目标路径还能解析出来，
    但参数会被读成空 —— 表现就是「双击启动了程序，却没带参数」。
    """
    return struct.pack("<H", len(text)) + _utf16(text)


def _relative(target, base_dir):
    """相对路径；跨盘符时返回空串（拼不出合法相对路径）。"""
    try:
        rel = os.path.relpath(target, base_dir)
    except ValueError:
        return ""
    if rel.startswith("..") and ".." + os.sep in rel and os.path.splitdrive(rel)[0]:
        return ""
    return rel


def make_lnk(out_path, target, args="", workdir="", icon="", icon_index=0,
             name=None, relpath=False):
    """写出一个 .lnk 文件。

    target    目标可执行文件（绝对路径）
    args      参数（相对工作目录的相对路径也可以）
    workdir   工作目录
    icon      图标文件（.ico）
    name      快捷方式显示名；None = 不写这个字段
    relpath   相对路径；默认**不写**这个字段（见下）

    ⚠ 不要写 RelativePath。
      MS-SHLLINK 里这个字段的基准目录有歧义：按「快捷方式所在目录」算，
      按「目标所在目录」算，行为并不一致。Windows 自己创建的快捷方式
      （对照系统里 Start Menu 的 Electron.lnk）根本不写这个字段 ——
      我们照做，别自己发明。
    """
    flags = HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO
    flags |= HAS_WORKING_DIR if workdir else 0
    flags |= HAS_ARGUMENTS if args else 0
    flags |= HAS_ICON_LOCATION if icon else 0
    flags |= IS_UNICODE

    if name is not None:
        flags |= HAS_NAME
    if relpath is not False:
        flags |= HAS_RELATIVE_PATH

    # 头部（76 字节）—— 字段顺序与 Windows 自己写的一致
    stat = None
    try:
        st = os.stat(target)
        stat = (int(st.st_size) & 0xFFFFFFFF,
                _filetime(st.st_mtime), _filetime(st.st_atime), _filetime(st.st_ctime))
    except OSError:
        stat = (0, 0, 0, 0)

    header = struct.pack(
        "<I16sIIIIIIIIIIIHHII",
        0x4C,                       # HeaderSize
        LINK_CLSID,                 # LinkCLSID
        flags,                      # LinkFlags
        0x20,                       # FileAttributes = FILE_ATTRIBUTE_ARCHIVE
        stat[1] & 0xFFFFFFFF, stat[1] >> 32,     # CreationTime
        stat[2] & 0xFFFFFFFF, stat[2] >> 32,     # AccessTime
        stat[3] & 0xFFFFFFFF, stat[3] >> 32,     # WriteTime
        stat[0],                    # FileSize（目标文件大小）
        icon_index,                 # IconIndex
        1,                          # ShowCommand = SW_SHOWNORMAL
        0,                          # HotKey
        0,                          # Reserved
        0, 0,                       # Reserved2 / Reserved3
    )

    body = b""
    pidl = _absolute_pidl(target)
    body += struct.pack("<H", len(pidl)) + pidl
    body += _link_info(target)

    if name is not None:
        body += _string_data(name or os.path.basename(out_path))
    if relpath is not False:
        lnk_dir = os.path.dirname(os.path.abspath(out_path))
        if relpath is None:
            relpath = _relative(target, lnk_dir)
        body += _string_data(relpath)
    if workdir:
        body += _string_data(workdir)
    if args:
        body += _string_data(args)
    if icon:
        body += _string_data("%s,%d" % (icon, icon_index))

    body += struct.pack("<I", 0)    # TerminalBlock

    with open(out_path, "wb") as f:
        f.write(header + body)
    return out_path


def main():
    electron = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
    if not os.path.exists(electron):
        print("! 没找到 Electron 运行时，先执行 npm install：", electron)
        print("  快捷方式稍后会自动生成，或现在手动执行：npm install")
        return

    icon = os.path.join(ROOT, "public", "app.ico")
    if not os.path.exists(icon):
        icon = ""

    made = []
    made.append(make_lnk(
        os.path.join(ROOT, "启动NoteFly桌面版.lnk"),
        target=electron,
        # args 必须是 "."（相对工作目录），工作目录指向放 package.json 的目录。
        # 这个形状是实测唯一能从 .bat 正常启动的：应用路径若指向别处，
        # electron.exe 会卡在启动阶段、根本不加载应用脚本。
        args=".",
        workdir=ROOT,
        icon=icon,
        name="NoteFly 桌面版",
    ))
    made.append(make_lnk(
        os.path.join(ROOT, "启动NoteFly.lnk"),
        target=electron,
        # 浏览器版与桌面版**形状必须完全一致**：同一个 electron.exe、同一个
        # 工作目录（项目根），参数只多一个 "browser"（主进程据此分流）。
        # 之前这里写的是 scripts/launch-server.js 的绝对路径、外加一个
        # browser-launcher 子目录做工作目录 —— 外壳解析快捷方式时直接判
        # 「目标不可访问」，双击弹「Windows 无法访问指定设备、路径或文件」。
        args=". browser",
        workdir=ROOT,
        icon=icon,
        name="NoteFly 浏览器版",
    ))

    for p in made:
        print("written:", p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
