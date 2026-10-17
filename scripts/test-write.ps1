$ErrorActionPreference="SilentlyContinue"
$base = "http://127.0.0.1:8091/api"
$tok = (Get-Content "$env:TEMP\tok.json" -Raw | ConvertFrom-Json).token
$J = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" }
function POST($name, $path, $body) {
  try { $r = Invoke-WebRequest -Uri ($base + $path) -Method POST -Headers $J -Body $body -UseBasicParsing -TimeoutSec 20; Write-Output ("### " + $name + " -> HTTP " + $r.StatusCode); Write-Output (($r.Content -replace "\s+"," ").Substring(0,[Math]::Min(300,$r.Content.Length))) }
  catch { $s=$_.Exception.Response.StatusCode.value__; Write-Output ("### " + $name + " -> HTTP " + $s); Write-Output $_.ErrorDetails.Message }
  Write-Output ""
}
function GET($name, $path) {
  try { $r = Invoke-WebRequest -Uri ($base + $path) -Headers $J -UseBasicParsing -TimeoutSec 20; Write-Output ("### " + $name + " -> HTTP " + $r.StatusCode); Write-Output (($r.Content -replace "\s+"," ").Substring(0,[Math]::Min(300,$r.Content.Length))) }
  catch { $s=$_.Exception.Response.StatusCode.value__; Write-Output ("### " + $name + " -> HTTP " + $s); Write-Output $_.ErrorDetails.Message }
  Write-Output ""
}

POST "A. CREATE tabla rara (allowWrite)" "/db-admin/demo.sqlite/query" '{"sql":"CREATE TABLE \"raro\"\"x\" (id INTEGER, texto TEXT)","allowWrite":true}'
GET  "B. objects incluye tabla rara" "/db-admin/demo.sqlite/objects"
GET  "C. columns de tabla rara (escapada)" "/db-admin/demo.sqlite/columns/raro%22x"
POST "D. rows sobre tabla rara" "/db-admin/demo.sqlite/rows" '{"table":"raro\"x","limit":5}'
POST "E. DROP tabla rara (allowWrite)" "/db-admin/demo.sqlite/query" '{"sql":"DROP TABLE \"raro\"\"x\"","allowWrite":true}'
POST "F. VACUUM con allowWrite" "/db-admin/demo.sqlite/vacuum" '{"allowWrite":true}'
GET  "G. stats tras vacuum" "/db-admin/demo.sqlite/stats"