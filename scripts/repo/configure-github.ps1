$ErrorActionPreference = "Stop"
$repository = "Spring500/aizen-assistant"

gh api --method PATCH "repos/$repository" `
  -F allow_squash_merge=true `
  -F allow_merge_commit=false `
  -F allow_rebase_merge=false `
  -F allow_auto_merge=false `
  -F delete_branch_on_merge=true `
  -F squash_merge_commit_title=PR_TITLE `
  -F squash_merge_commit_message=PR_BODY | Out-Null

$settings = gh api "repos/$repository" | ConvertFrom-Json
if (-not $settings.allow_squash_merge -or
    $settings.allow_merge_commit -or
    $settings.allow_rebase_merge -or
    $settings.allow_auto_merge -or
    -not $settings.delete_branch_on_merge -or
    $settings.squash_merge_commit_title -ne "PR_TITLE" -or
    $settings.squash_merge_commit_message -ne "PR_BODY") {
  throw "GitHub 合并设置不符合预期"
}

Write-Output "GitHub 合并设置检查通过"
