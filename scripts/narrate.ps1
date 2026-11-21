$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$projectRoot = Split-Path $PSScriptRoot -Parent
$scenes = Get-Content -LiteralPath (Join-Path $projectRoot 'public/narration.json') -Raw | ConvertFrom-Json
$narrator = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $narrator.SelectVoice('Microsoft Zira Desktop')
    $narrator.Rate = 3
    for ($index = 0; $index -lt $scenes.Count; $index++) {
        $narrator.SetOutputToWaveFile((Join-Path $projectRoot "output/video/narration-$index.wav"))
        $narrator.Speak($scenes[$index].text)
        $narrator.SetOutputToNull()
    }
} finally { $narrator.Dispose() }
Write-Output 'Rendered eight narration segments with the installed Windows voice.'
