# run.ps1 -- one-command entrypoint for the embedding benchmark.
# Runs bench_embed.py under the DevToolbox venv python (which carries onnxruntime + numpy + tokenizers).
# Pass through any flags, e.g.:  .\run.ps1 --smoke   |   .\run.ps1 --with-ollama   |   .\run.ps1 --validate
param([Parameter(ValueFromRemainingArguments=$true)] $Args)
$py = "$env:LOCALAPPDATA\DevToolbox\python\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Error "DevToolbox venv python not found at $py"; exit 1 }
& $py "$PSScriptRoot\bench_embed.py" @Args