$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path $root 'agent-linux-tmp'
$out = Join-Path $root 'agent-linux.zip'
if (Test-Path $out) { Remove-Item $out -Force }
$files = @(
  @{ src = 'runtime\node-linux'; entry = 'runtime/node' },
  @{ src = 'agent.js';           entry = 'agent.js' },
  @{ src = 'agent.sh';           entry = 'agent.sh' },
  @{ src = 'config.json';        entry = 'config.json' },
  @{ src = 'lib\metrics.js';     entry = 'lib/metrics.js' }
)
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $srcPath = Join-Path $root $f.src
    $e = $zip.CreateEntry($f.entry, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $e.Open()
    $bytes = [System.IO.File]::ReadAllBytes($srcPath)
    $es.Write($bytes, 0, $bytes.Length)
    $es.Close()
    Write-Host ("added " + $f.entry)
  }
} finally { $zip.Dispose() }
Write-Host ("OK " + $out)