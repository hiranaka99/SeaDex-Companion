# -----------------------------------------------------------------------------
# push-dockerhub.ps1 — Build SeaDex Companion and push it to Docker Hub (Windows)
#
# Prerequisites:
#   - Docker Desktop running
#   - Logged in to Docker Hub:  docker login
#
# Usage:
#   .\scripts\push-dockerhub.ps1 -User your-dockerhub-username
#   .\scripts\push-dockerhub.ps1 -User your-dockerhub-username -Tags "latest,1.0.0"
#
# The image is always additionally tagged with the current git short SHA so
# every push is traceable back to a commit.
# -----------------------------------------------------------------------------
param(
    [Parameter(Mandatory = $true, HelpMessage = "Your Docker Hub username")]
    [string]$User,
    [string]$Tags = "latest"
)

$ErrorActionPreference = "Stop"
$Repo = "docker.io/$User/seadex-companion"

Write-Host "==> Building ${Repo} ..." -ForegroundColor Cyan
docker build -t "${Repo}:build" .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

$tagList = @($Tags -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# Add the git short SHA tag for traceability
$sha = git rev-parse --short HEAD 2>$null
if ($sha) { $tagList += $sha }

foreach ($t in $tagList) {
    docker tag "${Repo}:build" "${Repo}:${t}"
    Write-Host "==> Pushing ${Repo}:${t} ..." -ForegroundColor Cyan
    docker push "${Repo}:${t}"
    if ($LASTEXITCODE -ne 0) { throw "docker push failed for ${Repo}:${t}" }
}

docker rmi "${Repo}:build" | Out-Null
Write-Host ""
Write-Host "Done! Pull it anywhere with:" -ForegroundColor Green
Write-Host "  docker pull ${Repo}:${tagList[0]}" -ForegroundColor Green
