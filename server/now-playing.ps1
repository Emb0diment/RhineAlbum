$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$songs = @()
$mediaError = ''
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Resolve-WinRT($operation, $resultType) {
    $task = $taskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(5000)) { throw 'Media session request timed out.' }
    return $task.Result
  }
  $manager = Resolve-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $songs = @()
  foreach ($session in $manager.GetSessions()) {
    if ($session.SourceAppUserModelId -notmatch '(?i)qqmusic|cloudmusic|netease|163music') { continue }
    try {
      $media = Resolve-WinRT ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $timeline = $session.GetTimelineProperties()
      if ($media.Title) { $songs += [pscustomobject]@{ title = $media.Title; artist = $media.Artist; album = $media.AlbumTitle; source = $session.SourceAppUserModelId; status = $session.GetPlaybackInfo().PlaybackStatus.ToString(); position = $timeline.Position.TotalSeconds; duration = $timeline.EndTime.TotalSeconds } }
    } catch { }
  }
} catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $mediaError = $failure.Message
}
if ($songs.Count -eq 0) {
  # Some clients expose only their own window title, without a system media session.
  foreach ($client in @(Get-Process -Name QQMusic,cloudmusic -ErrorAction SilentlyContinue)) {
    $caption = $client.MainWindowTitle.Trim()
    $caption = $caption -replace '\s*[-—|]\s*(QQ音乐|QQ Music|网易云音乐)\s*$', ''
    if (-not $caption -or $caption -match '^(QQ音乐|QQ Music|网易云音乐)$') { continue }
    $parts = $caption -split '\s+[-—]\s+', 2
    if ($parts.Count -lt 2 -or -not $parts[0].Trim() -or -not $parts[1].Trim()) { continue }
    $songs += [pscustomobject]@{ title=$parts[0].Trim(); artist=$parts[1].Trim(); album=''; source=$client.ProcessName; status='WindowTitle'; position=0; duration=0 }
  }
}
if ($songs.Count -eq 0 -and $mediaError) {
  ConvertTo-Json -InputObject ([pscustomobject]@{ sessions=@(); error=$mediaError + '。客户端窗口也没有提供可识别的歌曲标题。' }) -Compress
} else {
  ConvertTo-Json -InputObject ([pscustomobject]@{ sessions=@($songs) }) -Depth 5 -Compress
}
