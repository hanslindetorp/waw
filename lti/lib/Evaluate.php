<?php
// The server's copy of js/assessment/evaluate.js — the same model, the same
// numbers. When grades count, the score must be worked out here, from the
// values the page measured, and not taken from the browser. The two files are
// kept in step by tests/assessment-vectors.json: scripts/make-assessment-vectors.mjs
// writes the expected results from the JavaScript, tests/run.php checks this
// file against them. Change one, change the other, run both.
//
// An assessment: { max, pass, reveal, criteria: [...], bands: [...] } — see the
// JavaScript file for what each field means.

namespace Waw;

final class Evaluate
{
    private const TYPES = ['match', 'target', 'range', 'relation', 'spread'];
    private const REVEAL = ['score', 'distance', 'direction'];

    private static function isNum($x): bool
    {
        return (is_int($x) || is_float($x)) && is_finite((float) $x);
    }

    public static function readKey(array $read): string
    {
        return ($read['ref'] ?? '') . '.' . ($read['attr'] ?? '') . '.' . ((($read['as'] ?? null) === 'db') ? 'db' : 'number');
    }

    /** @return array[] the reads a criterion needs */
    private static function criterionReads(array $c): array
    {
        switch ($c['type'] ?? '') {
            case 'target':
            case 'range':
                return [$c['a'] ?? null];
            case 'match':
            case 'relation':
                return [$c['a'] ?? null, $c['b'] ?? null];
            case 'spread':
                return is_array($c['of'] ?? null) ? $c['of'] : [];
        }
        return [];
    }

    /** Every distinct read the assessment needs, keyed by readKey(). */
    public static function requiredReads(array $assessment): array
    {
        $seen = [];
        foreach (($assessment['criteria'] ?? []) as $c) {
            foreach (self::criterionReads($c) as $r) {
                if (is_array($r) && !empty($r['ref']) && !empty($r['attr'])) {
                    $seen[self::readKey($r)] = $r;
                }
            }
        }
        return $seen;
    }

    private static function scaled($scale, $x): float
    {
        if (!self::isNum($x)) {
            return NAN;
        }
        if ($scale === 'log2') {
            return $x > 0 ? log((float) $x, 2) : NAN;
        }
        return (float) $x;
    }

    private static function scoreFor(float $deviation, float $full, float $zero): float
    {
        if ($deviation <= $full) {
            return 1.0;
        }
        if ($zero <= $full || $deviation >= $zero) {
            return 0.0;
        }
        return 1 - ($deviation - $full) / ($zero - $full);
    }

    /** @return array{deviation: float, signed: ?float}|null */
    private static function measure(array $c, array $values): ?array
    {
        $get = function ($read) use ($values) {
            if (!is_array($read) || empty($read['ref'])) {
                return null;
            }
            return $values[self::readKey($read)] ?? null;
        };
        $scale = $c['scale'] ?? null;
        $s = fn($read) => self::scaled($scale, $get($read));
        $num = fn($x) => self::isNum($x) ? (float) $x : NAN;
        $signed = null;
        switch ($c['type'] ?? '') {
            case 'target':
                $signed = $s($c['a'] ?? null) - self::scaled($scale, $num($c['target'] ?? null));
                $deviation = abs($signed);
                break;
            case 'match':
                $signed = $s($c['a'] ?? null) - $s($c['b'] ?? null);
                $deviation = abs($signed);
                break;
            case 'relation':
                $signed = $s($c['a'] ?? null) - $s($c['b'] ?? null) - $num($c['target'] ?? null);
                $deviation = abs($signed);
                break;
            case 'range':
                $v = $s($c['a'] ?? null);
                $lo = self::scaled($scale, $num($c['min'] ?? null));
                $hi = self::scaled($scale, $num($c['max'] ?? null));
                $signed = $v < $lo ? $v - $lo : ($v > $hi ? $v - $hi : 0.0);
                $deviation = abs($signed);
                break;
            case 'spread':
                $list = array_map($s, is_array($c['of'] ?? null) ? $c['of'] : []);
                if (count($list) < 2) {
                    return null;
                }
                foreach ($list as $x) {
                    if (is_nan($x)) {
                        return null;
                    }
                }
                $deviation = max($list) - min($list);
                break;
            default:
                return null;
        }
        if (!is_finite($deviation)) {
            return null;
        }
        return ['deviation' => $deviation, 'signed' => is_finite((float) $signed) ? (float) $signed : null];
    }

    private static function describe(array $c, ?array $m, float $score, string $reveal): ?string
    {
        $name = self::label($c);
        if ($reveal === 'score') {
            return null;
        }
        $quality = $score >= 0.9 ? 'spot on' : ($score >= 0.5 ? 'close' : 'far off');
        $text = "$name: $quality";
        if ($reveal === 'direction' && $m && $m['signed'] !== null && $m['signed'] != 0.0 && $score < 0.9
            && in_array($c['type'] ?? '', ['range', 'target', 'match', 'relation'], true)) {
            $text .= $m['signed'] > 0 ? ' — too high' : ' — too low';
        }
        return $text . '.';
    }

    private static function label(array $c, ?string $fallback = null): string
    {
        if (!empty($c['label'])) {
            return (string) $c['label'];
        }
        if (!empty($c['id'])) {
            return (string) $c['id'];
        }
        return $fallback ?? (string) ($c['type'] ?? '');
    }

    private static function bandText($bands, float $share): string
    {
        $list = [];
        foreach (is_array($bands) ? $bands : [] as $b) {
            if (is_array($b) && self::isNum($b['min'] ?? null) && !empty($b['text'])) {
                $list[] = $b;
            }
        }
        usort($list, fn($a, $b) => $b['min'] <=> $a['min']);
        foreach ($list as $b) {
            if ($share >= $b['min']) {
                return (string) $b['text'];
            }
        }
        return '';
    }

    /**
     * @param array $assessment as in assessment.json
     * @param array $values     readKey() => number|null
     * @return array{total: float, score: float, max: float, passed: bool, comment: string, feedback: string, criteria: array}
     */
    public static function evaluate(array $assessment, array $values): array
    {
        $max = (self::isNum($assessment['max'] ?? null) && $assessment['max'] > 0) ? (float) $assessment['max'] : 10.0;
        $reveal = in_array($assessment['reveal'] ?? null, self::REVEAL, true) ? $assessment['reveal'] : 'distance';
        $criteria = [];
        foreach (($assessment['criteria'] ?? []) as $i => $c) {
            $weight = (self::isNum($c['weight'] ?? null) && $c['weight'] > 0) ? (float) $c['weight'] : 1.0;
            $m = self::measure($c, $values);
            $full = self::isNum($c['full'] ?? null) ? (float) $c['full'] : 0.0;
            $zero = self::isNum($c['zero'] ?? null) ? (float) $c['zero'] : INF;
            $score = $m ? self::scoreFor($m['deviation'], $full, $zero) : 0.0;
            $criteria[] = [
                'id' => !empty($c['id']) ? (string) $c['id'] : 'c' . ($i + 1),
                'label' => self::label($c, 'Criterion ' . ($i + 1)),
                'weight' => $weight,
                'score' => $score,
                'missing' => !$m,
                'text' => $m ? self::describe($c, $m, $score, $reveal)
                             : (self::label($c, 'A value') . ' could not be measured.'),
            ];
        }
        $weightSum = array_sum(array_column($criteria, 'weight'));
        if ($criteria && $weightSum > 0) {
            $total = 0.0;
            foreach ($criteria as $c) {
                $total += $c['score'] * $c['weight'];
            }
            $total /= $weightSum;
        } else {
            $total = 1.0;
        }
        $passed = self::isNum($assessment['pass'] ?? null) ? $total >= $assessment['pass'] : true;
        $comment = self::bandText($assessment['bands'] ?? null, $total);
        $texts = array_values(array_filter(array_merge([$comment], array_column($criteria, 'text')), fn($t) => $t !== null && $t !== ''));
        return [
            'total' => $total,
            'score' => round($total * $max * 10) / 10,
            'max' => $max,
            'passed' => $passed,
            'comment' => $comment,
            'feedback' => implode(' ', $texts),
            'criteria' => $criteria,
        ];
    }
}
