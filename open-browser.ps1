# Open the dashboard in the default browser once it is actually serving.
# Called by the .bat launcher, so the page never opens before the port is up.
$url = 'http://127.0.0.1:8787'
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($url + '/api/health') -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Start-Process $url
            exit 0
        }
    } catch {
        # service not ready yet, keep waiting
    }
}
Write-Host 'Service did not answer within 50 seconds. Check data\server.log'
