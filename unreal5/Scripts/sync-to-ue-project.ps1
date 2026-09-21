param([Parameter(Mandatory=$true)][string]$TargetProject)
$root=Split-Path -Parent $PSScriptRoot
$source=Join-Path $root "Plugins/MCPUnrealBridge"
$target=Join-Path $TargetProject "Plugins/MCPUnrealBridge"
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
robocopy $source $target /E /XF *.dll *.pdb /XD Binaries Intermediate Saved | Out-Null
if($LASTEXITCODE -gt 7){exit $LASTEXITCODE}; Write-Output "SYNC_OK $target"
