$files = Get-ChildItem -Path "z:\kanagawa\library" -Recurse -Filter "*.k"
foreach ($file in $files) {
    $output = npx tree-sitter parse $file.FullName 2>&1
    if ($output -match "\(ERROR") {
        Write-Host "Error parsing $($file.FullName)"
        # Write-Host $output
    }
}
