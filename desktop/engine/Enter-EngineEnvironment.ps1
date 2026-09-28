# Dot-source in a dedicated PowerShell process. Changes only that process's
# environment; it does not install anything or alter registry/global Git config.
param([string]$EngineRoot = 'D:\umbra-engine')

$engineDirectory = [IO.Path]::GetFullPath($EngineRoot)
foreach ($required in @('.gclient', 'depot_tools\gclient.bat', 'toolchain\BuildTools\VC')) {
  if (-not (Test-Path -LiteralPath (Join-Path $engineDirectory $required))) {
    throw "Incomplete engine environment: $required"
  }
}

$env:TEMP = Join-Path $engineDirectory 'temp'
$env:TMP = $env:TEMP
$env:CIPD_CACHE_DIR = Join-Path $engineDirectory 'cache\cipd'
$env:VPYTHON_VIRTUALENV_ROOT = Join-Path $engineDirectory 'cache\vpython'
$env:UV_CACHE_DIR = Join-Path $engineDirectory 'cache\uv'
$env:npm_config_cache = Join-Path $engineDirectory 'cache\npm'
$env:YARN_CACHE_FOLDER = Join-Path $engineDirectory 'cache\yarn'
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:vs2026_install = Join-Path $engineDirectory 'toolchain\BuildTools'
$env:PATH = (Join-Path $engineDirectory 'depot_tools') + ';' + $env:PATH

# Scoped to Git processes launched from this shell. Keep TLS verification on.
$env:GIT_CONFIG_COUNT = '7'
$env:GIT_CONFIG_KEY_0 = 'http.sslBackend'; $env:GIT_CONFIG_VALUE_0 = 'openssl'
$env:GIT_CONFIG_KEY_1 = 'core.longpaths'; $env:GIT_CONFIG_VALUE_1 = 'true'
$env:GIT_CONFIG_KEY_2 = 'core.autocrlf'; $env:GIT_CONFIG_VALUE_2 = 'false'
$env:GIT_CONFIG_KEY_3 = 'core.filemode'; $env:GIT_CONFIG_VALUE_3 = 'false'
$env:GIT_CONFIG_KEY_4 = 'depot-tools.allowGlobalGitConfig'; $env:GIT_CONFIG_VALUE_4 = 'false'
$env:GIT_CONFIG_KEY_5 = 'http.lowSpeedLimit'; $env:GIT_CONFIG_VALUE_5 = '1024'
$env:GIT_CONFIG_KEY_6 = 'http.lowSpeedTime'; $env:GIT_CONFIG_VALUE_6 = '120'
