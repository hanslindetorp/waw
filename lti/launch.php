<?php
// Step 2: the platform posts the signed launch here. It is checked, recorded,
// and the browser is sent on to the viewer with a short token.
require __DIR__ . '/lib/bootstrap.php';

waw_guard(function () {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        waw_page(405, 'Open this from your course', 'This address is opened by the learning platform, not directly.');
    }
    if (!empty($_POST['error'])) {
        waw_page(400, 'The platform refused the launch', (string) ($_POST['error_description'] ?? $_POST['error']));
    }
    $lti = waw_lti();
    $launch = $lti->completeLaunch((string) ($_POST['id_token'] ?? ''), (string) ($_POST['state'] ?? ''));
    header('Cache-Control: no-store');
    header('Location: ' . $lti->viewerUrl($launch['launch_id'], $launch['project'], $launch['view']), true, 302);
});
