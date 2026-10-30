<?php
// The random targets (lib/Targets.php) against the JavaScript's own draws.
require_once __DIR__ . '/../lib/Targets.php';

use Waw\Targets;

$file = json_decode(file_get_contents(__DIR__ . '/target-vectors.json'), true);
check('target vectors file is readable', is_array($file) && count($file['vectors'] ?? []) > 0);
foreach ($file['vectors'] ?? [] as $vector) {
    $drawn = Targets::draw($vector['targets'], $vector['seed']);
    $problems = [];
    foreach ($vector['expected'] as $i => $want) {
        $got = $drawn[$i] ?? null;
        if (!$got || $got['key'] !== $want['key'] || abs($got['value'] - $want['value']) > 1e-9) {
            $problems[] = $want['key'] . ': expected ' . json_encode($want['value']) . ', got ' . json_encode($got['value'] ?? null);
        }
    }
    check('targets: seed "' . substr($vector['seed'], 0, 24) . '"', !$problems, implode('; ', array_slice($problems, 0, 3)));
}

// The same student and task always give the same seed; another student a different one.
$launch = ['platform_id' => 1, 'user_sub' => 'u1', 'resource_link_id' => 'r1', 'project' => 'p', 'view_id' => 'v'];
check('seed is stable', Targets::seedFor($launch) === Targets::seedFor($launch));
check('seed depends on the student', Targets::seedFor($launch) !== Targets::seedFor(['user_sub' => 'u2'] + $launch));
check('seed depends on the assignment', Targets::seedFor($launch) !== Targets::seedFor(['resource_link_id' => 'r2'] + $launch));
check('seed is plain ASCII', (bool) preg_match('/^[0-9a-f]{64}$/', Targets::seedFor($launch)));
