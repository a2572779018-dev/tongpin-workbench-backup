[CmdletBinding()]
param(
  [string]$SenderDomain = "",
  [string]$TestEmail = "",
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath(
  (Split-Path -Parent $PSScriptRoot)
)
$WranglerConfig = Join-Path $ProjectRoot "cloudflare\wrangler.jsonc"
$WranglerPath = Join-Path $ProjectRoot "node_modules\wrangler\bin\wrangler.js"
$ApiUrl = "https://notify.samhubs.com"
$NodePath = (Get-Command node -ErrorAction Stop).Source

function Read-RequiredText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt
  )

  do {
    $Value = (Read-Host $Prompt).Trim()
  } while ([string]::IsNullOrWhiteSpace($Value))
  return $Value
}

function Convert-SecureValue {
  param(
    [Parameter(Mandatory = $true)]
    [Security.SecureString]$SecureValue
  )

  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
  }
}

function Assert-Domain {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $Normalized = $Value.Trim().TrimEnd(".").ToLowerInvariant()
  if (
    $Normalized -notmatch "^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
  ) {
    throw "发件域名格式不正确。只填写域名，例如 notify.example.com，不要填写 https:// 或邮箱地址。"
  }
  return $Normalized
}

function Assert-Email {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $Normalized = $Value.Trim().ToLowerInvariant()
  if ($Normalized -notmatch "^[^\s@]+@[^\s@]+\.[^\s@]+$") {
    throw "测试邮箱格式不正确。"
  }
  return $Normalized
}

function Invoke-Wrangler {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & $NodePath $WranglerPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Wrangler 命令失败：$($Arguments -join ' ')"
  }
}

function Get-ApiErrorMessage {
  param(
    [Parameter(Mandatory = $true)]
    $ErrorRecord
  )

  if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
    try {
      $Payload = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
      if ($Payload.error.message) {
        return [string]$Payload.error.message
      }
    }
    catch {
      return [string]$ErrorRecord.ErrorDetails.Message
    }
  }
  return [string]$ErrorRecord.Exception.Message
}

if (-not (Test-Path -LiteralPath $WranglerConfig -PathType Leaf)) {
  throw "找不到 Cloudflare 配置：$WranglerConfig"
}
if (-not (Test-Path -LiteralPath $WranglerPath -PathType Leaf)) {
  throw "找不到 Wrangler。请先在项目目录运行 npm.cmd install。"
}

Write-Host ""
Write-Host "同频 · Resend 生产邮件配置" -ForegroundColor Yellow
Write-Host "密钥只通过内存管道写入 Cloudflare Secret，不写入文件，也不会显示在终端。"
Write-Host ""

$WranglerVersion = & $NodePath $WranglerPath --version
if ($LASTEXITCODE -ne 0) {
  throw "Wrangler 无法运行。"
}
Write-Host "Wrangler $WranglerVersion" -ForegroundColor DarkGray

if ([string]::IsNullOrWhiteSpace($SenderDomain)) {
  $SenderDomain = Read-RequiredText "填写已在 Resend 验证通过的域名（例如 notify.example.com）"
}
$SenderDomain = Assert-Domain $SenderDomain
$Sender = "同频 <verify@$SenderDomain>"

if ($ValidateOnly) {
  if (-not [string]::IsNullOrWhiteSpace($TestEmail)) {
    $null = Assert-Email $TestEmail
  }
  Write-Host "配置脚本校验通过。" -ForegroundColor Green
  Write-Host "计划发件人：$Sender"
  exit 0
}

Write-Host "检查 Cloudflare 登录状态..."
& $NodePath $WranglerPath whoami
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "尚未登录 Cloudflare，将打开浏览器授权。" -ForegroundColor Yellow
  Invoke-Wrangler @("login", "--use-keyring")
  Invoke-Wrangler @("whoami")
}

$ApiKeySecure = Read-Host "粘贴 Resend Sending access API Key" -AsSecureString
$ApiKey = Convert-SecureValue $ApiKeySecure
$SecretsJson = $null
try {
  if ($ApiKey -notmatch "^re_[A-Za-z0-9_-]{16,}$") {
    throw "Resend API Key 格式不正确。它应以 re_ 开头。"
  }

  $SecretsJson = @{
    RESEND_API_KEY = $ApiKey
    RESEND_FROM = $Sender
  } | ConvertTo-Json -Compress

  Write-Host "写入 Cloudflare Worker Secret..."
  $SecretsJson | & $NodePath $WranglerPath secret bulk --config $WranglerConfig
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare Secret 写入失败。"
  }
}
finally {
  $ApiKey = $null
  $ApiKeySecure.Dispose()
  $SecretsJson = $null
}

Write-Host "等待线上 Worker 载入邮件配置..."
$Health = $null
for ($Attempt = 1; $Attempt -le 20; $Attempt += 1) {
  try {
    $Health = Invoke-RestMethod "$ApiUrl/api/health?check=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    if ($Health.mailMode -eq "resend") {
      break
    }
  }
  catch {
    if ($Attempt -eq 20) {
      throw
    }
  }
  Start-Sleep -Seconds 2
}
if (-not $Health -or $Health.mailMode -ne "resend") {
  throw "线上 Worker 仍未进入 resend 模式，请检查两个 Secret 是否都写入成功。"
}
Write-Host "线上邮件模式：resend" -ForegroundColor Green

if ([string]::IsNullOrWhiteSpace($TestEmail)) {
  $TestEmail = Read-RequiredText "填写用于真实注册验收、且尚未注册过的邮箱"
}
$TestEmail = Assert-Email $TestEmail
$TestName = Read-Host "测试成员姓名（直接回车使用“邮件验收成员”）"
if ([string]::IsNullOrWhiteSpace($TestName)) {
  $TestName = "邮件验收成员"
}
if ($TestName.Trim().Length -lt 2 -or $TestName.Trim().Length -gt 30) {
  throw "测试成员姓名需要 2 到 30 个字符。"
}

$PasswordSecure = Read-Host "为该成员设置登录密码（至少 8 位，包含字母和数字）" -AsSecureString
$Password = Convert-SecureValue $PasswordSecure
$RegisterBody = $null
try {
  if (
    $Password.Length -lt 8 -or
    $Password -notmatch "[A-Za-z]" -or
    $Password -notmatch "\d"
  ) {
    throw "密码至少 8 位，并且必须同时包含字母和数字。"
  }

  $RegisterBody = @{
    email = $TestEmail
    name = $TestName.Trim()
    password = $Password
  } | ConvertTo-Json -Compress

  Write-Host "通过线上注册接口发送真实验证码..."
  try {
    $RegisterResult = Invoke-RestMethod `
      -Method Post `
      -Uri "$ApiUrl/api/auth/register" `
      -ContentType "application/json; charset=utf-8" `
      -Body ([Text.Encoding]::UTF8.GetBytes($RegisterBody))
  }
  catch {
    $Message = Get-ApiErrorMessage $_
    throw "注册接口未完成发信：$Message。请使用一个尚未注册过的真实邮箱重试。"
  }
}
finally {
  $Password = $null
  $PasswordSecure.Dispose()
  $RegisterBody = $null
}

if ($RegisterResult.delivery -ne "resend" -or $RegisterResult.debugCode) {
  throw "线上注册接口没有使用 Resend，拒绝把预览验证码当成真实邮件。"
}

Write-Host ""
Write-Host "验证码已经发送到 $TestEmail。" -ForegroundColor Yellow
$VerificationCode = Read-RequiredText "从真实邮箱复制 6 位验证码"
if ($VerificationCode -notmatch "^\d{6}$") {
  throw "验证码必须是 6 位数字。"
}

$VerifyBody = @{
  email = $TestEmail
  code = $VerificationCode
} | ConvertTo-Json -Compress
try {
  $VerifyResult = Invoke-RestMethod `
    -Method Post `
    -Uri "$ApiUrl/api/auth/verify-email" `
    -ContentType "application/json; charset=utf-8" `
    -Body ([Text.Encoding]::UTF8.GetBytes($VerifyBody))
}
catch {
  $Message = Get-ApiErrorMessage $_
  throw "真实验证码校验失败：$Message"
}
finally {
  $VerificationCode = $null
  $VerifyBody = $null
}

if ($VerifyResult.nextStep -notin @("await_approval", "ready_to_login")) {
  throw "邮箱验证返回了意外状态。"
}

Write-Host ""
Write-Host "真实邮箱闭环通过。" -ForegroundColor Green
Write-Host "发件人：$Sender"
Write-Host "注册邮箱：$TestEmail"
Write-Host "账号状态：$($VerifyResult.nextStep)"
Write-Host "接下来由管理员批准该成员进入同频。"
