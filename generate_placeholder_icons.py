#!/usr/bin/env python3
"""
アイコンのプレースホルダーを生成するスクリプト。
本番では自分のアイコン画像を icons/ フォルダに入れてください。

使い方:
  python3 generate_placeholder_icons.py

依存: Pillow
  pip install Pillow
"""

try:
    from PIL import Image, ImageDraw, ImageFont
    import os

    SIZES = [32, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512]
    os.makedirs('icons', exist_ok=True)

    for size in SIZES:
        img = Image.new('RGB', (size, size), color='#090910')
        draw = ImageDraw.Draw(img)

        # Orange gradient rectangle as background accent
        for i in range(size):
            ratio = i / size
            r = int(249 + (250-249)*ratio)
            g = int(115 + (204-115)*ratio)
            b = int(22  + (21-22)*ratio)
            draw.line([(0, i), (size, i)], fill=(r, g, b, 40))

        # Draw "IL" text
        font_size = size // 3
        try:
            font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', font_size)
        except:
            font = ImageFont.load_default()

        text = "IL"
        bbox = draw.textbbox((0,0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = (size - tw) // 2
        y = (size - th) // 2 - bbox[1]
        draw.text((x, y), text, fill='#f97316', font=font)

        fname = f'icons/icon-{size}.png'
        img.save(fname)
        print(f'Generated {fname}')

    print('\n✅ プレースホルダーアイコン生成完了')
    print('本番では icons/ フォルダに自分の画像を入れ直してください。')

except ImportError:
    print('Pillowがインストールされていません。')
    print('pip install Pillow を実行してください。')
    print('またはアイコンを手動で icons/ フォルダに配置してください。')
