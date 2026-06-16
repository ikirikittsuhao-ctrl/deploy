import express from 'express';
import { createClient } from '@libsql/client';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const db = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

// ① コードを受け取って結合し、デプロイ（新規保存・更新）するAPI
app.post('/api/deploy', async (req, res) => {
  const { id, html, css, js } = req.body;

  const combinedHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <style>${css}</style>
</head>
<body>
${html}
<script>${js}<\/script>
</body>
</html>`;

  if (Buffer.byteLength(combinedHtml, 'utf8') > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'ファイルサイズが2MBを超えています。' });
  }

  try {
    let projectId = id;
    let nextVersion = 1;
    let isExisting = false;

    if (projectId) {
      const existing = await db.execute({
        sql: "SELECT version FROM pages WHERE id = ?",
        args: [projectId]
      });
      if (existing.rows.length > 0) {
        nextVersion = existing.rows[0].version + 1;
        isExisting = true;
      }
    } else {
      projectId = 'cr-' + crypto.randomBytes(4).toString('hex');
    }

    if (isExisting) {
      await db.execute({
        sql: "UPDATE pages SET html_content = ?, version = ? WHERE id = ?",
        args: [combinedHtml, nextVersion, projectId]
      });
    } else {
      await db.execute({
        sql: "INSERT INTO pages (id, html_content, version) VALUES (?, ?, ?)",
        args: [projectId, combinedHtml, nextVersion]
      });
    }

    res.json({ success: true, id: projectId, version: nextVersion });
  } catch (error) {
    console.error("【/api/deploy エラー詳細】:", error);
    res.status(500).json({ error: error.message });
  }
});

// ② アプリの統計情報を取得するAPI
app.get('/api/stats/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: "SELECT views, version FROM pages WHERE id = ?",
      args: [req.params.id]
    });
    if (result.rows.length > 0) {
      res.json({ views: result.rows[0].views, version: result.rows[0].version });
    } else {
      res.status(404).json({ error: 'Not Found' });
    }
  } catch (error) {
    console.error("【/api/stats/:id エラー詳細】:", error);
    res.status(500).json({ error: error.message });
  }
});

// ③ キャッシュ制御を兼ねた生のHTMLデータ取得API
app.get('/api/raw/:id', async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE pages SET views = views + 1 WHERE id = ?",
      args: [req.params.id]
    });

    const result = await db.execute({
      sql: "SELECT html_content, version FROM pages WHERE id = ?",
      args: [req.params.id]
    });

    if (result.rows.length > 0) {
      res.json({ html: result.rows[0].html_content, version: result.rows[0].version });
    } else {
      res.status(404).json({ error: 'Not Found' });
    }
  } catch (error) {
    console.error("【/api/raw/:id エラー詳細】:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🛠【追加】全プロジェクトの一覧を取得するAPI（ダッシュボード用）
app.get('/api/projects', async (req, res) => {
  try {
    const result = await db.execute("SELECT id, version, views FROM pages ORDER BY id DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("【/api/projects エラー詳細】:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🛠【追加】特定のプロジェクトを削除するAPI（ダッシュボード用）
app.delete('/api/project/:id', async (req, res) => {
  try {
    await db.execute({
      sql: "DELETE FROM pages WHERE id = ?",
      args: [req.params.id]
    });
    res.json({ success: true });
  } catch (error) {
    console.error("【DELETE /api/project/:id エラー詳細】:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🛠【追加】ビュアー画面（サイドバー付き）をマッピングするルート
app.get('/view/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// ④ 他の人がアクセスしたときの配信ルート（従来通りのダイレクト表示）
app.get('/:id', (req, res, next) => {
  if (req.params.id.startsWith('api') || req.params.id.includes('.') || req.params.id === 'dashboard') {
    return next();
  }

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Loading...</title></head>
    <body style="background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;">
    <div>Loading Application...</div>
    <script>
      const id = "${req.params.id}";
      async function loadApp() {
        const statsRes = await fetch('/api/stats/' + id);
        if (!statsRes.ok) {
          document.body.innerHTML = "ページが見つかりません";
          return;
        }
        const { version: serverVersion } = await statsRes.json();
        const cachedData = localStorage.getItem('app_' + id);
        let appData = cachedData ? JSON.parse(cachedData) : null;

        if (!appData || appData.version !== serverVersion) {
          const rawRes = await fetch('/api/raw/' + id);
          const rawData = await rawRes.json();
          appData = { html: rawData.html, version: rawData.version };
          localStorage.setItem('app_' + id, JSON.stringify(appData));
        }

        document.open();
        document.write(appData.html);
        document.close();
      }
      loadApp();
    </script>
    </body>
    </html>
  `);
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
