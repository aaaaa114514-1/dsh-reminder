import { spawn } from 'node:child_process'
import { join } from 'node:path'

const FLASH_GAP_MS = 400
let lastFlashAt = 0
let flashWarned = false

export type FlashResult = { ok: true; hwnds: number[] } | { ok: false; error: string }

function powershellPath(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const FLASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshFlash {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }
  public const uint FLASHW_ALL = 3;
  public const uint FLASHW_TIMER = 4;
  public const uint FLASHW_TIMERNOFG = 12;
  public static List<long> Find(int[] pids) {
    var set = new HashSet<int>(pids);
    var found = new List<long>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (set.Contains((int)pid) && IsWindow(h)) found.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Flash(long hwnd, bool force) {
    var info = new FLASHWINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    info.hwnd = new IntPtr(hwnd);
    info.dwFlags = force ? FLASHW_ALL | FLASHW_TIMER : FLASHW_ALL | FLASHW_TIMERNOFG;
    info.uCount = force ? 8u : 0u;
    info.dwTimeout = 0;
    return FlashWindowEx(ref info);
  }
}
"@
$pids = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids.Count) { Write-Output 'error:DSH Desktop is not running.'; exit 1 }
$hwnds = [DshFlash]::Find([int[]]$pids)
if (-not $hwnds.Count) {
  $hwnds = @(Get-Process -Id $pids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [int64]$_.MainWindowHandle })
}
if (-not $hwnds.Count) { Write-Output 'error:No DSH Desktop window handle.'; exit 1 }
$force = $env:DSH_REMINDER_FLASH_FORCE -eq '1'
$ok = $false
foreach ($hwnd in $hwnds) {
  if ([DshFlash]::Flash($hwnd, $force)) {
    $ok = $true
    Write-Output ("shown:" + $hwnd)
  }
}
if (-not $ok) { Write-Output 'error:FlashWindowEx failed.'; exit 1 }
`.trim()

function launchFlash(force: boolean, stdio: 'pipe' | 'ignore', detached: boolean) {
  const encoded = Buffer.from(FLASH_SCRIPT, 'utf16le').toString('base64')
  return spawn(powershellPath(), ['-NoProfile', '-STA', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    env: {
      ...process.env,
      DSH_REMINDER_FLASH_FORCE: force ? '1' : '0',
    },
    windowsHide: true,
    stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    detached,
  })
}

/**
 * Flash the DSH Desktop taskbar button. Failures never throw into the reminder path.
 * force=true flashes even while DSH is focused, used by 试听.
 */
export function flashDshTaskbar(force = false, warn?: (message: string) => void): Promise<FlashResult> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Taskbar flashing is only available on Windows.' })
  const now = Date.now()
  if (now - lastFlashAt < FLASH_GAP_MS) return Promise.resolve({ ok: true, hwnds: [] })
  lastFlashAt = now
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: FlashResult) => {
      if (settled) return
      settled = true
      if (!result.ok && !flashWarned) {
        flashWarned = true
        warn?.(`[dsh-reminder] ${result.error}`)
      }
      resolve(result)
    }
    try {
      const child = launchFlash(force, 'pipe', false)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish({ ok: false, error: 'Taskbar flash helper timed out.' })
      }, 8000)
      child.on('error', (error) => {
        clearTimeout(timer)
        try {
          const fallback = launchFlash(force, 'ignore', true)
          fallback.unref()
          finish({ ok: true, hwnds: [] })
        } catch {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const hwnds = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('shown:')).map((line) => Number(line.slice('shown:'.length))).filter((value) => Number.isFinite(value))
        if (hwnds.length) {
          finish({ ok: true, hwnds })
          return
        }
        const errorLine = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('error:'))
        if (code === 0) {
          finish({ ok: true, hwnds: [] })
          return
        }
        finish({ ok: false, error: errorLine?.slice('error:'.length) || stderr.trim() || `Taskbar flash helper exited ${code ?? 'unknown'}.` })
      })
    } catch {
      try {
        const fallback = launchFlash(force, 'ignore', true)
        fallback.unref()
        finish({ ok: true, hwnds: [] })
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}
