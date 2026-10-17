$ErrorActionPreference="SilentlyContinue"
$base = "http://127.0.0.1:8091/api"
$tok = (Get-Content "$env:TEMP\tok.json" -Raw | ConvertFrom-Json).token
$H = @{ Authorization = "Bearer $tok" }
$J = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" }
function Show($name, $res) {
  $txt = ($res.Content -replace "\s+"," ")
  if ($txt.Length -gt 320) { $txt = $txt.Substring(0,320) + "..." }
  Write-Output ("### " + $name + " -> HTTP " + $res.StatusCode)
  Write-Output $txt
  Write-Output ""
}
function GET($name, $path) {
  try { $r = Invoke-WebRequest -Uri ($base + $path) -Headers $H -UseBasicParsing -TimeoutSec 15; Show $name $r }
  catch { $s=$_.Exception.Response.StatusCode.value__; $b=$_.ErrorDetails.Message; Write-Output ("### " + $name + " -> HTTP " + $s); Write-Output $b; Write-Output "" }
}
function POST($name, $path, $body) {
  try { $r = Invoke-WebRequest -Uri ($base + $path) -Method POST -Headers $J -Body $body -UseBasicParsing -TimeoutSec 15; Show $name $r }
  catch { $s=$_.Exception.Response.StatusCode.value__; $b=$_.ErrorDetails.Message; Write-Output ("### " + $name + " -> HTTP " + $s); Write-Output $b; Write-Output "" }
}

GET "1. databases" "/db-admin/databases"
GET "2. objects" "/db-admin/demo.sqlite/objects"
GET "3. columns clientes" "/db-admin/demo.sqlite/columns/clientes"
POST "4. rows (filtro nit like + orden desc + limit 1)" "/db-admin/demo.sqlite/rows" '{"table":"clientes","filters":[{"column":"nombre","op":"like","value":"%Demo%"}],"order":[{"column":"id","dir":"desc"}],"limit":1}'
POST "5. rows paginado" "/db-admin/demo.sqlite/rows" '{"table":"productos","limit":1,"offset":1}'
GET "6. stats" "/db-admin/demo.sqlite/stats"
POST "7. query SELECT" "/db-admin/demo.sqlite/query" '{"sql":"SELECT nombre, precio FROM productos ORDER BY precio DESC"}'
POST "8. query PRAGMA" "/db-admin/demo.sqlite/query" '{"sql":"PRAGMA journal_mode"}'
POST "9. query DELETE sin allowWrite (debe 403)" "/db-admin/demo.sqlite/query" '{"sql":"DELETE FROM productos"}'
POST "10. query multiple statements (debe 400)" "/db-admin/demo.sqlite/query" '{"sql":"SELECT 1; DROP TABLE productos"}'
POST "11. query con comentario" "/db-admin/demo.sqlite/query" '{"sql":"-- comentario\nSELECT COUNT(*) AS n FROM clientes"}'
POST "12. vacuum sin permiso (debe 403)" "/db-admin/demo.sqlite/vacuum" '{}'
POST "13. integrity" "/db-admin/demo.sqlite/integrity" '{}'
POST "14. row con columna inyectada (debe 400)" "/db-admin/demo.sqlite/rows" '{"table":"clientes","filters":[{"column":"id) OR 1=1 --","op":"=","value":1}]}'
POST "15. op invalida (debe 400)" "/db-admin/demo.sqlite/rows" '{"table":"clientes","filters":[{"column":"id","op":"union select","value":1}]}'
POST "16. db traversal (debe 400)" "/db-admin/..%2F..%2Fetc%2Fpasswd/objects" '{}'
POST "17. tabla inexistente (debe 404)" "/db-admin/demo.sqlite/rows" '{"table":"no_existe"}'