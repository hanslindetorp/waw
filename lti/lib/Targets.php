<?php
// The server's copy of js/assessment/targets.js: random targets drawn per
// student. When grades count, the server draws a student's targets itself (from
// a seed that only depends on who the student is and which task it is), so the
// page cannot pick an easy target, and the same student always gets the same one.
// Kept in step with the JavaScript by tests/target-vectors.json
// (scripts/make-target-vectors.mjs writes them from the JavaScript, tests/run.php
// checks this file against them). Change one, change the other, run both.
//
// All the arithmetic of the hash and the generator is exact 32-bit integer
// arithmetic, done here on PHP's 64-bit integers with explicit masks.

namespace Waw;

final class Targets
{
    private const MASK = 0xFFFFFFFF;
    private const MAX_TRIES = 20;

    /** Math.imul for unsigned 32-bit operands: the low 32 bits of the product, without ever leaving the integer range. */
    private static function imul(int $a, int $b): int
    {
        $a &= self::MASK;
        $b &= self::MASK;
        $high = $a >> 16;
        $low = $a & 0xFFFF;
        return (($low * $b) + ((($high * $b) & 0xFFFF) << 16)) & self::MASK;
    }

    private static function hash(string $str): int
    {
        $length = strlen($str);
        $h = (1779033703 ^ $length) & self::MASK;
        for ($i = 0; $i < $length; $i++) {
            $h = self::imul($h ^ ord($str[$i]), 3432918353);
            $h = (($h << 13) | ($h >> 19)) & self::MASK;
        }
        $h = self::imul($h ^ ($h >> 16), 2246822507);
        $h = self::imul($h ^ ($h >> 13), 3266489909);
        return ($h ^ ($h >> 16)) & self::MASK;
    }

    /** @return callable(): float the generator (mulberry32) */
    private static function generator(int $seed): callable
    {
        $a = $seed & self::MASK;
        return static function () use (&$a): float {
            $a = ($a + 0x6D2B79F5) & self::MASK;
            $t = self::imul($a ^ ($a >> 15), 1 | $a);
            $t = (($t + self::imul($t ^ ($t >> 7), 61 | $t)) ^ $t) & self::MASK;
            return (($t ^ ($t >> 14)) & self::MASK) / 4294967296;
        };
    }

    private static function roundTo(float $value, int $decimals): float
    {
        $f = 10 ** $decimals;
        return floor($value * $f + 0.5) / $f;
    }

    /**
     * @param array[] $targets { key, ref, attr, write, min, max, scale, decimals }
     * @return array[] the same, each with its drawn `value`
     */
    public static function draw(array $targets, string $seed): array
    {
        $random = self::generator(self::hash($seed));
        $out = [];
        foreach ($targets as $t) {
            $min = (float) ($t['min'] ?? 0);
            $max = (float) ($t['max'] ?? 0);
            $lo = min($min, $max);
            $hi = max($min, $max);
            $log = ($t['scale'] ?? 'linear') === 'log2' && $lo > 0;
            $hasStart = isset($t['start']) && (is_int($t['start']) || is_float($t['start']));
            $start = $hasStart ? (float) $t['start'] : 0.0;
            $separation = isset($t['separation']) && (is_int($t['separation']) || is_float($t['separation'])) ? (float) $t['separation'] : 0.0;
            $best = 0.0;
            $bestDistance = -1.0;
            for ($i = 0; $i < self::MAX_TRIES; $i++) {
                $u = $random();
                $v = $log ? $lo * pow($hi / $lo, $u) : $lo + $u * ($hi - $lo);
                if (!$hasStart) {
                    $d = INF;
                } elseif ($log && $start > 0) {
                    $d = abs(log($v / $start) / M_LN2);
                } else {
                    $d = abs($v - $start);
                }
                if ($d > $bestDistance) {
                    $best = $v;
                    $bestDistance = $d;
                }
                if ($d >= $separation) {
                    break;
                }
            }
            $decimals = isset($t['decimals']) && is_int($t['decimals']) ? $t['decimals'] : 2;
            $t['value'] = self::roundTo($best, $decimals);
            $out[] = $t;
        }
        return $out;
    }

    /** The seed of a student's targets for a task: the same student on the same assignment always gets the same one. */
    public static function seedFor(array $launch): string
    {
        return hash('sha256', implode('|', [
            (string) ($launch['platform_id'] ?? ''),
            (string) ($launch['user_sub'] ?? ''),
            (string) ($launch['resource_link_id'] ?? ''),
            (string) ($launch['project'] ?? ''),
            (string) ($launch['view_id'] ?? ''),
        ]));
    }
}
