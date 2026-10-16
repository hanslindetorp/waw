<?php
// Just enough JWT/JWK for LTI 1.3, with nothing but PHP's own openssl: reading
// a platform's public key from its JWKS, checking an RS256 signature, signing
// our own RS256 tokens (the client assertion for the score service), and the
// short HMAC tokens that carry a launch from launch.php to the viewer.

namespace Waw;

final class Jwt
{
    public static function b64e(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    public static function b64d(string $s)
    {
        $pad = strlen($s) % 4;
        if ($pad) {
            $s .= str_repeat('=', 4 - $pad);
        }
        return base64_decode(strtr($s, '-_', '+/'), true);
    }

    // ── DER, to turn a JWK's modulus and exponent into a PEM public key ──
    private static function derLength(int $n): string
    {
        if ($n < 128) {
            return chr($n);
        }
        $bytes = '';
        while ($n > 0) {
            $bytes = chr($n & 0xff) . $bytes;
            $n >>= 8;
        }
        return chr(0x80 | strlen($bytes)) . $bytes;
    }

    private static function derInteger(string $bin): string
    {
        $bin = ltrim($bin, "\x00");
        if ($bin === '' || (ord($bin[0]) & 0x80)) {
            $bin = "\x00" . $bin;
        }
        return "\x02" . self::derLength(strlen($bin)) . $bin;
    }

    private static function derSequence(string $content): string
    {
        return "\x30" . self::derLength(strlen($content)) . $content;
    }

    /** An RSA JWK as a PEM public key, or null if it isn't one. */
    public static function jwkToPem(array $jwk): ?string
    {
        if (($jwk['kty'] ?? '') !== 'RSA' || empty($jwk['n']) || empty($jwk['e'])) {
            return null;
        }
        $n = self::b64d((string) $jwk['n']);
        $e = self::b64d((string) $jwk['e']);
        if ($n === false || $e === false || $n === '' || $e === '') {
            return null;
        }
        $rsaPublicKey = self::derSequence(self::derInteger($n) . self::derInteger($e));
        $algorithm = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00"; // rsaEncryption, NULL
        $bitString = "\x03" . self::derLength(strlen($rsaPublicKey) + 1) . "\x00" . $rsaPublicKey;
        $spki = self::derSequence($algorithm . $bitString);
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    /** The public JWK (with kid) of a private key in PEM. */
    public static function publicJwk(string $privatePem, string $kid): ?array
    {
        $key = openssl_pkey_get_private($privatePem);
        if ($key === false) {
            return null;
        }
        $details = openssl_pkey_get_details($key);
        if (!$details || empty($details['rsa'])) {
            return null;
        }
        return [
            'kty' => 'RSA',
            'alg' => 'RS256',
            'use' => 'sig',
            'kid' => $kid,
            'n' => self::b64e($details['rsa']['n']),
            'e' => self::b64e($details['rsa']['e']),
        ];
    }

    /** @return array{0: array, 1: array, 2: string, 3: string}|null [header, payload, signed part, signature] */
    public static function split(string $jwt): ?array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            return null;
        }
        $header = json_decode((string) self::b64d($parts[0]), true);
        $payload = json_decode((string) self::b64d($parts[1]), true);
        $signature = self::b64d($parts[2]);
        if (!is_array($header) || !is_array($payload) || $signature === false) {
            return null;
        }
        return [$header, $payload, $parts[0] . '.' . $parts[1], $signature];
    }

    /** The key id a token says it was signed with. */
    public static function keyId(string $jwt): ?string
    {
        $split = self::split($jwt);
        return $split && isset($split[0]['kid']) ? (string) $split[0]['kid'] : null;
    }

    /**
     * The payload of an RS256 token if its signature is made by one of the
     * keys in $jwks ({ keys: [...] }); null otherwise. Nothing else about the
     * token (who, for whom, until when) is checked here.
     */
    public static function verifyRs256(string $jwt, array $jwks): ?array
    {
        $split = self::split($jwt);
        if (!$split) {
            return null;
        }
        [$header, $payload, $signed, $signature] = $split;
        if (($header['alg'] ?? '') !== 'RS256') {
            return null; // never "none", never HMAC under a public key
        }
        $keys = is_array($jwks['keys'] ?? null) ? $jwks['keys'] : [];
        $kid = $header['kid'] ?? null;
        $candidates = array_values(array_filter($keys, fn($k) => is_array($k) && ($kid === null ? true : (($k['kid'] ?? null) === $kid))));
        if ($kid === null && count($keys) !== 1) {
            return null;
        }
        foreach ($candidates as $jwk) {
            $pem = self::jwkToPem($jwk);
            if ($pem !== null && openssl_verify($signed, $signature, $pem, OPENSSL_ALGO_SHA256) === 1) {
                return $payload;
            }
        }
        return null;
    }

    public static function signRs256(array $claims, string $privatePem, string $kid): string
    {
        $header = self::b64e(json_encode(['typ' => 'JWT', 'alg' => 'RS256', 'kid' => $kid]));
        $payload = self::b64e(json_encode($claims, JSON_UNESCAPED_SLASHES));
        $signature = '';
        if (!openssl_sign("$header.$payload", $signature, $privatePem, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('Could not sign the token.');
        }
        return "$header.$payload." . self::b64e($signature);
    }

    // ── Our own short tokens (launch -> viewer -> done.php) ──────────────
    public static function makeToken(array $payload, string $secret): string
    {
        $body = self::b64e(json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $body . '.' . self::b64e(hash_hmac('sha256', $body, $secret, true));
    }

    /** The payload of a token we made, if it is intact and not expired; otherwise null. */
    public static function readToken(string $token, string $secret): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 2) {
            return null;
        }
        $expected = self::b64e(hash_hmac('sha256', $parts[0], $secret, true));
        if (!hash_equals($expected, $parts[1])) {
            return null;
        }
        $payload = json_decode((string) self::b64d($parts[0]), true);
        if (!is_array($payload) || !isset($payload['exp']) || $payload['exp'] < time()) {
            return null;
        }
        return $payload;
    }
}
