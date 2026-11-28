<#
.SYNOPSIS
  Starts the weekly price sync by hand and follows it to the end (NWP-PRICE-011).

.DESCRIPTION
  Runs the same Step Functions workflow the Sunday schedule runs, so fck-nat is started and stopped
  for you, every vendor and distributor is scraped, and finalize (medians, review flags) always runs.

  1. Reads the state machine and function names from the AghmNwpStack outputs.
  2. Starts an execution (or attaches to one that is already running).
  3. Prints the current step every 30 seconds until the run ends.
  4. Prints the run-summary log line and, on failure, the error and cause.

  Ctrl+C stops the script only; the run carries on in AWS. Run the script again to attach to it.
  A full run costs Firecrawl credits (5 per active page), the same as a weekly run.

.EXAMPLE
  .\scripts\run-price-sync.ps1
.EXAMPLE
  .\scripts\run-price-sync.ps1 -NoWait          # start it and return
#>
[CmdletBinding()]
param(
  [string]$StackName = 'AghmNwpStack',
  [string]$Region = 'ap-southeast-1',
  [int]$PollSeconds = 30,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'

function Invoke-Aws {
  # Runs the AWS CLI, returns its output as one trimmed string, and stops on a non-zero exit code
  # (PowerShell does not stop on a failing native command by itself). AWS errors print as they happen.
  $output = & aws @args
  if ($LASTEXITCODE -ne 0) { throw "aws $($args[0]) $($args[1]) failed (exit code $LASTEXITCODE); see the message above." }
  return (($output | Out-String).Trim())
}

function Get-StackOutput([string]$Key) {
  $value = Invoke-Aws cloudformation describe-stacks --stack-name $StackName --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='$Key'].OutputValue" --output text
  if (-not $value -or $value -eq 'None') { return $null }
  return $value
}

# 1. Names from the stack
$stateMachine = Get-StackOutput 'PriceSyncStateMachineArn'
if (-not $stateMachine) {
  throw "The stack has no PriceSyncStateMachineArn output. The workflow is only created when cdk.json sets fckNatInstanceId; deploy with it set."
}
$functionName = Get-StackOutput 'PriceUpdaterFunctionName'
$logGroup = Invoke-Aws lambda get-function-configuration --function-name $functionName --region $Region `
  --query 'LoggingConfig.LogGroup' --output text
Write-Host "State machine: $stateMachine"
Write-Host "Log group:     $logGroup"

# 2. Start, or attach to a run already in progress (two runs at once would scrape everything twice)
$running = Invoke-Aws stepfunctions list-executions --state-machine-arn $stateMachine --region $Region `
  --status-filter RUNNING --max-results 1 --query 'executions[0].executionArn' --output text

if ($running -and $running -ne 'None') {
  $execution = $running
  Write-Host "A run is already in progress; following it: $execution" -ForegroundColor Yellow
} else {
  $name = 'manual-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $execution = Invoke-Aws stepfunctions start-execution --state-machine-arn $stateMachine --region $Region `
    --name $name --input '{}' --query 'executionArn' --output text
  Write-Host "Started: $execution" -ForegroundColor Green
}

if ($NoWait) {
  Write-Host 'Not waiting (-NoWait). Run the script again to follow the run.'
  return
}

# 3. Follow it
$started = Get-Date
$lastStep = ''
while ($true) {
  $status = Invoke-Aws stepfunctions describe-execution --execution-arn $execution --region $Region `
    --query 'status' --output text
  if ($status -ne 'RUNNING') { break }

  $step = Invoke-Aws stepfunctions get-execution-history --execution-arn $execution --region $Region `
    --reverse-order --max-results 25 `
    --query 'events[?stateEnteredEventDetails] | [0].stateEnteredEventDetails.name' --output text
  $elapsed = [int]((Get-Date) - $started).TotalMinutes
  if ($step -ne $lastStep) {
    # State names from lib/price-sync-workflow.ts. "break" stops switch at the first match.
    $hint = switch -Regex ($step) {
      '^StopNat'                  { '(stopping fck-nat)'; break }
      'Nat'                       { '(starting fck-nat; a few minutes)'; break }
      '^Probe$'                   { '(checking the database and Firecrawl)'; break }
      '^Plan$'                    { '(listing the pages to scrape)'; break }
      'Batch|AccountLevel'        { '(scraping)'; break }
      '^Finalize$'                { '(medians and review flags)'; break }
      default                     { '' }
    }
    Write-Host ("[{0,3} min] {1} {2}" -f $elapsed, $step, $hint)
    $lastStep = $step
  }
  Start-Sleep -Seconds $PollSeconds
}

# 4. Result
$color = if ($status -eq 'SUCCEEDED') { 'Green' } else { 'Red' }
Write-Host "Run ended: $status after $([int]((Get-Date) - $started).TotalMinutes) min" -ForegroundColor $color

if ($status -ne 'SUCCEEDED') {
  $detail = Invoke-Aws stepfunctions describe-execution --execution-arn $execution --region $Region `
    --query '{error: error, cause: cause}' --output json
  Write-Host $detail
}

$minutes = [Math]::Max(5, [int]((Get-Date) - $started).TotalMinutes + 5)
$logs = Invoke-Aws logs tail $logGroup --region $Region --since "$($minutes)m" --format short
$summary = $logs -split "`r?`n" | Where-Object { $_ -match 'run-summary' } | Select-Object -Last 1
if ($summary) {
  Write-Host "`nRun summary:"
  Write-Host $summary
} else {
  Write-Host "`nNo run-summary line found in the last $minutes minutes (finalize did not run, or the run was attached to late)."
}
