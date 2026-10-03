<#
.SYNOPSIS
  Rain World Desktop helper: tells the wallpaper where your windows, desktop
  icons, taskbar and cursor are, and serves the wallpaper itself.

.DESCRIPTION
  Runs a small web server on http://localhost:47315 (this machine only):
    /                  the wallpaper (wallpaper.html)
    /api/geometry      window / icon / taskbar / cursor rectangles as JSON
    /api/config        GET or POST the shared ecosystem settings (config.json)

  Point Lively Wallpaper at http://localhost:47315/ to use it. Open
  http://localhost:47315/?panel=1 in a normal browser to tweak spawn
  weights; the live wallpaper picks up changes within a few seconds.

  Window titles are never read or reported, only rectangles.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File rw-helper.ps1
#>
param(
  [int]$Port = 47315,
  # Let a packaged (file://) Lively wallpaper read the API. Off by default:
  # sandboxed iframes on any website also have the "null" origin.
  [switch]$AllowFileOrigin
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '..')).Path.TrimEnd('\', '/')
$configPath = Join-Path $here 'config.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not ('RwNative' -as [type])) {
  Add-Type -Path (Join-Path $here 'RwNative.cs')
}
[RwNative]::InitDpi()

$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Could not listen on $prefix - is the helper already running?" -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}

Write-Host ''
Write-Host '  Rain World Desktop helper' -ForegroundColor Cyan
Write-Host "  wallpaper : $prefix"
Write-Host "  settings  : ${prefix}?panel=1   (open in any browser)"
Write-Host "  serving   : $root"
Write-Host '  Ctrl+C to stop.'
Write-Host ''

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

function Send-Bytes($res, [int]$code, [string]$type, [byte[]]$bytes) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}

function Send-Text($res, [int]$code, [string]$type, [string]$text) {
  Send-Bytes $res $code $type ($utf8.GetBytes($text))
}

try {
  while ($listener.IsListening) {
    # Poll asynchronously so Ctrl+C can interrupt between requests.
    $pending = $listener.GetContextAsync()
    while (-not $pending.AsyncWaitHandle.WaitOne(250)) { }
    # A client that drops the connection mid-request must not kill the helper.
    try { $ctx = $pending.GetAwaiter().GetResult() } catch { continue }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $res.Headers['Cache-Control'] = 'no-store'
      $origin = $req.Headers['Origin']
      # A packaged (file://) wallpaper has the opaque origin "null". Nothing
      # else gets cross-origin access, so other websites can't read this.
      if ($AllowFileOrigin -and $origin -eq 'null') { $res.Headers['Access-Control-Allow-Origin'] = 'null' }
      $path = $req.Url.AbsolutePath

      if ($path -eq '/api/geometry') {
        Send-Text $res 200 'application/json' ([RwNative]::GeometryJson())
      }
      elseif ($path -eq '/api/config') {
        if ($req.HttpMethod -eq 'POST') {
          $sameOrigin = (-not $origin) -or ($origin -eq "http://localhost:$Port")
          if (-not $sameOrigin -or ($req.ContentType -notlike 'application/json*')) {
            Send-Text $res 403 'text/plain' 'forbidden'
            continue
          }
          if ($req.ContentLength64 -lt 0 -or $req.ContentLength64 -gt 262144) {
            Send-Text $res 413 'text/plain' 'too large'
            continue
          }
          $reader = New-Object System.IO.StreamReader($req.InputStream, $utf8)
          $body = $reader.ReadToEnd()
          $reader.Close()
          $valid = $body.Length -lt 262144 -and $body.TrimStart().StartsWith('{')
          if ($valid) { try { $null = $body | ConvertFrom-Json } catch { $valid = $false } }
          if (-not $valid) {
            Send-Text $res 400 'text/plain' 'bad config'
            continue
          }
          [System.IO.File]::WriteAllText($configPath, $body, $utf8)
          Send-Text $res 200 'application/json' '{"ok":true}'
        }
        else {
          $json = '{}'
          if (Test-Path -LiteralPath $configPath) { $json = [System.IO.File]::ReadAllText($configPath, $utf8) }
          Send-Text $res 200 'application/json' $json
        }
      }
      else {
        $rel = [System.Uri]::UnescapeDataString($path.TrimStart('/'))
        if ($rel -eq '') { $rel = 'wallpaper.html' }
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
        $sep = [System.IO.Path]::DirectorySeparatorChar
        $inside = $full.StartsWith($root + $sep, [System.StringComparison]::OrdinalIgnoreCase)
        # check the resolved path, so encoded separators can't sneak into windows\
        $blocked = $full.StartsWith($here.TrimEnd('\', '/') + $sep, [System.StringComparison]::OrdinalIgnoreCase)
        if ($inside -and -not $blocked -and (Test-Path -LiteralPath $full -PathType Leaf)) {
          $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
          $type = $types[$ext]
          if (-not $type) { $type = 'application/octet-stream' }
          Send-Bytes $res 200 $type ([System.IO.File]::ReadAllBytes($full))
        }
        else {
          Send-Text $res 404 'text/plain' 'not found'
        }
      }
    }
    catch {
      Write-Host ("request failed: " + $_.Exception.Message) -ForegroundColor DarkYellow
      try { Send-Text $res 500 'text/plain' 'error' } catch { }
    }
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}
