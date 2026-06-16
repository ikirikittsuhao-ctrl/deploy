import express from 'express';
import { createClient } from '@libsql/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

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

    if (projectId) {
      const existing = await db.execute({
        sql: "SELECT version FROM pages WHERE id = ?",
        args: [projectId]
      });
      if (existing.rows.length > 0) {
        nextVersion = existing.rows[0].version + 1;
      }
    } else {
      projectId = 'cr-' + crypto.randomBytes(4).toString('hex');
    }

    await db.execute({
      sql: `
        INSERT INTO pages (id, html_content, version) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET html_content=excluded.html_content, version=excluded.version
      `,
      args: [projectId, combinedHtml, nextVersion]
    });

    res.json({ success: true, id: projectId, version: nextVersion });
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// ④ 他の人がアクセスしたときの配信ルート
app.get('/:id', (req, res, next) => {
  if (req.params.id.startsWith('api') || req.params.id.includes('.')) {
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
