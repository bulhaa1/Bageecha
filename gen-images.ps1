Add-Type -AssemblyName System.Drawing

function New-BageechaImage {
  param([string]$Path, [int]$W, [int]$H, [bool]$WithText)

  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bg = [System.Drawing.Color]::FromArgb(255, 17, 18, 21)
  $g.Clear($bg)

  $soft = New-Object System.Drawing.Drawing2D.GraphicsPath
  $soft.AddEllipse(-($W * 0.15), -($H * 0.25), $W * 0.6, $H * 0.6)
  $softB = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28, 96, 165, 250))
  $g.FillPath($softB, $soft)

  $sunBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 96, 165, 250))
  $sunR = $H * 0.075
  $sunX = $W / 2
  if ($WithText) { $sunY = $H * 0.30 } else { $sunY = $H * 0.44 }
  $g.FillEllipse($sunBrush, ($sunX - $sunR), ($sunY - $sunR), (2 * $sunR), (2 * $sunR))

  $hiBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 147, 197, 253))
  $g.FillEllipse($hiBrush, ($sunX - $sunR * 0.45), ($sunY - $sunR * 0.6), ($sunR * 0.9), ($sunR * 0.9))

  function Draw-Wave {
    param([System.Drawing.Graphics]$gr, [float]$y, [float]$Amp, [int]$R, [int]$G, [int]$B, [float]$Alpha, [float]$StartX, [float]$EndX)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($Alpha, $R, $G, $B), ($H * 0.022))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $w = $EndX - $StartX
    $gr.DrawBezier($pen,
      $StartX, $y,
      ($StartX + $w * 0.33), ($y - $Amp),
      ($StartX + $w * 0.66), ($y + $Amp),
      $EndX, $y)
    $pen.Dispose()
  }

  if ($WithText) {
    $y1 = $H * 0.565
    $y2 = $H * 0.655
    Draw-Wave $g $y1 ($H * 0.02) 165 180 252 235 0 1.0 $W
    Draw-Wave $g $y2 ($H * 0.02) 96 165 250 130 0 1.0 $W

    $font1 = New-Object System.Drawing.Font("Palatino Linotype", ($H * 0.105), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 241, 242, 245))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect1 = New-Object System.Drawing.RectangleF(0, ($H * 0.68), $W, ($H * 0.16))
    $g.DrawString("Bageecha", $font1, $textBrush, $rect1, $sf)

    $font2 = New-Object System.Drawing.Font("Arial", ($H * 0.032), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $dimBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 154, 161, 176))
    $rect2 = New-Object System.Drawing.RectangleF(0, ($H * 0.835), $W, ($H * 0.08))
    $g.DrawString("The island's community poll board", $font2, $dimBrush, $rect2, $sf)

    $font1.Dispose(); $font2.Dispose()
    $textBrush.Dispose(); $dimBrush.Dispose()
    $sf.Dispose()
  } else {
    $y1 = $H * 0.72
    $y2 = $H * 0.86
    Draw-Wave $g $y1 ($H * 0.02) 165 180 252 235 0 1.0 $W
    Draw-Wave $g $y2 ($H * 0.02) 96 165 250 130 0 1.0 $W
  }

  $sunBrush.Dispose(); $hiBrush.Dispose()
  $soft.Dispose(); $softB.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-BageechaImage -Path "public\og-image.png" -W 1200 -H 630 -WithText $true
New-BageechaImage -Path "public\apple-touch-icon.png" -W 180 -H 180 -WithText $false
Write-Output "Generated public/og-image.png and public/apple-touch-icon.png"
