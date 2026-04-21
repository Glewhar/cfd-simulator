$port = 3000
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"
$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.wasm' = 'application/wasm'
    '.stl'  = 'model/stl'
    '.obj'  = 'text/plain'
}
while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $resp = $ctx.Response
    # Permissive CORS so the STL samples load from any origin.
    $resp.Headers.Add('Access-Control-Allow-Origin',  '*')
    $resp.Headers.Add('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    $resp.Headers.Add('Access-Control-Allow-Headers', '*')
    if ($req.HttpMethod -eq 'OPTIONS') {
        $resp.StatusCode = 204
        $resp.OutputStream.Close()
        continue
    }
    $path = $req.Url.LocalPath
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $root $path.TrimStart('/')
    if (Test-Path $file -PathType Leaf) {
        $ext  = [System.IO.Path]::GetExtension($file)
        $ct   = if ($mime[$ext]) { $mime[$ext] } else { 'text/plain' }
        $data = [System.IO.File]::ReadAllBytes($file)
        $resp.ContentType   = $ct
        $resp.ContentLength64 = $data.Length
        $resp.OutputStream.Write($data, 0, $data.Length)
    } else {
        $resp.StatusCode = 404
    }
    $resp.OutputStream.Close()
}
