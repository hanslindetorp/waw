<?php
// Tests for the server side — run with:  php lti/tests/run.php
// (no framework: each check prints a line, the exit code is 1 if any failed).

require __DIR__ . '/../lib/Evaluate.php';

use Waw\Evaluate;

$failures = 0;
$checks = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures, $checks;
    $checks++;
    if (!$ok) {
        $failures++;
        echo "FAIL  $name" . ($detail !== '' ? "  — $detail" : '') . "\n";
    }
}

function same($expected, $actual, string $path, array &$problems): void
{
    if (is_array($expected)) {
        if (!is_array($actual)) {
            $problems[] = "$path: expected an array";
            return;
        }
        foreach ($expected as $key => $value) {
            same($value, $actual[$key] ?? null, "$path.$key", $problems);
        }
        return;
    }
    if (is_float($expected) || is_int($expected)) {
        if (!is_numeric($actual) || abs((float) $expected - (float) $actual) > 1e-9) {
            $problems[] = "$path: expected " . json_encode($expected) . ", got " . json_encode($actual);
        }
        return;
    }
    if ($expected !== $actual) {
        $problems[] = "$path: expected " . json_encode($expected) . ", got " . json_encode($actual);
    }
}

// ── The evaluator against the JavaScript's own results ─────────────────
$cases = json_decode(file_get_contents(__DIR__ . '/assessment-vectors.json'), true);
check('vectors file is readable', is_array($cases) && count($cases) > 0);
foreach ($cases as $case) {
    $result = Evaluate::evaluate($case['assessment'], $case['values']);
    $problems = [];
    same($case['expected'], $result, 'result', $problems);
    check('evaluate: ' . $case['name'], !$problems, implode('; ', array_slice($problems, 0, 3)));
}

// Library tests (JWT, LTI) are added below as those files are written.
foreach (glob(__DIR__ . '/test-*.php') as $file) {
    require $file;
}

echo ($failures ? "\n$failures of $checks checks FAILED\n" : "$checks checks passed\n");
exit($failures ? 1 : 0);
