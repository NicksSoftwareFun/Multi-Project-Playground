<#
.SYNOPSIS
  Start the Rain World Desktop helper hidden at every sign-in (or -Remove it).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-startup.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File install-startup.ps1 -Remove
#>
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'Rain World Desktop helper.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link; Write-Host "Removed $link" } else { Write-Host 'Not installed.' }
  exit 0
}

$script = Join-Path $PSScriptRoot 'rw-helper.ps1'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($link)
$lnk.TargetPath = (Get-Command powershell.exe).Source
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Description = 'Rain World Desktop helper (window geometry for the live wallpaper)'
$lnk.Save()
Write-Host "Installed: $link"
Write-Host 'The helper will start hidden next time you sign in. Run start-helper.cmd to start it now.'
