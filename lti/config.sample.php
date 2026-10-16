<?php
// Copy this file to config.php (next to it) and fill it in. config.php is never
// committed. It returns an array and prints nothing, so it is harmless even if
// someone requests it from the web.
return [
    // The database made at one.com (Control Panel -> Databases). For tests: 'sqlite:/path/to/test.sqlite'.
    'db' => [
        'dsn' => 'mysql:host=DATABASE_HOST;dbname=DATABASE_NAME;charset=utf8mb4',
        'user' => 'DATABASE_USER',
        'pass' => 'DATABASE_PASSWORD',
    ],

    // Where this folder is served from (no trailing slash).
    'base_url' => 'https://waxml.org/lti',

    // The page a student is sent to after a launch (the viewer), and the
    // folder beside it that holds the project zips.
    'viewer_url' => 'https://workstation.waxml.org/viewer.html',
    'project_dir' => 'public',

    // Pages that may call done.php from the browser.
    'allowed_origins' => ['https://workstation.waxml.org', 'https://hanslindetorp.github.io'],

    // Two long random strings (e.g. from https://www.random.org/strings/ or `openssl rand -hex 32`).
    // token_secret signs the short tokens given to the viewer; admin_key opens admin.php.
    'token_secret' => 'CHANGE-ME-TO-A-LONG-RANDOM-STRING',
    'admin_key' => 'CHANGE-ME-TO-ANOTHER-LONG-RANDOM-STRING',
];
