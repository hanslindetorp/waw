<?php
// The database: one PDO connection and the tables, made the same way on MySQL
// (waxml.org) and SQLite (the local tests). Times are Unix seconds in plain
// integer columns so nothing depends on the database's own date types.

namespace Waw;

final class Db
{
    public static function connect(array $config): \PDO
    {
        $db = $config['db'] ?? [];
        $pdo = new \PDO($db['dsn'] ?? '', $db['user'] ?? null, $db['pass'] ?? null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        ]);
        return $pdo;
    }

    /** Creates whatever tables are missing (safe to run again). */
    public static function migrate(\PDO $pdo): void
    {
        $mysql = $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME) === 'mysql';
        $id = $mysql ? 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        $tail = $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
        $tables = [
            // The LMS installations (Canvas accounts) that may launch the tool.
            "CREATE TABLE IF NOT EXISTS lti_platforms (
                id $id,
                name VARCHAR(190) NOT NULL,
                issuer VARCHAR(190) NOT NULL,
                client_id VARCHAR(190) NOT NULL,
                deployment_id VARCHAR(190) NULL,
                auth_url TEXT NOT NULL,
                token_url TEXT NOT NULL,
                jwks_url TEXT NOT NULL,
                UNIQUE (issuer, client_id)
            )$tail",
            // A login that has started and waits for its launch (single use).
            "CREATE TABLE IF NOT EXISTS lti_states (
                state VARCHAR(64) NOT NULL PRIMARY KEY,
                nonce VARCHAR(64) NOT NULL,
                platform_id INT NOT NULL,
                target_link_uri TEXT NULL,
                created INT NOT NULL
            )$tail",
            "CREATE TABLE IF NOT EXISTS lti_launches (
                id $id,
                platform_id INT NOT NULL,
                user_sub VARCHAR(190) NOT NULL,
                context_id VARCHAR(190) NULL,
                resource_link_id VARCHAR(190) NULL,
                lineitem TEXT NULL,
                scopes TEXT NULL,
                roles TEXT NULL,
                project VARCHAR(190) NOT NULL,
                view_id VARCHAR(190) NOT NULL,
                created INT NOT NULL
            )$tail",
            // How each view of each project is assessed (what assessment.json holds).
            "CREATE TABLE IF NOT EXISTS lti_assessments (
                project VARCHAR(190) NOT NULL,
                view_id VARCHAR(190) NOT NULL,
                body TEXT NOT NULL,
                updated INT NOT NULL,
                PRIMARY KEY (project, view_id)
            )$tail",
            "CREATE TABLE IF NOT EXISTS lti_submissions (
                id $id,
                launch_id INT NOT NULL,
                user_sub VARCHAR(190) NOT NULL,
                project VARCHAR(190) NOT NULL,
                view_id VARCHAR(190) NOT NULL,
                values_json TEXT NOT NULL,
                score DOUBLE PRECISION NOT NULL,
                max_score DOUBLE PRECISION NOT NULL,
                passed INT NOT NULL,
                feedback TEXT NULL,
                ags_status VARCHAR(190) NULL,
                created INT NOT NULL
            )$tail",
            // This tool's own signing key (the public half is served by jwks.php).
            "CREATE TABLE IF NOT EXISTS lti_keys (
                kid VARCHAR(64) NOT NULL PRIMARY KEY,
                private_pem TEXT NOT NULL,
                jwk TEXT NOT NULL,
                created INT NOT NULL
            )$tail",
            "CREATE TABLE IF NOT EXISTS lti_jwks_cache (
                platform_id INT NOT NULL PRIMARY KEY,
                body TEXT NOT NULL,
                fetched INT NOT NULL
            )$tail",
        ];
        foreach ($tables as $sql) {
            $pdo->exec($sql);
        }
    }

    /** The tool's signing key, made on first use: [kid, private PEM, public JWK]. */
    public static function toolKey(\PDO $pdo): array
    {
        $row = $pdo->query('SELECT kid, private_pem, jwk FROM lti_keys ORDER BY created DESC LIMIT 1')->fetch();
        if ($row) {
            return [$row['kid'], $row['private_pem'], json_decode($row['jwk'], true)];
        }
        $res = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        if ($res === false || !openssl_pkey_export($res, $pem)) {
            throw new \RuntimeException('Could not make a signing key (openssl).');
        }
        $details = openssl_pkey_get_details($res);
        $kid = substr(hash('sha256', $details['rsa']['n']), 0, 16);
        $jwk = Jwt::publicJwk($pem, $kid);
        $stmt = $pdo->prepare('INSERT INTO lti_keys (kid, private_pem, jwk, created) VALUES (?, ?, ?, ?)');
        $stmt->execute([$kid, $pem, json_encode($jwk), time()]);
        return [$kid, $pem, $jwk];
    }
}
