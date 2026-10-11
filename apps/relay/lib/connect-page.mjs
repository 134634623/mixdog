// `/connect`: the public browser entry for pairing v2. Self-contained (no app
// bundle, no data): the visitor types the 6-digit code shown on the main PC,
// the relay resolves it to a device route plus a one-time ticket, and the
// browser continues at `/d/<deviceId>/#pair=<ticket>` where the web app asks
// the main PC for approval. The page itself grants nothing.
const CONNECT_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mixdog</title>
<style>
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px;background:#0e0e0e;color:#e9e9e9;font:400 15px/22px system-ui,-apple-system,"Segoe UI",sans-serif}
main{display:grid;gap:14px;justify-items:center;width:100%;max-width:344px;padding:28px 22px;border-radius:22px;background:#17171a;text-align:center}
img{width:54px;height:54px}
h1{font-size:18px;line-height:24px}
p{color:#a8a8a8;font-size:13.5px;line-height:19px}
input{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:#1f1f23;color:#e9e9e9;text-align:center;font:700 26px/32px ui-monospace,Consolas,monospace;letter-spacing:.3em}
button{width:100%;padding:13px;border:0;border-radius:12px;background:#e9e9e9;color:#111114;font:600 15px/20px system-ui,sans-serif;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#status{min-height:19px;font-size:13px;color:#a8a8a8}
#status.bad{color:#e5484d}
.fine{font-size:12px;color:#7a7a80}
</style>
</head>
<body>
<main>
<img src="/mixdog.svg" alt="" draggable="false" />
<h1 id="heading"></h1>
<p id="note"></p>
<input id="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000 000" aria-labelledby="heading" />
<button id="go" disabled></button>
<div id="status" role="status"></div>
<p class="fine" id="fine"></p>
</main>
<script>
(function () {
  var ko = (navigator.language || '').toLowerCase().indexOf('ko') === 0;
  var T = ko
    ? { heading: 'Mixdog 연결', note: '설치 없이 이 브라우저에서 바로 사용합니다. 메인 PC의 6자리 코드를 입력하세요.', go: '연결', fine: '알림을 받으려면 Mixdog 앱을 설치하세요.', bad: '코드가 맞지 않거나 만료되었습니다. 메인 PC의 새 코드를 확인하세요.', wait: function (s) { return '시도가 너무 많습니다. ' + s + '초 뒤에 다시 시도하세요.'; }, net: '릴레이에 연결할 수 없습니다.' }
    : { heading: 'Connect Mixdog', note: 'Use Mixdog right in this browser, no install needed. Enter the 6-digit code from your main PC.', go: 'Connect', fine: 'To get notifications, install the Mixdog app.', bad: 'That code is wrong or has expired. Check the new code on your main PC.', wait: function (s) { return 'Too many attempts. Try again in ' + s + ' seconds.'; }, net: 'Could not reach the relay.' };
  document.documentElement.lang = ko ? 'ko' : 'en';
  var $ = function (id) { return document.getElementById(id); };
  $('heading').textContent = T.heading;
  $('note').textContent = T.note;
  $('go').textContent = T.go;
  $('fine').textContent = T.fine;
  var input = $('code');
  var digits = function () { return input.value.replace(/\\D/g, '').slice(0, 6); };
  input.addEventListener('input', function () {
    var d = digits();
    input.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
    $('go').disabled = d.length !== 6;
  });
  var say = function (text, bad) { $('status').textContent = text; $('status').className = bad ? 'bad' : ''; };
  var submit = function () {
    var d = digits();
    if (d.length !== 6) return;
    $('go').disabled = true;
    say('');
    fetch('/pair-code/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: d }) })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.status === 200 && r.body.deviceId && r.body.ticket) {
          location.href = '/d/' + encodeURIComponent(r.body.deviceId) + '/#pair=' + encodeURIComponent(r.body.ticket);
          return;
        }
        say(r.status === 429 ? T.wait(r.body.retryAfter || 60) : T.bad, true);
        $('go').disabled = digits().length !== 6;
      })
      .catch(function () { say(T.net, true); $('go').disabled = digits().length !== 6; });
  };
  $('go').addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  input.focus();
})();
</script>
</body>
</html>`;

export function sendConnectPage(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  response
    .writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CONNECT_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
    })
    .end(request.method === 'HEAD' ? undefined : PAGE);
}
