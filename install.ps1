# dsh-persona 安装/卸载的 PowerShell 入口：参数原样转给 install.mjs。
# 它自己不做任何文件操作，避免 PowerShell 5.1 的 UTF-8/BOM 坑。
param(
  [string]$Profile = 'desktop',
  [string]$Seed = '',
  [string]$Name = '',
  [ValidateSet('copy', 'junction')][string]$Mode = 'copy',
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$args = @("$here\install.mjs", '--profile', $Profile, '--mode', $Mode)
if ($Seed) { $args += @('--seed', $Seed) }
if ($Name) { $args += @('--name', $Name) }
if ($Force) { $args += '--force' }
if ($DryRun) { $args += '--dry-run' }
if ($Uninstall) { $args += '--uninstall' }
if ($Purge) { $args += '--purge' }

& node @args
exit $LASTEXITCODE
