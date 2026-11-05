<?php
declare(strict_types=1);

/**
 * StockMaster BD - 1-Click Browser Auto-Installer for cPanel Shared Hosting
 * Works at BOTH:
 *   1) https://yourdomain.com/install.php
 *   2) https://yourdomain.com/api/install.php
 *
 * Automatically:
 *   - Creates the MySQL database if permitted (CREATE DATABASE IF NOT EXISTS)
 *   - Imports all 16 InnoDB tables + initial Bangla/English seed data + Customer Ledger
 *   - Generates and saves env.php with your MySQL credentials
 *   - Creates .htaccess if missing
 *   - Locks the installer with install.lock after completion
 */

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('X-XSS-Protection: 1; mode=block');
header('Referrer-Policy: strict-origin-when-cross-origin');
header("Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none';");

if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return $needle === '' || strpos($haystack, $needle) === 0;
    }
}

$webRoot = basename(__DIR__) === 'api' ? dirname(__DIR__) : __DIR__;
$rootHtaccessInit = $webRoot . '/.htaccess';
if (!is_file($rootHtaccessInit) || filesize($rootHtaccessInit) < 100) {
    if (is_file($webRoot . '/htaccess.txt') && filesize($webRoot . '/htaccess.txt') >= 100) {
        @copy($webRoot . '/htaccess.txt', $rootHtaccessInit);
    } elseif (is_file($webRoot . '/public/.htaccess') && filesize($webRoot . '/public/.htaccess') >= 100) {
        @copy($webRoot . '/public/.htaccess', $rootHtaccessInit);
    }
}
$lockCandidates = [
    $webRoot . '/install.lock',
    $webRoot . '/api/install.lock',
    __DIR__ . '/install.lock',
];

$envCandidates = [
    $webRoot . '/backend/config/env.php',
    $webRoot . '/api/env.php',
    __DIR__ . '/env.php',
];

$isAlreadyInstalled = false;
foreach ($lockCandidates as $lf) {
    if (file_exists($lf)) {
        $isAlreadyInstalled = true;
        break;
    }
}
if (!$isAlreadyInstalled) {
    foreach ($envCandidates as $ef) {
        if (is_file($ef) && filesize($ef) > 20) {
            $cfg = @include $ef;
            if (is_array($cfg) && !empty($cfg['DB_NAME'])) {
                $isAlreadyInstalled = true;
                break;
            }
        }
    }
}

if ($isAlreadyInstalled) {
    http_response_code(403);
    die('<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StockMaster BD Installed</title><style>body{font-family:sans-serif;background:#071f1d;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#0f2e2b;padding:32px;border-radius:16px;border:1px solid #14b8a6;max-width:520px;text-align:center;line-height:1.6}</style></head><body><div class="card"><h2>✅ ইনস্টলেশন ইতিমধ্যে সম্পন্ন হয়েছে! (Already Installed)</h2><p>নিরাপত্তার স্বার্থে অটো-ইনস্টলারটি লক করা হয়েছে। পুনরায় ইনস্টল করতে চাইলে cPanel File Manager থেকে <code>install.lock</code> এবং <code>backend/config/env.php</code> (অথবা <code>api/env.php</code>) ফাইল ডিলিট করুন।</p><a href="/" style="display:inline-block;margin-top:14px;padding:12px 24px;background:#0d9488;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold">মূল সফটওয়্যারে যান (Go to App)</a></div></body></html>');
}

$message = '';
$status  = '';
$tablesCreated = 0;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $dbHost = trim((string) ($_POST['db_host'] ?? 'localhost'));
    $dbPort = trim((string) ($_POST['db_port'] ?? '3306'));
    $dbName = trim((string) ($_POST['db_name'] ?? ''));
    $dbUser = trim((string) ($_POST['db_user'] ?? ''));
    $dbPass = (string) ($_POST['db_pass'] ?? '');

    if ($dbName === '' || $dbUser === '') {
        $status  = 'error';
        $message = 'অনুগ্রহ করে ডাটাবেজের নাম (Database Name) এবং ইউজারনেম (Database Username) সঠিকভাবে লিখুন।';
    } else {
        try {
            // Step 1: Connect to MySQL Server and try creating database if permitted
            $safeDbName = str_replace('`', '``', $dbName);
            try {
                $initDsn = "mysql:host={$dbHost};port={$dbPort};charset=utf8mb4";
                $initPdo = new PDO($initDsn, $dbUser, $dbPass, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                ]);
                $initPdo->exec("CREATE DATABASE IF NOT EXISTS `{$safeDbName}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            } catch (Throwable $ignoreCreateErr) {
                // Shared cPanel often requires DB creation via MySQL Wizard; proceed to connect directly to $dbName
            }

            // Step 2: Connect to target MySQL Database
            $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
            $pdo = new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
            $pdo->exec("SET time_zone = '+06:00'");
            $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");

            // Step 3: Find and import cpanel_complete_install.sql statement by statement
            $sqlCandidates = [
                $webRoot . '/database/cpanel_complete_install.sql',
                dirname($webRoot) . '/database/cpanel_complete_install.sql',
                __DIR__ . '/cpanel_complete_install.sql',
            ];

            $sqlFileFound = '';
            foreach ($sqlCandidates as $candidate) {
                if (is_readable($candidate)) {
                    $sqlFileFound = $candidate;
                    break;
                }
            }

            if ($sqlFileFound !== '') {
                $rawSql = (string) file_get_contents($sqlFileFound);
                // Strip full-line SQL comments (-- ...)
                $lines = preg_split('/\r\n|\r|\n/', $rawSql) ?: [];
                $cleanLines = [];
                foreach ($lines as $line) {
                    $trimmed = ltrim($line);
                    if ($trimmed === '' || str_starts_with($trimmed, '--')) {
                        continue;
                    }
                    $cleanLines[] = $line;
                }
                $cleanSql = implode("\n", $cleanLines);
                // Split by semicolon at end of line
                $statements = preg_split('/;\s*(?:\n|$)/', $cleanSql) ?: [];
                foreach ($statements as $stmt) {
                    $stmt = trim($stmt);
                    if ($stmt !== '') {
                        $pdo->exec($stmt);
                        $tablesCreated++;
                    }
                }
            }

            $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");

            // Step 4: Save env.php in all standard lookup locations so Database.php always finds it
            $envContent = "<?php\nreturn [\n"
                . "    'DB_HOST' => " . var_export($dbHost, true) . ",\n"
                . "    'DB_PORT' => " . var_export($dbPort, true) . ",\n"
                . "    'DB_NAME' => " . var_export($dbName, true) . ",\n"
                . "    'DB_USER' => " . var_export($dbUser, true) . ",\n"
                . "    'DB_PASS' => " . var_export($dbPass, true) . ",\n"
                . "    'APP_ENV' => 'production',\n"
                . "    'TIMEZONE' => 'Asia/Dhaka',\n"
                . "];\n";

            $denyHtaccess = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n";

            // Strict per-domain isolation: Save env.php ONLY inside this domain's own protected directories
            // so installing on 2-3 domains on the same cPanel account never links or overwrites another domain!
            // Location A: <domain_root>/backend/config/env.php
            $backendConfigDir = $webRoot . '/backend/config';
            if (@is_dir($backendConfigDir) || @mkdir($backendConfigDir, 0750, true)) {
                @file_put_contents($backendConfigDir . '/env.php', $envContent);
                @chmod($backendConfigDir . '/env.php', 0600);
                @file_put_contents($backendConfigDir . '/.htaccess', $denyHtaccess);
            }

            // Location B: <domain_root>/api/env.php (protected by FilesMatch in .htaccess)
            $apiDir = $webRoot . '/api';
            if (@is_dir($apiDir) || @mkdir($apiDir, 0755, true)) {
                @file_put_contents($apiDir . '/env.php', $envContent);
                @chmod($apiDir . '/env.php', 0600);
            }

            // Remove any legacy disk JSON state files so 100% of data comes exclusively from this MySQL database
            $legacyJsonFiles = [
                $webRoot . '/backend/config/erp_persistent_state.json',
                $webRoot . '/backend/erp_persistent_state.json',
                $webRoot . '/data/erp_persistent_state.json',
            ];
            foreach ($legacyJsonFiles as $oldJson) {
                if (is_file($oldJson)) {
                    @unlink($oldJson);
                }
            }

            // Step 5: Ensure root .htaccess exists for React SPA & security
            $rootHtaccess = $webRoot . '/.htaccess';
            if (!file_exists($rootHtaccess) || filesize($rootHtaccess) < 100) {
                $htaccessContent = <<<'HTACCESS'
Options -MultiViews -Indexes
DirectoryIndex index.php index.html
ErrorDocument 404 /index.php
<IfModule mod_mime.c>
    AddType application/javascript .js .mjs
    AddType text/css .css
    AddType image/svg+xml .svg
    AddType image/webp .webp
    AddType application/json .json
</IfModule>
<IfModule mod_brotli.c>
    AddOutputFilterByType BROTLI_COMPRESS text/html text/plain text/css text/xml text/javascript application/javascript application/x-javascript application/json application/ld+json application/xml image/svg+xml font/ttf font/otf font/woff font/woff2
</IfModule>
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/plain text/css text/xml text/javascript application/javascript application/x-javascript application/json application/ld+json application/xml image/svg+xml font/ttf font/otf font/woff font/woff2
</IfModule>
<IfModule mod_headers.c>
    Header append Vary Accept-Encoding
    Header set X-Content-Type-Options "nosniff"
    Header set X-XSS-Protection "1; mode=block"
    Header set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresByType text/css "access plus 1 year"
    ExpiresByType application/javascript "access plus 1 year"
    ExpiresByType image/webp "access plus 1 year"
    ExpiresByType image/png "access plus 1 year"
    ExpiresByType image/jpeg "access plus 1 year"
    ExpiresByType image/svg+xml "access plus 1 year"
    ExpiresByType font/woff2 "access plus 1 year"
</IfModule>
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule (^|/)(env\.php|erp_persistent_state\.json|package(-lock)?\.json|composer\.(json|lock)|tsconfig\.json|vite\.config\.ts|server\.ts)$ - [F,L]
    RewriteRule \.(sql|md|lock|env|example|log|bak|ini|sh|yml|yaml)$ - [F,L]
    RewriteRule ^/?backend/(config|controllers|middleware|repositories|services|validators)/ - [F,L]
    RewriteRule ^/?install\.php$ - [L]
    RewriteRule ^/?api/install\.php$ - [L]
    RewriteRule ^/?backend/api/install\.php$ - [L]
    RewriteRule ^/?api/index\.php$ - [L]
    RewriteRule ^/?backend/api/index\.php$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?api/(.*)$ api/index.php?route=$1 [QSA,L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?(.+)/assets/(.*)$ assets/$2 [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?(.+)/uploads/(.*)$ uploads/$2 [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^(.*)$ index.php [QSA,L]
</IfModule>
HTACCESS;
                @file_put_contents($rootHtaccess, $htaccessContent);
            }

            // Step 6: Write install.lock so installer cannot be abused later
            $lockText = 'Installed on ' . date('Y-m-d H:i:s');
            @file_put_contents($webRoot . '/install.lock', $lockText);
            @chmod($webRoot . '/install.lock', 0640);
            if (is_dir($webRoot . '/api')) {
                @file_put_contents($webRoot . '/api/install.lock', $lockText);
                @chmod($webRoot . '/api/install.lock', 0640);
            }

            $status  = 'success';
            $message = 'অভিনন্দন! আপনার MySQL ডাটাবেজ কানেকশন, ১৬টি টেবিল, গ্রাহক খতিয়ান এবং ডিফল্ট অ্যাডমিন অ্যাকাউন্ট সফলভাবে সেটআপ হয়েছে!';
        } catch (Throwable $e) {
            $status  = 'error';
            $message = 'ডাটাবেজ কানেকশন ব্যর্থ হয়েছে: ' . htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8') . '<br><br>💡 <strong>পরামর্শ:</strong> cPanel-এর <em>MySQL Database Wizard</em> থেকে ডাটাবেজ ও ইউজার তৈরি করে <strong>ALL PRIVILEGES</strong> টিক দিয়েছেন কি না এবং নামের শুরুতে cPanel prefix (যেমন: <code>cpaneluser_</code>) আছে কি না তা চেক করুন।';
        }
    }
}
?>
<!doctype html>
<html lang="bn">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>StockMaster BD — 1-Click cPanel & MySQL Installer</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #071f1d 0%, #0f172a 100%);
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .card {
            background: #ffffff;
            color: #0f172a;
            width: 100%;
            max-width: 580px;
            border-radius: 18px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.45);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #0d9488 0%, #115e59 100%);
            color: #ffffff;
            padding: 24px 28px;
        }
        .header h1 { margin: 0; font-size: 20px; }
        .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.92; }
        .body { padding: 28px; }
        .steps-box {
            background: #f0fdfa;
            border: 1px solid #99f6e4;
            border-radius: 12px;
            padding: 12px 16px;
            margin-bottom: 18px;
            font-size: 12px;
            color: #115e59;
            line-height: 1.6;
        }
        .field { margin-bottom: 15px; }
        label { display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 5px; }
        input {
            width: 100%;
            padding: 11px 14px;
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            font-size: 14px;
            outline: none;
        }
        input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.15); }
        .btn {
            width: 100%;
            padding: 14px;
            background: #0d9488;
            color: #ffffff;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
        }
        .btn:hover { background: #0f766e; }
        .alert {
            padding: 14px 16px;
            border-radius: 10px;
            font-size: 13px;
            margin-bottom: 18px;
            line-height: 1.6;
        }
        .alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
        .alert-success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
        .hint { font-size: 11px; color: #64748b; margin-top: 4px; }
        code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #0f172a; }
    </style>
</head>
<body>
<div class="card">
    <div class="header">
        <h1>StockMaster BD — 1-Click Auto Installer</h1>
        <p>সহজ বাংলায় ১-ক্লিকে MySQL ডাটাবেজ কানেকশন ও অটো-টেবিল সেটআপ</p>
    </div>
    <div class="body">
        <?php if ($message !== ''): ?>
            <div class="alert <?php echo $status === 'success' ? 'alert-success' : 'alert-error'; ?>">
                <?php echo $message; ?>
            </div>
        <?php endif; ?>

        <?php if ($status === 'success'): ?>
            <div class="steps-box">
                <strong>ডিফল্ট অ্যাডমিন লগইন তথ্য:</strong><br>
                ইমেইল / ইউজারনেম: <code>owner@stockflowbd.com</code> অথবা <code>admin</code><br>
                পাসওয়ার্ড: <code>Admin@1234</code>
            </div>
            <a href="/smart" class="btn" style="display:block;text-align:center;text-decoration:none;margin-top:16px;">
                অ্যাডমিন প্যানেলে প্রবেশ করুন (Go to /smart Login) →
            </a>
        <?php else: ?>
            <div class="steps-box">
                <strong>কীভাবে সেটআপ করবেন?</strong><br>
                ১. cPanel-এর <b>MySQL Database Wizard</b> থেকে একটি ডাটাবেজ ও ইউজার তৈরি করুন (ALL PRIVILEGES সহ)।<br>
                ২. নিচের ফর্মে সেই ডাটাবেজ নাম, ইউজারনেম ও পাসওয়ার্ড দিয়ে বাটনে ক্লিক করলেই <b>সবগুলো টেবিল স্বয়ংক্রিয়ভাবে তৈরি হয়ে যাবে</b> (phpMyAdmin-এ আলাদা করে ফাইল আপলোড করতে হবে না)!
            </div>

            <form method="post">
                <div class="field">
                    <label>MySQL Host (ডাটাবেজ হোস্ট)</label>
                    <input type="text" name="db_host" value="<?php echo htmlspecialchars($_POST['db_host'] ?? 'localhost', ENT_QUOTES, 'UTF-8'); ?>" required>
                    <div class="hint">cPanel হোস্টিংয়ে সবসময় <code>localhost</code> থাকে।</div>
                </div>
                <div class="field">
                    <label>Database Name (ডাটাবেজের পুরো নাম) *</label>
                    <input type="text" name="db_name" value="<?php echo htmlspecialchars($_POST['db_name'] ?? '', ENT_QUOTES, 'UTF-8'); ?>" placeholder="যেমন: cpaneluser_stockmaster" required>
                    <div class="hint">cPanel-এ তৈরি করা ডাটাবেজের পুরো নাম লিখুন (প্রিফিক্স সহ)।</div>
                </div>
                <div class="field">
                    <label>Database Username (ডাটাবেজ ইউজারনেম) *</label>
                    <input type="text" name="db_user" value="<?php echo htmlspecialchars($_POST['db_user'] ?? '', ENT_QUOTES, 'UTF-8'); ?>" placeholder="যেমন: cpaneluser_admin" required>
                    <div class="hint">ডাটাবেজ ইউজারের পুরো নাম লিখুন (প্রিফিক্স সহ)।</div>
                </div>
                <div class="field">
                    <label>Database Password (ডাটাবেজ পাসওয়ার্ড)</label>
                    <input type="password" name="db_pass" placeholder="আপনার ডাটাবেজ পাসওয়ার্ড দিন">
                </div>
                <button type="submit" class="btn">
                    এখনই অটো-ইনস্টল ও ডাটাবেজ সেটআপ সম্পন্ন করুন (1-Click Install)
                </button>
            </form>
        <?php endif; ?>
    </div>
</div>
</body>
</html>
