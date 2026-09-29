<#
.SYNOPSIS
  One-time setup: registers a Windows Task Scheduler task that runs every day at 9:55 AM,
  11:55 AM, and 3:55 PM and makes sure Chrome is open (so the MGE extension's 10:00 AM, 12:00 PM,
  and 4:00 PM scrapes can run).

.USAGE (normal PowerShell window, NOT "Run as administrator" - the task must run as YOU):
  powershell -ExecutionPolicy Bypass -File .\Register-MGEChromeTask.ps1
  # optional: -Times @('09:55', '11:55', '15:55')  -ProfileDirectory "Profile 1"  -Unregister
#>
[CmdletBinding()]
param(
  [Alias('Time')]
  [string[]]$Times = @('09:55', '11:55', '15:55'),
  [string]$ProfileDirectory = 'Default',
  [string]$TaskName = 'MGE - Ensure Chrome Running',
  [switch]$Unregister
)
$ErrorActionPreference = 'Stop'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  return
}

# Copy the helper to a stable per-user location so the task keeps working if this folder moves.
$installDir = Join-Path $env:LOCALAPPDATA 'MGE'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$helperSrc = Join-Path $PSScriptRoot 'Ensure-ChromeRunning.ps1'
$helper = Join-Path $installDir 'Ensure-ChromeRunning.ps1'
Copy-Item -Path $helperSrc -Destination $helper -Force

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$triggers = @()
foreach ($t in $Times) {
  $at = [datetime]::ParseExact($t, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  $triggers += New-ScheduledTaskTrigger -Daily -At $at
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -ProfileDirectory `"{1}`"" -f $helper, $ProfileDirectory)
# Interactive = runs in your logged-in desktop session (Chrome must use your normal profile/session).
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal `
  -Settings $settings -Description 'Starts Chrome (normal profile) before the MGE NetSuite scrapes at 10:00 AM, 12:00 PM, and 4:00 PM.' -Force | Out-Null

$timeList = $Times -join ', '
Write-Host "Registered '$TaskName' daily at $timeList for $user." -ForegroundColor Green
Write-Host "Helper: $helper   Log: $installDir\ensure-chrome.log"
Write-Host ("Test it now with:  Start-ScheduledTask -TaskName '{0}'" -f $TaskName)

# Wake timers must be allowed for -WakeToRun to wake a sleeping PC (current power plan, AC + battery).
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
$ac = $LASTEXITCODE
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
$dc = $LASTEXITCODE
powercfg /SETACTIVE SCHEME_CURRENT | Out-Null
if ($ac -eq 0 -and $dc -eq 0) { Write-Host 'Enabled wake timers on the current power plan.' }
else { Write-Warning 'Could not enable wake timers automatically; see docs/SETUP-GUIDE.md (Power settings).' }
