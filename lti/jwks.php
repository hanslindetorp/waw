<?php
// This tool's public key, which the platform uses to check the tool's requests
// (the score). Canvas is told this address when the tool is registered.
require __DIR__ . '/lib/bootstrap.php';

waw_guard(function () {
    [, , $jwk] = Waw\Db::toolKey(waw_pdo());
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Cache-Control: public, max-age=300');
    echo json_encode(['keys' => [$jwk]], JSON_UNESCAPED_SLASHES);
});
