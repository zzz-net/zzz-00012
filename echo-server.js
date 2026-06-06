const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('=== 收到请求 ===');
    console.log('URL:', req.url);
    console.log('Method:', req.method);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body 原始字符:', [...body].map(c => c.charCodeAt(0) + ':' + c).join(' '));
    console.log('Body 字符串:', JSON.stringify(body));
    res.end('ok');
  });
});
server.listen(9999, () => console.log('Echo server on :9999'));
