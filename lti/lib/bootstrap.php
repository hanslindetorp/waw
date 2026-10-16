<?php
// Shared start-up for the endpoints: the classes, the configuration, the
// database, and one way of answering with an error page.

// Errors go to the server's log, never into the page: a notice printed before a
// redirect would break it, and a message could say more than a visitor should see.
ini_set('display_errors', '0');
error_reporting(E_ALL);

foreach (['Evaluate', 'Jwt', 'Http', 'Db', 'Lti'] as $file) {
    require_once __DIR__ . '/' . $file . '.php';
}

function waw_config(): array
{
    static $config = null;
    if ($config === null) {
        // config.php next to the endpoints; WAW_CONFIG can point elsewhere (the tests use it).
        $file = getenv('WAW_CONFIG') ?: __DIR__ . '/../config.php';
        if (!is_file($file)) {
            waw_page(500, 'Not set up yet', 'Copy config.sample.php to config.php and fill it in.');
        }
        $config = require $file;
    }
    return $config;
}

function waw_pdo(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $pdo = Waw\Db::connect(waw_config());
        Waw\Db::migrate($pdo);
    }
    return $pdo;
}

function waw_lti(?callable $http = null): Waw\Lti
{
    return new Waw\Lti(waw_pdo(), waw_config(), $http);
}

/** A plain page with a status code, then the end of the request. */
function waw_page(int $status, string $title, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $m = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        . "<title>$t</title><body style=\"font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222\">"
        . "<h1 style=\"font-size:1.2rem\">$t</h1><p>$m</p></body>";
    exit;
}

/** Runs an endpoint: what the tool is allowed to say goes to the user, anything else is logged. */
function waw_guard(callable $run): void
{
    try {
        $run();
    } catch (Waw\LtiException $e) {
        waw_page(400, 'Could not open the task', $e->getMessage());
    } catch (Throwable $e) {
        error_log('WAW LTI: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
        waw_page(500, 'Something went wrong', 'The server could not handle the request. Try again, or tell your teacher.');
    }
}
