<?php
// Step 4: the viewer's Done button posts what the page measured. The score is
// worked out here, stored, and sent to the platform's gradebook. Answers JSON.
require __DIR__ . '/lib/bootstrap.php';

function waw_json(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $config = waw_config();
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && in_array($origin, $config['allowed_origins'] ?? [], true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if ($method !== 'POST') {
        waw_json(405, ['error' => 'POST only.']);
    }
    $raw = file_get_contents('php://input', false, null, 0, 65537);
    if ($raw === false || strlen($raw) > 65536) {
        waw_json(413, ['error' => 'Too much data.']);
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !is_string($data['token'] ?? null)) {
        waw_json(400, ['error' => 'The request is incomplete.']);
    }
    // First the viewer asks what to measure; then it sends the values.
    if (($data['action'] ?? '') === 'reads') {
        waw_json(200, ['reads' => waw_lti()->reads($data['token'])]);
    }
    if (!is_array($data['values'] ?? null)) {
        waw_json(400, ['error' => 'The request is incomplete.']);
    }
    $outcome = waw_lti()->submit($data['token'], $data['values']);
    waw_json(200, $outcome);
} catch (Waw\LtiException $e) {
    waw_json(400, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('WAW LTI done: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    waw_json(500, ['error' => 'The server could not handle the request.']);
}
