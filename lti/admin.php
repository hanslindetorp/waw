<?php
// The tool's control page: sets up the database, shows the addresses and the
// ready-made Canvas settings, registers learning platforms, loads the
// assessments (the facit — kept here, never in the public project) and shows
// the latest results. Opened as admin.php?key=<admin_key from config.php>;
// every form on it sends the key along. Nothing here is for students.
require __DIR__ . '/lib/bootstrap.php';

$config = waw_config();
$key = (string) ($_GET['key'] ?? $_POST['key'] ?? '');
if ($key === '' || !hash_equals((string) $config['admin_key'], $key)) {
    http_response_code(404);
    exit;
}
header('Cache-Control: no-store');
$pdo = waw_pdo(); // also makes any missing tables
[$kid, , $jwk] = Waw\Db::toolKey($pdo);
$base = rtrim($config['base_url'], '/');
$h = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
$notice = '';

// ── Actions ─────────────────────────────────────────────────────────────
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $action = (string) ($_POST['action'] ?? '');
    try {
        if ($action === 'add_platform') {
            $fields = [];
            foreach (['name', 'issuer', 'client_id', 'deployment_id', 'auth_url', 'token_url', 'jwks_url'] as $f) {
                $fields[$f] = trim((string) ($_POST[$f] ?? ''));
            }
            foreach (['name', 'issuer', 'client_id', 'auth_url', 'token_url', 'jwks_url'] as $f) {
                if ($fields[$f] === '') {
                    throw new RuntimeException("Fill in \"$f\".");
                }
            }
            foreach (['auth_url', 'token_url', 'jwks_url'] as $f) {
                if (!preg_match('#^https://#', $fields[$f])) {
                    throw new RuntimeException("\"$f\" must be an https address.");
                }
            }
            $pdo->prepare('DELETE FROM lti_platforms WHERE issuer = ? AND client_id = ?')->execute([$fields['issuer'], $fields['client_id']]);
            $pdo->prepare('INSERT INTO lti_platforms (name, issuer, client_id, deployment_id, auth_url, token_url, jwks_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$fields['name'], $fields['issuer'], $fields['client_id'], $fields['deployment_id'] ?: null, $fields['auth_url'], $fields['token_url'], $fields['jwks_url']]);
            $notice = 'Platform saved.';
        } elseif ($action === 'delete_platform') {
            $pdo->prepare('DELETE FROM lti_platforms WHERE id = ?')->execute([(int) ($_POST['id'] ?? 0)]);
            $notice = 'Platform removed.';
        } elseif ($action === 'save_assessments') {
            $project = trim((string) ($_POST['project'] ?? ''));
            if (!preg_match('/^[A-Za-z0-9._-]{1,120}$/', $project)) {
                throw new RuntimeException('The project name may hold letters, digits, dots, dashes and underscores only (the zip\'s name without .zip).');
            }
            $data = json_decode((string) ($_POST['json'] ?? ''), true);
            if (!is_array($data) || !is_array($data['assessments'] ?? null)) {
                throw new RuntimeException('That is not an assessment.json (it should hold an "assessments" object).');
            }
            $count = 0;
            foreach ($data['assessments'] as $viewId => $assessment) {
                if (!preg_match('/^[A-Za-z0-9._-]{1,120}$/', (string) $viewId) || !is_array($assessment)) {
                    continue;
                }
                $pdo->prepare('DELETE FROM lti_assessments WHERE project = ? AND view_id = ?')->execute([$project, (string) $viewId]);
                $pdo->prepare('INSERT INTO lti_assessments (project, view_id, body, updated) VALUES (?, ?, ?, ?)')
                    ->execute([$project, (string) $viewId, json_encode($assessment, JSON_UNESCAPED_UNICODE), time()]);
                $count++;
            }
            $notice = "Saved $count view(s) for $project.";
        } elseif ($action === 'delete_assessment') {
            $pdo->prepare('DELETE FROM lti_assessments WHERE project = ? AND view_id = ?')->execute([(string) ($_POST['project'] ?? ''), (string) ($_POST['view_id'] ?? '')]);
            $notice = 'Assessment removed.';
        }
    } catch (Throwable $e) {
        $notice = 'Error: ' . $e->getMessage();
    }
}

$platforms = $pdo->query('SELECT * FROM lti_platforms ORDER BY id')->fetchAll();
$assessments = $pdo->query('SELECT project, view_id, updated FROM lti_assessments ORDER BY project, view_id')->fetchAll();
$submissions = $pdo->query('SELECT project, view_id, user_sub, score, max_score, passed, ags_status, created FROM lti_submissions ORDER BY id DESC LIMIT 30')->fetchAll();

$canvas = [
    'title' => 'WAW — Web Audio Workstation',
    'description' => 'Interactive audio tasks that are assessed on the server.',
    'target_link_uri' => "$base/launch.php",
    'oidc_initiation_url' => "$base/login.php",
    'public_jwk_url' => "$base/jwks.php",
    'redirect_uris' => ["$base/launch.php"],
    'scopes' => [
        'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
        'https://purl.imsglobal.org/spec/lti-ags/scope/score',
    ],
    'extensions' => [[
        'domain' => parse_url($base, PHP_URL_HOST),
        'platform' => 'canvas.instructure.com',
        'privacy_level' => 'anonymous', // "Private" in Canvas's menu: only an opaque user id is sent
        'settings' => ['placements' => [
            ['placement' => 'assignment_selection', 'enabled' => true, 'message_type' => 'LtiResourceLinkRequest'],
            ['placement' => 'link_selection', 'enabled' => true, 'message_type' => 'LtiResourceLinkRequest'],
        ]],
    ]],
];
?>
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAW LTI — control page</title>
<style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 62rem; margin: 1.5rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #ccc; padding-bottom: .2rem; }
    code, pre, textarea, input { font: 13px ui-monospace, Menlo, monospace; }
    pre { background: #f4f4f4; padding: .6rem; overflow: auto; }
    table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid #ddd; padding: .25rem .4rem; text-align: left; font-size: 13px; }
    input[type=text] { width: 100%; box-sizing: border-box; } label { display: block; margin: .4rem 0 .1rem; font-size: 13px; color: #555; }
    textarea { width: 100%; height: 9rem; box-sizing: border-box; }
    .notice { background: #eef6ff; border: 1px solid #9cc4ee; padding: .5rem .7rem; }
    button { padding: .3rem .8rem; }
</style>
<h1>WAW LTI — control page</h1>
<?php if ($notice !== ''): ?><p class="notice"><?= $h($notice) ?></p><?php endif; ?>

<h2>1. Addresses (give these to Canvas)</h2>
<table>
    <tr><th>Login (OIDC initiation)</th><td><code><?= $h("$base/login.php") ?></code></td></tr>
    <tr><th>Launch / redirect</th><td><code><?= $h("$base/launch.php") ?></code></td></tr>
    <tr><th>Public keys (JWKS)</th><td><code><?= $h("$base/jwks.php") ?></code> &nbsp; key id <code><?= $h($kid) ?></code></td></tr>
</table>
<p>Canvas settings to paste into <em>Admin → Developer Keys → + Developer Key → + LTI Key → Method: Paste JSON</em>:</p>
<pre><?= $h(json_encode($canvas, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
<p><em>The placements above are my best reading of Canvas's documentation and have not been tried against a real Canvas yet — if Canvas does not offer the tool where you expect it, that is the line to adjust.</em></p>
<p>A link to a task is <code><?= $h("$base/launch.php") ?>?project=<b>NAME</b>&amp;view=<b>VIEW-ID</b></code>, where NAME is the project zip's name without .zip and VIEW-ID is the view's id (Export → Public pages shows it in the address).</p>

<h2>2. Learning platforms</h2>
<table>
    <tr><th>Name</th><th>Issuer</th><th>Client ID</th><th>Deployment</th><th></th></tr>
    <?php foreach ($platforms as $p): ?>
    <tr>
        <td><?= $h($p['name']) ?></td><td><?= $h($p['issuer']) ?></td><td><?= $h($p['client_id']) ?></td><td><?= $h($p['deployment_id']) ?></td>
        <td><form method="post"><input type="hidden" name="key" value="<?= $h($key) ?>"><input type="hidden" name="action" value="delete_platform"><input type="hidden" name="id" value="<?= (int) $p['id'] ?>"><button>Remove</button></form></td>
    </tr>
    <?php endforeach; ?>
    <?php if (!$platforms): ?><tr><td colspan="5">None yet.</td></tr><?php endif; ?>
</table>
<form method="post">
    <input type="hidden" name="key" value="<?= $h($key) ?>"><input type="hidden" name="action" value="add_platform">
    <label>Name (anything)</label><input type="text" name="name" value="Canvas">
    <label>Issuer (Canvas Cloud: https://canvas.instructure.com)</label><input type="text" name="issuer" value="https://canvas.instructure.com">
    <label>Client ID (the number shown in the Developer Keys list)</label><input type="text" name="client_id">
    <label>Deployment ID (shown when the tool is installed; leave empty to accept any)</label><input type="text" name="deployment_id">
    <label>Authorization URL (Canvas Cloud: https://sso.canvaslms.com/api/lti/authorize_redirect)</label><input type="text" name="auth_url" value="https://sso.canvaslms.com/api/lti/authorize_redirect">
    <label>Token URL (Canvas Cloud: https://sso.canvaslms.com/login/oauth2/token)</label><input type="text" name="token_url" value="https://sso.canvaslms.com/login/oauth2/token">
    <label>Platform keys URL (Canvas Cloud: https://sso.canvaslms.com/api/lti/security/jwks)</label><input type="text" name="jwks_url" value="https://sso.canvaslms.com/api/lti/security/jwks">
    <p><button>Save platform</button></p>
</form>

<h2>3. Assessments (the facit)</h2>
<table>
    <tr><th>Project</th><th>View</th><th>Saved</th><th></th></tr>
    <?php foreach ($assessments as $a): ?>
    <tr>
        <td><?= $h($a['project']) ?></td><td><?= $h($a['view_id']) ?></td><td><?= $h(gmdate('Y-m-d H:i', (int) $a['updated'])) ?> UTC</td>
        <td><form method="post"><input type="hidden" name="key" value="<?= $h($key) ?>"><input type="hidden" name="action" value="delete_assessment"><input type="hidden" name="project" value="<?= $h($a['project']) ?>"><input type="hidden" name="view_id" value="<?= $h($a['view_id']) ?>"><button>Remove</button></form></td>
    </tr>
    <?php endforeach; ?>
    <?php if (!$assessments): ?><tr><td colspan="4">None yet.</td></tr><?php endif; ?>
</table>
<form method="post">
    <input type="hidden" name="key" value="<?= $h($key) ?>"><input type="hidden" name="action" value="save_assessments">
    <label>Project name (the zip's name without .zip)</label><input type="text" name="project">
    <label>The project's assessment.json (paste all of it — every view in it is saved, replacing what was there)</label><textarea name="json"></textarea>
    <p><button>Save assessments</button></p>
</form>

<h2>4. Latest results</h2>
<table>
    <tr><th>When (UTC)</th><th>Project / view</th><th>User</th><th>Score</th><th>Passed</th><th>Gradebook</th></tr>
    <?php foreach ($submissions as $s): ?>
    <tr>
        <td><?= $h(gmdate('Y-m-d H:i', (int) $s['created'])) ?></td><td><?= $h($s['project'] . ' / ' . $s['view_id']) ?></td>
        <td><?= $h(substr($s['user_sub'], 0, 12)) ?>…</td><td><?= $h($s['score'] . ' / ' . $s['max_score']) ?></td>
        <td><?= $s['passed'] ? 'yes' : 'no' ?></td><td><?= $h($s['ags_status']) ?></td>
    </tr>
    <?php endforeach; ?>
    <?php if (!$submissions): ?><tr><td colspan="6">None yet.</td></tr><?php endif; ?>
</table>
