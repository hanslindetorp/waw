<?php
// LTI 1.3 for WAW, from the tool's side: the login that starts a launch, the
// check of what the platform (Canvas) sends back, the hand-over to the viewer,
// and — when the user presses Done — the score back to the gradebook.
//
// The flow:
//   1. Canvas calls login.php            -> startLogin()      sends the browser back to Canvas
//   2. Canvas POSTs to launch.php        -> completeLaunch()  checks the signed id_token, records the launch
//   3. launch.php redirects to the viewer with a short token (viewerUrl())
//   4. The viewer's Done calls done.php  -> submit()          evaluates on the server, stores, posts the score
//
// What a launch has to prove: it carries an id_token signed with a key that
// the platform's own JWKS lists, for this tool (aud), from this platform
// (iss), not expired, with the nonce that this tool made when the login
// started, for a resource link request of version 1.3.0. The state that ties a
// launch to its login is single-use and short-lived. It is not tied to the
// browser by a cookie — cookies are unreliable in an iframe — so a launch
// can in principle be steered into another user's browser; what that gets an
// attacker is that user's page, under the attacker's own identity.

namespace Waw;

final class Lti
{
    private const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
    private const AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
    private const SCOPE_SCORE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
    private const STATE_TTL = 600;
    private const JWKS_TTL = 3600;
    private const TOKEN_TTL = 14400; // a viewer token is good for four hours
    private const SKEW = 60;

    /** @var callable */
    private $http;

    public function __construct(private \PDO $pdo, private array $config, ?callable $http = null)
    {
        $this->http = $http ?? [Http::class, 'request'];
    }

    // ── 1. Login ─────────────────────────────────────────────────────────
    public function platformFor(string $issuer, ?string $clientId): ?array
    {
        if ($clientId !== null && $clientId !== '') {
            $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_platforms WHERE issuer = ? AND client_id = ?');
            $stmt->execute([$issuer, $clientId]);
        } else {
            $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_platforms WHERE issuer = ? LIMIT 1');
            $stmt->execute([$issuer]);
        }
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** The address to send the browser to for the platform's authentication step. */
    public function startLogin(array $params): string
    {
        $issuer = (string) ($params['iss'] ?? '');
        $loginHint = (string) ($params['login_hint'] ?? '');
        if ($issuer === '' || $loginHint === '') {
            throw new LtiException('The login request is incomplete.');
        }
        $platform = $this->platformFor($issuer, $params['client_id'] ?? null);
        if (!$platform) {
            // Says what arrived, to make a mismatch with the registration easy to see
            // (an address and a number the platform itself sent; nothing secret).
            $clientId = (string) ($params['client_id'] ?? '');
            throw new LtiException(
                'This learning platform is not registered with this tool. It said: issuer "' . mb_substr($issuer, 0, 120) . '"'
                . ($clientId !== '' ? ', client id "' . mb_substr($clientId, 0, 60) . '"' : ', no client id')
                . '. Compare with the platform on the control page (section 2).'
            );
        }
        $this->purgeStates();
        $state = bin2hex(random_bytes(24));
        $nonce = bin2hex(random_bytes(24));
        $stmt = $this->pdo->prepare('INSERT INTO waw_lti_states (state, nonce, platform_id, target_link_uri, created) VALUES (?, ?, ?, ?, ?)');
        $stmt->execute([$state, $nonce, $platform['id'], (string) ($params['target_link_uri'] ?? ''), time()]);
        $query = [
            'scope' => 'openid',
            'response_type' => 'id_token',
            'client_id' => $platform['client_id'],
            'redirect_uri' => $this->launchUrl(),
            'login_hint' => $loginHint,
            'state' => $state,
            'response_mode' => 'form_post',
            'nonce' => $nonce,
            'prompt' => 'none',
        ];
        if (!empty($params['lti_message_hint'])) {
            $query['lti_message_hint'] = (string) $params['lti_message_hint'];
        }
        $sep = str_contains($platform['auth_url'], '?') ? '&' : '?';
        return $platform['auth_url'] . $sep . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }

    public function launchUrl(): string
    {
        return rtrim($this->config['base_url'], '/') . '/launch.php';
    }

    private function purgeStates(): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM waw_lti_states WHERE created < ?');
        $stmt->execute([time() - self::STATE_TTL]);
    }

    // ── 2. Launch ────────────────────────────────────────────────────────
    /** @return array{launch_id: int, project: string, view: string} */
    public function completeLaunch(string $idToken, string $state): array
    {
        if ($idToken === '' || $state === '') {
            throw new LtiException('The launch is incomplete.');
        }
        $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_states WHERE state = ?');
        $stmt->execute([$state]);
        $login = $stmt->fetch();
        // Single use: gone whatever happens next.
        $this->pdo->prepare('DELETE FROM waw_lti_states WHERE state = ?')->execute([$state]);
        if (!$login || $login['created'] < time() - self::STATE_TTL) {
            throw new LtiException('This launch has expired or was already used. Open it again from the course.');
        }
        $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_platforms WHERE id = ?');
        $stmt->execute([$login['platform_id']]);
        $platform = $stmt->fetch();
        if (!$platform) {
            throw new LtiException('The learning platform is no longer registered.');
        }

        $claims = $this->verifiedClaims($idToken, $platform);
        $this->checkClaims($claims, $platform, $login['nonce']);

        [$project, $view] = $this->projectAndView($claims, (string) $login['target_link_uri']);
        $ags = $claims[self::AGS] ?? [];
        $stmt = $this->pdo->prepare(
            'INSERT INTO waw_lti_launches (platform_id, user_sub, context_id, resource_link_id, lineitem, scopes, roles, project, view_id, created)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $platform['id'],
            (string) $claims['sub'],
            isset($claims[self::CLAIM . 'context']['id']) ? (string) $claims[self::CLAIM . 'context']['id'] : null,
            (string) $claims[self::CLAIM . 'resource_link']['id'],
            isset($ags['lineitem']) ? (string) $ags['lineitem'] : null,
            json_encode(is_array($ags['scope'] ?? null) ? $ags['scope'] : []),
            json_encode($claims[self::CLAIM . 'roles'] ?? []),
            $project,
            $view,
            time(),
        ]);
        return ['launch_id' => (int) $this->pdo->lastInsertId(), 'project' => $project, 'view' => $view];
    }

    /** The token's claims, once its signature is proven by the platform's keys. */
    private function verifiedClaims(string $idToken, array $platform): array
    {
        $kid = Jwt::keyId($idToken);
        $jwks = $this->jwks($platform, false);
        $claims = Jwt::verifyRs256($idToken, $jwks);
        if ($claims === null) {
            // A key rotated since the keys were cached: fetch them again, once.
            $jwks = $this->jwks($platform, true);
            $claims = Jwt::verifyRs256($idToken, $jwks);
        }
        if ($claims === null) {
            throw new LtiException('The launch could not be verified (signature' . ($kid ? ", key $kid" : '') . ').');
        }
        return $claims;
    }

    private function checkClaims(array $c, array $platform, string $nonce): void
    {
        $now = time();
        if (($c['iss'] ?? null) !== $platform['issuer']) {
            throw new LtiException('The launch comes from another platform than the one it claims.');
        }
        $aud = $c['aud'] ?? null;
        $auds = is_array($aud) ? $aud : [$aud];
        if (!in_array($platform['client_id'], $auds, true)) {
            throw new LtiException('The launch is not meant for this tool.');
        }
        if (count($auds) > 1 && ($c['azp'] ?? null) !== $platform['client_id']) {
            throw new LtiException('The launch is not meant for this tool.');
        }
        if (!isset($c['exp']) || $c['exp'] < $now - self::SKEW) {
            throw new LtiException('The launch has expired.');
        }
        if (isset($c['iat']) && $c['iat'] > $now + self::SKEW) {
            throw new LtiException('The launch is dated in the future (check the server clock).');
        }
        if (!isset($c['nonce']) || !hash_equals($nonce, (string) $c['nonce'])) {
            throw new LtiException('The launch does not belong to the login that started it.');
        }
        $deployment = $c[self::CLAIM . 'deployment_id'] ?? '';
        if ($deployment === '' || ($platform['deployment_id'] !== null && $platform['deployment_id'] !== '' && $platform['deployment_id'] !== $deployment)) {
            throw new LtiException('The launch is for another deployment of this tool.');
        }
        if (($c[self::CLAIM . 'message_type'] ?? '') !== 'LtiResourceLinkRequest') {
            throw new LtiException('This tool handles resource link launches only.');
        }
        if (($c[self::CLAIM . 'version'] ?? '') !== '1.3.0') {
            throw new LtiException('This tool handles LTI 1.3 only.');
        }
        if (empty($c['sub'])) {
            throw new LtiException('The launch does not say who the user is.');
        }
        if (empty($c[self::CLAIM . 'resource_link']['id'])) {
            throw new LtiException('The launch does not say which link was opened.');
        }
    }

    /**
     * Which project and view the link is for: custom parameters if the platform
     * sends them, else the query of the link's own address (what a teacher puts
     * in the assignment: .../launch.php?project=NAME&view=ID).
     * @return array{0: string, 1: string}
     */
    private function projectAndView(array $claims, string $loginTarget): array
    {
        $custom = $claims[self::CLAIM . 'custom'] ?? [];
        $project = is_array($custom) ? ($custom['project'] ?? null) : null;
        $view = is_array($custom) ? ($custom['view'] ?? null) : null;
        if (!$project || !$view) {
            $target = (string) ($claims[self::CLAIM . 'target_link_uri'] ?? $loginTarget);
            parse_str((string) parse_url($target, PHP_URL_QUERY), $query);
            $project = $project ?: ($query['project'] ?? null);
            $view = $view ?: ($query['view'] ?? null);
        }
        $ok = fn($v) => is_string($v) && preg_match('/^[A-Za-z0-9._-]{1,120}$/', $v) === 1;
        if (!$ok($project) || !$ok($view)) {
            throw new LtiException('The link does not say which project and view to open (project=... and view=... in its address).');
        }
        return [$project, $view];
    }

    // ── The platform's keys ──────────────────────────────────────────────
    public function jwks(array $platform, bool $force): array
    {
        $stmt = $this->pdo->prepare('SELECT body, fetched FROM waw_lti_jwks_cache WHERE platform_id = ?');
        $stmt->execute([$platform['id']]);
        $cached = $stmt->fetch();
        if ($cached && !$force && $cached['fetched'] > time() - self::JWKS_TTL) {
            $keys = json_decode($cached['body'], true);
            if (is_array($keys)) {
                return $keys;
            }
        }
        $response = ($this->http)('GET', $platform['jwks_url'], ['Accept: application/json'], null);
        $keys = json_decode($response['body'], true);
        if ($response['status'] !== 200 || !is_array($keys) || !is_array($keys['keys'] ?? null)) {
            if ($cached && ($decoded = json_decode($cached['body'], true)) && is_array($decoded)) {
                return $decoded; // better the last known keys than none
            }
            throw new LtiException("The platform's public keys could not be fetched.");
        }
        $this->pdo->prepare('DELETE FROM waw_lti_jwks_cache WHERE platform_id = ?')->execute([$platform['id']]);
        $this->pdo->prepare('INSERT INTO waw_lti_jwks_cache (platform_id, body, fetched) VALUES (?, ?, ?)')->execute([$platform['id'], $response['body'], time()]);
        return $keys;
    }

    // ── 3. Hand-over to the viewer ───────────────────────────────────────
    public function viewerUrl(int $launchId, string $project, string $view): string
    {
        $token = Jwt::makeToken(['lid' => $launchId, 'exp' => time() + self::TOKEN_TTL], $this->config['token_secret']);
        $projectPath = trim($this->config['project_dir'] ?? 'public', '/') . '/' . $project . '.zip';
        $query = http_build_query(['project' => $projectPath, 'view' => $view, 'lti' => $token, 'api' => rtrim($this->config['base_url'], '/') . '/done.php'], '', '&', PHP_QUERY_RFC3986);
        return $this->config['viewer_url'] . '?' . $query;
    }

    // ── 4. Done ──────────────────────────────────────────────────────────
    /** The launch a viewer token stands for, with its view's assessment. */
    private function launchAndAssessment(string $token): array
    {
        $payload = Jwt::readToken($token, $this->config['token_secret']);
        if (!$payload) {
            throw new LtiException('This session has expired. Open the task again from the course.');
        }
        $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_launches WHERE id = ?');
        $stmt->execute([(int) $payload['lid']]);
        $launch = $stmt->fetch();
        if (!$launch) {
            throw new LtiException('This session is not known.');
        }
        $stmt = $this->pdo->prepare('SELECT body FROM waw_lti_assessments WHERE project = ? AND view_id = ?');
        $stmt->execute([$launch['project'], $launch['view_id']]);
        $row = $stmt->fetch();
        $assessment = $row ? json_decode($row['body'], true) : null;
        if (!is_array($assessment)) {
            throw new LtiException('This view has no assessment on the server.');
        }
        return [$launch, $assessment];
    }

    /**
     * What the page has to measure for this view — the values the criteria read,
     * and nothing of how they are judged (the viewer is given no facit).
     * @return array[] [{ ref, attr, as }]
     */
    public function reads(string $token): array
    {
        [, $assessment] = $this->launchAndAssessment($token);
        return array_values(Evaluate::requiredReads($assessment));
    }

    /**
     * The values this student's task is set to, where the task draws random
     * targets (its assessment lists `targets`): the same ones every time this
     * student opens this assignment. The page writes them into the project before
     * it lets the student start; the ranges they were drawn from stay here.
     * @return array[] [{ ref, attr, write, value }]
     */
    public function targets(string $token): array
    {
        [$launch, $assessment] = $this->launchAndAssessment($token);
        $out = [];
        foreach (self::drawnTargets($launch, $assessment) as $t) {
            $out[] = ['ref' => $t['ref'], 'attr' => $t['attr'], 'write' => $t['write'] ?? 'number', 'value' => $t['value']];
        }
        return $out;
    }

    /** @return array[] the assessment's targets with this student's drawn values */
    private static function drawnTargets(array $launch, array $assessment): array
    {
        $targets = array_values(array_filter(is_array($assessment['targets'] ?? null) ? $assessment['targets'] : [], static fn ($t) => is_array($t) && isset($t['key'], $t['ref'], $t['attr'], $t['min'], $t['max'])));
        return $targets ? Targets::draw($targets, Targets::seedFor($launch)) : [];
    }

    /**
     * The viewer's Done: evaluates the values it measured against the view's
     * assessment, stores the outcome and sends the score on to the gradebook.
     * @return array{result: array, ags: array}
     */
    public function submit(string $token, array $values): array
    {
        [$launch, $assessment] = $this->launchAndAssessment($token);
        // Only the values the assessment asks for, and only numbers.
        $clean = [];
        foreach (array_keys(Evaluate::requiredReads($assessment)) as $key) {
            $v = $values[$key] ?? null;
            $clean[$key] = (is_int($v) || is_float($v)) && is_finite((float) $v) ? $v : null;
        }
        // What the targets are is the server's to say, whatever the page measured.
        foreach (self::drawnTargets($launch, $assessment) as $t) {
            if (array_key_exists($t['key'], $clean)) {
                $clean[$t['key']] = $t['value'];
            }
        }
        $result = Evaluate::evaluate($assessment, $clean);
        $result['hasPass'] = is_int($assessment['pass'] ?? null) || is_float($assessment['pass'] ?? null); // for the page: does a pass level exist?
        $ags = $this->sendScore($launch, $result);
        $stmt = $this->pdo->prepare(
            'INSERT INTO waw_lti_submissions (launch_id, user_sub, project, view_id, values_json, score, max_score, passed, feedback, ags_status, created)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $launch['id'], $launch['user_sub'], $launch['project'], $launch['view_id'], json_encode($clean),
            $result['score'], $result['max'], $result['passed'] ? 1 : 0, $result['feedback'], $ags['status'], time(),
        ]);
        return ['result' => $result, 'ags' => $ags];
    }

    /** The score to the gradebook (Assignment and Grade Services), if the launch allows it. */
    private function sendScore(array $launch, array $result): array
    {
        $scopes = json_decode((string) $launch['scopes'], true) ?: [];
        if (empty($launch['lineitem']) || !in_array(self::SCOPE_SCORE, $scopes, true)) {
            return ['sent' => false, 'status' => 'not sent: this launch has no gradebook entry'];
        }
        $stmt = $this->pdo->prepare('SELECT * FROM waw_lti_platforms WHERE id = ?');
        $stmt->execute([$launch['platform_id']]);
        $platform = $stmt->fetch();
        if (!$platform) {
            return ['sent' => false, 'status' => 'not sent: unknown platform'];
        }
        try {
            $accessToken = $this->accessToken($platform, self::SCOPE_SCORE);
        } catch (LtiException $e) {
            return ['sent' => false, 'status' => 'not sent: ' . $e->getMessage()];
        }
        $body = json_encode([
            'userId' => $launch['user_sub'],
            'scoreGiven' => $result['score'],
            'scoreMaximum' => $result['max'],
            'comment' => mb_substr($result['feedback'], 0, 1000),
            'activityProgress' => 'Completed',
            'gradingProgress' => 'FullyGraded',
            'timestamp' => (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.vP'),
        ], JSON_UNESCAPED_UNICODE);
        $response = ($this->http)('POST', self::scoresUrl($launch['lineitem']), [
            'Authorization: Bearer ' . $accessToken,
            'Content-Type: application/vnd.ims.lis.v1.score+json',
            'Accept: application/json',
        ], $body);
        $ok = $response['status'] >= 200 && $response['status'] < 300;
        return ['sent' => $ok, 'status' => $ok ? 'sent' : self::refusal('the gradebook answered ' . $response['status'], $response['body'])];
    }

    /**
     * A refusal from the platform as one short line: what we did, and what the platform
     * said about it (its own error text — nothing of ours — cut to fit the status column).
     */
    private static function refusal(string $what, string $body): string
    {
        $said = trim(preg_replace('/\s+/', ' ', strip_tags($body)));
        return mb_substr($said === '' ? $what : "$what: $said", 0, 180);
    }

    /** The line item's /scores address (any query string stays at the end). */
    public static function scoresUrl(string $lineitem): string
    {
        $parts = explode('?', $lineitem, 2);
        return rtrim($parts[0], '/') . '/scores' . (isset($parts[1]) ? '?' . $parts[1] : '');
    }

    /** An access token for the score service: a signed client assertion, traded for a bearer token. */
    private function accessToken(array $platform, string $scope): string
    {
        [$kid, $pem] = Db::toolKey($this->pdo);
        $now = time();
        $assertion = Jwt::signRs256([
            'iss' => $platform['client_id'],
            'sub' => $platform['client_id'],
            'aud' => $platform['token_url'],
            'iat' => $now,
            'exp' => $now + 60,
            'jti' => bin2hex(random_bytes(16)),
        ], $pem, $kid);
        $response = ($this->http)('POST', $platform['token_url'], ['Content-Type: application/x-www-form-urlencoded', 'Accept: application/json'], http_build_query([
            'grant_type' => 'client_credentials',
            'client_assertion_type' => 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            'client_assertion' => $assertion,
            'scope' => $scope,
        ], '', '&', PHP_QUERY_RFC3986));
        $data = json_decode($response['body'], true);
        if ($response['status'] !== 200 || !is_array($data) || empty($data['access_token'])) {
            throw new LtiException(self::refusal('the platform did not give an access token (' . $response['status'] . ')', $response['body']));
        }
        return (string) $data['access_token'];
    }
}

/** A problem that is safe to show the user (it never contains anything secret). */
final class LtiException extends \RuntimeException
{
}
