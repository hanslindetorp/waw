<?php
// JWT/JWK helpers (included by run.php).
require_once __DIR__ . '/../lib/Jwt.php';

use Waw\Jwt;

$rsa = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
openssl_pkey_export($rsa, $privatePem);
$publicPem = openssl_pkey_get_details($rsa)['key'];
$other = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
openssl_pkey_export($other, $otherPem);

// A JWK made from a key becomes the same PEM public key again.
$jwk = Jwt::publicJwk($privatePem, 'k1');
check('jwt: public JWK has the parts', ($jwk['kty'] ?? '') === 'RSA' && ($jwk['kid'] ?? '') === 'k1' && !empty($jwk['n']) && !empty($jwk['e']));
$pem = Jwt::jwkToPem($jwk);
check('jwt: JWK -> PEM matches the original public key', $pem !== null && trim($pem) === trim($publicPem));
check('jwt: a non-RSA JWK is refused', Jwt::jwkToPem(['kty' => 'EC']) === null);

// Sign and verify.
$jwks = ['keys' => [$jwk]];
$claims = ['iss' => 'x', 'n' => 42, 'text' => 'åäö'];
$token = Jwt::signRs256($claims, $privatePem, 'k1');
check('jwt: a signed token verifies', Jwt::verifyRs256($token, $jwks) === $claims);
check('jwt: keyId is read', Jwt::keyId($token) === 'k1');
check('jwt: another key does not verify it', Jwt::verifyRs256(Jwt::signRs256($claims, $otherPem, 'k1'), $jwks) === null);
check('jwt: an unknown kid does not verify', Jwt::verifyRs256(Jwt::signRs256($claims, $privatePem, 'nope'), $jwks) === null);
[$h, $p, $s] = explode('.', $token);
$forged = $h . '.' . Jwt::b64e(json_encode(['iss' => 'x', 'n' => 43])) . '.' . $s;
check('jwt: a changed payload does not verify', Jwt::verifyRs256($forged, $jwks) === null);
$none = Jwt::b64e(json_encode(['alg' => 'none', 'kid' => 'k1'])) . '.' . $p . '.';
check('jwt: alg "none" is refused', Jwt::verifyRs256($none, $jwks) === null);
$hmac = Jwt::b64e(json_encode(['alg' => 'HS256', 'kid' => 'k1'])) . '.' . $p . '.' . Jwt::b64e(hash_hmac('sha256', "x.$p", $publicPem, true));
check('jwt: HMAC under the public key is refused', Jwt::verifyRs256($hmac, $jwks) === null);
check('jwt: garbage is refused', Jwt::verifyRs256('not.a.jwt', $jwks) === null && Jwt::verifyRs256('abc', $jwks) === null);
$noKid = Jwt::b64e(json_encode(['typ' => 'JWT', 'alg' => 'RS256'])) . '.' . $p;
openssl_sign($noKid, $sig, $privatePem, OPENSSL_ALGO_SHA256);
check('jwt: no kid is fine with a single key', Jwt::verifyRs256($noKid . '.' . Jwt::b64e($sig), $jwks) === $claims);
check('jwt: no kid is refused with several keys', Jwt::verifyRs256($noKid . '.' . Jwt::b64e($sig), ['keys' => [$jwk, $jwk]]) === null);

// Our own short tokens.
$secret = 'secret-1';
$t = Jwt::makeToken(['lid' => 7, 'exp' => time() + 60], $secret);
check('token: read back', (Jwt::readToken($t, $secret)['lid'] ?? null) === 7);
check('token: wrong secret', Jwt::readToken($t, 'secret-2') === null);
check('token: expired', Jwt::readToken(Jwt::makeToken(['lid' => 7, 'exp' => time() - 1], $secret), $secret) === null);
check('token: without expiry', Jwt::readToken(Jwt::makeToken(['lid' => 7], $secret), $secret) === null);
[$body, $mac] = explode('.', $t);
check('token: changed body', Jwt::readToken(Jwt::b64e(json_encode(['lid' => 8, 'exp' => time() + 60])) . '.' . $mac, $secret) === null);
check('token: garbage', Jwt::readToken('x', $secret) === null);
