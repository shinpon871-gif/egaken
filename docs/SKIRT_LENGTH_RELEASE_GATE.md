# Length（スカート丈）の生成と公開ゲート

Length は既存スカートの裾からの延長率（+25 / +50 / +75%）です。物理ベイクではなく、**幾何教師データ**で作ります（base と同じ仕組み）。

## 仕組み
- `create_skirt_body_context.py` がスカートメッシュを「Bottoms + 裾帯8段」の上位集合にします。base では帯を裾へ折りたたみ（0.2mm厚）、各 Length 候補は帯を展開して表します。頂点数・面が同じなので、GLB のモーフターゲット（`Style_length_XXX_NNN`）としてそのまま入ります。
- 帯の各段は、裾の表面の延長方向から重力方向へ少しずつ向きを変えながら伸ばし、段ごとに Body の外側へ射影します（脚の上では太腿に沿い、膝の先では垂れます）。
- 全フレーム・全頂点を base と同じ符号付き面距離で検証し、さらに帯の面の10点（重心・辺の中点・面内）が Body を横切らないことを確認します（腕・手に最も近い点は、ランタイムが腕を開いて回避するため対象外）。1つでも不足すれば生成を止めます。
- +100% は、膝を閉じた座位で左右の膝の間に垂れる布を両側から挟むため解がなく、提供していません。

## 手順
```bash
BLENDER_BIN=/path/to/Blender python scripts/run_skirt_pipeline.py --steps context,render
```
1. `context`: 教師データと数値QA（`public/models/skirt_length_release_manifest.json`）を作ります。
2. `render`: 候補ごとの6視点（立位・遷移・座位 × 正面・側面）を `docs/skirt_length_qa/rendered/` に出力します（`base` も含みます）。
3. **人が画像を目視して**、問題なければ基準画像として別ディレクトリへ複製し、承認します。承認は画像の SHA-256 完全一致で判定します。
```bash
rm -rf docs/skirt_length_qa/approved_reference && cp -r docs/skirt_length_qa/rendered docs/skirt_length_qa/approved_reference   # 目視後
SKIRT_LENGTH_REVIEWER="あなたの名前" python scripts/approve_skirt_length_release.py
python scripts/run_skirt_pipeline.py --steps train,glb
```
`release_status=approved` になった場合のみ、GLB に Length 候補が入り、UI のスライダーが有効になります。承認は context PKL の SHA-256 に結び付いており、context を再生成すると無効になります。

## 数値ゲート
- 頂点: 全フレーム・全頂点で Body 面からの符号付き距離がクリアランス以上。
- 面: 帯の面上の10点が Body 外側（距離 ≥ 0）。
- 縮退面なし（面積しきい値）。折りたたんだ段も微小な厚みを保つ。

旧方式（Blender Cloth ベイク）は座り始めで発散したため廃止しました。

`docs/skirt_length_qa/` の画像は作業用でコミットしません（`.gitignore` 済み）。承認結果は `public/models/skirt_length_release_manifest.json` の `approved_by` / `image_qa` に記録されます（現在の承認: Yanai-SHIN、+25/+50/+75%）。
