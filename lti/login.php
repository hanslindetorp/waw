<?php
// Step 1 of a launch: the platform (Canvas) calls this ("OIDC login initiation").
// It records a state and a nonce and sends the browser back to the platform to
// authenticate. GET or POST.
require __DIR__ . '/lib/bootstrap.php';

waw_guard(function () {
    $params = array_merge($_GET, $_POST);
    $url = waw_lti()->startLogin($params);
    header('Cache-Control: no-store');
    header('Location: ' . $url, true, 302);
});
