/**
 * ボートレース予想アプリ サーバー (Node 10 互換・依存パッケージなし)
 * - BoatraceOpenAPI (https://boatraceopenapi.github.io) から当日データを取得してプロキシ
 * - public/ 配下の静的ファイルを配信
 */
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3300;
var PUBLIC_DIR = path.join(__dirname, 'public');

// 取得元 (当日データ・レース進行に合わせて随時更新される)
var SOURCES = {
  programs: 'https://boatraceopenapi.github.io/programs/v2/today.json',
  previews: 'https://boatraceopenapi.github.io/previews/v2/today.json',
  results: 'https://boatraceopenapi.github.io/results/v2/today.json'
};

// キャッシュ (直前情報・結果は頻繁に更新されるので短め)
var CACHE_TTL = {
  programs: 5 * 60 * 1000, // 5分
  previews: 60 * 1000,     // 1分
  results: 60 * 1000       // 1分
};
var cache = {}; // key -> { time, body }

function fetchUrl(url, cb) {
  https.get(url, { headers: { 'User-Agent': 'boatrace-predictor/1.0' } }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      fetchUrl(res.headers.location, cb);
      res.resume();
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      cb(new Error('HTTP ' + res.statusCode));
      return;
    }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf8')); });
  }).on('error', cb);
}

function serveApi(key, res) {
  var now = Date.now();
  var hit = cache[key];
  if (hit && now - hit.time < CACHE_TTL[key]) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' });
    res.end(hit.body);
    return;
  }
  fetchUrl(SOURCES[key], function (err, body) {
    if (err) {
      // 取得失敗時は古いキャッシュがあればそれを返す
      if (hit) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'STALE' });
        res.end(hit.body);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'データ取得に失敗しました: ' + err.message }));
      return;
    }
    cache[key] = { time: now, body: body };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' });
    res.end(body);
  });
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(reqPath, res) {
  var filePath = path.join(PUBLIC_DIR, reqPath === '/' ? 'index.html' : reqPath);
  // ディレクトリトラバーサル防止
  if (filePath.indexOf(PUBLIC_DIR) !== 0) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(function (req, res) {
  var urlPath = req.url.split('?')[0];
  if (urlPath === '/api/programs') return serveApi('programs', res);
  if (urlPath === '/api/previews') return serveApi('previews', res);
  if (urlPath === '/api/results') return serveApi('results', res);
  serveStatic(urlPath, res);
}).listen(PORT, function () {
  console.log('ボートレース予想アプリ起動: http://localhost:' + PORT);
});
