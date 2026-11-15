# とらのバーコードバトル ネットたいせん 中継サーバー

「とらのバーコードバトル」のネット対戦用 WebSocket 中継サーバー。
ベースは「とらのごもく」あいことば対戦サーバー（部屋管理の枠組みを流用）。

- 部屋（4桁番号）の管理、部屋名・プライベート設定、クイックマッチ（公開の待機部屋への自動参加）
- 両者のチーム（バーコード列）と「じゅんびOK」を集め、そろったら対戦シードを配って開始（`start`）
- バトルは各端末が同じシードで再現する前提。サーバーは着手の中継をしない
- 部屋は10分で自動解散（相手が来ない部屋は `room_expired`、対戦成立後の無操作は `idle_timeout`）
- 個人情報は扱わない。部屋はメモリ上のみ、対戦終了/切断で消える
- `GET /health` → `{"ok":true,"rooms":N}`
- 起動: `npm install && npm start`（ポートは `PORT` 環境変数、既定 8377）

## デプロイ（GitHub + Render の例）

このフォルダの中身を、そのまま専用GitHubリポジトリのルートに置く。

1. GitHub で新しいリポジトリを作り、このフォルダのファイルを上げる（`node_modules` は上げない。.gitignore 済み）
2. Render で「New Web Service」→ そのリポジトリを選ぶ
   - Build Command: `npm install` / Start Command: `npm start`
   - ポートは Render が `PORT` 環境変数で渡すので、コード側の対応は済んでいる
3. 発行されたURL（例: `https://xxxx.onrender.com`）が接続先になる
   - ゲーム側の `NET_SERVER_URL` を `wss://xxxx.onrender.com` に差し替える
   - 注意: Render の無料プランは無操作でスリープし、初回接続に30〜60秒かかることがある

## プロトコル（JSON）

クライアント→サーバー:
- `{type:"create", name, isPrivate, team:[barcode,...]}` → `created {code, name, isPrivate}`
- `{type:"join", code, team}` → `joined {code, name, isPrivate}`（ホストへ `opponent_joined`）
- `{type:"quick", team}` → 待機中の公開部屋へ `joined`、なければ自分がホストで `created {via:"quick"}`
- `{type:"ready"}` → 全員へ `ready_state {ready:[bool,bool]}`、両者OKで `start {seed, teams:[hostTeam, guestTeam]}`
- `{type:"rematch", team?}` → 相手へ `rematch_offer`、両者希望で `rematch_ok`（ready からやり直し）
- `{type:"leave"}` → 相手へ `opponent_left`、部屋は消える

エラー: `error {reason: bad_code|no_room|full|started|bad_team}`
