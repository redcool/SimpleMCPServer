<#
.SYNOPSIS
  启动指定编号的 Blender 实例（多实例 MCP：每个实例独立 socket 端口）。

.DESCRIPTION
  1. 设置 BLENDER_MCP_PORT 环境变量后启动 Blender —— Blender 的 startup 脚本
     (blender_mcp_auto.py) 会读取该变量，让本实例的 MCP addon 用对应端口起 socket，
     从而支持多个 Blender 窗口同时在线、互不冲突。
  2. 每个实例对应 SimpleMcpServer config.json 里一条 mcpServers（rblender-mcp 多进程
     各连一个端口），Agent 通过 toolsPrefix 区分目标实例。见 README「多 Blender 实例」。

.EXAMPLE
  pwsh scripts\start-blender-instance.ps1 -Instance 2
  pwsh scripts\start-blender-instance.ps1 -Port 9877 -BlendFile D:\proj\scene.blend

.NOTES
  端口分配：Instance N -> 9875 + N（实例1=9876，实例2=9877，…）；-Port 可手动覆盖。
  同一实例内切换 .blend 工程无需任何额外配置（socket 是进程级的）。
#>
param(
  [Parameter(Mandatory = $false)][int] $Instance = 1,
  [Parameter(Mandatory = $false)][int] $Port = 0,
  [string] $BlenderExe = "H:\Program Files\blender-5.2.0-windows-x64\blender.exe",
  [string] $BlendFile = ""
)

if ($Port -eq 0) { $Port = 9875 + $Instance }

$env:BLENDER_MCP_PORT = "$Port"
$blenderArgs = @()
if ($BlendFile) { $blenderArgs += $BlendFile }

if (-not (Test-Path $BlenderExe)) {
  Write-Error "Blender 未找到: $BlenderExe（可用 -BlenderExe 指定）"
  exit 1
}
if ($blenderArgs.Count -eq 0) {
  Start-Process -FilePath $BlenderExe
} else {
  Start-Process -FilePath $BlenderExe -ArgumentList $blenderArgs
}

Write-Host "Blender 实例 #$Instance 启动中（MCP 端口 $Port)" -ForegroundColor Green
Write-Host ""
Write-Host "之后在 SimpleMcpServer config.json 的 mcpServers 加一条："
Write-Host "  { ""name"": ""blender$Instance"", ""command"": ""<uvx 绝对路径>"", ""args"": [""blender-mcp@1.9.1""], ""env"": { ""BLENDER_PORT"": ""$Port"" }, ""toolsPrefix"": ""blender$Instance"" }"
Write-Host "再重启 SimpleMcpServer，Agent 即可用 blender$Instance.* 工具控制该实例。"