<#
  FaceitExt installer
  Usage:  powershell -ExecutionPolicy Bypass -File install.ps1            # install / update
          powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall # restore original FACEIT
#>
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$Src      = $PSScriptRoot
$Root     = Join-Path $env:APPDATA 'FaceitExtensions'
$Faceit   = Join-Path $env:LOCALAPPDATA 'FACEIT'
$Launcher = Join-Path $Root 'bin\FaceitLauncher.exe'

function Step($m) { Write-Host "[FaceitExt] $m" -ForegroundColor DarkYellow }

function Get-LatestApp {
  Get-ChildItem $Faceit -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'FACEIT.exe') } |
    Sort-Object { [version]($_.Name.Substring(4)) } -Descending | Select-Object -First 1
}

function Stop-Faceit {
  $p = Get-Process FACEIT -ErrorAction SilentlyContinue
  if ($p) { Step 'Zamykam FACEIT Client...'; $p | Stop-Process -Force; Start-Sleep -Milliseconds 1500 }
}

function Get-Shortcuts {
  @( [Environment]::GetFolderPath('Desktop'),
     [Environment]::GetFolderPath('Programs'),
     (Join-Path ([Environment]::GetFolderPath('Programs')) 'FACEIT Ltd') ) |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Filter 'FACEIT*.lnk' -ErrorAction SilentlyContinue }
}

$shell = New-Object -ComObject WScript.Shell
$app = Get-LatestApp
if (-not $app) { throw "Nie znaleziono FACEIT Client w $Faceit" }
$asar = Join-Path $app.FullName 'resources\app.asar'
$exe  = Join-Path $app.FullName 'FACEIT.exe'

if ($Uninstall) {
  Stop-Faceit
  if (Test-Path "$asar.faceitext.bak") { Copy-Item "$asar.faceitext.bak" $asar -Force; Remove-Item "$asar.faceitext.bak"; Step "Przywrócono oryginalny app.asar ($($app.Name))" }
  foreach ($l in Get-Shortcuts) {
    $s = $shell.CreateShortcut($l.FullName)
    if ($s.TargetPath -ieq $Launcher) {
      $s.TargetPath = Join-Path $Faceit 'FACEIT.exe'; $s.WorkingDirectory = $Faceit; $s.Save(); Step "Przywrócono skrót: $($l.Name)"
    }
  }
  Step 'Odinstalowano. Katalog z wtyczkami pozostawiono: ' + $Root
  return
}

# 1. directory structure + core files
Step "Tworzenie struktury w $Root"
'core\ui', 'installed', 'bin' | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $Root $_) | Out-Null }
Copy-Item (Join-Path $Src 'core\*') (Join-Path $Root 'core') -Recurse -Force
if (-not (Test-Path (Join-Path $Root 'config.json'))) { '{ "extensions": [] }' | Set-Content (Join-Path $Root 'config.json') -Encoding UTF8 }

# 2. compile launcher with the C# compiler shipped in Windows (.NET Framework 4.x)
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4*\csc.exe", "$env:WINDIR\Microsoft.NET\Framework\v4*\csc.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $csc) { throw 'Nie znaleziono csc.exe (.NET Framework 4.x)' }
Step 'Kompilacja FaceitLauncher.exe'
$icon = Join-Path $Src 'launcher\faceit.ico'
if (-not (Test-Path $icon)) {
  Add-Type -AssemblyName System.Drawing
  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
  $fs = [IO.File]::Create($icon); $ico.Save($fs); $fs.Close()
}
& $csc.FullName /nologo /target:winexe /optimize+ "/win32icon:$icon" /r:System.Windows.Forms.dll "/out:$Launcher" (Join-Path $Src 'launcher\FaceitLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Kompilacja launchera nie powiodła się' }

# 3. one-time patch of current installation (FACEIT.exe runs our patcher thanks to the RunAsNode fuse)
Stop-Faceit
Step "Patchowanie $($app.Name)\resources\app.asar"
$env:ELECTRON_RUN_AS_NODE = '1'
& $exe (Join-Path $Root 'core\asar-patcher.js') $asar | Write-Host
$code = $LASTEXITCODE
Remove-Item Env:ELECTRON_RUN_AS_NODE
if ($code -ne 0) { throw 'Patch app.asar nie powiódł się' }

# 4. redirect shortcuts to the launcher
$links = @(Get-Shortcuts)
if (-not $links) { $links = @([pscustomobject]@{ FullName = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FACEIT.lnk'; Name = 'FACEIT.lnk' }) }
foreach ($l in $links) {
  $s = $shell.CreateShortcut($l.FullName)
  $s.TargetPath = $Launcher; $s.Arguments = ''; $s.WorkingDirectory = Split-Path $Launcher
  $s.IconLocation = "$(Join-Path $Faceit 'FACEIT.exe'),0"; $s.Save()
  Step "Skrót przekierowany: $($l.FullName)"
}

Step 'Gotowe! Uruchom FACEIT ze skrótu – w prawym dolnym rogu pojawi się przycisk rozszerzeń.'
