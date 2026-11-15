$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root 'winmon-server-windows.zip'
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($root.Length + 1)
    ($rel -notlike '.git\*') -and
    ($rel -notlike 'data\*') -and
    ($rel -notlike '*.zip') -and
    ($rel -ne 'runtime\node-linux') -and
    ($rel -notlike '*.log') -and
    ($rel -notlike '*.pid')
  }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    $e = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $e.Open()
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $es.Write($bytes, 0, $bytes.Length)
    $es.Close()
  }
  Write-Host ("entries: " + $files.Count)
} finally { $zip.Dispose() }
Write-Host ("OK " + $out)