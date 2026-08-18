<#
.SYNOPSIS
  Android 自动化测试: 录屏 → 走回原点 → 点按钮 → 旋转Cube → 移动Sphere → 停止录屏
.DESCRIPTION
  每一步 HTTP 同步等待上一步完成，顺序执行。通过 JSON-RPC 调用 Android 桥上的工具。
#>

$SERVER = "http://127.0.0.1:45678/rpc"
$ID = [int](Get-Random -Minimum 1000 -Maximum 9999)

function Invoke-Tool($name, $argsJson) {
    $body = @{jsonrpc="2.0";method="tools/call";params=@{name=$name;arguments=$argsJson};id=($ID++)} |
        ConvertTo-Json -Compress -Depth 5
    try {
        $r = Invoke-RestMethod -Uri $SERVER -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
        $text = $r.result.content[0].text
        return $text | ConvertFrom-Json
    } catch {
        Write-Error "Tool '$name' FAILED: $_"
        throw
    }
}

function Hold-Key($key) {
    $null = Invoke-Tool "input.key_press" @{key=$key; action="hold"}
}

function Release-Key($key) {
    $null = Invoke-Tool "input.key_press" @{key=$key; action="release"}
}

function Release-All {
    $null = Invoke-Tool "input.key_press" @{action="release"}
}

function Get-Hierarchy {
    $raw = Invoke-Tool "scene.get_hierarchy" @{}
    return $raw
}

function Get-PlayerPos {
    $h = Get-Hierarchy
    if ($h.Count -and $h[0].name -eq "Player") {
        return $h[0].position
    }
    # Fallback: search by name
    foreach ($obj in $h) {
        if ($obj.name -eq "Player") { return $obj.position }
    }
    return $null
}

function Log-Pos($label) {
    $pos = Get-PlayerPos
    if ($pos) {
        Write-Host "  → $label ($([math]::Round($pos[0],2)), $([math]::Round($pos[1],2)), $([math]::Round($pos[2],2)))" -ForegroundColor Gray
    } else {
        Write-Host "  → $label (unknown)" -ForegroundColor DarkGray
    }
}

function Wait-Recording($seconds) {
    Start-Sleep -Seconds $seconds
}

# ═══════════════════════════════════════════════════
Write-Host "╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Android Auto Test 启动              ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════╝" -ForegroundColor Cyan

# ── 0. 先释放所有按键 ──
Write-Host "`n[0] Release all keys" -ForegroundColor Yellow
Release-All
Start-Sleep -Milliseconds 200
Log-Pos "start"

# ── 1. 开始录屏 ──
Write-Host "`n[1] Start MP4 recording..." -ForegroundColor Yellow
$r = Invoke-Tool "recording.start" @{}
Write-Host "  ✓ recording.start → outputPath=$($r.outputPath)" -ForegroundColor Green
Wait-Recording 1

# ── 2. Player 走回原点 (0, 1, 0) ──
Write-Host "`n[2] Walk player to origin (0,1,0)..." -ForegroundColor Yellow
# 当前位置: (~4, 1, ~7.2) → 按住 A(左) + S(后) 对角走回
Hold-Key "a"   # -X
Hold-Key "s"   # -Z
Wait-Recording 1.8
Log-Pos "after A+S"

# 已经有 ~1.8s A+S = 走了约 6.3 单位对角 -> 应该已接近原点
# 全部释放后精确归零
Release-All
Wait-Recording 0.2

Release-All
Wait-Recording 0.2

# 精确归零
$null = Invoke-Tool "scene.set_transform" @{path="Player"; position=@(0.0, 1.0, 0.0)}
Log-Pos "snapped to origin"
Wait-Recording 0.5

# ── 3. 点击屏幕中心的 Button ──
Write-Host "`n[3] Click center Button..." -ForegroundColor Yellow
# Button normalized center: (1304/2408 ≈ 0.5415, 540/1080 = 0.5)
$r = Invoke-Tool "input.click_screen" @{x=0.5415; y=0.5}
Write-Host "  ✓ click_screen → clicked=$($r.clicked.name)" -ForegroundColor Green
Wait-Recording 1

# ── 4. 绕 X 轴旋转 Cube, 10次, 每次15度 ──
Write-Host "`n[4] Rotate Cube 10×15° around X..." -ForegroundColor Yellow
for ($i = 1; $i -le 10; $i++) {
    $deg = $i * 15
        $null = Invoke-Tool "scene.set_transform" @{path="Cube"; rotation=@($deg, 0.0, 0.0)}
    Write-Host "  $i/10 rotation=($deg, 0, 0)" -ForegroundColor DarkGray
    Wait-Recording 0.3
}
Write-Host "  ✓ Cube rotated 150° around X" -ForegroundColor Green
Wait-Recording 0.5

# ── 5. 找到 Cube/Sphere, 移动10次 ──
Write-Host "`n[5] Move Cube/Sphere 10 times..." -ForegroundColor Yellow
$spherePositions = @(
    @(6.0, 2.0, 4.0),  # 回到原处
    @(5.0, 2.5, 5.0),
    @(4.0, 3.0, 6.0),
    @(3.0, 3.5, 5.0),
    @(2.0, 4.0, 4.0),
    @(3.0, 4.5, 3.0),
    @(4.0, 5.0, 2.0),
    @(5.0, 4.5, 3.0),
    @(6.0, 4.0, 4.0),
    @(7.0, 3.0, 5.0)
)
for ($i = 0; $i -lt $spherePositions.Length; $i++) {
    $p = $spherePositions[$i]
    $null = Invoke-Tool "scene.set_transform" @{path="Cube/Sphere"; position=@($p[0], $p[1], $p[2])}
    Write-Host "  $($i+1)/10 position=($($p[0]), $($p[1]), $($p[2]))" -ForegroundColor DarkGray
    Wait-Recording 0.3
}
Write-Host "  ✓ Sphere moved 10 times" -ForegroundColor Green

# ── 6. 停止录屏 ──
Write-Host "`n[6] Stop recording..." -ForegroundColor Yellow
$r = Invoke-Tool "recording.stop" @{}
Write-Host "  ✓ stop → status=$($r.status)" -ForegroundColor Green

# Poll until completed
Write-Host "  Polling status..." -NoNewline
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $s = Invoke-Tool "recording.status" @{}
    Write-Host "." -NoNewline
    if ($s.state -eq "completed") {
        Write-Host ""
        Write-Host "  ✓ Recording completed!" -ForegroundColor Green
        Write-Host "  File: $($s.filePath)" -ForegroundColor Green
        break
    }
    if ($s.state -eq "error") {
        Write-Host ""
        Write-Error "Recording failed: $($s.error)"
        break
    }
    if ($i -eq 29) {
        Write-Host ""
        Write-Warning "Recording poll timeout"
    }
}

# ── 完成 ──
Write-Host "`n═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host " Auto Test Complete!" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
