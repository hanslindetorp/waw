<?php
// The launch, the viewer hand-over and the score (included by run.php): a
// pretend learning platform with its own key signs the launches, and the
// network is replaced by a function that records what the tool sends.
require_once __DIR__ . '/../lib/bootstrap.php';

use Waw\Db;
use Waw\Jwt;
use Waw\Lti;
use Waw\LtiException;

$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
Db::migrate($pdo);
$config = [
    'base_url' => 'https://tool.example/lti',
    'viewer_url' => 'https://viewer.example/viewer.html',
    'project_dir' => 'public',
    'token_secret' => 'test-secret',
];

$platformKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
openssl_pkey_export($platformKey, $platformPem);
$platformJwk = Jwt::publicJwk($platformPem, 'p1');
$strangerKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
openssl_pkey_export($strangerKey, $strangerPem);

$ISS = 'https://canvas.example';
$CLIENT = '10000000000001';
$pdo->prepare('INSERT INTO waw_lti_platforms (name, issuer, client_id, deployment_id, auth_url, token_url, jwks_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ->execute(['Test', $ISS, $CLIENT, 'dep-1', 'https://canvas.example/auth', 'https://canvas.example/token', 'https://canvas.example/jwks']);

$requests = [];
$jwksFetches = 0;
$scoreResponse = ['status' => 200, 'body' => '{}']; // what the gradebook answers a score with
$http = function (string $method, string $url, array $headers, ?string $body) use (&$requests, &$jwksFetches, &$scoreResponse, $platformJwk) {
    $requests[] = compact('method', 'url', 'headers', 'body');
    if ($url === 'https://canvas.example/jwks') {
        $jwksFetches++;
        return ['status' => 200, 'body' => json_encode(['keys' => [$platformJwk]])];
    }
    if ($url === 'https://canvas.example/token') {
        return ['status' => 200, 'body' => json_encode(['access_token' => 'access-123', 'token_type' => 'Bearer', 'expires_in' => 3600])];
    }
    if (str_contains($url, '/scores')) {
        return $scoreResponse;
    }
    return ['status' => 404, 'body' => ''];
};
$lti = new Lti($pdo, $config, $http);

// A login, then the launch the platform would answer it with.
function begin(Lti $lti, string $target = 'https://tool.example/lti/launch.php?project=filter-task&view=vabc123'): array
{
    global $ISS, $CLIENT;
    $url = $lti->startLogin(['iss' => $ISS, 'login_hint' => 'hint-1', 'target_link_uri' => $target, 'lti_message_hint' => 'mh-1', 'client_id' => $CLIENT]);
    parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
    return [$url, $q];
}
function launchClaims(string $nonce, array $override = []): array
{
    global $ISS, $CLIENT;
    $c = 'https://purl.imsglobal.org/spec/lti/claim/';
    $claims = [
        'iss' => $ISS, 'aud' => $CLIENT, 'sub' => 'user-77', 'exp' => time() + 300, 'iat' => time(), 'nonce' => $nonce,
        $c . 'deployment_id' => 'dep-1',
        $c . 'message_type' => 'LtiResourceLinkRequest',
        $c . 'version' => '1.3.0',
        $c . 'resource_link' => ['id' => 'rl-1'],
        $c . 'context' => ['id' => 'course-1'],
        $c . 'roles' => ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
        $c . 'target_link_uri' => 'https://tool.example/lti/launch.php?project=filter-task&view=vabc123',
        'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint' => [
            'scope' => ['https://purl.imsglobal.org/spec/lti-ags/scope/score', 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem'],
            'lineitem' => 'https://canvas.example/api/lti/courses/1/line_items/5?x=1',
        ],
    ];
    return array_replace($claims, $override);
}
function throws(callable $fn): ?string
{
    try {
        $fn();
    } catch (LtiException $e) {
        return $e->getMessage();
    }
    return null;
}

// ── Login ──
check('lti login: unknown platform is refused', throws(fn() => $lti->startLogin(['iss' => 'https://other.example', 'login_hint' => 'x'])) !== null);
check('lti login: incomplete request is refused', throws(fn() => $lti->startLogin(['iss' => $ISS])) !== null);
[$loginUrl, $q] = begin($lti);
check('lti login: goes to the platform with the right parameters',
    str_starts_with($loginUrl, 'https://canvas.example/auth?') && $q['client_id'] === $CLIENT && $q['response_type'] === 'id_token'
    && $q['response_mode'] === 'form_post' && $q['redirect_uri'] === 'https://tool.example/lti/launch.php' && $q['login_hint'] === 'hint-1'
    && $q['lti_message_hint'] === 'mh-1' && $q['scope'] === 'openid' && strlen($q['state']) >= 32 && strlen($q['nonce']) >= 32);

// ── A good launch ──
$idToken = Jwt::signRs256(launchClaims($q['nonce']), $platformPem, 'p1');
$launch = $lti->completeLaunch($idToken, $q['state']);
check('lti launch: accepted, project and view read from the link', $launch['project'] === 'filter-task' && $launch['view'] === 'vabc123' && $launch['launch_id'] > 0);
$row = $pdo->query('SELECT * FROM waw_lti_launches')->fetch();
check('lti launch: recorded with user, gradebook entry and scopes', $row['user_sub'] === 'user-77' && str_contains($row['lineitem'], 'line_items/5') && in_array('https://purl.imsglobal.org/spec/lti-ags/scope/score', json_decode($row['scopes'], true), true));
check('lti launch: the state is single use', throws(fn() => $lti->completeLaunch($idToken, $q['state'])) !== null);
check('lti launch: the platform keys were fetched once', $jwksFetches === 1);

// ── Launches that must be refused ──
$refused = function (string $name, callable $makeToken) use ($lti, $platformPem) {
    [, $q] = begin($lti);
    $token = $makeToken($q['nonce']);
    check("lti launch refused: $name", throws(fn() => $lti->completeLaunch($token, $q['state'])) !== null);
};
$sign = fn(array $c, ?string $pem = null) => Jwt::signRs256($c, $pem ?? $platformPem, 'p1');
$refused('signed by a stranger', fn($n) => $sign(launchClaims($n), $strangerPem));
$refused('wrong nonce', fn($n) => $sign(launchClaims('not-' . $n)));
$refused('expired', fn($n) => $sign(launchClaims($n, ['exp' => time() - 600])));
$refused('no expiry', fn($n) => $sign(array_diff_key(launchClaims($n), ['exp' => 1])));
$refused('issued in the future', fn($n) => $sign(launchClaims($n, ['iat' => time() + 3600])));
$refused('another issuer', fn($n) => $sign(launchClaims($n, ['iss' => 'https://evil.example'])));
$refused('another audience', fn($n) => $sign(launchClaims($n, ['aud' => 'someone-else'])));
$refused('several audiences without azp', fn($n) => $sign(launchClaims($n, ['aud' => [$CLIENT, 'other']])));
$refused('another deployment', fn($n) => $sign(launchClaims($n, ['https://purl.imsglobal.org/spec/lti/claim/deployment_id' => 'dep-2'])));
$refused('not a resource link request', fn($n) => $sign(launchClaims($n, ['https://purl.imsglobal.org/spec/lti/claim/message_type' => 'LtiDeepLinkingRequest'])));
$refused('wrong LTI version', fn($n) => $sign(launchClaims($n, ['https://purl.imsglobal.org/spec/lti/claim/version' => '1.1'])));
$refused('no user', fn($n) => $sign(array_diff_key(launchClaims($n), ['sub' => 1])));
$refused('no resource link', fn($n) => $sign(array_diff_key(launchClaims($n), ['https://purl.imsglobal.org/spec/lti/claim/resource_link' => 1])));
$refused('no project in the link', fn($n) => $sign(launchClaims($n, ['https://purl.imsglobal.org/spec/lti/claim/target_link_uri' => 'https://tool.example/lti/launch.php'])));
$refused('a project name with path characters', fn($n) => $sign(launchClaims($n, ['https://purl.imsglobal.org/spec/lti/claim/target_link_uri' => 'https://tool.example/lti/launch.php?project=../x&view=v'])));
[, $q2] = begin($lti);
check('lti launch refused: a state that never existed', throws(fn() => $lti->completeLaunch($sign(launchClaims($q2['nonce'])), 'nonexistent')) !== null);
[, $q3] = begin($lti);
$pdo->exec('UPDATE waw_lti_states SET created = ' . (time() - 3600));
check('lti launch refused: an old login', throws(fn() => $lti->completeLaunch($sign(launchClaims($q3['nonce'])), $q3['state'])) !== null);

// custom parameters win over the link's address
[, $q4] = begin($lti);
$custom = $lti->completeLaunch($sign(launchClaims($q4['nonce'], ['https://purl.imsglobal.org/spec/lti/claim/custom' => ['project' => 'other-task', 'view' => 'vcustom']])), $q4['state']);
check('lti launch: custom parameters are used when present', $custom['project'] === 'other-task' && $custom['view'] === 'vcustom');

// ── To the viewer ──
$viewer = $lti->viewerUrl($launch['launch_id'], 'filter-task', 'vabc123');
parse_str((string) parse_url($viewer, PHP_URL_QUERY), $vq);
check('lti viewer url: points at the viewer with project, view, token and the tool address',
    str_starts_with($viewer, 'https://viewer.example/viewer.html?') && $vq['project'] === 'public/filter-task.zip' && $vq['view'] === 'vabc123' && $vq['api'] === 'https://tool.example/lti/done.php');
check('lti viewer url: the token stands for the launch', (Jwt::readToken($vq['lti'], 'test-secret')['lid'] ?? null) === $launch['launch_id']);
$token = $vq['lti'];

// ── Done ──
$assessment = [
    'max' => 10, 'pass' => 0.6, 'reveal' => 'direction',
    'bands' => [['min' => 0.9, 'text' => 'Excellent.'], ['min' => 0, 'text' => 'Try again.']],
    'criteria' => [
        ['id' => 'freq', 'label' => 'Frequency', 'type' => 'match', 'a' => ['ref' => 'B', 'attr' => 'frequency'], 'b' => ['ref' => 'A', 'attr' => 'frequency'], 'scale' => 'log2', 'full' => 0.1, 'zero' => 1],
    ],
];
check('lti done: no assessment on the server is refused', throws(fn() => $lti->submit($token, [])) !== null);
$pdo->prepare('INSERT INTO waw_lti_assessments (project, view_id, body, updated) VALUES (?, ?, ?, ?)')->execute(['filter-task', 'vabc123', json_encode($assessment), time()]);
$reads = $lti->reads($token);
check('lti reads: only what the criteria measure', count($reads) === 2 && $reads[0]['ref'] === 'B' && !array_key_exists('full', $reads[0]));
check('lti done: a bad token is refused', throws(fn() => $lti->submit('x.y', [])) !== null);
check('lti done: an expired token is refused', throws(fn() => $lti->submit(Jwt::makeToken(['lid' => $launch['launch_id'], 'exp' => time() - 5], 'test-secret'), [])) !== null);

$requests = [];
$out = $lti->submit($token, ['B.frequency.number' => 410, 'A.frequency.number' => 400, 'junk' => 5, 'B.gain.db' => 99]);
check('lti done: scored on the server', $out['result']['score'] == 10.0 && $out['result']['passed'] === true && $out['result']['hasPass'] === true);
check('lti done: sent to the gradebook', $out['ags']['sent'] === true);
$token_req = array_values(array_filter($requests, fn($r) => $r['url'] === 'https://canvas.example/token'))[0] ?? null;
$score_req = array_values(array_filter($requests, fn($r) => str_contains($r['url'], '/scores')))[0] ?? null;
parse_str((string) ($token_req['body'] ?? ''), $form);
check('lti ags: asks for a token with a client assertion for the score scope',
    ($form['grant_type'] ?? '') === 'client_credentials' && ($form['client_assertion_type'] ?? '') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    && ($form['scope'] ?? '') === 'https://purl.imsglobal.org/spec/lti-ags/scope/score');
[$toolKid, , $toolJwk] = Db::toolKey($pdo);
$assertion = Jwt::verifyRs256($form['client_assertion'] ?? '', ['keys' => [$toolJwk]]);
check('lti ags: the assertion is signed with the tool key and says who, to whom and until when',
    $assertion && $assertion['iss'] === $CLIENT && $assertion['sub'] === $CLIENT && $assertion['aud'] === 'https://canvas.example/token' && $assertion['exp'] > time() && !empty($assertion['jti']));
check('lti ags: the score goes to the line item\'s /scores, query kept',
    ($score_req['url'] ?? '') === 'https://canvas.example/api/lti/courses/1/line_items/5/scores?x=1');
$scoreBody = json_decode($score_req['body'] ?? '', true) ?: [];
check('lti ags: the score has user, points, comment and progress',
    ($scoreBody['userId'] ?? '') === 'user-77' && ($scoreBody['scoreGiven'] ?? null) == 10 && ($scoreBody['scoreMaximum'] ?? null) == 10
    && ($scoreBody['activityProgress'] ?? '') === 'Completed' && ($scoreBody['gradingProgress'] ?? '') === 'FullyGraded'
    && str_contains($scoreBody['comment'] ?? '', 'Excellent.') && preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/', $scoreBody['timestamp'] ?? '') === 1);
check('lti ags: the request is authorised and typed',
    in_array('Authorization: Bearer access-123', $score_req['headers'] ?? [], true) && in_array('Content-Type: application/vnd.ims.lis.v1.score+json', $score_req['headers'] ?? [], true));
$sub = $pdo->query('SELECT * FROM waw_lti_submissions ORDER BY id DESC LIMIT 1')->fetch();
check('lti done: stored with only the values asked for', $sub['score'] == 10 && $sub['passed'] == 1 && json_decode($sub['values_json'], true) === ['B.frequency.number' => 410, 'A.frequency.number' => 400] && $sub['ags_status'] === 'sent');

$out = $lti->submit($token, ['B.frequency.number' => 100, 'A.frequency.number' => 400]);
check('lti done: a bad result is scored too', $out['result']['score'] == 0.0 && $out['result']['passed'] === false);

// When the gradebook refuses, the result stands and its own words say why.
$scoreResponse = ['status' => 403, 'body' => '{"errors":{"type":"forbidden","message":"The tool may not post to this line item"}}'];
$out = $lti->submit($token, ['B.frequency.number' => 410, 'A.frequency.number' => 400]);
check('lti done: a refused score is reported with the platform\'s own message',
    $out['result']['score'] == 10.0 && $out['ags']['sent'] === false && str_contains($out['ags']['status'], '403') && str_contains($out['ags']['status'], 'may not post to this line item') && mb_strlen($out['ags']['status']) <= 180);
$scoreResponse = ['status' => 200, 'body' => '{}'];

// Random targets: the server draws this student's A, and the page cannot choose it.
$withTargets = $assessment + ['targets' => [['key' => 'A.frequency.number', 'ref' => 'A', 'attr' => 'frequency', 'write' => 'number', 'min' => 200, 'max' => 4000, 'scale' => 'log2', 'decimals' => 0]]];
$pdo->prepare('UPDATE waw_lti_assessments SET body = ? WHERE project = ? AND view_id = ?')->execute([json_encode($withTargets), 'filter-task', 'vabc123']);
$drawn = $lti->targets($token);
check('lti targets: one value, within the range, without the range', count($drawn) === 1 && $drawn[0]['ref'] === 'A' && $drawn[0]['value'] >= 200 && $drawn[0]['value'] <= 4000 && !array_key_exists('min', $drawn[0]));
check('lti targets: the same student gets the same target again', $lti->targets($token) === $drawn);
$mine = $drawn[0]['value'];
$out = $lti->submit($token, ['B.frequency.number' => $mine, 'A.frequency.number' => 400]); // the page claims A = 400
check('lti done: the server\'s target counts, not the one the page reports', $out['result']['score'] == 10.0);
$sub = $pdo->query('SELECT * FROM waw_lti_submissions ORDER BY id DESC LIMIT 1')->fetch();
check('lti done: the stored values hold the server\'s target', (json_decode($sub['values_json'], true)['A.frequency.number'] ?? null) == $mine);
$pdo->prepare('UPDATE waw_lti_assessments SET body = ? WHERE project = ? AND view_id = ?')->execute([json_encode($assessment), 'filter-task', 'vabc123']);

// A launch without a gradebook entry still scores, and says nothing was sent.
[, $q5] = begin($lti);
$noAgs = $lti->completeLaunch($sign(array_diff_key(launchClaims($q5['nonce']), ['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint' => 1])), $q5['state']);
$tok2 = Jwt::makeToken(['lid' => $noAgs['launch_id'], 'exp' => time() + 60], 'test-secret');
$requests = [];
$out = $lti->submit($tok2, ['B.frequency.number' => 400, 'A.frequency.number' => 400]);
check('lti done: without a gradebook entry nothing is sent', $out['ags']['sent'] === false && !array_filter($requests, fn($r) => str_contains($r['url'], '/scores')));

check('lti scoresUrl', Lti::scoresUrl('https://x/li/1') === 'https://x/li/1/scores' && Lti::scoresUrl('https://x/li/1/') === 'https://x/li/1/scores' && Lti::scoresUrl('https://x/li/1?a=b') === 'https://x/li/1/scores?a=b');
