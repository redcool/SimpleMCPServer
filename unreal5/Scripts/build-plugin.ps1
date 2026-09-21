param([Parameter(Mandatory=$true)][string]$ProjectFile)
$ue=Join-Path ${env:ProgramFiles} "Epic Games/UE_5.8/Engine/Build/BatchFiles/RunUAT.bat"
& $ue BuildPlugin -Plugin (Join-Path (Split-Path $PSScriptRoot -Parent) "Plugins/MCPUnrealBridge/MCPUnrealBridge.uplugin") -Package (Join-Path (Split-Path $PSScriptRoot -Parent) "Build/MCPUnrealBridge") -TargetPlatforms=Win64
exit $LASTEXITCODE
