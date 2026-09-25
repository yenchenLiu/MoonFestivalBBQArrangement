# 🌕 中秋烤肉管理

超簡易的一次性烤肉籌備工具：場地投票、人員出席時間、物品認領，以及一眼看懂的總覽進度。

- **零依賴**：Node 版只用內建 `node:sqlite`，不用 `npm install`；Cloudflare 版只多一個 `wrangler`
- **單一資料庫**：本機是 `data/bbq.db`，雲端是 Cloudflare D1
- **無登入**：每個人在右上角選「我是誰」即可操作，適合 10 幾人的群組
- **最低限度的門**：只有從帶通關碼的網址進來的人才看得到，其他人一律 404

## 啟動

需要 Node.js 22.13 以上。

```bash
ACCESS_CODE=bbq node server.js
```

然後把這個網址丟到群組：

```
http://localhost:3000/?code=bbq
```

（也接受 `http://localhost:3000/code=bbq`）

點開後伺服器會發一個 30 天的 cookie 並導回首頁，之後直接開首頁即可。沒有 cookie 或 code 打錯，所有頁面與 API 都回 404。

環境變數：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `ACCESS_CODE` | （必填） | 通關碼，沒設定伺服器不會啟動 |
| `PORT` | `3000` | 監聽埠 |
| `DB_FILE` | `./data/bbq.db` | SQLite 檔案路徑 |

## 部署

兩種後端擇一，前端與資料模型完全相同：

| | Node 版（`server.js`） | Cloudflare 版（`worker.js`） |
| --- | --- | --- |
| 資料庫 | 本機 SQLite 檔 | Cloudflare D1（雲端 SQLite） |
| 適合 | 本機、VPS、Fly.io、Docker | 不想管機器，免費額度就夠 |
| 費用 | 看平台 | Workers 每日 10 萬次請求、D1 5GB 免費，這個規模用不完 |

### 方案 A：Cloudflare Workers + D1（推薦）

需要一個 Cloudflare 帳號（免費即可）。第一次：

```bash
npm install                       # 安裝 wrangler（唯一的開發依賴）
npx wrangler login                # 開瀏覽器授權
npx wrangler d1 create moon-bbq   # 建資料庫，會印出 database_id
```

把印出的 `database_id` 貼進 `wrangler.toml` 的 `[[d1_databases]]` 區塊，然後：

```bash
npx wrangler secret put ACCESS_CODE   # 貼上通關碼，例如bbq
npx wrangler deploy
```

部署完會印出網址，例如 `https://moon-bbq.<你的帳號>.workers.dev`。
丟給群組的網址就是：

```
https://moon-bbq.<你的帳號>.workers.dev/?code=bbq
```

資料表與預設清單會在第一次呼叫 API 時自動建立，不需要手動跑 migration。

之後改了程式碼只要再 `npx wrangler deploy`。要換通關碼就再 `wrangler secret put ACCESS_CODE`，舊 cookie 會全部失效。活動結束想關站：`npx wrangler delete`。

本機測試 Cloudflare 版（用本機模擬的 D1，不需登入）：

```bash
npx wrangler dev
```

通關碼讀 `.dev.vars`（已在 `.gitignore`）。

想查或改雲端資料：

```bash
npx wrangler d1 execute moon-bbq --remote --command "SELECT name, status FROM people"
```

### 方案 B：Fly.io（Node 版，有 `fly.toml`）

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config      # 會問 app 名稱，記得改 fly.toml 裡的 app
fly volumes create bbq_data --region nrt --size 1
fly secrets set ACCESS_CODE=bbq
fly deploy
```

### 方案 C：本機 + Cloudflare Tunnel（不想開任何帳號）

```bash
ACCESS_CODE=bbq node server.js
cloudflared tunnel --url http://localhost:3000
```

會給你一個臨時的 `https://xxx.trycloudflare.com` 網址，電腦要一直開著。

### Docker（任何 VPS）

```bash
docker build -t bbq .
docker run -d -p 3000:3000 -v bbq-data:/data -e ACCESS_CODE=bbq bbq
```

Node 版需要能保留磁碟的地方，Vercel／Netlify 這類無伺服器平台不適合；要用 Cloudflare 就走方案 A。

## 功能

| 分頁 | 內容 |
| --- | --- |
| 總覽 | 準備度環圈、檢查清單（日期／場地／座位／烤肉架／各類物品）、出席人數、每小時在場人數與每人時間條、還缺什麼 |
| 人員 | 名字、會到／不確定／不來、到達與離開時間（空白＝全程）、備註 |
| 場地 | 活動日期時間、桌子座位、烤肉架數；場地候選投票與選定 |
| 物品 | 工具／食材／調味料／餐具，每項有需要量，大家按「我帶」認領；場地自帶的已預填 |

所有欄位改完自動儲存，頁面每 6 秒自動同步。

## 重置

刪掉 `data/bbq.db` 後重啟，會重新建立預設建議清單（約 12 人份）。

## API

全部回傳 JSON，寫入類操作皆回傳最新完整狀態。需帶有效 cookie。

```
GET    /api/state
PUT    /api/event
GET/POST        /api/{people|venues|items|contributions}
PUT/DELETE      /api/{people|venues|items|contributions}/:id
```
