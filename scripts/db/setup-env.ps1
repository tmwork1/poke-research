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
$publishableKey = Read-Secret "SUPABASE_PUBLISHABLE_KEY (input hidden)"
$secretKey = Read-Secret "SUPABASE_SECRET_KEY (input hidden)"
$databaseUrl = Read-Host "DATABASE_URL (default: postgresql://postgres:postgres@localhost:54322/postgres)"
if ([string]::IsNullOrWhiteSpace($databaseUrl)) { $databaseUrl = 'postgresql://postgres:postgres@localhost:54322/postgres' }

$content = @()
$content += "SUPABASE_URL=$supabaseUrl"
$content += "SUPABASE_PUBLISHABLE_KEY=$publishableKey"
$content += "SUPABASE_SECRET_KEY=$secretKey"
$content += "DATABASE_URL=$databaseUrl"

Set-Content -Path $envPath -Value $content -Encoding UTF8
Write-Host ".env has been written to $envPath" -ForegroundColor Green
