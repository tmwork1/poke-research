<#
Interactive setup script to create a .env file from user input.
This avoids committing secrets to the repo and helps local setup.
#>
$envPath = Join-Path -Path (Get-Location) -ChildPath ".env"

if (Test-Path $envPath) {
    $overwrite = Read-Host ".env already exists. Overwrite? (y/N)"
    if ($overwrite -ne 'y' -and $overwrite -ne 'Y') {
        Write-Host "Aborted. .env was not changed." -ForegroundColor Yellow
        exit 0
    }
}

function Read-Secret($prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    return $plain
}

$supabaseUrl = Read-Host "SUPABASE_URL (default: http://localhost:54321)"
if ([string]::IsNullOrWhiteSpace($supabaseUrl)) { $supabaseUrl = 'http://localhost:54321' }
$anonKey = Read-Secret "SUPABASE_ANON_KEY (input hidden)"
$serviceKey = Read-Secret "SUPABASE_SERVICE_KEY (input hidden)"
$databaseUrl = Read-Host "DATABASE_URL (default: postgresql://postgres:postgres@localhost:5432/postgres)"
if ([string]::IsNullOrWhiteSpace($databaseUrl)) { $databaseUrl = 'postgresql://postgres:postgres@localhost:5432/postgres' }

$content = @()
$content += "SUPABASE_URL=$supabaseUrl"
$content += "SUPABASE_ANON_KEY=$anonKey"
$content += "SUPABASE_SERVICE_KEY=$serviceKey"
$content += "DATABASE_URL=$databaseUrl"

Set-Content -Path $envPath -Value $content -Encoding UTF8
Write-Host ".env has been written to $envPath" -ForegroundColor Green
