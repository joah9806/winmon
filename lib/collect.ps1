# WinMon slow-metric collector.
# Must run on Windows 7 PowerShell 2.0: Get-CimInstance and ConvertTo-Json are
# PowerShell 3.0+ only, so fall back to Get-WmiObject and build JSON by hand.
# Keep this file ASCII-only: PS 2.0 reads BOM-less scripts as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  $t = $s -replace '\\', '\\'
  $t = $t -replace '"', '\"'
  $t = $t -replace "`r", '\r'
  $t = $t -replace "`n", '\n'
  $t = $t -replace "`t", '\t'
  $t = $t -replace '[\x00-\x1f]', ''
  return $t
}

function Num($v) {
  if ($null -eq $v) { return 'null' }
  try {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }
    return $d.ToString('0.##########', [System.Globalization.CultureInfo]::InvariantCulture)
  } catch { return 'null' }
}

$useCim = $false
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { $useCim = $true }

function Query([string]$class, [string]$filter) {
  if ($useCim) {
    if ($filter) { return @(Get-CimInstance -ClassName $class -Filter $filter) }
    return @(Get-CimInstance -ClassName $class)
  }
  if ($filter) { return @(Get-WmiObject -Class $class -Filter $filter) }
  return @(Get-WmiObject -Class $class)
}

$diskParts = @()
foreach ($d in (Query 'Win32_LogicalDisk' 'DriveType=3')) {
  if (-not $d.DeviceID) { continue }
  $diskParts += ('{"DeviceID":"' + (Esc $d.DeviceID) + '","Size":' + (Num $d.Size) + ',"FreeSpace":' + (Num $d.FreeSpace) + '}')
}

$netParts = @()
foreach ($n in (Query 'Win32_PerfFormattedData_Tcpip_NetworkInterface' $null)) {
  if (-not $n.Name) { continue }
  $netParts += ('{"Name":"' + (Esc $n.Name) + '","BytesReceivedPersec":' + (Num $n.BytesReceivedPersec) + ',"BytesSentPersec":' + (Num $n.BytesSentPersec) + '}')
}

$osRow = @(Query 'Win32_OperatingSystem' $null)
if ($osRow.Count -gt 0) {
  $osJson = '{"FreePhysicalMemory":' + (Num $osRow[0].FreePhysicalMemory) + ',"TotalVisibleMemorySize":' + (Num $osRow[0].TotalVisibleMemorySize) + '}'
} else {
  $osJson = '{"FreePhysicalMemory":null,"TotalVisibleMemorySize":null}'
}

$procCount = @(Get-Process).Count

$json = '{"disks":[' + ($diskParts -join ',') + '],"net":[' + ($netParts -join ',') + '],"os":' + $osJson + ',"procs":' + (Num $procCount) + '}'
Write-Output $json