$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\sou\AppData\Local\Temp\akatuki-w'
function New-Token { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ([BitConverter]::ToString($b) -replace '-','').ToLower() }
$api = New-Token
$sync = New-Token
$vault = 'staging-pr14-' + [guid]::NewGuid().ToString()
@{ API_TOKEN = $api; SYNC_TOKEN = $sync; VAULT_ID = $vault } | ConvertTo-Json | Set-Content -Encoding utf8 '.stg.json'
icacls '.stg.json' /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
$w = @('--yes','wrangler@4.69.0')
Write-Output '--- yaos-staging SYNC_TOKEN'
$sync | & npx.cmd @w secret put SYNC_TOKEN --name yaos-staging 2>&1 | Select-Object -Last 3
Write-Output '--- knowledge-staging API_TOKEN'
$api | & npx.cmd @w secret put API_TOKEN --name akatuki-knowledge-staging 2>&1 | Select-Object -Last 3
Write-Output '--- knowledge-staging YAOS_TOKEN'
$sync | & npx.cmd @w secret put YAOS_TOKEN --name akatuki-knowledge-staging 2>&1 | Select-Object -Last 3
Write-Output '--- knowledge-staging VAULT_ID'
$vault | & npx.cmd @w secret put VAULT_ID --name akatuki-knowledge-staging 2>&1 | Select-Object -Last 3
Write-Output '--- secret lists (names only)'
& npx.cmd @w secret list --name yaos-staging 2>&1 | Select-Object -Last 6
& npx.cmd @w secret list --name akatuki-knowledge-staging 2>&1 | Select-Object -Last 12
Write-Output "vault id: $vault"
