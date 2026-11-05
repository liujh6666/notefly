# 生成 NoteFly 的 Windows 快捷方式（零窗口启动入口）
# ------------------------------------------------------------
# 这是 scripts/make-lnk.py 的退路：没装 Python 时用 Windows 自带的
# WScript.Shell COM 生成。COM 走的是系统自己的快捷方式写入器，
# 写出来的 .lnk 和资源管理器右键「创建快捷方式」完全同形，
# 必然带 LinkTargetIDList —— 外壳解析得动，双击就有反应。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-lnk.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"

if (-not (Test-Path $electron)) {
    Write-Host "[make-lnk] 没找到 Electron 运行时：$electron" -ForegroundColor Yellow
    Write-Host "[make-lnk] 请先执行 npm install" -ForegroundColor Yellow
    exit 0
}

$icon = Join-Path $root "public\app.ico"
if (-not (Test-Path $icon)) { $icon = "" }

function New-NoteflyLink([string]$path, [string]$arguments, [string]$title) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $electron
    $link.Arguments = $arguments
    $link.WorkingDirectory = $root
    $link.WindowStyle = 1          # SW_SHOWNORMAL
    if ($icon -ne "") { $link.IconLocation = "$icon,0" }
    $link.Description = $title
    $link.Save()
    Write-Host ("[make-lnk] 已生成 {0}" -f (Split-Path -Leaf $path))
}

# 两个快捷方式形状必须完全一致：同一个 electron.exe、同一个工作目录，
# 参数只差一个 browser —— 主进程据此分流（electron/main.js）。
New-NoteflyLink (Join-Path $root "启动NoteFly桌面版.lnk") "." "NoteFly 桌面版"
New-NoteflyLink (Join-Path $root "启动NoteFly.lnk") ". browser" "NoteFly 浏览器版"

exit 0
