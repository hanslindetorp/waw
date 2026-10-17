<?php
// Outgoing requests (the platform's public keys, the score service). One small
// function so the tests can stand in for the network.

namespace Waw;

final class Http
{
    // Canvas refuses API requests without a User-Agent that says who is calling
    // (its "403 Not Authorized … valid user agent" answer), so every request names
    // the tool. Contact details can be added here if a platform asks for them.
    public const USER_AGENT = 'WAW-LTI/1.0 (+https://waxml.org/waw/)';

    /** @return array{status: int, body: string} status 0 when the request itself failed */
    public static function request(string $method, string $url, array $headers = [], ?string $body = null): array
    {
        if (!preg_match('#^https?://#i', $url)) {
            return ['status' => 0, 'body' => ''];
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_USERAGENT => self::USER_AGENT,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        return ['status' => $response === false ? 0 : $status, 'body' => $response === false ? '' : (string) $response];
    }
}
